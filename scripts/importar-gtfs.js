"use strict";

// Converte o GTFS bruto em JSON menor para ser consultado pela aplicação.
// Uso: npm run importar-gtfs

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse");

const raiz = path.resolve(__dirname, "..", "data", "gtfs");
const saida = path.resolve(__dirname, "..", "data");

function arquivo(nome) {
  const caminho = path.join(raiz, nome);
  if (!fs.existsSync(caminho)) throw new Error(`Arquivo GTFS não encontrado: ${caminho}`);
  return caminho;
}

async function ler(nome, aoLer) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(arquivo(nome));
    const parser = stream.pipe(parse({ columns: true, bom: true, skip_empty_lines: true, relax_column_count: true }));
    parser.on("data", aoLer);
    parser.once("error", reject);
    parser.once("end", resolve);
    stream.once("error", reject);
  });
}

function numero(valor) {
  const resultado = Number(valor);
  return Number.isFinite(resultado) ? resultado : null;
}

function dataHojeRio() {
  const formato = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
  return formato.format(new Date()).replace(/-/g, "");
}

async function importar() {
  const rotas = new Map();
  const viagens = new Map();
  const paradas = new Map();
  const tempos = new Map();
  const formas = new Map();
  const dataReferencia = process.env.GTFS_DATE || dataHojeRio();
  const todosServicos = process.env.GTFS_ALL_DAYS !== "0";
  const diaSemana = new Date(`${dataReferencia.slice(0, 4)}-${dataReferencia.slice(4, 6)}-${dataReferencia.slice(6, 8)}T12:00:00Z`).getUTCDay();
  const nomesDias = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const servicos = new Map();
  const excecoes = new Map();

  await ler("calendar.txt", (c) => {
    if (!c.service_id) return;
    const ativa = dataReferencia >= c.start_date && dataReferencia <= c.end_date && (todosServicos || c[nomesDias[diaSemana]] === "1");
    servicos.set(c.service_id, ativa);
  });
  await ler("calendar_dates.txt", (c) => {
    if (todosServicos) {
      if (c.exception_type === "1") excecoes.set(c.service_id, true);
      return;
    }
    if (c.date !== dataReferencia) return;
    excecoes.set(c.service_id, c.exception_type === "1");
  });

  const servicoAtivo = (id) => excecoes.has(id) ? excecoes.get(id) : servicos.get(id) === true;

  await ler("routes.txt", (r) => {
    if (!r.route_id || !r.route_short_name) return;
    rotas.set(r.route_id, {
      id: r.route_id,
      linha: r.route_short_name.trim(),
      nome: (r.route_long_name || r.route_desc || "").trim(),
      cor: r.route_color || null,
    });
  });

  await ler("trips.txt", (t) => {
    if (!t.trip_id || !rotas.has(t.route_id) || !servicoAtivo(t.service_id)) return;
    viagens.set(t.trip_id, {
      id: t.trip_id,
      routeId: t.route_id,
      destino: (t.trip_headsign || "").trim(),
      sentido: (t.direction_id || "").trim(),
      shapeId: (t.shape_id || "").trim(),
    });
  });

  await ler("stops.txt", (s) => {
    const lat = numero(s.stop_lat);
    const lng = numero(s.stop_lon);
    if (!s.stop_id || lat === null || lng === null) return;
    paradas.set(s.stop_id, {
      id: s.stop_id,
      nome: (s.stop_name || "Parada sem nome").trim(),
      lat,
      lng,
    });
  });

  await ler("stop_times.txt", (s) => {
    if (!viagens.has(s.trip_id) || !paradas.has(s.stop_id)) return;
    if (!tempos.has(s.trip_id)) tempos.set(s.trip_id, []);
    tempos.get(s.trip_id).push({
      id: s.stop_id,
      ordem: Number(s.stop_sequence) || 0,
    });
  });

  await ler("shapes.txt", (s) => {
    const lat = numero(s.shape_pt_lat);
    const lng = numero(s.shape_pt_lon);
    if (!s.shape_id || lat === null || lng === null) return;
    if (!formas.has(s.shape_id)) formas.set(s.shape_id, []);
    formas.get(s.shape_id).push({
      ordem: Number(s.shape_pt_sequence) || 0,
      coordenada: [lng, lat],
    });
  });

  const variantesPorRota = new Map();
  for (const viagem of viagens.values()) {
    const paradasDaViagem = (tempos.get(viagem.id) || [])
      .sort((a, b) => a.ordem - b.ordem)
      .map((p) => p.id);
    const chave = `${viagem.routeId}|${viagem.sentido}|${viagem.destino}|${viagem.shapeId}`;
    if (!variantesPorRota.has(viagem.routeId)) variantesPorRota.set(viagem.routeId, new Map());
    if (!variantesPorRota.get(viagem.routeId).has(chave)) {
      variantesPorRota.get(viagem.routeId).set(chave, {
        destino: viagem.destino,
        sentido: viagem.sentido,
        shapeId: viagem.shapeId,
        tripIds: [viagem.id],
        paradas: paradasDaViagem,
      });
    } else {
      const variante = variantesPorRota.get(viagem.routeId).get(chave);
      if (!variante.tripIds.includes(viagem.id)) variante.tripIds.push(viagem.id);
    }
  }

  const linhas = [];
  for (const rota of rotas.values()) {
    const variantes = [...(variantesPorRota.get(rota.id)?.values() || [])];
    linhas.push({ ...rota, variantes });
  }

  const rotasGeoJson = {};
  for (const [shapeId, pontos] of formas) {
    pontos.sort((a, b) => a.ordem - b.ordem);
    rotasGeoJson[shapeId] = {
      type: "LineString",
      coordinates: pontos.map((p) => p.coordenada),
    };
  }

  fs.mkdirSync(saida, { recursive: true });
  fs.writeFileSync(path.join(saida, "linhas.json"), JSON.stringify(linhas));
  fs.writeFileSync(path.join(saida, "paradas.json"), JSON.stringify([...paradas.values()]));
  fs.writeFileSync(path.join(saida, "rotas.json"), JSON.stringify(rotasGeoJson));
  fs.writeFileSync(path.join(saida, "gtfs-meta.json"), JSON.stringify({
    importadoEm: new Date().toISOString(),
    dataReferencia,
    linhas: linhas.length,
    paradas: paradas.size,
    rotas: formas.size,
    todosServicos,
  }, null, 2));

  console.log(`Importação concluída: ${linhas.length} linhas, ${paradas.size} paradas e ${formas.size} rotas.`);
}

importar().catch((erro) => {
  console.error("Falha ao importar GTFS:", erro.message);
  process.exitCode = 1;
});


const test = require("node:test");
const assert = require("node:assert/strict");
const { minutoUtc, normalizar, buscarMinuto, carregarOnibus } = require("../lib");
const comOnibus = require("./fixtures/linha-com-onibus.json");
const semOnibus = require("./fixtures/linha-sem-onibus.json");

const resposta = (corpo, status = 200) => ({ ok: status < 400, status, json: async () => corpo });
const agora = () => new Date("2026-10-17T14:32:45Z");

test("minutoUtc zera os segundos e usa UTC", () => {
  assert.equal(minutoUtc("2026-10-17T14:32:45.500Z"), "2026-10-17T14:32:00Z");
});

test("normalizar aceita vírgula decimal e descarta registros inválidos", () => {
  const ok = normalizar({ id_veiculo: "A1", servico: "485", latitude: "-22,9", longitude: "-43,2", datetime: "2026-10-17T14:32:10Z" });
  assert.equal(ok.lat, -22.9);
  assert.equal(ok.linha, "485");
  assert.equal(normalizar({ servico: "485", latitude: -22, longitude: -43 }), null); // sem id_veiculo
  assert.equal(normalizar({ id_veiculo: "A1", latitude: -22, longitude: -43 }), null); // sem servico
  assert.equal(normalizar({ id_veiculo: "A1", servico: "485", latitude: null, longitude: -43 }), null);
  assert.equal(normalizar({ id_veiculo: "A1", servico: "485", latitude: "-22.9xyz", longitude: -43 }), null);
  assert.equal(normalizar({ id_veiculo: "A1", servico: "   ", latitude: -22, longitude: -43 }), null);
  assert.equal(normalizar({ id_veiculo: "A1", servico: "485", latitude: 999, longitude: -43 }), null);
});

test("filtra pela linha, deduplica e fica com a posição mais recente", async () => {
  const onibus = await carregarOnibus("485", { fetch: async () => resposta(comOnibus), agora });
  assert.equal(onibus.length, 2); // A63001 e A63002; 232 e inválidos ficam de fora
  const a = onibus.find((o) => o.ordem === "A63001");
  assert.equal(a.lat, -22.904); // a leitura das 14:32:40 vence a das 14:32:10
});

test("linha sem veículos devolve lista vazia", async () => {
  const onibus = await carregarOnibus("999", { fetch: async () => resposta(semOnibus), agora });
  assert.deepEqual(onibus, []);
});

test("consulta o minuto atual e o anterior e tenta um terceiro minuto sem dados", async () => {
  const urls = [];
  await carregarOnibus("485", { fetch: async (u) => (urls.push(new URL(u)), resposta(semOnibus)), agora });
  const minutos = urls.map((u) => u.searchParams.get("minuto_utc")).sort();
  assert.deepEqual(minutos, ["2026-10-17T14:30:00Z", "2026-10-17T14:31:00Z", "2026-10-17T14:32:00Z"]);
  assert.ok(urls.every((u) => u.searchParams.get("servico") === "485" && u.searchParams.get("limit")));
  assert.ok(urls.every((u) => !u.searchParams.has("datetime_inicio")));
});

test("segue next_cursor até acabar as páginas", async () => {
  const cursores = [];
  const fetchFalso = async (u) => {
    const cursor = new URL(u).searchParams.get("cursor");
    cursores.push(cursor);
    if (!cursor) return resposta({ data: [{ id_veiculo: "A1", servico: "485", latitude: -22.9, longitude: -43.2 }], next_cursor: "p2" });
    return resposta({ data: [{ id_veiculo: "A2", servico: "485", latitude: -22.8, longitude: -43.1 }], next_cursor: null });
  };
  const registros = await buscarMinuto("485", "2026-10-17T14:32:00Z", { ...require("../lib").PADRAO, fetch: fetchFalso });
  assert.equal(registros.length, 2);
  assert.deepEqual(cursores, [null, "p2"]);
});

test("para na trava de segurança se o cursor nunca acabar", async () => {
  let chamadas = 0;
  const fetchFalso = async () => (chamadas++, resposta({ data: [], next_cursor: "sempre" }));
  await assert.rejects(
    buscarMinuto("485", "m", { ...require("../lib").PADRAO, fetch: fetchFalso, maxPaginas: 3 }),
    /excedeu o limite de 3 páginas/
  );
  assert.equal(chamadas, 3);
});

test("rejeita resposta de sucesso sem lista de veículos", async () => {
  await assert.rejects(
    carregarOnibus("485", { fetch: async () => resposta({ detalhe: "formato alterado" }), agora }),
    /não contém uma lista de veículos/
  );
});

test("API indisponível: erro quando todas as chamadas falham", async () => {
  await assert.rejects(carregarOnibus("485", { fetch: async () => resposta({}, 503), agora }), /503/);
  await assert.rejects(carregarOnibus("485", { fetch: async () => { throw new Error("rede caiu"); }, agora }), /rede caiu/);
});

test("se só um minuto falhar, usa o que deu certo", async () => {
  let n = 0;
  const fetchFalso = async () => (++n === 1 ? resposta({}, 500) : resposta(comOnibus));
  const onibus = await carregarOnibus("485", { fetch: fetchFalso, agora });
  assert.equal(onibus.length, 2);
});

test("envia um prazo (timeout) em cada chamada", async () => {
  let sinal;
  await carregarOnibus("485", { fetch: async (u, opts) => (sinal = opts.signal, resposta(semOnibus)), agora });
  assert.ok(sinal instanceof AbortSignal);
});

"use strict";

const TIMEOUT_MS = 10_000;
// A política do Nominatim pede identificação do app (com contato) e no máximo 1 requisição por segundo.
const CONTATO = process.env.CONTATO_APP || "projeto educacional";
const INTERVALO_NOMINATIM_MS = 1100;

// Cache simples com validade e tamanho máximo.
function criarCache(validadeMs, maximo = 200) {
  const mapa = new Map();
  return {
    pegar(chave) {
      const item = mapa.get(chave);
      if (!item) return undefined;
      if (Date.now() - item.em > validadeMs) { mapa.delete(chave); return undefined; }
      return item.valor;
    },
    guardar(chave, valor) {
      mapa.set(chave, { em: Date.now(), valor });
      while (mapa.size > maximo) mapa.delete(mapa.keys().next().value);
    },
  };
}
const cacheEnderecos = criarCache(10 * 60_000);
const cacheParadas = criarCache(5 * 60_000);

// Fila global: as chamadas ao Nominatim saem uma por vez, com intervalo mínimo entre elas.
let filaNominatim = Promise.resolve();
function naFilaDoNominatim(tarefa) {
  const resultado = filaNominatim.then(tarefa);
  filaNominatim = resultado.catch(() => {}).then(() => new Promise((ok) => setTimeout(ok, INTERVALO_NOMINATIM_MS)));
  return resultado;
}

function numero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : NaN;
}

async function jsonFetch(url, opcoes = {}) {
  const resposta = await fetch(url, {
    ...opcoes,
    headers: { "User-Agent": `PegaObusao/1.0 (${CONTATO})`, ...(opcoes.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resposta.ok) throw new Error(`Serviço externo respondeu ${resposta.status}`);
  return resposta.json();
}

async function buscarEnderecos(q) {
  const chave = q.trim().toLowerCase();
  const guardado = cacheEnderecos.pegar(chave);
  if (guardado) return guardado;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", `${q}, Rio de Janeiro, RJ`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "br");
  url.searchParams.set("viewbox", "-43.9,-22.6,-42.9,-23.2"); // esquerda,topo,direita,base
  url.searchParams.set("bounded", "1");
  const dados = await naFilaDoNominatim(() => jsonFetch(url));
  const resultado = dados.map((item) => ({
    nome: item.display_name,
    lat: numero(item.lat),
    lng: numero(item.lon),
  })).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
  cacheEnderecos.guardar(chave, resultado);
  return resultado;
}

async function buscarParadas(lat, lng, raio = 800) {
  // Arredonda a ~100 m para que pedidos vizinhos reaproveitem o cache e o Overpass.
  const chave = `${lat.toFixed(3)},${lng.toFixed(3)},${raio}`;
  const guardado = cacheParadas.pegar(chave);
  if (guardado) return guardado;
  const query = `[out:json][timeout:8];nwr[highway=bus_stop](around:${raio},${lat},${lng});out center tags;`;
  const dados = await jsonFetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: query,
  });
  const resultado = (dados.elements || []).map((item) => {
    const centro = item.type === "node" ? { lat: item.lat, lng: item.lon } : item.center || {};
    return {
      id: `${item.type}/${item.id}`,
      nome: item.tags?.name || item.tags?.ref || "Parada de ônibus",
      lat: numero(centro.lat),
      lng: numero(centro.lng),
      linhas: item.tags?.route_ref || "",
    };
  }).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
  cacheParadas.guardar(chave, resultado);
  return resultado;
}

async function calcularRota(origem, destino) {
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${origem.lng},${origem.lat};${destino.lng},${destino.lat}`);
  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");
  const dados = await jsonFetch(url);
  const rota = dados.routes?.[0];
  if (!rota) throw new Error("Nenhuma rota encontrada.");
  return {
    perfil: "carro", // o servidor público do OSRM só calcula por vias para carro
    distanciaMetros: Math.round(rota.distance),
    duracaoSegundos: Math.round(rota.duration),
    geometria: rota.geometry,
  };
}

module.exports = { buscarEnderecos, buscarParadas, calcularRota };


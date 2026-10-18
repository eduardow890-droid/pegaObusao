"use strict";
// Lógica de acesso à API da SMTR, separada do servidor para poder ser testada.

const PADRAO = {
  url: process.env.GPS_URL || "https://its.mobilidade.rio/v1/geolocalizacao/veiculos",
  limite: 500, // registros por página
  maxPaginas: 10, // trava de segurança contra paginação infinita
  timeoutMs: 8000, // prazo de cada chamada à SMTR
  fetch: (...args) => fetch(...args),
  agora: () => new Date(),
};

// A API trabalha com minutos UTC. Ex.: 2026-10-17T14:32:00Z
// Formato exigido pela API: minuto UTC arredondado ao início do minuto.
function minutoUtc(data) {
  const d = new Date(data);
  d.setUTCSeconds(0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  const texto = v.trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(texto)) return NaN;
  return Number(texto.replace(",", "."));
}

// Valida e normaliza um registro. Devolve null se estiver inválido.
function normalizar(o) {
  if (!o || typeof o !== "object") return null;
  const id = String(o.id_veiculo ?? "").trim();
  const servico = String(o.servico ?? "").trim();
  const lat = num(o.latitude);
  const lng = num(o.longitude);
  if (!id || !servico) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const hora = Date.parse(o.datetime ?? o.timestamp_gps ?? "");
  return {
    ordem: id,
    linha: servico,
    lat,
    lng,
    velocidade: num(o.velocidade) || 0,
    hora: Number.isFinite(hora) ? hora : 0,
  };
}

function extrairLista(bruto) {
  if (Array.isArray(bruto)) return bruto;
  if (!bruto || typeof bruto !== "object") throw new Error("Formato inesperado na resposta da API de GPS.");
  const lista = bruto.data ?? bruto.items ?? bruto.results;
  if (!Array.isArray(lista)) throw new Error("A resposta da API de GPS não contém uma lista de veículos.");
  return lista;
}

// Busca todas as páginas de um minuto, seguindo next_cursor.
async function buscarMinuto(linha, minuto, cfg) {
  const registros = [];
  let cursor = null;
  for (let pagina = 0; pagina < cfg.maxPaginas; pagina++) {
    const url = new URL(cfg.url);
    url.searchParams.set("servico", linha);
    url.searchParams.set("minuto_utc", minuto);
    url.searchParams.set("limit", String(cfg.limite));
    if (cursor) url.searchParams.set("cursor", cursor);

    const resp = await cfg.fetch(url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!resp.ok) throw new Error(`GPS respondeu ${resp.status}`);
    const bruto = await resp.json();
    registros.push(...extrairLista(bruto));

    cursor = bruto && !Array.isArray(bruto) ? bruto.next_cursor : null;
    if (!cursor) break;
    if (pagina === cfg.maxPaginas - 1) {
      throw new Error(`A paginação da API excedeu o limite de ${cfg.maxPaginas} páginas.`);
    }
  }
  return registros;
}

// Posição mais recente de cada ônibus da linha (minuto atual + anterior).
async function carregarOnibus(linha, deps = {}) {
  const cfg = { ...PADRAO, ...deps };
  const agora = cfg.agora();
  const minutos = [minutoUtc(agora), minutoUtc(new Date(agora.getTime() - 60_000))];

  const resultados = await Promise.allSettled(minutos.map((m) => buscarMinuto(linha, m, cfg)));
  const bons = resultados.filter((r) => r.status === "fulfilled");
  if (bons.length === 0) throw resultados[0].reason;

  const alvo = linha.toUpperCase();
  const maisRecente = new Map();
  for (const { value } of bons) {
    for (const bruto of value) {
      const o = normalizar(bruto);
      if (!o || o.linha.toUpperCase() !== alvo) continue;
      const atual = maisRecente.get(o.ordem);
      if (!atual || o.hora > atual.hora) maisRecente.set(o.ordem, o);
    }
  }
  return [...maisRecente.values()];
}

module.exports = { minutoUtc, normalizar, extrairLista, buscarMinuto, carregarOnibus, PADRAO };

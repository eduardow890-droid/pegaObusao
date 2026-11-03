"use strict";
const { lerJson } = require("./json-body");

function json(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(corpo));
}

function numero(valor) {
  if (typeof valor !== "number" && typeof valor !== "string") return NaN;
  if (typeof valor === "string" && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(valor.trim())) return NaN;
  return Number(valor);
}

async function lerCorpoJson(req, res, mensagem) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    json(res, 415, { erro: "O Content-Type deve ser application/json." });
    return null;
  }
  try {
    return await lerJson(req);
  } catch (erro) {
    const excedido = erro.code === "BODY_TOO_LARGE";
    json(res, excedido ? 413 : 400, { erro: excedido ? "O corpo da requisição excede o limite permitido." : mensagem });
    return null;
  }
}

async function atender({ req, res, url, buscarEndereco, buscarParadas, calcularRota, permitir, obterIp = (requisicao) => requisicao.socket.remoteAddress || "desconhecido", retryAfter, dentroDoRio, registrarErro, logger }) {
  if (!["/api/endereco", "/api/paradas", "/api/rota"].includes(url.pathname)) return false;
  const metodoEsperado = url.pathname === "/api/endereco" ? "GET" : "POST";
  if (req.method !== metodoEsperado) { json(res, 405, { erro: "Método não permitido." }); return true; }
  if (!permitir(obterIp(req))) {
    res.setHeader("Retry-After", String(retryAfter));
    json(res, 429, { erro: "Muitas consultas. Aguarde um momento e tente novamente." });
    return true;
  }
  try {
    if (url.pathname === "/api/endereco") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 3 || q.length > 120) { json(res, 400, { erro: "Informe um endereço válido." }); return true; }
      json(res, 200, await buscarEndereco(q));
      return true;
    }
    if (url.pathname === "/api/paradas") {
      const corpo = await lerCorpoJson(req, res, "Envie latitude e longitude em um corpo JSON válido.");
      if (!corpo) return true;
      const lat = numero(corpo.lat);
      const lng = numero(corpo.lng);
      const valorRaio = corpo.raio;
      const raio = valorRaio == null ? 800 : numero(valorRaio);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !dentroDoRio({ lat, lng }) || !(raio >= 100 && raio <= 2000)) {
        json(res, 400, { erro: "Informe latitude, longitude e um raio válido." });
        return true;
      }
      json(res, 200, await buscarParadas(lat, lng, raio));
      return true;
    }
    const corpo = await lerCorpoJson(req, res, "Envie origem e destino em um corpo JSON válido.");
    if (!corpo) return true;
    const origem = { lat: numero(corpo.origem?.lat), lng: numero(corpo.origem?.lng) };
    const destino = { lat: numero(corpo.destino?.lat), lng: numero(corpo.destino?.lng) };
    if ([origem, destino].some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !dentroDoRio(p))) {
      json(res, 400, { erro: "Informe origem e destino válidos." });
      return true;
    }
    json(res, 200, await calcularRota(origem, destino));
  } catch (erro) {
    registrarErro();
    const tipo = ["AbortError", "TimeoutError"].includes(erro?.name) ? erro.name : "Error";
    logger.error(`Falha na rota externa (${url.pathname}) [${tipo}]`);
    json(res, 502, { erro: "Serviço externo indisponível no momento." });
  }
  return true;
}

module.exports = { atender };

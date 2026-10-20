"use strict";

function json(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(corpo));
}

function numero(valor) {
  if (valor === null || String(valor).trim() === "") return NaN;
  return Number(valor);
}

async function atender({ req, res, url, buscarLinha, prever, calcularChegada, carregarOnibus, permitir, retryAfter, registrarErro, logger }) {
  if (!["/api/linha", "/api/previsao", "/api/chegada"].includes(url.pathname)) return false;
  if (req.method !== "GET") { json(res, 405, { erro: "Método não permitido." }); return true; }
  if (!permitir(req.socket.remoteAddress || "desconhecido")) {
    res.setHeader("Retry-After", String(retryAfter));
    json(res, 429, { erro: "Muitas consultas. Aguarde um momento e tente novamente." });
    return true;
  }
  const linha = (url.searchParams.get("linha") || "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(linha)) { json(res, 400, { erro: "Informe uma linha válida." }); return true; }
  try {
    const dados = buscarLinha(linha);
    if (!dados) { json(res, 404, { erro: `A linha ${linha} não foi encontrada no GTFS.` }); return true; }
    if (url.pathname === "/api/linha") { json(res, 200, dados); return true; }
    const variante = Number(url.searchParams.get("variante"));
    if (!Number.isInteger(variante) || variante < 0 || !dados.variantes[variante]) {
      json(res, 400, { erro: "Informe uma variante válida." });
      return true;
    }
    const { onibus } = await carregarOnibus(linha);
    if (url.pathname === "/api/chegada") {
      const lat = numero(url.searchParams.get("lat"));
      const lng = numero(url.searchParams.get("lng"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -23.2 || lat > -22.6 || lng < -43.9 || lng > -42.9) {
        json(res, 400, { erro: "Informe uma localização válida no Rio de Janeiro." });
        return true;
      }
      json(res, 200, calcularChegada(dados, variante, onibus, { lat, lng }));
      return true;
    }
    json(res, 200, { linha, variante, estimativa: "aproximada", paradas: prever(dados, variante, onibus) });
  } catch (erro) {
    registrarErro();
    logger.error(`Falha ao consultar GTFS (linha ${linha}):`, erro);
    json(res, 503, { erro: "Dados de linhas e paradas indisponíveis no momento." });
  }
  return true;
}

module.exports = { atender };


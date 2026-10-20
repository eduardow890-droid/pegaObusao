"use strict";

function json(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(corpo));
}

function numero(valor) {
  if (valor === null || String(valor).trim() === "") return NaN;
  return Number(valor);
}

async function atender({ req, res, url, buscarEndereco, buscarParadas, calcularRota, permitir, retryAfter, dentroDoRio, registrarErro, logger }) {
  if (!["/api/endereco", "/api/paradas", "/api/rota"].includes(url.pathname)) return false;
  if (req.method !== "GET") { json(res, 405, { erro: "Método não permitido." }); return true; }
  if (!permitir(req.socket.remoteAddress || "desconhecido")) {
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
      const lat = numero(url.searchParams.get("lat"));
      const lng = numero(url.searchParams.get("lng"));
      const valorRaio = url.searchParams.get("raio");
      const raio = valorRaio === null ? 800 : numero(valorRaio);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !dentroDoRio({ lat, lng }) || !(raio >= 100 && raio <= 2000)) {
        json(res, 400, { erro: "Informe latitude, longitude e um raio válido." });
        return true;
      }
      json(res, 200, await buscarParadas(lat, lng, raio));
      return true;
    }
    const origem = { lat: numero(url.searchParams.get("origemLat")), lng: numero(url.searchParams.get("origemLng")) };
    const destino = { lat: numero(url.searchParams.get("destinoLat")), lng: numero(url.searchParams.get("destinoLng")) };
    if ([origem, destino].some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !dentroDoRio(p))) {
      json(res, 400, { erro: "Informe origem e destino válidos." });
      return true;
    }
    json(res, 200, await calcularRota(origem, destino));
  } catch (erro) {
    registrarErro();
    logger.error(`Falha na rota externa (${url.pathname}):`, erro);
    json(res, 502, { erro: "Serviço externo indisponível no momento." });
  }
  return true;
}

module.exports = { atender };


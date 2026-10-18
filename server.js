// Backend mínimo: busca o GPS dos ônibus do Rio, guarda em cache e serve o mapa.
// Sem dependências. Requer Node 18+ (fetch nativo).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { carregarOnibus } = require("./lib");

const PORT = process.env.PORT || 3001;
const CACHE_MS = 15_000;
const CACHE_MAX = 100;

const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

function json(res, status, corpo) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(corpo));
}

function criarServidor({ buscarOnibus = carregarOnibus, cacheMs = CACHE_MS, cacheMax = CACHE_MAX, agora = Date.now, logger = console } = {}) {
  const cache = new Map(); // linha -> { em, onibus }
  const pendentes = new Map(); // evita chamadas duplicadas simultâneas pela mesma linha

  async function onibusDaLinha(linha) {
    const guardado = cache.get(linha);
    if (guardado && agora() - guardado.em < cacheMs) {
      cache.delete(linha);
      cache.set(linha, guardado); // LRU: a linha acessada recentemente vai para o fim
      return guardado;
    }
    if (guardado) cache.delete(linha);
    if (pendentes.has(linha)) return pendentes.get(linha);

    const consulta = Promise.resolve().then(() => buscarOnibus(linha)).then((onibus) => {
      const instante = agora();
      for (const [chave, valor] of cache) {
        if (instante - valor.em >= cacheMs) cache.delete(chave);
      }
      const novo = { em: instante, onibus };
      cache.set(linha, novo);
      while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
      return novo;
    }).finally(() => pendentes.delete(linha));
    pendentes.set(linha, consulta);
    return consulta;
  }

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      res.writeHead(400);
      return res.end("Requisição inválida");
    }

    if (url.pathname === "/api/onibus") {
      if (req.method !== "GET") return json(res, 405, { erro: "Método não permitido." });
      const linha = (url.searchParams.get("linha") || "").trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,12}$/.test(linha)) {
        return json(res, 400, { erro: "Informe uma linha válida, ex.: ?linha=485" });
      }
      try {
        const { em, onibus } = await onibusDaLinha(linha);
        return json(res, 200, { linha, total: onibus.length, atualizadoEm: new Date(em).toISOString(), onibus });
      } catch (e) {
        logger.error(`Falha ao ler o GPS (linha ${linha}):`, e); // detalhe só no log do servidor
        return json(res, 502, { erro: "Serviço de GPS indisponível no momento. Tente de novo em instantes." });
      }
    }

    // Arquivos estáticos da pasta /public
    let decodificado;
    try {
      decodificado = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end("Caminho inválido");
    }
    const pasta = path.resolve(__dirname, "public");
    const relativo = decodificado === "/" ? "index.html" : decodificado.replace(/^\/+/, "");
    const caminho = path.resolve(pasta, relativo);
    if (caminho !== pasta && !caminho.startsWith(pasta + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(caminho, (err, dados) => {
      if (err) {
        res.writeHead(404);
        return res.end("Não encontrado");
      }
      res.writeHead(200, { "Content-Type": tipos[path.extname(caminho)] || "application/octet-stream" });
      res.end(dados);
    });
  });
}

const servidor = criarServidor();

if (require.main === module) {
  servidor.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));
}

module.exports = servidor;
module.exports.criarServidor = criarServidor;

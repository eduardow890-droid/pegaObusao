// Backend mínimo: busca o GPS dos ônibus do Rio, guarda em cache e serve o mapa.
// Sem dependências. Requer Node 18+ (fetch nativo).

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { carregarOnibus } = require("./lib");
const { buscarEnderecos, buscarParadas, calcularRota } = require("./servicos");
const { buscarLinha, statusGtfs, previsao, chegada } = require("./gtfs");
const { atender: atenderGtfs } = require("./rotas/gtfs");
const { atender: atenderServicos } = require("./rotas/servicos");

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";
const CACHE_MS = 15_000;
const CACHE_MAX = 100;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);

// Caixa aproximada da região do Rio: evita usar o servidor como roteador para o mundo todo.
const dentroDoRio = (p) => p.lat >= -23.2 && p.lat <= -22.6 && p.lng >= -43.9 && p.lng <= -42.9;

// Number(null) e Number("") dão 0; aqui ausente ou vazio vira NaN e é rejeitado.
function numero(valor) {
  if (valor === null || String(valor).trim() === "") return NaN;
  return Number(valor);
}

const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };

function json(res, status, corpo) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(corpo));
}

function cabecalhosSeguros(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "geolocation=(self)");
}

function criarServidor({
  buscarOnibus = carregarOnibus,
  buscarEndereco = buscarEnderecos,
  buscarParadasProximas = buscarParadas,
  calcularRotaExterna = calcularRota,
  buscarLinhaGtfs = buscarLinha,
  calcularChegadaGtfs = chegada,
  cacheMs = CACHE_MS,
  cacheMax = CACHE_MAX,
  agora = Date.now,
  logger = console,
  rateLimitMax = RATE_LIMIT_MAX,
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
} = {}) {
  const cache = new Map(); // linha -> { em, onibus }
  const pendentes = new Map(); // evita chamadas duplicadas simultâneas pela mesma linha
  const limites = new Map(); // IP -> { inicio, quantidade }
  let requisicoes = 0;
  let erros = 0;

  function permitido(ip) {
    const instante = agora();
    if (limites.size > 5000) {
      for (const [chave, valor] of limites) {
        if (instante - valor.inicio >= rateLimitWindowMs) limites.delete(chave);
      }
    }
    const anterior = limites.get(ip);
    if (!anterior || instante - anterior.inicio >= rateLimitWindowMs) {
      limites.set(ip, { inicio: instante, quantidade: 1 });
      return true;
    }
    anterior.quantidade += 1;
    return anterior.quantidade <= rateLimitMax;
  }

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
    cabecalhosSeguros(res);
    requisicoes += 1;
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      res.writeHead(400);
      return res.end("Requisição inválida");
    }

    if (url.pathname === "/healthz") {
      const gtfs = statusGtfs();
      return json(res, gtfs.disponivel ? 200 : 503, { status: gtfs.disponivel ? "ok" : "degradado", requisicoes, erros, gtfs });
    }

    if (url.pathname === "/metrics") {
      return json(res, 200, { requisicoes, erros, cacheLinhas: cache.size, consultasPendentes: pendentes.size });
    }

    if (url.pathname === "/api/onibus") {
      if (req.method !== "GET") return json(res, 405, { erro: "Método não permitido." });
      const ip = req.socket.remoteAddress || "desconhecido";
      if (!permitido(ip)) {
        res.setHeader("Retry-After", String(Math.ceil(rateLimitWindowMs / 1000)));
        return json(res, 429, { erro: "Muitas consultas. Aguarde um momento e tente novamente." });
      }
      const linha = (url.searchParams.get("linha") || "").trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,12}$/.test(linha)) {
        return json(res, 400, { erro: "Informe uma linha válida, ex.: ?linha=485" });
      }
      try {
        const { em, onibus } = await onibusDaLinha(linha);
        return json(res, 200, { linha, total: onibus.length, atualizadoEm: new Date(em).toISOString(), onibus });
      } catch (e) {
        erros += 1;
        logger.error(`Falha ao ler o GPS (linha ${linha}):`, e); // detalhe só no log do servidor
        return json(res, 502, { erro: "Serviço de GPS indisponível no momento. Tente de novo em instantes." });
      }
    }

    if (await atenderGtfs({
      req, res, url,
      buscarLinha: buscarLinhaGtfs,
      prever: previsao,
      calcularChegada: calcularChegadaGtfs,
      carregarOnibus: onibusDaLinha,
      permitir: permitido,
      retryAfter: Math.ceil(rateLimitWindowMs / 1000),
      registrarErro: () => { erros += 1; },
      logger,
    })) return;

    if (await atenderServicos({
      req, res, url,
      buscarEndereco,
      buscarParadas: buscarParadasProximas,
      calcularRota: calcularRotaExterna,
      permitir: permitido,
      retryAfter: Math.ceil(rateLimitWindowMs / 1000),
      dentroDoRio,
      registrarErro: () => { erros += 1; },
      logger,
    })) return;

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
      res.writeHead(200, {
        "Content-Type": tipos[path.extname(caminho)] || "application/octet-stream",
        "Cache-Control": caminho.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
      });
      res.end(dados);
    });
  });
}

const servidor = criarServidor();

if (require.main === module) {
  servidor.listen(PORT, HOST, () => {
    console.log(`Rodando localmente em http://localhost:${PORT}`);
    const enderecos = Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === "IPv4" && !item.internal).map((item) => item.address);
    enderecos.forEach((endereco) => console.log(`Para testar no celular: http://${endereco}:${PORT}`));
  });
}

module.exports = servidor;
module.exports.criarServidor = criarServidor;

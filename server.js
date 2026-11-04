// Backend mínimo: busca o GPS dos ônibus do Rio, guarda em cache e serve o mapa.
// Sem dependências. Requer Node 18+ (fetch nativo).

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { carregarOnibus, metricasDescartesGPS } = require("./lib");
const { buscarEnderecos, buscarParadas, calcularRota, validarContatoNominatim } = require("./servicos");
const { buscarLinha, statusGtfs, previsao, chegada, buscarParadasLocais, projetarOnibusNaRota, metricasAssociacaoSentido } = require("./gtfs");
const { atender: atenderGtfs } = require("./rotas/gtfs");
const { atender: atenderServicos } = require("./rotas/servicos");

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";
const CACHE_MS = 15_000;
const CACHE_MAX = 100;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const CONFIAR_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
const METRICS_TOKEN = process.env.METRICS_TOKEN || "";
const MAP_TILES_URL = process.env.MAP_TILES_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

// Caixa aproximada da região do Rio: evita usar o servidor como roteador para o mundo todo.
const dentroDoRio = (p) => p.lat >= -23.2 && p.lat <= -22.6 && p.lng >= -43.9 && p.lng <= -42.9;

// Number(null) e Number("") dão 0; aqui ausente ou vazio vira NaN e é rejeitado.
function numero(valor) {
  if (valor === null || String(valor).trim() === "") return NaN;
  return Number(valor);
}

const tipos = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function buscarParadasDaFonte(lat, lng, raio) {
  try { return buscarParadasLocais(lat, lng, raio); }
  catch { return buscarParadas(lat, lng, raio); }
}

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

function ipCliente(req) {
  if (CONFIAR_PROXY) {
    const encaminhado = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (encaminhado) return encaminhado;
  }
  return req.socket.remoteAddress || "desconhecido";
}

function criarServidor({
  buscarOnibus = carregarOnibus,
  buscarEndereco = buscarEnderecos,
  buscarParadasProximas = buscarParadasDaFonte,
  calcularRotaExterna = calcularRota,
  buscarLinhaGtfs = buscarLinha,
  calcularChegadaGtfs = chegada,
  cacheMs = CACHE_MS,
  cacheMax = CACHE_MAX,
  agora = Date.now,
  logger = console,
  rateLimitMax = RATE_LIMIT_MAX,
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
  metricsToken = METRICS_TOKEN,
  mapTilesUrl = MAP_TILES_URL,
} = {}) {
  const cache = new Map(); // linha -> { em, onibus }
  const ultimasRespostasGps = new Map(); // linha -> último conjunto obtido com sucesso
  const pendentes = new Map(); // evita chamadas duplicadas simultâneas pela mesma linha
  const limites = new Map(); // IP -> { inicio, quantidade }
  const metricasVazias = {
    recebidos: 0,
    descartadosPorDistancia: 0,
    comSentidoPorRumo: 0,
    comSentidoPorMovimento: 0,
    indeterminados: 0,
  };
  let requisicoes = 0;
  let erros = 0;
  let gpsUltimaConsulta = null;
  let gpsUltimoSucesso = null;
  let gpsUltimoErro = null;
  let associacaoSentidoUltimaConsulta = { ...metricasVazias };

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

    const consulta = Promise.resolve().then(() => buscarOnibus(linha)).then((onibusBrutos) => {
      const instante = agora();
      const dadosLinha = statusGtfs().disponivel ? buscarLinhaGtfs(linha) : null;
      let onibus = onibusBrutos;
      let metricasConsulta = { ...metricasVazias };
      if (dadosLinha?.variantes?.some((variante) => variante.rota?.coordinates?.length >= 2)) {
        const antes = metricasAssociacaoSentido();
        onibus = projetarOnibusNaRota(dadosLinha, onibusBrutos);
        const depois = metricasAssociacaoSentido();
        metricasConsulta = Object.fromEntries(
          Object.keys(metricasVazias).map((chave) => [chave, depois[chave] - antes[chave]]),
        );
      }
      associacaoSentidoUltimaConsulta = metricasConsulta;
      for (const [chave, valor] of cache) {
        if (instante - valor.em >= cacheMs) cache.delete(chave);
      }
      const novo = { em: instante, onibus, metricasAssociacaoSentido: metricasConsulta };
      const sucesso = { em: instante, obtidoEm: new Date(instante).toISOString(), onibus };
      ultimasRespostasGps.set(linha, sucesso);
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
      return json(res, 200, {
        status: gtfs.disponivel && !gpsUltimoErro ? "ok" : "degradado",
        gtfsDisponivel: gtfs.disponivel,
      });
    }

    if (url.pathname === "/metrics") {
      if (!metricsToken || req.headers.authorization !== `Bearer ${metricsToken}`) {
        return json(res, 401, { erro: "Não autorizado." });
      }
      return json(res, 200, {
        requisicoes,
        erros,
        cacheLinhas: cache.size,
        consultasPendentes: pendentes.size,
        gps: {
          ultimaConsulta: gpsUltimaConsulta,
          ultimoSucesso: gpsUltimoSucesso,
          ultimoErro: gpsUltimoErro,
          descartes: metricasDescartesGPS(),
          associacaoSentido: {
            acumulados: metricasAssociacaoSentido(),
            ultimaConsulta: { ...associacaoSentidoUltimaConsulta },
          },
        },
      });
    }

    if (url.pathname === "/api/onibus") {
      if (req.method !== "GET") return json(res, 405, { erro: "Método não permitido." });
      const ip = ipCliente(req);
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
        gpsUltimaConsulta = new Date(agora()).toISOString();
        gpsUltimoErro = null;
        const resposta = ultimasRespostasGps.get(linha);
        const obtidoEm = resposta?.obtidoEm || new Date(em).toISOString();
        gpsUltimoSucesso = obtidoEm;
        return json(res, 200, {
          linha,
          total: onibus.length,
          atualizadoEm: new Date(em).toISOString(),
          obtidoEm,
          ultimaConsultaEm: gpsUltimaConsulta,
          desatualizado: false,
          onibus,
        });
      } catch (e) {
        erros += 1;
        gpsUltimaConsulta = new Date(agora()).toISOString();
        gpsUltimoErro = e?.message || "erro desconhecido";
        logger.error(`Falha ao ler o GPS (linha ${linha}):`, e); // detalhe só no log do servidor
        const anterior = ultimasRespostasGps.get(linha);
        if (anterior) {
          const idadeSegundos = Math.max(0, Math.floor((agora() - anterior.em) / 1000));
          return json(res, 200, {
            linha,
            total: anterior.onibus.length,
            atualizadoEm: anterior.obtidoEm,
            obtidoEm: anterior.obtidoEm,
            ultimaConsultaEm: gpsUltimaConsulta,
            desatualizado: true,
            idadeSegundos,
            onibus: anterior.onibus,
          });
        }
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
      obterIp: ipCliente,
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
      obterIp: ipCliente,
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
      let conteudo = dados;
      if (caminho.endsWith("index.html")) {
        const urlSegura = mapTilesUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        conteudo = Buffer.from(dados.toString("utf8").replace("__MAP_TILES_URL__", urlSegura));
      }
      res.writeHead(200, {
        "Content-Type": tipos[path.extname(caminho)] || "application/octet-stream",
        "Cache-Control": caminho.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
      });
      res.end(conteudo);
    });
  });
}

const servidor = criarServidor();

if (require.main === module) {
  validarContatoNominatim({
    production: process.env.NODE_ENV === "production",
    contato: process.env.CONTATO_APP,
    avisar: console.warn,
  });
  servidor.listen(PORT, HOST, () => {
    console.log(`Rodando localmente em http://localhost:${PORT}`);
    const enderecos = Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === "IPv4" && !item.internal).map((item) => item.address);
    enderecos.forEach((endereco) => console.log(`Para testar no celular: http://${endereco}:${PORT}`));
  });
}

module.exports = servidor;
module.exports.criarServidor = criarServidor;

const test = require("node:test");
const assert = require("node:assert/strict");
const { criarServidor } = require("../server");

async function comServidor(opcoes, executar) {
  const servidor = criarServidor(opcoes);
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    await executar(base, servidor);
  } finally {
    await new Promise((resolve, reject) => servidor.close((erro) => erro ? reject(erro) : resolve()));
  }
}

test("endpoint retorna o contrato esperado para o front-end", async () => {
  const onibus = [{ ordem: "A1", linha: "485", lat: -22.9, lng: -43.2, velocidade: 10, hora: 1 }];
  await comServidor({
    buscarOnibus: async () => onibus,
    buscarLinhaGtfs: () => ({
      linha: "485",
      variantes: [{ sentido: "0", tripIds: [], rota: { coordinates: [[-43.21, -22.9], [-43.19, -22.9]] }, paradas: [] }],
    }),
  }, async (base) => {
    const resposta = await fetch(`${base}/api/onibus?linha=485`);
    const dados = await resposta.json();
    assert.equal(resposta.status, 200);
    assert.equal(dados.linha, "485");
    assert.equal(dados.total, 1);
    assert.ok(Number.isFinite(Date.parse(dados.atualizadoEm)));
    assert.equal(dados.onibus[0].ordem, "A1");
    assert.equal(dados.onibus[0].sentido, "indeterminado");
    assert.equal(dados.onibus[0].confiancaSentido, "nenhuma");
    assert.equal("desvioMetros" in dados.onibus[0], false);
  });
});

test("endpoint de ônibus devolve posição projetada e metadados da rota", async () => {
  const shape = [[-43.3, -22.9], [-43.1, -22.9]];
  await comServidor({
    buscarOnibus: async () => [{
      ordem: "ON-ROTA",
      linha: "485",
      lat: -22.90018,
      lng: -43.25,
      velocidade: 20,
      directionId: "0",
      hora: Date.now(),
    }],
    buscarLinhaGtfs: () => ({
      linha: "485",
      variantes: [{ sentido: "0", tripIds: [], rota: { coordinates: shape }, paradas: [] }],
    }),
  }, async (base) => {
    const resposta = await fetch(`${base}/api/onibus?linha=485`);
    const dados = await resposta.json();
    assert.equal(resposta.status, 200);
    assert.equal(dados.onibus.length, 1);
    assert.deepEqual(dados.onibus[0].posicaoNaRota, [-43.25, -22.9]);
    assert.equal(dados.onibus[0].foraDaRota, false);
    assert.equal(dados.onibus[0].varianteIndice, 0);
    assert.equal(dados.onibus[0].sentido, "0");
    assert.equal(dados.onibus[0].confiancaSentido, "rumo");
    assert.ok(Number.isFinite(dados.onibus[0].progressoMetros));
    assert.ok(dados.onibus[0].desvioMetros >= 19 && dados.onibus[0].desvioMetros <= 21);
  });
});

test("valida linha e método HTTP sem consultar a API", async () => {
  let chamadas = 0;
  await comServidor({ buscarOnibus: async () => (chamadas++, []) }, async (base) => {
    const invalida = await fetch(`${base}/api/onibus?linha=%20`);
    const metodo = await fetch(`${base}/api/onibus?linha=485`, { method: "POST" });
    assert.equal(invalida.status, 400);
    assert.equal(metodo.status, 405);
    assert.equal(chamadas, 0);
  });
});

test("requisições simultâneas para a mesma linha compartilham uma consulta", async () => {
  let chamadas = 0;
  let liberar;
  const consultaPendente = new Promise((resolve) => { liberar = resolve; });
  await comServidor({ buscarOnibus: async () => { chamadas++; return consultaPendente; } }, async (base, servidor) => {
    const duasRequisicoes = new Promise((resolve) => {
      let total = 0;
      servidor.on("request", () => { if (++total === 2) resolve(); });
    });
    const primeira = fetch(`${base}/api/onibus?linha=485`);
    const segunda = fetch(`${base}/api/onibus?linha=485`);
    await duasRequisicoes;
    assert.equal(chamadas, 1);
    liberar([]);
    const respostas = await Promise.all([primeira, segunda]);
    assert.deepEqual(respostas.map((r) => r.status), [200, 200]);
  });
});

test("cache respeita o limite configurado e a expiração", async () => {
  let chamadas = 0;
  await comServidor({ buscarOnibus: async () => (chamadas++, []), cacheMax: 1, cacheMs: 60_000 }, async (base) => {
    await fetch(`${base}/api/onibus?linha=485`);
    await fetch(`${base}/api/onibus?linha=232`);
    await fetch(`${base}/api/onibus?linha=485`);
    assert.equal(chamadas, 3);
  });
});

test("cache expira após o prazo configurado", async () => {
  let chamadas = 0;
  let instante = 1_000;
  await comServidor({ buscarOnibus: async () => (chamadas++, []), cacheMs: 100, agora: () => instante }, async (base) => {
    await fetch(`${base}/api/onibus?linha=485`);
    instante += 101;
    await fetch(`${base}/api/onibus?linha=485`);
    assert.equal(chamadas, 2);
  });
});

test("erro da API retorna mensagem segura e status 502", async () => {
  await comServidor({ buscarOnibus: async () => { throw new Error("erro interno confidencial"); }, logger: { error() {} } }, async (base) => {
    const resposta = await fetch(`${base}/api/onibus?linha=485`);
    const dados = await resposta.json();
    assert.equal(resposta.status, 502);
    assert.match(dados.erro, /indisponível/);
    assert.equal(JSON.stringify(dados).includes("confidencial"), false);
  });
});

test("healthcheck e métricas retornam estado operacional", async () => {
  await comServidor({ metricsToken: "test-secret" }, async (base) => {
    const health = await fetch(`${base}/healthz`);
    const dadosHealth = await health.json();
    assert.equal(health.status, 200);
    assert.equal(dadosHealth.status, "ok");
    assert.equal("gps" in dadosHealth, false);

    const semToken = await fetch(`${base}/metrics`);
    assert.equal(semToken.status, 401);
    const metrics = await fetch(`${base}/metrics`, { headers: { Authorization: "Bearer test-secret" } });
    const dadosMetrics = await metrics.json();
    assert.equal(metrics.status, 200);
    assert.ok(dadosMetrics.requisicoes >= 2);
    assert.equal(typeof dadosMetrics.cacheLinhas, "number");
    assert.equal(typeof dadosMetrics.gps.descartes, "object");
    assert.deepEqual(Object.keys(dadosMetrics.gps.associacaoSentido), [
      "recebidos",
      "descartadosPorDistancia",
      "comSentidoPorRumo",
      "comSentidoPorMovimento",
      "indeterminados",
    ]);
  });
});

test("métricas ficam indisponíveis sem token configurado", async () => {
  await comServidor({ metricsToken: "" }, async (base) => {
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
  });
});

test("falha da API devolve a última resposta válida marcada como desatualizada", async () => {
  let chamadas = 0;
  let instante = 1_000_000;
  await comServidor({
    buscarOnibus: async () => {
      chamadas += 1;
      if (chamadas > 1) throw new Error("SMTR indisponível");
      return [{ ordem: "A1", lat: -22.9, lng: -43.2 }];
    },
    cacheMs: 0,
    agora: () => instante,
    logger: { error() {} },
  }, async (base) => {
    const primeira = await fetch(`${base}/api/onibus?linha=485`);
    const atual = await primeira.json();
    assert.equal(primeira.status, 200);
    assert.equal(atual.desatualizado, false);
    assert.ok(atual.obtidoEm);
    instante += 125_000;
    const segunda = await fetch(`${base}/api/onibus?linha=485`);
    const antiga = await segunda.json();
    assert.equal(segunda.status, 200);
    assert.equal(antiga.desatualizado, true);
    assert.equal(antiga.idadeSegundos, 125);
    assert.equal(antiga.ultimaConsultaEm, new Date(instante).toISOString());
    assert.deepEqual(antiga.onibus, atual.onibus);
  });
});

test("aplica rate limiting por endereço", async () => {
  await comServidor({ buscarOnibus: async () => [], rateLimitMax: 1, rateLimitWindowMs: 60_000 }, async (base) => {
    const primeira = await fetch(`${base}/api/onibus?linha=485`);
    const segunda = await fetch(`${base}/api/onibus?linha=232`);
    assert.equal(primeira.status, 200);
    assert.equal(segunda.status, 429);
    assert.ok(segunda.headers.get("retry-after"));
  });
});

test("serve a página inicial e bloqueia caminho fora de public", async () => {
  await comServidor({}, async (base) => {
    const pagina = await fetch(`${base}/`);
    assert.equal(pagina.status, 200);
    const html = await pagina.text();
    assert.match(html, /PegaObusão/);
    assert.match(html, /tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
    assert.match(html, /apple-touch-icon\.png/);
    assert.match(html, /logo-titulo-600\.png/);
    assert.match(html, /og:description/);
    assert.doesNotMatch(html, /__MAP_TILES_URL__/);
    const icone = await fetch(`${base}/icon.svg`);
    assert.equal(icone.status, 200);
    assert.match(icone.headers.get("content-type"), /image\/svg\+xml/);
    const iconePwa = await fetch(`${base}/icons/icon-192.png`);
    assert.equal(iconePwa.status, 200);
    assert.match(iconePwa.headers.get("content-type"), /image\/png/);
    const fonte = await fetch(`${base}/fonts/rubik-latin.woff2`);
    assert.equal(fonte.status, 200);
    assert.match(fonte.headers.get("content-type"), /font\/woff2/);
    const manifest = await (await fetch(`${base}/manifest.json`)).json();
    assert.equal(manifest.theme_color, "#14202E");
    assert.ok(manifest.icons.some((item) => item.src === "/icons/icon-maskable-512.png" && item.purpose === "maskable"));

    const fora = await fetch(`${base}/%2e%2e%2fserver.js`);
    assert.equal(fora.status, 403);
  });
});

test("URL de tiles configurada é entregue ao mapa como atributo HTML escapado", async () => {
  await comServidor({ mapTilesUrl: "https://tiles.example/{z}/{x}/{y}.png?token=a&layer=b" }, async (base) => {
    const html = await (await fetch(base)).text();
    assert.match(html, /tiles\.example\/\{z\}\/\{x\}\/\{y\}\.png\?token=a&amp;layer=b/);
  });
});

test("endpoints de endereço, paradas e rota validam e encaminham dados", async () => {
  await comServidor({
    buscarEndereco: async (q) => [{ nome: q, lat: -22.9, lng: -43.2 }],
    buscarParadasProximas: async (lat, lng, raio) => [{ nome: "Parada teste", lat, lng, raio }],
    calcularRotaExterna: async (origem, destino) => ({ distanciaMetros: 1000, duracaoSegundos: 600, geometria: { type: "LineString", coordinates: [[origem.lng, origem.lat], [destino.lng, destino.lat]] } }),
  }, async (base) => {
    const endereco = await fetch(`${base}/api/endereco?q=Central`);
    assert.deepEqual(await endereco.json(), [{ nome: "Central", lat: -22.9, lng: -43.2 }]);

    const paradas = await fetch(`${base}/api/paradas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: -22.9, lng: -43.2 }),
    });
    assert.equal((await paradas.json())[0].nome, "Parada teste");

    const rota = await fetch(`${base}/api/rota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origem: { lat: -22.9, lng: -43.2 }, destino: { lat: -22.8, lng: -43.1 } }),
    });
    assert.equal((await rota.json()).distanciaMetros, 1000);

    const invalida = await fetch(`${base}/api/paradas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: 999, lng: -43.2 }),
    });
    assert.equal(invalida.status, 400);
  });
});

test("endpoints POST rejeitam tipo de conteúdo, JSON inválido, corpo grande e tipos numéricos inválidos", async () => {
  let chamadas = 0;
  await comServidor({ buscarParadasProximas: async () => (chamadas++, []) }, async (base) => {
    const semContentType = await fetch(`${base}/api/paradas`, {
      method: "POST",
      body: JSON.stringify({ lat: -22.9, lng: -43.2 }),
    });
    assert.equal(semContentType.status, 415);

    const jsonInvalido = await fetch(`${base}/api/paradas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(jsonInvalido.status, 400);

    const corpoGrande = await fetch(`${base}/api/paradas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: -22.9, lng: -43.2, extra: "x".repeat(5000) }),
    });
    assert.equal(corpoGrande.status, 413);

    const tipoInvalido = await fetch(`${base}/api/paradas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: false, lng: -43.2 }),
    });
    assert.equal(tipoInvalido.status, 400);
    assert.equal(chamadas, 0);
  });
});

test("falhas do serviço de rota não registram coordenadas nos logs", async () => {
  const logs = [];
  await comServidor({
    calcularRotaExterna: async () => { throw new Error("falha em https://router.example/-43.2,-22.9"); },
    logger: { error: (...valores) => logs.push(valores.join(" ")) },
  }, async (base) => {
    const resposta = await fetch(`${base}/api/rota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origem: { lat: -22.9, lng: -43.2 }, destino: { lat: -22.8, lng: -43.1 } }),
    });
    assert.equal(resposta.status, 502);
    assert.equal(logs.join(" ").includes("-43.2"), false);
    assert.equal(logs.join(" ").includes("-22.9"), false);
    assert.match(logs.join(" "), /Falha na rota externa/);
  });
});

test("endpoint de linha retorna dados GTFS e trata linha inexistente", async () => {
  const buscarLinhaGtfs = (linha) => linha === "485"
    ? { linha, variantes: [{ destino: "Destino teste", paradas: [{ id: "P1" }], rota: { type: "LineString", coordinates: [] } }] }
    : null;
  await comServidor({ buscarLinhaGtfs, rateLimitMax: 100 }, async (base) => {
    const ok = await fetch(`${base}/api/linha?linha=485`);
    const dados = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(dados.variantes[0].destino, "Destino teste");

    const ausente = await fetch(`${base}/api/linha?linha=999`);
    assert.equal(ausente.status, 404);
  });
});

test("falha ao carregar GTFS é explicitada pela API e a interface oferece retry", async () => {
  const mensagens = [];
  await comServidor({
    buscarLinhaGtfs: () => { throw new Error("arquivos GTFS ausentes"); },
    logger: { error: (...args) => mensagens.push(args.join(" ")) },
  }, async (base) => {
    const resposta = await fetch(`${base}/api/linha?linha=485`);
    assert.equal(resposta.status, 503);
    assert.match((await resposta.json()).erro, /GTFS/);
    const html = await (await fetch(base)).text();
    assert.match(html, /id="gtfs-status"[^>]+role="status"/);
    assert.match(html, /id="tentar-gtfs"/);
    assert.ok(mensagens.some((mensagem) => mensagem.includes("Falha ao consultar GTFS")));
  });
});

test("endpoint de previsão usa linha, variante e ônibus injetados", async () => {
  await comServidor({
    buscarLinhaGtfs: () => ({ linha: "485", variantes: [{ destino: "Teste" }] }),
    buscarOnibus: async () => [{ ordem: "A1", hora: Date.now(), lat: -22.9, lng: -43.2, velocidade: 20 }],
    rateLimitMax: 100,
  }, async (base) => {
    const previsaoLocal = await fetch(`${base}/api/previsao?linha=485&variante=0`);
    assert.equal(previsaoLocal.status, 200);
    assert.equal((await previsaoLocal.json()).estimativa, "aproximada");
  });
});

test("endpoint de chegada valida localização e encaminha cálculo", async () => {
  await comServidor({
    buscarLinhaGtfs: () => ({ linha: "485", variantes: [{ destino: "Teste" }] }),
    buscarOnibus: async () => [],
    calcularChegadaGtfs: (linha, variante, onibus, localizacao) => ({ disponivel: true, linha: linha.linha, variante, total: onibus.length, localizacao }),
    rateLimitMax: 100,
  }, async (base) => {
    const ok = await fetch(`${base}/api/chegada?linha=485&variante=0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: -22.9, lng: -43.2 }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).localizacao, { lat: -22.9, lng: -43.2 });
    const invalida = await fetch(`${base}/api/chegada?linha=485&variante=0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: 0, lng: 0 }),
    });
    assert.equal(invalida.status, 400);
    const metodoAntigo = await fetch(`${base}/api/chegada?linha=485&variante=0&lat=-22.9&lng=-43.2`);
    assert.equal(metodoAntigo.status, 405);
  });
});

test("coordenadas POST não aparecem nos logs do servidor mesmo em falha de ETA", async () => {
  const logs = [];
  await comServidor({
    buscarLinhaGtfs: () => ({ linha: "485", variantes: [{}] }),
    buscarOnibus: async () => [],
    calcularChegadaGtfs: () => { throw new Error("falha de cálculo"); },
    logger: { error: (...args) => logs.push(args.join(" ")) },
    rateLimitMax: 100,
  }, async (base) => {
    const resposta = await fetch(`${base}/api/chegada?linha=485&variante=0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: -22.912, lng: -43.212 }),
    });
    assert.equal(resposta.status, 503);
    assert.equal(logs.join(" ").includes("-22.912"), false);
    assert.equal(logs.join(" ").includes("-43.212"), false);
  });
});

test("rejeita coordenadas ausentes, vazias, fora do Rio e raio inválido", async () => {
  let chamadas = 0;
  const contar = async () => (chamadas++, []);
  await comServidor({ buscarParadasProximas: contar, calcularRotaExterna: contar, rateLimitMax: 100 }, async (base) => {
    const corposInvalidos = [
      {},
      { lat: "", lng: -43.2 },
      { lat: 40.7, lng: -74 },
      { lat: -22.9, lng: -43.2, raio: "abc" },
      { lat: -22.9, lng: -43.2, raio: 50 },
      { lat: -22.9, lng: -43.2, raio: 5000 },
    ];
    for (const corpo of corposInvalidos) {
      const r = await fetch(`${base}/api/paradas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      assert.equal(r.status, 400, JSON.stringify(corpo));
    }
    const rotaInvalida = await fetch(`${base}/api/rota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origem: { lat: -22.9, lng: -43.2 }, destino: { lat: 0, lng: 0 } }),
    });
    assert.equal(rotaInvalida.status, 400);
    assert.equal(chamadas, 0);
    const ok = await fetch(`${base}/api/paradas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: -22.9, lng: -43.2 }),
    });
    assert.equal(ok.status, 200);
  });
});

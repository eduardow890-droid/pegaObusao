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
  await comServidor({ buscarOnibus: async () => onibus }, async (base) => {
    const resposta = await fetch(`${base}/api/onibus?linha=485`);
    const dados = await resposta.json();
    assert.equal(resposta.status, 200);
    assert.equal(dados.linha, "485");
    assert.equal(dados.total, 1);
    assert.ok(Number.isFinite(Date.parse(dados.atualizadoEm)));
    assert.deepEqual(dados.onibus, onibus);
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
  await comServidor({}, async (base) => {
    const health = await fetch(`${base}/healthz`);
    const dadosHealth = await health.json();
    assert.equal(health.status, 200);
    assert.equal(dadosHealth.status, "ok");

    const metrics = await fetch(`${base}/metrics`);
    const dadosMetrics = await metrics.json();
    assert.equal(metrics.status, 200);
    assert.ok(dadosMetrics.requisicoes >= 2);
    assert.equal(typeof dadosMetrics.cacheLinhas, "number");
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
    assert.match(await pagina.text(), /PegaObusão/);
    const icone = await fetch(`${base}/icon.svg`);
    assert.equal(icone.status, 200);
    assert.match(icone.headers.get("content-type"), /image\/svg\+xml/);

    const fora = await fetch(`${base}/%2e%2e%2fserver.js`);
    assert.equal(fora.status, 403);
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

    const paradas = await fetch(`${base}/api/paradas?lat=-22.9&lng=-43.2`);
    assert.equal((await paradas.json())[0].nome, "Parada teste");

    const rota = await fetch(`${base}/api/rota?origemLat=-22.9&origemLng=-43.2&destinoLat=-22.8&destinoLng=-43.1`);
    assert.equal((await rota.json()).distanciaMetros, 1000);

    const invalida = await fetch(`${base}/api/paradas?lat=999&lng=-43.2`);
    assert.equal(invalida.status, 400);
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
    const ok = await fetch(`${base}/api/chegada?linha=485&variante=0&lat=-22.9&lng=-43.2`);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).localizacao, { lat: -22.9, lng: -43.2 });
    const invalida = await fetch(`${base}/api/chegada?linha=485&variante=0&lat=0&lng=0`);
    assert.equal(invalida.status, 400);
  });
});

test("rejeita parâmetros ausentes, vazios, fora do Rio e raio inválido", async () => {
  let chamadas = 0;
  const contar = async () => (chamadas++, []);
  await comServidor({ buscarParadasProximas: contar, calcularRotaExterna: contar, rateLimitMax: 100 }, async (base) => {
    const urls = [
      "/api/paradas",                                  // sem lat/lng (antes virava 0,0)
      "/api/paradas?lat=&lng=",                         // vazios
      "/api/paradas?lat=0&lng=0",                       // fora do Rio
      "/api/paradas?lat=40.7&lng=-74",                  // outra cidade
      "/api/paradas?lat=-22.9&lng=-43.2&raio=abc",      // raio inválido (antes passava como NaN)
      "/api/paradas?lat=-22.9&lng=-43.2&raio=50",
      "/api/paradas?lat=-22.9&lng=-43.2&raio=5000",
      "/api/rota",
      "/api/rota?origemLat=-22.9&origemLng=-43.2&destinoLat=0&destinoLng=0",
    ];
    for (const u of urls) {
      const r = await fetch(`${base}${u}`);
      assert.equal(r.status, 400, u);
    }
    assert.equal(chamadas, 0);
    const ok = await fetch(`${base}/api/paradas?lat=-22.9&lng=-43.2`);
    assert.equal(ok.status, 200);
  });
});

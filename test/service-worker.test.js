const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function iniciarServiceWorker({ rede, cacheInicial = new Map() }) {
  const listeners = {};
  const cache = new Map(cacheInicial);
  const gravados = [];
  const cacheApi = {
    async addAll(arquivos) { arquivos.forEach((arquivo) => cache.set(arquivo, `asset:${arquivo}`)); },
    async put(chave, valor) { gravados.push(chave.url || chave); cache.set(chave.url || chave, valor); },
  };
  const contexto = {
    self: { addEventListener: (nome, callback) => { listeners[nome] = callback; } },
    location: { origin: "https://app.example" },
    URL,
    caches: {
      open: async () => cacheApi,
      match: async (solicitacao) => cache.get(solicitacao.url || solicitacao),
      keys: async () => [...cache.keys()],
      delete: async (chave) => cache.delete(chave),
    },
    fetch: rede,
    Promise,
    Set,
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../public/sw.js"), "utf8"), contexto);
  return { listeners, cache, gravados };
}

function pedido(url, method = "GET") {
  return { request: { url: `https://app.example${url}`, method }, respondWith(promessa) { this.resposta = promessa; } };
}

test("service worker instala shell local com scripts, estilos, ícone e manifest", async () => {
  const { listeners, cache } = iniciarServiceWorker({ rede: async () => { throw new Error("offline"); } });
  let aguardado;
  listeners.install({ waitUntil: (promessa) => { aguardado = promessa; } });
  await aguardado;
  for (const arquivo of [
    "/", "/app.js", "/app.js?v=pixel-brt-5", "/favoritos.js", "/map-match.js", "/map-match.js?v=pixel-brt-5",
    "/styles.css", "/styles.css?v=pixel-brt-4", "/favicon-32.png", "/manifest.json",
    "/favicon.ico", "/favicon-16.png", "/favicon-32.png", "/apple-touch-icon.png",
    "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-192.png", "/icons/icon-maskable-512.png",
    "/logo-titulo-600.png", "/og-image.png",
  ]) {
    assert.ok(cache.has(arquivo), `cacheia ${arquivo}`);
  }
  assert.equal(cache.has("/icon.svg"), false);
});

test("imagens instaladas também são respondidas pelo cache offline", async () => {
  const image = { cached: true };
  const { listeners } = iniciarServiceWorker({
    cacheInicial: new Map([["https://app.example/icons/icon-192.png", image]]),
    rede: async () => { throw new Error("não deve consultar a rede"); },
  });
  const requisicao = pedido("/icons/icon-192.png");
  listeners.fetch(requisicao);
  assert.equal(await requisicao.resposta, image);
});

test("assets usam cache-first e o GPS não é armazenado como dado atual", async () => {
  let chamadas = 0;
  const { listeners, gravados } = iniciarServiceWorker({
    cacheInicial: new Map([["https://app.example/app.js", "asset cached"]]),
    rede: async () => { chamadas += 1; return { ok: true, clone: () => ({}) }; },
  });
  const asset = pedido("/app.js");
  listeners.fetch(asset);
  assert.equal(await asset.resposta, "asset cached");
  assert.equal(chamadas, 0);

  const gps = pedido("/api/onibus?linha=485");
  listeners.fetch(gps);
  await gps.resposta;
  assert.equal(chamadas, 1);
  assert.deepEqual(gravados, []);
});

test("API é network-first e só dados GTFS estáticos podem ter fallback offline", async () => {
  const stored = { clone: () => ({ cached: true }) };
  let chamadas = 0;
  const { listeners, cache, gravados } = iniciarServiceWorker({
    cacheInicial: new Map([["https://app.example/api/linha?linha=485", stored]]),
    rede: async () => { chamadas += 1; throw new Error("offline"); },
  });
  const linha = pedido("/api/linha?linha=485");
  listeners.fetch(linha);
  assert.equal(await linha.resposta, stored);
  assert.equal(chamadas, 1);
  assert.deepEqual(gravados, []);

  const gps = pedido("/api/chegada?linha=485");
  listeners.fetch(gps);
  await assert.rejects(gps.resposta, /offline/);
  assert.equal(cache.has("https://app.example/api/chegada?linha=485"), false);
});

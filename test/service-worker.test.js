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
  for (const arquivo of ["/", "/app.js", "/favoritos.js", "/map-match.js", "/styles.css", "/icon.svg", "/manifest.json"]) {
    assert.ok(cache.has(arquivo), `cacheia ${arquivo}`);
  }
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

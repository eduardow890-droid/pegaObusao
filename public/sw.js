const CACHE = "pegaobusao-shell-v4";
const ARQUIVOS = ["/", "/app.js", "/favoritos.js", "/map-match.js", "/styles.css", "/styles.css?v=pixel-brt-1", "/icon.svg", "/manifest.json", "/fonts/bungee-latin.woff2", "/fonts/rubik-latin.woff2"];
const API_OFFLINE = new Set(["/api/linha"]);

self.addEventListener("install", (evento) => {
  evento.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS)));
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(caches.keys().then((chaves) => Promise.all(
    chaves.filter((chave) => chave.startsWith("pegaobusao-") && chave !== CACHE).map((chave) => caches.delete(chave)),
  )));
});

self.addEventListener("fetch", (evento) => {
  if (evento.request.method !== "GET") return;
  const url = new URL(evento.request.url);
  const mesmaOrigem = url.origin === location.origin;
  const assetExterno = url.hostname === "unpkg.com" && /\.(?:js|css)$/.test(url.pathname);
  if (!mesmaOrigem && !assetExterno) return;
  if (url.pathname.startsWith("/api/")) {
    if (!mesmaOrigem) return;
    evento.respondWith((async () => {
      try {
        const resposta = await fetch(evento.request);
        if (resposta.ok && API_OFFLINE.has(url.pathname)) {
          const cache = await caches.open(CACHE);
          await cache.put(evento.request, resposta.clone());
        }
        return resposta;
      } catch (erro) {
        if (API_OFFLINE.has(url.pathname)) {
          const guardada = await caches.match(evento.request);
          if (guardada) return guardada;
        }
        throw erro;
      }
    })());
    return;
  }
  if (/\.(?:js|css|svg|json)$/.test(url.pathname) || url.pathname === "/") {
    evento.respondWith((async () => {
      const guardada = await caches.match(evento.request);
      if (guardada) return guardada;
      const resposta = await fetch(evento.request);
      if (resposta.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(evento.request, resposta.clone());
      }
      return resposta;
    })());
  }
});

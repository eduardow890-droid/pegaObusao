const CACHE = "pegaobusao-shell-v10";
const ARQUIVOS = [
  "/", "/app.js", "/app.js?v=pixel-brt-6", "/favoritos.js", "/map-match.js", "/map-match.js?v=pixel-brt-5",
  "/styles.css", "/styles.css?v=pixel-brt-6",
  "/favicon.ico", "/favicon-16.png", "/favicon-32.png", "/apple-touch-icon.png",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-192.png", "/icons/icon-maskable-512.png",
  "/logo-titulo-600.png", "/og-image.png", "/manifest.json",
  "/fonts/bungee-latin.woff2", "/fonts/rubik-latin.woff2",
];
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
  if (/\.(?:js|css|svg|json|png|ico)$/.test(url.pathname) || url.pathname === "/") {
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

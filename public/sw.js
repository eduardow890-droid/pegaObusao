const CACHE = "pegaobusao-shell-v1";
const ARQUIVOS = ["/", "/manifest.json"];

self.addEventListener("install", (evento) => {
  evento.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS)));
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(caches.keys().then((chaves) => Promise.all(chaves.filter((chave) => chave !== CACHE).map((chave) => caches.delete(chave)))));
});

self.addEventListener("fetch", (evento) => {
  if (evento.request.method !== "GET" || new URL(evento.request.url).origin !== location.origin) return;
  evento.respondWith(fetch(evento.request).catch(() => caches.match(evento.request)));
});


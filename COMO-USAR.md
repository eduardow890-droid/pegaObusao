# Assets do PegaObusão

Copie a pasta `public/` para a `public/` do projeto.

## public/index.html (dentro do <head>)
```html
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#14202E">
<meta property="og:type" content="website">
<meta property="og:title" content="PegaObusão · ônibus do Rio ao vivo">
<meta property="og:description" content="Linhas, paradas e previsão de chegada dos ônibus do Rio.">
<meta property="og:image" content="https://SEU-DOMINIO/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://SEU-DOMINIO/og-image.png">
```
Troque SEU-DOMINIO pelo endereço real (a og:image precisa de URL absoluta).

## public/manifest.json (campos de ícone)
```json
"theme_color": "#14202E",
"background_color": "#14202E",
"icons": [
  { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
  { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
  { "src": "/icons/icon-maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
  { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

## public/sw.js
Inclua no cache: /icon.svg, /icons/icon-192.png, /icons/icon-512.png, /logo-titulo-600.png (e versione o cache).

## Logo no cabeçalho
`<img src="/logo-titulo-600.png" alt="PegaObusão" width="600" height="115">` (fundo transparente; use com altura de 28 a 40 px no app).

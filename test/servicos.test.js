const test = require("node:test");
const assert = require("node:assert/strict");

function respostaJson(corpo) {
  return { ok: true, status: 200, json: async () => corpo };
}

test("endereços: manda User-Agent, restringe ao Rio e usa cache", async () => {
  const original = global.fetch;
  const chamadas = [];
  global.fetch = async (url, opcoes) => {
    chamadas.push({ url: new URL(url), opcoes });
    return respostaJson([{ display_name: "Central do Brasil", lat: "-22,9", lon: "-43.19" }]);
  };
  try {
    const { buscarEnderecos } = require("../servicos");
    const a = await buscarEnderecos("Central do Brasil");
    const b = await buscarEnderecos("central do brasil"); // mesma busca: vem do cache
    assert.equal(chamadas.length, 1);
    assert.deepEqual(a, b);
    assert.match(chamadas[0].opcoes.headers["User-Agent"], /^PegaObusao\//);
    assert.equal(chamadas[0].url.searchParams.get("bounded"), "1");
    assert.ok(chamadas[0].url.searchParams.get("viewbox"));
  } finally {
    global.fetch = original;
  }
});

test("paradas: pedidos próximos reaproveitam o cache", async () => {
  const original = global.fetch;
  let chamadas = 0;
  global.fetch = async () => (chamadas++, respostaJson({ elements: [{ type: "node", id: 1, lat: -22.9, lon: -43.2, tags: { name: "Parada X" } }] }));
  try {
    const { buscarParadas } = require("../servicos");
    await buscarParadas(-22.90012, -43.20011, 800);
    const segunda = await buscarParadas(-22.90049, -43.20049, 800);
    assert.equal(chamadas, 1);
    assert.equal(segunda[0].nome, "Parada X");
  } finally {
    global.fetch = original;
  }
});

test("rota: informa que o perfil é de carro", async () => {
  const original = global.fetch;
  global.fetch = async () => respostaJson({ routes: [{ distance: 1000.4, duration: 600.2, geometry: { type: "LineString", coordinates: [] } }] });
  try {
    const { calcularRota } = require("../servicos");
    const rota = await calcularRota({ lat: -22.9, lng: -43.2 }, { lat: -22.8, lng: -43.1 });
    assert.equal(rota.perfil, "carro");
    assert.equal(rota.distanciaMetros, 1000);
  } finally {
    global.fetch = original;
  }
});

test("URLs de serviços podem ser configuradas e o contato Nominatim é obrigatório em produção", async () => {
  const anteriores = {
    NOMINATIM_URL: process.env.NOMINATIM_URL,
    OVERPASS_URL: process.env.OVERPASS_URL,
    OSRM_URL: process.env.OSRM_URL,
    CONTATO_APP: process.env.CONTATO_APP,
  };
  const originalFetch = global.fetch;
  const urls = [];
  process.env.NOMINATIM_URL = "https://geo.example/search";
  process.env.OVERPASS_URL = "https://osm.example/interpreter";
  process.env.OSRM_URL = "https://route.example/route/v1/driving";
  process.env.CONTATO_APP = "contato@exemplo.org";
  global.fetch = async (url, opcoes) => {
    urls.push({ url: new URL(url), opcoes });
    if (new URL(url).hostname === "geo.example") return respostaJson([{ display_name: "Rua teste", lat: "-22.9", lon: "-43.2" }]);
    if (new URL(url).hostname === "osm.example") return respostaJson({ elements: [] });
    return respostaJson({ routes: [{ distance: 100, duration: 10, geometry: { type: "LineString", coordinates: [] } }] });
  };
  try {
    const { buscarEnderecos, buscarParadas, calcularRota, validarContatoNominatim } = require("../servicos");
    await buscarEnderecos("Rua configurada para teste");
    await buscarParadas(-22.81, -43.11, 777);
    await calcularRota({ lat: -22.9, lng: -43.2 }, { lat: -22.8, lng: -43.1 });
    assert.deepEqual(urls.map(({ url }) => url.hostname), ["geo.example", "osm.example", "route.example"]);
    assert.match(urls[0].opcoes.headers["User-Agent"], /contato@exemplo\.org/);
    assert.throws(() => validarContatoNominatim({ production: true, contato: "" }), /CONTATO_APP/);
    let aviso = "";
    assert.equal(validarContatoNominatim({ production: false, contato: "", avisar: (mensagem) => { aviso = mensagem; } }), false);
    assert.match(aviso, /CONTATO_APP/);
  } finally {
    global.fetch = originalFetch;
    for (const [nome, valor] of Object.entries(anteriores)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  }
});

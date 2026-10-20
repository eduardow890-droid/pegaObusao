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

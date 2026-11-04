const test = require("node:test");
const assert = require("node:assert/strict");
const { filtrarOnibusSentido, projetarOnibusNaRota, varianteDoOnibus } = require("../gtfs");
const { metricasDescartesGPS } = require("../lib");

function linhaTeste(id) {
  const ida = [[-43.3, -22.9], [-43.1, -22.9]];
  const volta = [...ida].reverse();
  return {
    linha: id,
    variantes: [
      { sentido: "0", tripIds: [], rota: { coordinates: ida } },
      { sentido: "1", tripIds: [], rota: { coordinates: volta } },
    ],
  };
}

function onibus(id, lng, lat, extras = {}) {
  return { ordem: id, lat, lng, directionId: "0", rumo: null, ...extras };
}

test("projeta ônibus a 20 metros para a rota", () => {
  const linha = linhaTeste("PROJ-20M");
  const real = onibus("V20", -43.25, -22.90018);
  const [projetado] = projetarOnibusNaRota(linha, [real]);
  assert.ok(projetado);
  assert.equal(projetado.foraDaRota, false);
  assert.ok(projetado.desvioMetros >= 19 && projetado.desvioMetros <= 21);
  assert.deepEqual(projetado.posicaoNaRota, [-43.25, -22.9]);
  assert.equal(projetado.lat, projetado.posicaoNaRota[1]);
});

test("mantém posição real a 200 metros e marca como fora da rota", () => {
  const linha = linhaTeste("PROJ-200M");
  const real = onibus("V200", -43.25, -22.9018);
  const [projetado] = projetarOnibusNaRota(linha, [real]);
  assert.ok(projetado);
  assert.equal(projetado.foraDaRota, true);
  assert.ok(projetado.desvioMetros >= 190 && projetado.desvioMetros <= 210);
  assert.deepEqual([projetado.lng, projetado.lat], [real.lng, real.lat]);
  assert.deepEqual(projetado.posicaoNaRota, [-43.25, -22.9]);
});

test("descarta posição a 2 km e incrementa métrica de fora da rota", () => {
  const linha = linhaTeste("PROJ-2KM");
  const antes = metricasDescartesGPS().fora_da_rota || 0;
  const resultado = projetarOnibusNaRota(linha, [onibus("V2KM", -43.25, -22.918, {
    directionId: "",
    tripId: "",
  })]);
  assert.deepEqual(resultado, []);
  assert.equal(metricasDescartesGPS().fora_da_rota, antes + 1);
});

test("usa direction_id e rumo para nunca associar veículo ao sentido oposto", () => {
  const linha = linhaTeste("PROJ-SENTIDO");
  linha.variantes[0].tripIds = ["trip-ida"];
  assert.equal(varianteDoOnibus(linha, onibus("V-ID", -43.25, -22.9, { directionId: "1" })), 1);
  assert.equal(varianteDoOnibus(linha, onibus("V-RUMO", -43.25, -22.9, { directionId: "", rumo: 270 })), 1);
  assert.equal(varianteDoOnibus(linha, onibus("V-SEM-RUMO", -43.25, -22.9, { directionId: "", rumo: null })), -1);
  assert.equal(varianteDoOnibus(linha, onibus("V-CONFLITO", -43.25, -22.9, {
    tripId: "trip-ida",
    directionId: "1",
  })), -1);
});

test("rumo ausente ou inválido não é convertido para zero", () => {
  const linha = linhaTeste("PROJ-RUMO-DESCONHECIDO");
  for (const rumo of [null, undefined, "", " ", NaN, "NaN"]) {
    assert.equal(varianteDoOnibus(linha, onibus("V-SEM-RUMO", -43.25, -22.9, {
      directionId: "",
      tripId: "",
      rumo,
    })), -1);
  }
});

test("primeira leitura sem rumo fica indeterminada e movimento crescente define o sentido", () => {
  const linha = linhaTeste("PROJ-MOVIMENTO-IDA");
  const primeira = onibus("V-MOV-IDA", -43.25, -22.9, { directionId: "", hora: 1000 });
  const seguinte = onibus("V-MOV-IDA", -43.249, -22.9, { directionId: "", hora: 20_000 });
  const [semSentido] = projetarOnibusNaRota(linha, [primeira]);
  const [comSentido] = projetarOnibusNaRota(linha, [seguinte]);
  assert.equal(semSentido.sentido, "indeterminado");
  assert.equal(semSentido.confiancaSentido, "nenhuma");
  assert.equal("posicaoNaRota" in semSentido, false);
  assert.equal(comSentido.sentido, "0");
  assert.equal(comSentido.confiancaSentido, "movimento");
  assert.equal(comSentido.varianteIndice, 0);
});

test("progresso decrescente na primeira variante define o sentido oposto", () => {
  const linha = linhaTeste("PROJ-MOVIMENTO-VOLTA");
  const primeira = onibus("V-MOV-VOLTA", -43.25, -22.9, { directionId: "", hora: 1000 });
  const seguinte = onibus("V-MOV-VOLTA", -43.251, -22.9, { directionId: "", hora: 20_000 });
  assert.equal(projetarOnibusNaRota(linha, [primeira])[0].sentido, "indeterminado");
  const [comSentido] = projetarOnibusNaRota(linha, [seguinte]);
  assert.equal(comSentido.sentido, "1");
  assert.equal(comSentido.confiancaSentido, "movimento");
});

test("ônibus parado permanece indeterminado", () => {
  const linha = linhaTeste("PROJ-MOVIMENTO-PARADO");
  const primeira = onibus("V-PARADO", -43.25, -22.9, { directionId: "", hora: 1000 });
  const seguinte = onibus("V-PARADO", -43.25, -22.9, { directionId: "", hora: 20_000 });
  assert.equal(projetarOnibusNaRota(linha, [primeira])[0].sentido, "indeterminado");
  const [parado] = projetarOnibusNaRota(linha, [seguinte]);
  assert.equal(parado.sentido, "indeterminado");
  assert.equal(parado.confiancaSentido, "nenhuma");
  assert.equal("desvioMetros" in parado, false);
});

test("previsão filtra sentido oposto e veículos indeterminados", () => {
  const dados = [
    { sentido: "0", varianteIndice: 0, confiancaSentido: "movimento" },
    { sentido: "1", varianteIndice: 1, confiancaSentido: "rumo" },
    { sentido: "indeterminado", confiancaSentido: "nenhuma" },
  ];
  assert.deepEqual(filtrarOnibusSentido(linhaTeste("PROJ-FILTRO"), 0, dados), [dados[0]]);
  assert.deepEqual(filtrarOnibusSentido(linhaTeste("PROJ-FILTRO"), 1, dados), [dados[1]]);
});

test("não permite que o progresso por veículo recue mais de 30 metros", () => {
  const linha = linhaTeste("PROJ-RECUO");
  const [primeiro] = projetarOnibusNaRota(linha, [onibus("VRECUO", -43.29, -22.9)]);
  const [segundo] = projetarOnibusNaRota(linha, [onibus("VRECUO", -43.2906, -22.9)]);
  assert.ok(primeiro.progressoMetros > 900);
  assert.equal(segundo.progressoMetros, primeiro.progressoMetros);
  assert.equal(segundo.progressoAnteriorMetros, primeiro.progressoMetros);
});

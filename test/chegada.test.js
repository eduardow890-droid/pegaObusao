const test = require("node:test");
const assert = require("node:assert/strict");
const { projetarPonto, rumoGraus, diferencaAngulo, estimarChegada } = require("../chegada");

const rota = { type: "LineString", coordinates: [[-43.2, -22.9], [-43.19, -22.9], [-43.18, -22.9]] };
const parada = { id: "P1", nome: "Parada teste", lat: -22.9, lng: -43.18 };
const agora = 1_000_000;

test("projeta ponto e calcula posição ao longo do trajeto", () => {
  const ponto = projetarPonto(rota.coordinates, { lat: -22.9, lng: -43.19 });
  assert.ok(ponto);
  assert.ok(ponto.aoLongo > 1000);
  assert.equal(Math.round(ponto.rumoTrecho), 90);
});

test("calcula rumo e diferença angular sem confundir 359° com 1°", () => {
  assert.equal(Math.round(rumoGraus([-43.2, -22.9], [-43.19, -22.9])), 90);
  assert.equal(diferencaAngulo(359, 1), 2);
});

test("estima apenas ônibus antes da parada e ignora o que já passou", () => {
  const dados = estimarChegada({
    rota, paradas: [parada], agora, localizacao: { lat: -22.9, lng: -43.2 },
    onibus: [
      { ordem: "antes", lat: -22.9, lng: -43.19, velocidade: 20, hora: agora },
      { ordem: "passou", lat: -22.9, lng: -43.17, velocidade: 20, hora: agora },
    ],
  });
  assert.equal(dados.disponivel, true);
  assert.deepEqual(dados.onibus.map((item) => item.ordem), ["antes"]);
});

test("descarta sentido contrário, sinal velho e velocidade inválida", () => {
  const dados = estimarChegada({
    rota, paradas: [parada], agora, localizacao: { lat: -22.9, lng: -43.2 },
    onibus: [
      { ordem: "contrario", lat: -22.9, lng: -43.19, velocidade: 20, progressoAnterior: 2000, hora: agora },
      { ordem: "velho", lat: -22.9, lng: -43.19, velocidade: 20, hora: agora - 181_000 },
      { ordem: "parado", lat: -22.9, lng: -43.19, velocidade: 0, hora: agora },
    ],
  });
  assert.equal(dados.disponivel, true);
  assert.equal(dados.onibus[0].ordem, "parado");
  assert.ok(dados.estimativa.minimo >= 1);
});

test("sem ônibus retorna motivo honesto", () => {
  const dados = estimarChegada({ rota, paradas: [parada], onibus: [], agora, localizacao: { lat: -22.2, lng: -43.2 } });
  assert.equal(dados.disponivel, false);
  assert.match(dados.motivo, /Não há ônibus/);
});

test("mantém apenas o ônibus-alvo quando ele continua disponível", () => {
  const dados = estimarChegada({
    rota, paradas: [parada], agora, localizacao: { lat: -22.9, lng: -43.2 }, alvoOrdem: "segundo",
    onibus: [
      { ordem: "primeiro", lat: -22.9, lng: -43.195, velocidade: 20, hora: agora },
      { ordem: "segundo", lat: -22.9, lng: -43.19, velocidade: 20, hora: agora },
    ],
  });
  assert.equal(dados.disponivel, true);
  assert.equal(dados.onibus[0].ordem, "segundo");
});

test("rejeita ônibus cujo rumo foi considerado incompatível", () => {
  const dados = estimarChegada({
    rota, paradas: [parada], agora, localizacao: { lat: -22.9, lng: -43.2 },
    onibus: [{ ordem: "contrario", lat: -22.9, lng: -43.19, velocidade: 20, hora: agora, rumoCompativel: false }],
  });
  assert.equal(dados.disponivel, false);
});

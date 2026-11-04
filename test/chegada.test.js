const test = require("node:test");
const assert = require("node:assert/strict");
const { projetarPonto, rumoGraus, diferencaAngulo, estimarChegada, compararChegadaCaminhando } = require("../chegada");

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

test("sinal velho e sentido contrário são descartados; ônibus parado não recebe ETA inventado", () => {
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
  assert.equal(dados.confiavel, false);
  assert.equal(dados.estimativa, undefined);
  assert.match(dados.motivo, /parado/);
});

test("usuário chega antes do ônibus e recebe orientação para sair agora", () => {
  const comparacao = compararChegadaCaminhando(1.2 * 60 * 4, { minimo: 6, maximo: 8 });
  assert.equal(comparacao.minutosCaminhando, 4);
  assert.equal(comparacao.status, "antes");
  assert.match(comparacao.mensagem, /saia agora/);
});

test("usuário chega depois do ônibus e não compara sem dados válidos", () => {
  const comparacao = compararChegadaCaminhando(1.2 * 60 * 9, { minimo: 6, maximo: 8 });
  assert.equal(comparacao.status, "depois");
  assert.equal(compararChegadaCaminhando(null, { minimo: 6, maximo: 8 }), null);
});

test("não calcula tempo de caminhada quando a parada está muito distante", () => {
  const comparacao = compararChegadaCaminhando(2500, { minimo: 6, maximo: 8 });
  assert.equal(comparacao.status, "distante");
  assert.equal(comparacao.minutosCaminhando, null);
  assert.match(comparacao.mensagem, /2,5 km em linha reta/);
  assert.match(comparacao.mensagem, /não exibida/);
});

test("velocidade desconhecida também não gera previsão numérica", () => {
  const dados = estimarChegada({
    rota, paradas: [parada], agora, localizacao: { lat: -22.9, lng: -43.2 },
    onibus: [{ ordem: "sem-velocidade", lat: -22.9, lng: -43.19, velocidade: null, hora: agora }],
  });
  assert.equal(dados.disponivel, true);
  assert.equal(dados.confiavel, false);
  assert.equal(dados.estimativa, undefined);
});

test("sem ônibus retorna motivo honesto", () => {
  const primeira = { id: "P0", nome: "Terminal inicial", lat: -22.9, lng: -43.2 };
  const dados = estimarChegada({
    rota, paradas: [primeira, parada], onibus: [], agora,
    localizacao: { lat: parada.lat, lng: parada.lng },
  });
  assert.equal(dados.disponivel, false);
  assert.equal(dados.paradaInicial, false);
  assert.equal(dados.parada.id, parada.id);
  assert.match(dados.motivo, /Não há ônibus/);
});

test("parada inicial informa que os ônibus saem dali", () => {
  const primeira = { id: "P0", nome: "Terminal inicial", lat: -22.9, lng: -43.2 };
  const dados = estimarChegada({
    rota, paradas: [primeira, parada], onibus: [], agora,
    localizacao: { lat: primeira.lat, lng: primeira.lng },
  });
  assert.equal(dados.disponivel, false);
  assert.equal(dados.paradaInicial, true);
  assert.match(dados.motivo, /parada inicial: os ônibus saem daqui/);
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

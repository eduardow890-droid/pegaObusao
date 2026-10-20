const test = require("node:test");
const assert = require("node:assert/strict");
const { buscarLinha, statusGtfs, previsao } = require("../gtfs");

test("GTFS importado contém uma linha real com sentidos, paradas e rota", () => {
  const status = statusGtfs();
  assert.equal(status.disponivel, true);
  const linha = buscarLinha("485");
  assert.ok(linha);
  assert.ok(linha.variantes.length > 0);
  assert.ok(linha.variantes.some((v) => v.paradas.length > 0));
  assert.ok(linha.variantes.some((v) => v.rota?.coordinates?.length > 1));
});

test("previsão GTFS retorna paradas mesmo sem ônibus disponível", () => {
  const linha = buscarLinha("485");
  const resultado = previsao(linha, 0, []);
  assert.ok(Array.isArray(resultado));
  assert.ok(resultado.length > 0);
  assert.equal(resultado[0].previsaoMinutos, null);
});


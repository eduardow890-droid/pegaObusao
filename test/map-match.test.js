const test = require("node:test");
const assert = require("node:assert/strict");
const { ajustarAoTrajeto, projetarPonto } = require("../public/map-match");

const rota = [[-43.2, -22.9], [-43.19, -22.9]];

test("projeta ônibus ligeiramente deslocado para cima do shape", () => {
  const ponto = { lng: -43.195, lat: -22.899 };
  const ajustado = ajustarAoTrajeto(ponto, [rota]);
  const projetado = projetarPonto(rota, ponto);

  assert.ok(ajustado);
  assert.equal(ajustado.lat, -22.9);
  assert.ok(Math.abs(ajustado.lng - -43.195) < 1e-9);
  assert.ok(ajustado.distanciaAjusteMetros > 100);
  assert.ok(projetado.distanciaMetros > 100);
});

test("mantém posição original fora do limite para evitar snap em rua distante", () => {
  assert.equal(ajustarAoTrajeto({ lng: -43.195, lat: -22.89 }, [rota]), null);
});

test("escolhe a variante mais próxima entre sentidos da linha", () => {
  const outraRota = [[-43.2, -22.91], [-43.19, -22.91]];
  const ajustado = ajustarAoTrajeto({ lng: -43.195, lat: -22.909 }, [rota, outraRota]);

  assert.ok(ajustado);
  assert.equal(ajustado.indiceVariante, 1);
  assert.ok(Math.abs(ajustado.lat - -22.91) < 1e-9);
});

test("não tenta ajustar quando não há shapes utilizáveis", () => {
  assert.equal(ajustarAoTrajeto({ lng: -43.2, lat: -22.9 }, [[], null]), null);
});

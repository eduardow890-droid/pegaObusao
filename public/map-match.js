(function disponibilizar(root, fabrica) {
  const api = fabrica();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PegaObusaoMapa = api;
}(globalThis, function criarApiMapa() {
  function distanciaMetros(a, b) {
    const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const dx = (a[0] - b[0]) * Math.cos(latitude) * 111320;
    const dy = (a[1] - b[1]) * 110540;
    return Math.hypot(dx, dy);
  }

  function rumoGraus(a, b) {
    const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const dx = (b[0] - a[0]) * Math.cos(latitude);
    const dy = b[1] - a[1];
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }

  function diferencaAngulo(a, b) {
    return Math.abs(((a - b + 540) % 360) - 180);
  }

  function projetarPonto(coordenadas, ponto) {
    if (!Array.isArray(coordenadas) || coordenadas.length < 2) return null;
    let acumulada = 0;
    let melhor = null;
    for (let i = 1; i < coordenadas.length; i += 1) {
      const a = coordenadas[i - 1];
      const b = coordenadas[i];
      const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
      const escalaX = Math.cos(latitude) * 111320;
      const escalaY = 110540;
      const ax = a[0] * escalaX;
      const ay = a[1] * escalaY;
      const bx = b[0] * escalaX;
      const by = b[1] * escalaY;
      const px = ponto.lng * escalaX;
      const py = ponto.lat * escalaY;
      const dx = bx - ax;
      const dy = by - ay;
      const tamanho = dx * dx + dy * dy || 1;
      const fator = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / tamanho));
      const coordenada = [a[0] + (b[0] - a[0]) * fator, a[1] + (b[1] - a[1]) * fator];
      const distancia = Math.hypot(px - (ax + dx * fator), py - (ay + dy * fator));
      const trecho = distanciaMetros(a, b);
      const aoLongo = acumulada + trecho * fator;
      if (!melhor || distancia < melhor.distanciaMetros) {
        melhor = { aoLongo, distanciaMetros: distancia, coordenada, rumoTrecho: rumoGraus(a, b) };
      }
      acumulada += trecho;
    }
    return { ...melhor, comprimentoMetros: acumulada };
  }

  function ajustarAoTrajeto(ponto, rotas, distanciaMaximaMetros = 300) {
    let melhor = null;
    for (const [indice, coordenadas] of rotas.entries()) {
      const posicao = projetarPonto(coordenadas, ponto);
      if (posicao && (!melhor || posicao.distanciaMetros < melhor.distanciaMetros)) {
        melhor = { ...posicao, indiceVariante: indice };
      }
    }
    if (!melhor || melhor.distanciaMetros > distanciaMaximaMetros) return null;
    return {
      lat: melhor.coordenada[1],
      lng: melhor.coordenada[0],
      distanciaAjusteMetros: Math.round(melhor.distanciaMetros),
      indiceVariante: melhor.indiceVariante,
    };
  }

  return { distanciaMetros, rumoGraus, diferencaAngulo, projetarPonto, ajustarAoTrajeto };
}));

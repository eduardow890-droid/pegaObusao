"use strict";

// Funções puras para estimativas ao longo do trajeto GTFS.
// A posição anterior é opcional: quando não existe, não afirmamos que o veículo
// está avançando no sentido escolhido.

function distanciaMetros(a, b) {
  const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const dx = (a[0] - b[0]) * Math.cos(latitude) * 111320;
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
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
    const projetado = [a[0] + (b[0] - a[0]) * fator, a[1] + (b[1] - a[1]) * fator];
    const distancia = Math.hypot(px - (ax + dx * fator), py - (ay + dy * fator));
    const trecho = distanciaMetros(a, b);
    const aoLongo = acumulada + trecho * fator;
    if (!melhor || distancia < melhor.distanciaMetros) {
      melhor = { aoLongo, distanciaMetros: distancia, coordenada: projetado };
    }
    acumulada += trecho;
  }
  return { ...melhor, comprimentoMetros: acumulada };
}

function velocidadeValida(kmh) {
  const valor = Number(kmh);
  return Number.isFinite(valor) && valor >= 1 && valor <= 120 ? valor : null;
}

function estimarChegada({ rota, paradas, onibus, localizacao, agora = Date.now(), maxSinalMs = 180_000 }) {
  const coordenadas = rota?.coordinates || [];
  if (coordenadas.length < 2 || !Array.isArray(paradas) || !localizacao) {
    return { disponivel: false, motivo: "Dados oficiais de trajeto ou localização insuficientes." };
  }
  const paradaMaisProxima = paradas.map((parada) => ({ parada, posicao: projetarPonto(coordenadas, parada) }))
    .filter((item) => item.posicao)
    .sort((a, b) => a.posicao.distanciaMetros - b.posicao.distanciaMetros)[0];
  if (!paradaMaisProxima) return { disponivel: false, motivo: "Nenhuma parada foi encontrada nesse sentido." };

  const posicaoUsuario = projetarPonto(coordenadas, localizacao);
  const candidatos = (onibus || []).map((bus) => {
    const hora = Number(bus.hora);
    const sinalMs = Number.isFinite(hora) ? Math.max(0, agora - hora) : Infinity;
    const posicao = projetarPonto(coordenadas, bus);
    const velocidade = velocidadeValida(bus.velocidade);
    const anterior = Number.isFinite(bus.progressoAnterior) ? bus.progressoAnterior : null;
    const avancando = anterior === null || posicao?.aoLongo >= anterior - 150;
    return { bus, hora, sinalMs, posicao, velocidade, avancando };
  }).filter((item) => item.posicao && item.sinalMs < maxSinalMs && item.avancando)
    .filter((item) => paradaMaisProxima.posicao.aoLongo - item.posicao.aoLongo > 50)
    .sort((a, b) => (paradaMaisProxima.posicao.aoLongo - a.posicao.aoLongo) - (paradaMaisProxima.posicao.aoLongo - b.posicao.aoLongo));

  if (!candidatos.length) {
    return {
      disponivel: false,
      motivo: "Não há ônibus com sinal recente antes da parada escolhida.",
      parada: paradaMaisProxima.parada,
      distanciaUsuarioMetros: posicaoUsuario ? Math.round(Math.abs(paradaMaisProxima.posicao.aoLongo - posicaoUsuario.aoLongo)) : null,
    };
  }

  const velocidades = candidatos.map((item) => item.velocidade).filter(Boolean);
  const media = velocidades.length ? velocidades.reduce((total, valor) => total + valor, 0) / velocidades.length : 20;
  const kmh = Math.max(8, Math.min(40, media));
  const faixa = (item) => {
    const distancia = paradaMaisProxima.posicao.aoLongo - item.posicao.aoLongo;
    const minutos = distancia / (kmh * 1000 / 3600) / 60;
    return { minimo: Math.max(1, Math.floor(minutos + 1)), maximo: Math.max(2, Math.ceil(minutos * 1.45 + 1)) };
  };
  const escolhidos = candidatos.slice(0, 2).map((item) => ({
    ordem: item.bus.ordem,
    distanciaMetros: Math.round(paradaMaisProxima.posicao.aoLongo - item.posicao.aoLongo),
    velocidadeKmh: Math.round(item.velocidade || kmh),
    sinalSegundos: Math.round(item.sinalMs / 1000),
    faixa: faixa(item),
  }));
  const estimativa = escolhidos[0].faixa;
  return {
    disponivel: true,
    estimativa,
    parada: paradaMaisProxima.parada,
    onibus: escolhidos,
    distanciaUsuarioMetros: posicaoUsuario ? Math.round(Math.abs(paradaMaisProxima.posicao.aoLongo - posicaoUsuario.aoLongo)) : null,
    aviso: "Estimativa aproximada com base no trajeto oficial e no GPS recente.",
  };
}

module.exports = { distanciaMetros, projetarPonto, estimarChegada };

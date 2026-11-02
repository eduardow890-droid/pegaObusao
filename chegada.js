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
    const projetado = [a[0] + (b[0] - a[0]) * fator, a[1] + (b[1] - a[1]) * fator];
    const distancia = Math.hypot(px - (ax + dx * fator), py - (ay + dy * fator));
    const trecho = distanciaMetros(a, b);
    const aoLongo = acumulada + trecho * fator;
    if (!melhor || distancia < melhor.distanciaMetros) {
      melhor = { aoLongo, distanciaMetros: distancia, coordenada: projetado, rumoTrecho: rumoGraus(a, b) };
    }
    acumulada += trecho;
  }
  return { ...melhor, comprimentoMetros: acumulada };
}

function velocidadeValida(kmh) {
  const valor = Number(kmh);
  return Number.isFinite(valor) && valor >= 1 && valor <= 120 ? valor : null;
}

function compararChegadaCaminhando(distanciaUsuarioMetros, estimativaOnibus) {
  if (!Number.isFinite(distanciaUsuarioMetros) || !estimativaOnibus
    || !Number.isFinite(estimativaOnibus.minimo) || !Number.isFinite(estimativaOnibus.maximo)) return null;
  const minutosCaminhando = Math.ceil(Math.max(0, distanciaUsuarioMetros) / 1.2 / 60);
  const antes = minutosCaminhando <= estimativaOnibus.minimo;
  const depois = minutosCaminhando > estimativaOnibus.maximo;
  return {
    minutosCaminhando,
    status: antes ? "antes" : depois ? "depois" : "incerto",
    mensagem: antes
      ? `O ônibus chega em ${estimativaOnibus.minimo} min, você leva ${minutosCaminhando} min a pé: saia agora.`
      : depois
        ? `Você leva ${minutosCaminhando} min a pé e pode chegar depois do ônibus.`
        : `Você leva ${minutosCaminhando} min a pé; a chegada do ônibus está em uma faixa incerta.`,
  };
}

function estimarChegada({ rota, paradas, onibus, localizacao, agora = Date.now(), maxSinalMs = 180_000, alvoOrdem = null }) {
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
    const velocidadeParada = (bus.velocidade != null && Number(bus.velocidade) === 0)
      || (bus.velocidadeEma != null && Number(bus.velocidadeEma) === 0);
    const velocidade = velocidadeParada ? 0 : velocidadeValida(bus.velocidadeEma) ?? velocidadeValida(bus.velocidade);
    const anterior = Number.isFinite(bus.progressoAnterior) ? bus.progressoAnterior : null;
    const avancando = anterior === null || posicao?.aoLongo >= anterior - 150;
    return { bus, hora, sinalMs, posicao, velocidade: velocidade ?? velocidadeValida(bus.velocidadeEma), avancando };
  }).filter((item) => item.posicao && item.sinalMs < maxSinalMs && item.avancando)
    .filter((item) => item.bus.rumoCompativel !== false)
    .filter((item) => paradaMaisProxima.posicao.aoLongo - item.posicao.aoLongo > 50)
    .sort((a, b) => (paradaMaisProxima.posicao.aoLongo - a.posicao.aoLongo) - (paradaMaisProxima.posicao.aoLongo - b.posicao.aoLongo));

  if (!candidatos.length) {
    return {
      disponivel: false,
      motivo: "Não há ônibus com sinal recente antes da parada escolhida.",
      parada: paradaMaisProxima.parada,
      distanciaUsuarioMetros: Math.round(distanciaMetros(
        [localizacao.lng, localizacao.lat],
        [paradaMaisProxima.parada.lng, paradaMaisProxima.parada.lat],
      )),
    };
  }

  const alvo = alvoOrdem == null ? null : candidatos.find((item) => String(item.bus.ordem) === String(alvoOrdem));
  if (alvoOrdem != null && !alvo) {
    return {
      disponivel: false,
      alvoAusente: true,
      candidatosOrdens: candidatos.map((item) => String(item.bus.ordem)),
      motivo: "O ônibus acompanhado não enviou um sinal válido neste ciclo.",
      parada: paradaMaisProxima.parada,
    };
  }

  const distanciaAteParada = (item) => paradaMaisProxima.posicao.aoLongo - item.posicao.aoLongo;
  const ordenados = alvo ? [alvo, ...candidatos.filter((item) => item !== alvo)] : candidatos;
  const distanciaUsuarioMetros = Math.round(distanciaMetros(
    [localizacao.lng, localizacao.lat],
    [paradaMaisProxima.parada.lng, paradaMaisProxima.parada.lat],
  ));
  const velocidadeDoOnibus = ordenados[0].velocidade;
  if (!Number.isFinite(velocidadeDoOnibus) || velocidadeDoOnibus <= 0) {
    const parado = velocidadeDoOnibus === 0;
    return {
      disponivel: true,
      confiavel: false,
      motivo: parado
        ? "O ônibus está parado; não há previsão confiável de chegada."
        : "Velocidade do ônibus desconhecida; não há previsão confiável de chegada.",
      parada: paradaMaisProxima.parada,
      onibus: ordenados.slice(0, 2).map((item) => ({
        ordem: item.bus.ordem,
        distanciaMetros: Math.round(distanciaAteParada(item)),
        velocidadeKmh: null,
        sinalSegundos: Math.round(item.sinalMs / 1000),
      })),
      distanciaUsuarioMetros,
    };
  }
  const faixa = (item) => {
    const distancia = paradaMaisProxima.posicao.aoLongo - item.posicao.aoLongo;
    const kmh = Math.min(40, item.velocidade);
    const minutos = distancia / (kmh * 1000 / 3600) / 60;
    return { minimo: Math.max(1, Math.floor(minutos + 1)), maximo: Math.max(2, Math.ceil(minutos * 1.45 + 1)) };
  };
  const escolhidos = ordenados.slice(0, 2).map((item) => ({
    ordem: item.bus.ordem,
    distanciaMetros: Math.round(distanciaAteParada(item)),
    velocidadeKmh: Math.round(item.velocidade),
    sinalSegundos: Math.round(item.sinalMs / 1000),
    faixa: faixa(item),
  }));
  const estimativa = escolhidos[0].faixa;
  return {
    disponivel: true,
    estimativa,
    confiavel: true,
    comparacaoCaminhada: compararChegadaCaminhando(distanciaUsuarioMetros, estimativa),
    parada: paradaMaisProxima.parada,
    onibus: escolhidos,
    distanciaUsuarioMetros,
    aviso: "Estimativa aproximada com base no trajeto oficial e no GPS recente.",
  };
}

module.exports = {
  distanciaMetros,
  rumoGraus,
  diferencaAngulo,
  projetarPonto,
  estimarChegada,
  compararChegadaCaminhando,
};

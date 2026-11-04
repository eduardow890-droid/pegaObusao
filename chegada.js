"use strict";
const { distanciaMetros, rumoGraus, diferencaAngulo, projetarPonto } = require("./public/map-match");
const DISTANCIA_MAXIMA_COMPARACAO_CAMINHADA_METROS = 2000;

// Funções puras para estimativas ao longo do trajeto GTFS.
// A posição anterior é opcional: quando não existe, não afirmamos que o veículo
// está avançando no sentido escolhido.

function velocidadeValida(kmh) {
  const valor = Number(kmh);
  return Number.isFinite(valor) && valor >= 1 && valor <= 120 ? valor : null;
}

function compararChegadaCaminhando(distanciaUsuarioMetros, estimativaOnibus) {
  if (!Number.isFinite(distanciaUsuarioMetros) || !estimativaOnibus
    || !Number.isFinite(estimativaOnibus.minimo) || !Number.isFinite(estimativaOnibus.maximo)) return null;
  if (distanciaUsuarioMetros > DISTANCIA_MAXIMA_COMPARACAO_CAMINHADA_METROS) {
    const distancia = distanciaUsuarioMetros >= 1000
      ? `${(distanciaUsuarioMetros / 1000).toFixed(1).replace(".", ",")} km`
      : `${Math.round(distanciaUsuarioMetros)} m`;
    return {
      minutosCaminhando: null,
      status: "distante",
      mensagem: `A parada está a ${distancia} em linha reta; comparação de caminhada não exibida.`,
    };
  }
  const minutosCaminhando = Math.ceil(Math.max(0, distanciaUsuarioMetros) / 1.2 / 60);
  const antes = minutosCaminhando <= estimativaOnibus.minimo;
  const depois = minutosCaminhando > estimativaOnibus.maximo;
  return {
    minutosCaminhando,
    status: antes ? "antes" : depois ? "depois" : "incerto",
    mensagem: antes
      ? `O ônibus chega em ${estimativaOnibus.minimo} min, você leva ${minutosCaminhando} min a pé (distância em linha reta): saia agora.`
      : depois
        ? `Você leva ${minutosCaminhando} min a pé (distância em linha reta) e pode chegar depois do ônibus.`
        : `Você leva ${minutosCaminhando} min a pé (distância em linha reta); a chegada do ônibus está em uma faixa incerta.`,
  };
}

function estimarChegada({ rota, paradas, onibus, localizacao, agora = Date.now(), maxSinalMs = 180_000, alvoOrdem = null }) {
  const coordenadas = rota?.coordinates || [];
  if (coordenadas.length < 2 || !Array.isArray(paradas) || !localizacao) {
    return { disponivel: false, motivo: "Dados oficiais de trajeto ou localização insuficientes." };
  }
  const paradasProjetadas = paradas.map((parada) => ({
    parada,
    posicao: projetarPonto(coordenadas, parada),
    distanciaUsuario: distanciaMetros([localizacao.lng, localizacao.lat], [parada.lng, parada.lat]),
  }))
    .filter((item) => item.posicao)
    .sort((a, b) => a.distanciaUsuario - b.distanciaUsuario);
  const paradaMaisProxima = paradasProjetadas[0];
  if (!paradaMaisProxima) return { disponivel: false, motivo: "Nenhuma parada foi encontrada nesse sentido." };
  const primeiraParada = [...paradasProjetadas].sort((a, b) => a.posicao.aoLongo - b.posicao.aoLongo)[0];
  const paradaInicial = paradaMaisProxima.parada === primeiraParada?.parada;

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
      paradaInicial,
      motivo: paradaInicial
        ? "Esta é a parada inicial: os ônibus saem daqui."
        : "Não há ônibus com sinal recente antes da parada escolhida; sem previsão por falta de sinal.",
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

"use strict";

const fs = require("fs");
const path = require("path");
const { estimarChegada, projetarPonto, distanciaMetros: distanciaMetrosRota, rumoGraus, diferencaAngulo } = require("./chegada");

let banco;
const historicoChegada = new Map();
const alvosChegada = new Map();
const ultimasEstimativas = new Map();

function carregar() {
  if (banco) return banco;
  const pasta = path.resolve(__dirname, "data");
  const linhas = JSON.parse(fs.readFileSync(path.join(pasta, "linhas.json"), "utf8"));
  const paradas = new Map(JSON.parse(fs.readFileSync(path.join(pasta, "paradas.json"), "utf8")).map((p) => [p.id, p]));
  const rotas = JSON.parse(fs.readFileSync(path.join(pasta, "rotas.json"), "utf8"));
  const metaPath = path.join(pasta, "gtfs-meta.json");
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : null;
  banco = { linhas, paradas, rotas, meta };
  return banco;
}

function statusGtfs() {
  try {
    const dados = carregar();
    return { disponivel: true, ...dados.meta };
  } catch (erro) {
    return { disponivel: false, erro: "Dados GTFS não importados. Execute npm run importar-gtfs." };
  }
}

function buscarLinha(linha) {
  const alvo = String(linha).trim().toUpperCase();
  const dados = carregar();
  const encontrada = dados.linhas.find((item) => item.linha.toUpperCase() === alvo);
  if (!encontrada) return null;

  return {
    linha: encontrada.linha,
    nome: encontrada.nome,
    cor: encontrada.cor,
    variantes: encontrada.variantes.map((variante) => ({
      destino: variante.destino,
      sentido: variante.sentido,
      tripIds: variante.tripIds || [],
      paradas: variante.paradas.map((id) => dados.paradas.get(id)).filter(Boolean),
      rota: dados.rotas[variante.shapeId] || null,
    })),
  };
}

function varianteDoOnibus(dadosLinha, bus) {
  const texto = `${bus.destino || ""} ${bus.sentido || ""}`.trim().toUpperCase();
  const porTrip = dadosLinha.variantes.findIndex((variante) => variante.tripIds?.includes(bus.tripId));
  if (porTrip >= 0) return porTrip;
  const porTexto = dadosLinha.variantes.findIndex((variante) => {
    const alvo = `${variante.destino || ""} ${variante.sentido || ""}`.trim().toUpperCase();
    return alvo && texto && (alvo.includes(texto) || texto.includes(alvo));
  });
  if (porTexto >= 0) return porTexto;
  let melhor = null;
  dadosLinha.variantes.forEach((variante, indice) => {
    const posicao = projetarPonto(variante.rota?.coordinates || [], bus);
    if (!posicao || !melhor || posicao.distanciaMetros < melhor.distancia) melhor = { indice, distancia: posicao?.distanciaMetros ?? Infinity };
  });
  return melhor?.distancia <= 1500 ? melhor.indice : null;
}

function filtrarOnibusSentido(dadosLinha, indice, onibus) {
  return (onibus || []).filter((bus) => varianteDoOnibus(dadosLinha, bus) === indice);
}

function distanciaMetros(a, b) {
  return distanciaMetrosRota(a, b);
}

function buscarParadasLocais(lat, lng, raio = 800) {
  const dados = carregar();
  return [...dados.paradas.values()]
    .map((parada) => ({ parada, distanciaMetros: distanciaMetros([lng, lat], [parada.lng, parada.lat]) }))
    .filter((item) => item.distanciaMetros <= raio)
    .sort((a, b) => a.distanciaMetros - b.distanciaMetros)
    .map(({ parada, distanciaMetros: distancia }) => ({ ...parada, distanciaMetros: Math.round(distancia) }));
}

function previsao(dadosLinha, indice, onibus) {
  const variante = dadosLinha?.variantes?.[indice];
  const coordenadas = variante?.rota?.coordinates || [];
  if (!variante || coordenadas.length < 2) return [];
  const buses = filtrarOnibusSentido(dadosLinha, indice, onibus).map((bus) => ({ bus, posicao: projetarPonto(coordenadas, bus) })).filter((item) => item.posicao?.distanciaMetros < 1500);
  return variante.paradas.map((parada) => {
    const posicaoParada = projetarPonto(coordenadas, parada);
    const candidatos = buses.map(({ bus, posicao }) => {
      const distancia = posicaoParada.aoLongo - posicao.aoLongo;
      if (distancia < 0) return null;
      const velocidade = Math.max(Number(bus.velocidade) || 0, 8) * 1000 / 3600;
      return { minutos: Math.max(1, Math.round(distancia / velocidade / 60)), ordem: bus.ordem };
    }).filter(Boolean).sort((a, b) => a.minutos - b.minutos);
    return { ...parada, previsaoMinutos: candidatos[0]?.minutos ?? null, onibus: candidatos[0]?.ordem ?? null };
  });
}

function chegada(dadosLinha, indice, onibus, localizacao, agora = Date.now()) {
  const variante = dadosLinha?.variantes?.[indice];
  if (!variante) return { disponivel: false, motivo: "Sentido não encontrado." };
  const chaveBase = `${dadosLinha.linha}:${indice}`;
  const comHistorico = filtrarOnibusSentido(dadosLinha, indice, onibus).map((bus) => {
    const posicao = projetarPonto(variante.rota?.coordinates || [], bus);
    const chave = `${chaveBase}:${bus.ordem}`;
    const anterior = historicoChegada.get(chave);
    let rumoCompativel = true;
    let velocidadeEma = Number.isFinite(bus.velocidade) && bus.velocidade > 0 ? bus.velocidade : null;
    if (anterior && posicao) {
      const distancia = distanciaMetros([anterior.lng, anterior.lat], [bus.lng, bus.lat]);
      const decorrido = Math.max(1, (Number(bus.hora) - Number(anterior.hora)) / 1000);
      const velocidadeCalculada = distancia / decorrido * 3.6;
      if (velocidadeCalculada >= 1 && velocidadeCalculada <= 120) {
        velocidadeEma = anterior.velocidadeEma == null
          ? velocidadeCalculada
          : anterior.velocidadeEma * 0.7 + velocidadeCalculada * 0.3;
      }
      if (distancia >= 30 && Number.isFinite(posicao.rumoTrecho)) {
        const rumoOnibus = rumoGraus([anterior.lng, anterior.lat], [bus.lng, bus.lat]);
        rumoCompativel = diferencaAngulo(rumoOnibus, posicao.rumoTrecho) < 90;
      }
    }
    if (posicao) historicoChegada.set(chave, {
      lat: bus.lat,
      lng: bus.lng,
      hora: bus.hora,
      aoLongo: posicao.aoLongo,
      rumo: posicao.rumoTrecho,
      velocidadeEma,
    });
    return anterior === undefined ? { ...bus, velocidadeEma } : {
      ...bus,
      progressoAnterior: anterior.aoLongo,
      velocidadeEma,
      rumoCompativel,
    };
  });
  while (historicoChegada.size > 10_000) historicoChegada.delete(historicoChegada.keys().next().value);
  const alvo = alvosChegada.get(chaveBase);
  let resultado = estimarChegada({
    rota: variante.rota,
    paradas: variante.paradas,
    onibus: comHistorico,
    localizacao,
    agora,
    alvoOrdem: alvo?.ordem || null,
  });

  if (resultado.alvoAusente && alvo && alvo.falhas < 2) {
    alvosChegada.set(chaveBase, { ...alvo, falhas: alvo.falhas + 1 });
    const anterior = ultimasEstimativas.get(chaveBase);
    if (anterior) return { ...anterior, aviso: "Sinal instável; mantendo o ônibus acompanhado." };
  }

  if (resultado.alvoAusente) {
    resultado = estimarChegada({ rota: variante.rota, paradas: variante.paradas, onibus: comHistorico, localizacao, agora });
  }
  if (resultado.disponivel && resultado.onibus?.[0]) {
    alvosChegada.set(chaveBase, { ordem: String(resultado.onibus[0].ordem), falhas: 0 });
    ultimasEstimativas.set(chaveBase, resultado);
  }
  return resultado;
}

module.exports = { buscarLinha, statusGtfs, previsao, chegada, buscarParadasLocais, distanciaMetros, varianteDoOnibus, filtrarOnibusSentido };


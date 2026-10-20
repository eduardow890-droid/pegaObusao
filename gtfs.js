"use strict";

const fs = require("fs");
const path = require("path");
const { estimarChegada, projetarPonto } = require("./chegada");

let banco;
const historicoChegada = new Map();

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

function distanciaMetros(a, b) {
  const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const dx = (a[0] - b[0]) * Math.cos(latitude) * 111320;
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
}

function previsao(dadosLinha, indice, onibus) {
  const variante = dadosLinha?.variantes?.[indice];
  const coordenadas = variante?.rota?.coordinates || [];
  if (!variante || coordenadas.length < 2) return [];
  const acumuladas = [0];
  for (let i = 1; i < coordenadas.length; i += 1) acumuladas.push(acumuladas[i - 1] + distanciaMetros(coordenadas[i - 1], coordenadas[i]));
  const progresso = (ponto) => {
    let melhor = { distancia: Infinity, metros: 0 };
    coordenadas.forEach((coordenada, i) => {
      const distancia = distanciaMetros([ponto.lng, ponto.lat], coordenada);
      if (distancia < melhor.distancia) melhor = { distancia, metros: acumuladas[i] };
    });
    return melhor;
  };
  const buses = onibus.map((bus) => ({ bus, posicao: progresso(bus) })).filter((item) => item.posicao.distancia < 1500);
  return variante.paradas.map((parada) => {
    const posicaoParada = progresso(parada);
    const candidatos = buses.map(({ bus, posicao }) => {
      const distancia = posicaoParada.metros - posicao.metros;
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
  const comHistorico = onibus.map((bus) => {
    const posicao = projetarPonto(variante.rota?.coordinates || [], bus);
    const chave = `${chaveBase}:${bus.ordem}`;
    const anterior = historicoChegada.get(chave);
    if (posicao) historicoChegada.set(chave, posicao.aoLongo);
    return anterior === undefined ? bus : { ...bus, progressoAnterior: anterior };
  });
  while (historicoChegada.size > 10_000) historicoChegada.delete(historicoChegada.keys().next().value);
  return estimarChegada({ rota: variante.rota, paradas: variante.paradas, onibus: comHistorico, localizacao, agora });
}

module.exports = { buscarLinha, statusGtfs, previsao, chegada };


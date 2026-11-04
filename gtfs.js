"use strict";

const fs = require("fs");
const path = require("path");
const { estimarChegada, projetarPonto, distanciaMetros: distanciaMetrosRota, rumoGraus, diferencaAngulo } = require("./chegada");
const { contarDescarte } = require("./lib");

let banco;
const historicoChegada = new Map();
const historicoProgressoRota = new Map();
const historicoProgressoVariantes = new Map();
const alvosChegada = new Map();
const ultimasEstimativas = new Map();
const DISTANCIA_GRUDAR_METROS = 60;
const DISTANCIA_MAXIMA_ROTA_METROS = 500;
const MOVIMENTO_MINIMO_SENTIDO_METROS = 30;
const JANELA_SENTIDO_MS = 180_000;
const VELOCIDADE_PARADO_KMH = 1;
const metricasAssociacao = {
  recebidos: 0,
  descartadosPorDistancia: 0,
  comSentidoPorRumo: 0,
  comSentidoPorMovimento: 0,
  indeterminados: 0,
};

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
  const porTrip = dadosLinha.variantes.findIndex((variante) => variante.tripIds?.includes(bus.tripId));
  if (bus.directionId !== "" && bus.directionId != null) {
    const porDirecao = dadosLinha.variantes.findIndex((variante) => String(variante.sentido) === String(bus.directionId));
    if (porDirecao >= 0) return porTrip >= 0 && porTrip !== porDirecao ? -1 : porDirecao;
  }
  if (porTrip >= 0) return porTrip;
  const rumo = normalizarRumo(bus.rumo);
  if (rumo === null) return -1;
  let melhor = null;
  dadosLinha.variantes.forEach((variante, indice) => {
    const posicao = projetarPonto(variante.rota?.coordinates || [], bus);
    if (!posicao || diferencaAngulo(rumo, posicao.rumoTrecho) >= 90) return;
    if (!melhor || posicao.distanciaMetros < melhor.distancia) {
      melhor = { indice, distancia: posicao.distanciaMetros };
    }
  });
  return melhor ? melhor.indice : -1;
}

function normalizarRumo(valor) {
  if (valor == null || (typeof valor === "string" && valor.trim() === "")) return null;
  if (typeof valor !== "number" && typeof valor !== "string") return null;
  if (typeof valor === "string" && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(valor.trim())) return null;
  const rumo = Number(valor);
  return Number.isFinite(rumo) && rumo >= 0 && rumo <= 360 ? rumo : null;
}

function metricasAssociacaoSentido() {
  return { ...metricasAssociacao };
}

function filtrarOnibusSentido(dadosLinha, indice, onibus) {
  return (onibus || []).filter((bus) =>
    Number(bus.sentido) === indice
    && Number.isInteger(bus.varianteIndice)
    && ["rumo", "movimento"].includes(bus.confiancaSentido));
}

function projetarEmVariantes(dadosLinha, bus) {
  return dadosLinha.variantes.map((variante, indice) => {
    const coordenadas = variante.rota?.coordinates || [];
    const posicao = coordenadas.length >= 2 ? projetarPonto(coordenadas, bus) : null;
    return posicao ? { indice, coordenadas, posicao } : null;
  }).filter(Boolean);
}

function variantePorMovimento(projecoes, historico, leituraAtual) {
  if (!historico.length) return null;
  const baseline = historico[0];
  if (leituraAtual.hora <= baseline.hora) return null;
  const janela = [...historico, leituraAtual];
  const paradoNaJanela = janela.length > 1 && janela.every((leitura) =>
    Number.isFinite(leitura.velocidade) && leitura.velocidade <= VELOCIDADE_PARADO_KMH);
  if (paradoNaJanela) return null;
  const candidatas = projecoes.map((projecao) => {
    const progressoAnterior = baseline.progressoPorVariante[projecao.indice];
    return {
      ...projecao,
      movimento: progressoAnterior == null ? 0 : projecao.posicao.aoLongo - progressoAnterior,
    };
  }).filter((projecao) => projecao.movimento >= MOVIMENTO_MINIMO_SENTIDO_METROS);
  candidatas.sort((a, b) => a.posicao.distanciaMetros - b.posicao.distanciaMetros
    || b.movimento - a.movimento
    || a.indice - b.indice);
  return candidatas[0] || null;
}

function coordenadaEmProgresso(coordenadas, progressoMetros) {
  let acumulada = 0;
  for (let indice = 1; indice < coordenadas.length; indice += 1) {
    const a = coordenadas[indice - 1];
    const b = coordenadas[indice];
    const trecho = distanciaMetrosRota(a, b);
    if (acumulada + trecho >= progressoMetros) {
      const fator = trecho ? Math.max(0, Math.min(1, (progressoMetros - acumulada) / trecho)) : 0;
      return [a[0] + (b[0] - a[0]) * fator, a[1] + (b[1] - a[1]) * fator];
    }
    acumulada += trecho;
  }
  return coordenadas.at(-1);
}

function projetarOnibusNaRota(dadosLinha, onibus) {
  const resultado = [];
  for (const registro of onibus || []) {
    metricasAssociacao.recebidos += 1;
    const chaveVeiculo = `${dadosLinha.linha}:${registro.ordem}`;
    const projecoes = projetarEmVariantes(dadosLinha, registro);
    const maisProxima = projecoes.reduce((melhor, item) =>
      !melhor || item.posicao.distanciaMetros < melhor.posicao.distanciaMetros ? item : melhor, null);
    if (!maisProxima || maisProxima.posicao.distanciaMetros > DISTANCIA_MAXIMA_ROTA_METROS) {
      contarDescarte("fora_da_rota");
      metricasAssociacao.descartadosPorDistancia += 1;
      continue;
    }

    const rumo = normalizarRumo(registro.rumo);
    let escolhida = null;
    let confiancaSentido = "nenhuma";
    if (rumo !== null) {
      escolhida = varianteDoOnibus(dadosLinha, { ...registro, rumo });
      if (escolhida >= 0) {
        escolhida = projecoes.find((item) => item.indice === escolhida) || null;
        confiancaSentido = escolhida ? "rumo" : "nenhuma";
      }
    } else {
      const porMetadado = varianteDoOnibus(dadosLinha, registro);
      if (porMetadado >= 0 && (registro.directionId || registro.tripId)) {
        escolhida = projecoes.find((item) => item.indice === porMetadado) || null;
        confiancaSentido = escolhida ? "rumo" : "nenhuma";
      }
      if (!escolhida) {
        const hora = Number(registro.hora);
        const velocidade = Number.isFinite(registro.velocidade) ? registro.velocidade : null;
        const historico = (historicoProgressoVariantes.get(chaveVeiculo) || [])
          .filter((leitura) => hora - leitura.hora <= JANELA_SENTIDO_MS && hora >= leitura.hora);
        escolhida = variantePorMovimento(projecoes, historico, {
          hora,
          velocidade,
          progressoPorVariante: Object.fromEntries(projecoes.map(({ indice, posicao }) => [indice, posicao.aoLongo])),
        });
        if (escolhida) confiancaSentido = "movimento";
      }
    }

    const hora = Number(registro.hora);
    const leituraAtual = {
      hora,
      velocidade: Number.isFinite(registro.velocidade) ? registro.velocidade : null,
      progressoPorVariante: Object.fromEntries(projecoes.map(({ indice, posicao }) => [indice, posicao.aoLongo])),
    };
    const historico = (historicoProgressoVariantes.get(chaveVeiculo) || [])
      .filter((leitura) => Number.isFinite(hora) && hora - leitura.hora <= JANELA_SENTIDO_MS && hora >= leitura.hora);
    if (Number.isFinite(hora) && (!historico.length || hora > historico.at(-1).hora)) {
      historico.push(leituraAtual);
      historicoProgressoVariantes.set(chaveVeiculo, historico);
    } else if (historico.length) {
      historicoProgressoVariantes.set(chaveVeiculo, historico);
    } else {
      historicoProgressoVariantes.delete(chaveVeiculo);
    }

    if (!escolhida || escolhida.posicao.distanciaMetros > DISTANCIA_MAXIMA_ROTA_METROS) {
      metricasAssociacao.indeterminados += 1;
      resultado.push({ ...registro, sentido: "indeterminado", confiancaSentido: "nenhuma" });
      continue;
    }
    const { indice: varianteIndice, coordenadas, posicao } = escolhida;

    const chave = `${dadosLinha.linha}:${varianteIndice}:${registro.ordem}`;
    const anterior = historicoProgressoRota.get(chave);
    const progressoAnteriorMetros = anterior?.progressoMetros ?? null;
    const progressoMetros = anterior && posicao.aoLongo < anterior.progressoMetros - 30
      ? anterior.progressoMetros
      : posicao.aoLongo;
    const posicaoNaRota = coordenadaEmProgresso(coordenadas, progressoMetros);
    const desvioMetros = Math.round(posicao.distanciaMetros);
    const foraDaRota = posicao.distanciaMetros > DISTANCIA_GRUDAR_METROS;
    historicoProgressoRota.set(chave, { progressoMetros });
    metricasAssociacao[confiancaSentido === "movimento" ? "comSentidoPorMovimento" : "comSentidoPorRumo"] += 1;
    resultado.push({
      ...registro,
      lat: foraDaRota ? registro.lat : posicaoNaRota[1],
      lng: foraDaRota ? registro.lng : posicaoNaRota[0],
      sentido: String(varianteIndice),
      confiancaSentido,
      varianteIndice,
      posicaoNaRota,
      progressoMetros,
      progressoAnteriorMetros,
      desvioMetros,
      foraDaRota,
    });
  }
  while (historicoProgressoRota.size > 10_000) {
    historicoProgressoRota.delete(historicoProgressoRota.keys().next().value);
  }
  while (historicoProgressoVariantes.size > 10_000) {
    historicoProgressoVariantes.delete(historicoProgressoVariantes.keys().next().value);
  }
  return resultado;
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
      const kmh = bus.velocidade == null ? NaN : Number(bus.velocidade);
      if (!Number.isFinite(kmh) || kmh <= 0) return null;
      const velocidade = kmh * 1000 / 3600;
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
    let velocidadeEma = bus.velocidade === 0
      ? 0
      : Number.isFinite(bus.velocidade) && bus.velocidade > 0 ? bus.velocidade : null;
    if (anterior && posicao) {
      const distancia = distanciaMetros([anterior.lng, anterior.lat], [bus.lng, bus.lat]);
      const decorrido = (Number(bus.hora) - Number(anterior.hora)) / 1000;
      if (decorrido > 0 && bus.velocidade !== 0) {
        const velocidadeCalculada = distancia / decorrido * 3.6;
        if (velocidadeCalculada < 1) {
          velocidadeEma = 0;
        } else if (velocidadeCalculada <= 120) {
          velocidadeEma = anterior.velocidadeEma == null
            ? velocidadeCalculada
            : anterior.velocidadeEma * 0.7 + velocidadeCalculada * 0.3;
        }
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

module.exports = {
  buscarLinha,
  statusGtfs,
  previsao,
  chegada,
  buscarParadasLocais,
  distanciaMetros,
  varianteDoOnibus,
  filtrarOnibusSentido,
  projetarOnibusNaRota,
  metricasAssociacaoSentido,
  normalizarRumo,
  coordenadaEmProgresso,
};

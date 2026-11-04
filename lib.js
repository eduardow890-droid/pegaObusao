"use strict";
// Lógica de acesso à API da SMTR, separada do servidor para poder ser testada.

const dns = require("node:dns");
// Alguns ambientes de hospedagem anunciam IPv6, mas não possuem rota IPv6 de saída.
// Preferir IPv4 evita que a conexão HTTPS externa falhe antes de chegar à SMTR.
dns.setDefaultResultOrder("ipv4first");

const PADRAO = {
  url: (process.env.GPS_URL || "https://its.mobilidade.rio/v1/geolocalizacao/veiculos").trim().replace(/^['"]|['"]$/g, ""),
  limite: 500, // registros por página
  maxPaginas: 10, // trava de segurança contra paginação infinita
  timeoutMs: Number(process.env.GPS_TIMEOUT_MS || 15_000), // prazo de cada chamada à SMTR
  tentativas: 2,
  maxIdadeMs: Number(process.env.MAX_IDADE_ONIBUS_MS || 180_000),
  toleranciaFuturaMs: Number(process.env.GPS_CLOCK_SKEW_MS || 30_000),
  maxVelocidadeKmh: Number(process.env.GPS_MAX_SPEED_KMH || 100),
  limitesRio: {
    minLat: Number(process.env.GPS_RIO_MIN_LAT || -23.2),
    maxLat: Number(process.env.GPS_RIO_MAX_LAT || -22.6),
    minLng: Number(process.env.GPS_RIO_MIN_LNG || -43.9),
    maxLng: Number(process.env.GPS_RIO_MAX_LNG || -42.9),
  },
  fetch: (...args) => fetch(...args),
  agora: () => new Date(),
};
const descartesGPS = Object.create(null);

// A API trabalha com minutos UTC. Ex.: 2026-10-17T14:32:00Z
// Formato exigido pela API: minuto UTC arredondado ao início do minuto.
function minutoUtc(data) {
  const d = new Date(data);
  d.setUTCSeconds(0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  const texto = v.trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(texto)) return NaN;
  return Number(texto.replace(",", "."));
}

function erroDeRede(erro) {
  if (!erro) return new Error("Falha desconhecida ao acessar a API de GPS.");
  if (erro.cause?.code) return new Error(`${erro.message} (${erro.cause.code})`);
  return erro;
}

// Valida e normaliza um registro. Devolve null se estiver inválido.
function normalizarComMotivo(o, {
  agora = Date.now(),
  toleranciaFuturaMs = PADRAO.toleranciaFuturaMs,
  maxVelocidadeKmh = PADRAO.maxVelocidadeKmh,
  limitesRio = PADRAO.limitesRio,
} = {}) {
  const rejeitar = (motivo) => ({ onibus: null, motivo });
  if (!o || typeof o !== "object") return rejeitar("registro_invalido");
  const id = String(o.id_veiculo ?? "").trim();
  const servico = String(o.servico ?? "").trim();
  const lat = num(o.latitude);
  const lng = num(o.longitude);
  if (!id || !servico) return rejeitar("identificacao_ausente");
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return rejeitar("coordenada_invalida");
  }
  if (lat === 0 && lng === 0) return rejeitar("coordenada_zero_zero");
  if (lat < limitesRio.minLat || lat > limitesRio.maxLat || lng < limitesRio.minLng || lng > limitesRio.maxLng) {
    return rejeitar("fora_do_rio");
  }
  const hora = Date.parse(o.datetime ?? o.timestamp_gps ?? "");
  if (!Number.isFinite(hora)) return rejeitar("timestamp_invalido");
  if (hora > agora + toleranciaFuturaMs) return rejeitar("timestamp_futuro");
  const velocidadeBruta = o.velocidade;
  const velocidade = velocidadeBruta == null || String(velocidadeBruta).trim() === "" ? null : num(velocidadeBruta);
  if (velocidadeBruta != null && String(velocidadeBruta).trim() !== ""
    && (!Number.isFinite(velocidade) || velocidade < 0 || velocidade > maxVelocidadeKmh)) {
    return rejeitar("velocidade_impossivel");
  }
  return {
    onibus: {
      ordem: id,
      linha: servico,
      lat,
      lng,
      velocidade,
      destino: String(o.destino ?? o.destination ?? o.sentido ?? o.direcao ?? "").trim(),
      sentido: String(o.sentido ?? o.direcao ?? "").trim(),
      tripId: String(o.trip_id ?? o.tripId ?? "").trim(),
      routeId: String(o.route_id ?? o.routeId ?? "").trim(),
      directionId: String(o.direction_id ?? o.directionId ?? "").trim(),
      rumo: (() => {
        const valor = o.rumo ?? o.bearing ?? o.course ?? o.heading;
        if (valor == null || String(valor).trim() === "") return null;
        const normalizado = num(valor);
        return Number.isFinite(normalizado) && normalizado >= 0 && normalizado <= 360 ? normalizado : null;
      })(),
      hora,
    },
    motivo: null,
  };
}

function normalizar(o, opcoes) {
  return normalizarComMotivo(o, opcoes).onibus;
}

function contarDescarte(motivo) {
  descartesGPS[motivo] = (descartesGPS[motivo] || 0) + 1;
}

function distanciaGPSMetros(a, b) {
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function metricasDescartesGPS() {
  return { ...descartesGPS };
}

function extrairLista(bruto) {
  if (Array.isArray(bruto)) return bruto;
  if (!bruto || typeof bruto !== "object") throw new Error("Formato inesperado na resposta da API de GPS.");
  const lista = bruto.data ?? bruto.items ?? bruto.results;
  if (!Array.isArray(lista)) throw new Error("A resposta da API de GPS não contém uma lista de veículos.");
  return lista;
}

// Busca todas as páginas de um minuto, seguindo next_cursor.
async function buscarMinuto(linha, minuto, cfg) {
  const registros = [];
  let cursor = null;
  for (let pagina = 0; pagina < cfg.maxPaginas; pagina++) {
    const url = new URL(cfg.url);
    url.searchParams.set("servico", linha);
    url.searchParams.set("minuto_utc", minuto);
    url.searchParams.set("limit", String(cfg.limite));
    if (cursor) url.searchParams.set("cursor", cursor);

    let resp;
    let falha;
    for (let tentativa = 1; tentativa <= cfg.tentativas; tentativa += 1) {
      try {
        resp = await cfg.fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "PegaObusao/1.0" },
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (resp.ok || (resp.status < 500 && resp.status !== 429)) break;
        falha = new Error(`GPS respondeu ${resp.status}`);
      } catch (erro) {
        falha = erroDeRede(erro);
      }
      if (tentativa < cfg.tentativas) await new Promise((resolver) => setTimeout(resolver, 300));
    }
    if (!resp) throw falha || new Error("Não foi possível conectar à API de GPS.");
    if (!resp.ok) throw new Error(`GPS respondeu ${resp.status}`);
    const bruto = await resp.json();
    registros.push(...extrairLista(bruto));

    cursor = bruto && !Array.isArray(bruto) ? bruto.next_cursor : null;
    if (!cursor) break;
    if (pagina === cfg.maxPaginas - 1) {
      throw new Error(`A paginação da API excedeu o limite de ${cfg.maxPaginas} páginas.`);
    }
  }
  return registros;
}

// Posição mais recente de cada ônibus da linha (minuto atual + anterior).
// Um terceiro minuto é consultado somente quando os dois primeiros não
// entregam nenhum veículo, evitando aumentar o custo normal da API.
async function carregarOnibus(linha, deps = {}) {
  const cfg = { ...PADRAO, ...deps };
  const agora = cfg.agora();
  const minutos = [minutoUtc(agora), minutoUtc(new Date(agora.getTime() - 60_000))];
  let terceiroConsultado = false;

  let resultados = await Promise.allSettled(minutos.map((m) => buscarMinuto(linha, m, cfg)));
  let bons = resultados.filter((r) => r.status === "fulfilled");
  if (bons.length === 0) {
    try {
      terceiroConsultado = true;
      resultados = [...resultados, { status: "fulfilled", value: await buscarMinuto(linha, minutoUtc(new Date(agora.getTime() - 2 * 60_000)), cfg) }];
      bons = resultados.filter((r) => r.status === "fulfilled");
    } catch (erro) {
      throw resultados[0].reason || erro;
    }
  }

  const alvo = linha.toUpperCase();
  const porVeiculo = new Map();
  for (const { value } of bons) {
    for (const bruto of value) {
      const resultado = normalizarComMotivo(bruto, {
        agora: agora.getTime(),
        toleranciaFuturaMs: cfg.toleranciaFuturaMs,
        maxVelocidadeKmh: cfg.maxVelocidadeKmh,
        limitesRio: cfg.limitesRio,
      });
      if (!resultado.onibus) {
        contarDescarte(resultado.motivo);
        continue;
      }
      const o = resultado.onibus;
      if (o.linha.toUpperCase() !== alvo) {
        contarDescarte("linha_diferente");
        continue;
      }
      if (agora.getTime() - o.hora > cfg.maxIdadeMs) {
        contarDescarte("sinal_antigo");
        continue;
      }
      if (!porVeiculo.has(o.ordem)) porVeiculo.set(o.ordem, []);
      porVeiculo.get(o.ordem).push(o);
    }
  }
  if (porVeiculo.size === 0 && !terceiroConsultado) {
    try {
      terceiroConsultado = true;
      const terceiro = await buscarMinuto(linha, minutoUtc(new Date(agora.getTime() - 2 * 60_000)), cfg);
      for (const bruto of terceiro) {
        const resultado = normalizarComMotivo(bruto, {
          agora: agora.getTime(),
          toleranciaFuturaMs: cfg.toleranciaFuturaMs,
          maxVelocidadeKmh: cfg.maxVelocidadeKmh,
          limitesRio: cfg.limitesRio,
        });
        if (!resultado.onibus) {
          contarDescarte(resultado.motivo);
          continue;
        }
        const o = resultado.onibus;
        if (o.linha.toUpperCase() !== alvo) {
          contarDescarte("linha_diferente");
          continue;
        }
        if (agora.getTime() - o.hora > cfg.maxIdadeMs) {
          contarDescarte("sinal_antigo");
          continue;
        }
        if (!porVeiculo.has(o.ordem)) porVeiculo.set(o.ordem, []);
        porVeiculo.get(o.ordem).push(o);
      }
    } catch {}
  }
  const aceitos = [];
  for (const registros of porVeiculo.values()) {
    registros.sort((a, b) => a.hora - b.hora);
    let anterior = null;
    for (const onibus of registros) {
      if (anterior && onibus.hora <= anterior.hora) {
        contarDescarte("registro_duplicado");
        continue;
      }
      if (anterior) {
        const decorridoSegundos = (onibus.hora - anterior.hora) / 1000;
        const distanciaMaxima = cfg.maxVelocidadeKmh * decorridoSegundos / 3.6 + 100;
        if (distanciaGPSMetros(anterior, onibus) > distanciaMaxima) {
          contarDescarte("salto_posicao");
          continue;
        }
      }
      anterior = onibus;
    }
    if (anterior) aceitos.push(anterior);
  }
  return aceitos;
}

module.exports = {
  minutoUtc,
  normalizar,
  normalizarComMotivo,
  extrairLista,
  buscarMinuto,
  carregarOnibus,
  metricasDescartesGPS,
  contarDescarte,
  PADRAO,
};

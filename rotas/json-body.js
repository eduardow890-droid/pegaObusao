"use strict";

async function lerJson(req, limiteBytes = 4096) {
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > limiteBytes) {
      const erro = new Error("Corpo da requisição excede o limite.");
      erro.code = "BODY_TOO_LARGE";
      throw erro;
    }
    partes.push(parte);
  }
  const dados = JSON.parse(Buffer.concat(partes).toString("utf8"));
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
    throw new Error("O corpo da requisição deve ser um objeto JSON.");
  }
  return dados;
}

module.exports = { lerJson };

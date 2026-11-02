"use strict";

const fs = require("fs/promises");
const path = require("path");

const LOCK_PATH = path.resolve(__dirname, "..", "data", ".gtfs-update.lock");

async function comBloqueioGtfs(tarefa, caminho = LOCK_PATH) {
  let arquivo;
  try {
    arquivo = await fs.open(caminho, "wx");
  } catch (erro) {
    if (erro.code === "EEXIST") throw new Error("Uma atualização/importação GTFS já está em andamento.");
    throw erro;
  }
  try {
    await arquivo.writeFile(`${process.pid}\n`);
    return await tarefa();
  } finally {
    await arquivo.close();
    await fs.rm(caminho, { force: true });
  }
}

module.exports = { comBloqueioGtfs, LOCK_PATH };

"use strict";

// Processo simples para manter o GTFS atualizado.
// Uso: GTFS_URL="..." npm run agendar-gtfs

const path = require("path");
const { spawn } = require("child_process");

const intervalo = Number(process.env.GTFS_UPDATE_INTERVAL_MS || 7 * 24 * 60 * 60 * 1000);
const script = path.join(__dirname, "atualizar-gtfs.js");

function atualizar() {
  const processo = spawn(process.execPath, [script], { stdio: "inherit", env: process.env });
  processo.on("close", (codigo) => {
    if (codigo !== 0) console.error(`Atualização GTFS terminou com código ${codigo}. Nova tentativa no próximo ciclo.`);
  });
}

if (!process.env.GTFS_URL) {
  console.error("Defina GTFS_URL antes de iniciar o agendador.");
  process.exit(1);
}

atualizar();
setInterval(atualizar, intervalo);
console.log(`Agendador GTFS ativo: atualização a cada ${Math.round(intervalo / 86_400_000)} dia(s).`);


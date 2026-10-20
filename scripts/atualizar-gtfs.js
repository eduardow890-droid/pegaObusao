"use strict";

// Atualiza o GTFS bruto usando GTFS_URL e executa o importador.
// Exemplo: GTFS_URL="https://.../gtfs.zip" npm run atualizar-gtfs

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

async function main() {
  const origem = process.env.GTFS_URL;
  if (!origem) throw new Error("Defina GTFS_URL com o endereço do arquivo GTFS .zip.");
  const resposta = await fetch(origem, { signal: AbortSignal.timeout(120_000) });
  if (!resposta.ok) throw new Error(`Download do GTFS falhou: HTTP ${resposta.status}`);
  const temporario = path.join(os.tmpdir(), `pegaobusao-${Date.now()}.zip`);
  const destino = path.resolve(__dirname, "..", "data", "gtfs");
  fs.mkdirSync(destino, { recursive: true });
  fs.writeFileSync(temporario, Buffer.from(await resposta.arrayBuffer()));
  try {
    await execFileAsync("unzip", ["-o", temporario, "-d", destino]);
  } finally {
    fs.rmSync(temporario, { force: true });
  }
  console.log("GTFS atualizado. Gerando dados da aplicação...");
  await execFileAsync(process.execPath, [path.join(__dirname, "importar-gtfs.js")], { stdio: "inherit" });
}

main().catch((erro) => {
  console.error("Falha ao atualizar GTFS:", erro.message);
  process.exitCode = 1;
});


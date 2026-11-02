"use strict";

// Atualiza o GTFS bruto usando GTFS_URL e executa o importador.
// Exemplo: GTFS_URL="https://.../gtfs.zip" npm run atualizar-gtfs

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { comBloqueioGtfs } = require("./gtfs-lock");
const { importar } = require("./importar-gtfs");
const execFileAsync = promisify(execFile);
const META_PATH = path.resolve(__dirname, "..", "data", "gtfs-meta.json");

function registrarFalha({ downloadSucessoEm, agora = new Date(), metaPath = META_PATH }) {
  const anterior = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
  const temporario = `${metaPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify({
    ...anterior,
    ultimoDownloadSucessoEm: downloadSucessoEm || anterior.ultimoDownloadSucessoEm || null,
    ultimaTentativaDownloadEm: agora.toISOString(),
    resultadoDownload: downloadSucessoEm ? "falha_importacao" : "falha",
  }, null, 2));
  fs.renameSync(temporario, metaPath);
}

async function atualizar({ fetcher = (...args) => fetch(...args), agora = () => new Date() } = {}) {
  const origem = process.env.GTFS_URL;
  if (!origem) throw new Error("Defina GTFS_URL com o endereço do arquivo GTFS .zip.");
  return comBloqueioGtfs(async () => {
    let downloadSucessoEm = null;
    let temporario = null;
    try {
      const resposta = await fetcher(origem, { signal: AbortSignal.timeout(120_000) });
      if (!resposta.ok) throw new Error(`Download do GTFS falhou: HTTP ${resposta.status}`);
      temporario = path.join(os.tmpdir(), `pegaobusao-${process.pid}-${Date.now()}.zip`);
      fs.writeFileSync(temporario, Buffer.from(await resposta.arrayBuffer()));
      downloadSucessoEm = agora().toISOString();
      const destino = path.resolve(__dirname, "..", "data", "gtfs");
      fs.mkdirSync(destino, { recursive: true });
      await execFileAsync("unzip", ["-o", temporario, "-d", destino]);
      await importar({ bloqueioAdquirido: true, downloadSucessoEm });
      console.log("GTFS atualizado. Gerando dados da aplicação...");
    } catch (erro) {
      registrarFalha({ downloadSucessoEm, agora: agora() });
      throw erro;
    } finally {
      if (temporario) fs.rmSync(temporario, { force: true });
    }
  });
}

if (require.main === module) {
  atualizar().catch((erro) => {
    console.error("Falha ao atualizar GTFS:", erro.message);
    process.exitCode = 1;
  });
}

module.exports = { atualizar, registrarFalha };

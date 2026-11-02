const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { comBloqueioGtfs } = require("../scripts/gtfs-lock");
const { registrarFalha } = require("../scripts/atualizar-gtfs");

test("bloqueia uma segunda importação GTFS concorrente", async () => {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "pegaobusao-gtfs-lock-"));
  const caminho = path.join(pasta, "import.lock");
  let liberar;
  const parada = new Promise((resolve) => { liberar = resolve; });
  let iniciou;
  const iniciada = new Promise((resolve) => { iniciou = resolve; });
  try {
    const primeira = comBloqueioGtfs(async () => {
      iniciou();
      await parada;
    }, caminho);
    await iniciada;
    await assert.rejects(comBloqueioGtfs(async () => {}, caminho), /já está em andamento/);
    liberar();
    await primeira;
    await assert.rejects(fs.access(caminho), { code: "ENOENT" });
  } finally {
    liberar?.();
    await fs.rm(pasta, { recursive: true, force: true });
  }
});

test("metadados GTFS preservam o último download bem-sucedido quando uma tentativa falha", async () => {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "pegaobusao-gtfs-meta-"));
  const metaPath = path.join(pasta, "gtfs-meta.json");
  const data = new Date("2026-11-02T12:00:00Z");
  try {
    fsSync.writeFileSync(metaPath, JSON.stringify({ ultimoDownloadSucessoEm: "2026-10-20T10:00:00.000Z" }));
    registrarFalha({ metaPath, agora: data });
    const falha = JSON.parse(fsSync.readFileSync(metaPath, "utf8"));
    assert.equal(falha.ultimoDownloadSucessoEm, "2026-10-20T10:00:00.000Z");
    assert.equal(falha.ultimaTentativaDownloadEm, data.toISOString());
    assert.equal(falha.resultadoDownload, "falha");

    registrarFalha({ metaPath, downloadSucessoEm: data.toISOString(), agora: data });
    const falhaImportacao = JSON.parse(fsSync.readFileSync(metaPath, "utf8"));
    assert.equal(falhaImportacao.ultimoDownloadSucessoEm, data.toISOString());
    assert.equal(falhaImportacao.resultadoDownload, "falha_importacao");
  } finally {
    await fs.rm(pasta, { recursive: true, force: true });
  }
});

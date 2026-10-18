const test = require("node:test");
const assert = require("node:assert/strict");
const { criarServidor } = require("../server");

async function comServidor(opcoes, executar) {
  const servidor = criarServidor(opcoes);
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    await executar(base, servidor);
  } finally {
    await new Promise((resolve, reject) => servidor.close((erro) => erro ? reject(erro) : resolve()));
  }
}

test("endpoint retorna o contrato esperado para o front-end", async () => {
  const onibus = [{ ordem: "A1", linha: "485", lat: -22.9, lng: -43.2, velocidade: 10, hora: 1 }];
  await comServidor({ buscarOnibus: async () => onibus }, async (base) => {
    const resposta = await fetch(`${base}/api/onibus?linha=485`);
    const dados = await resposta.json();
    assert.equal(resposta.status, 200);
    assert.equal(dados.linha, "485");
    assert.equal(dados.total, 1);
    assert.ok(Number.isFinite(Date.parse(dados.atualizadoEm)));
    assert.deepEqual(dados.onibus, onibus);
  });
});

test("valida linha e método HTTP sem consultar a API", async () => {
  let chamadas = 0;
  await comServidor({ buscarOnibus: async () => (chamadas++, []) }, async (base) => {
    const invalida = await fetch(`${base}/api/onibus?linha=%20`);
    const metodo = await fetch(`${base}/api/onibus?linha=485`, { method: "POST" });
    assert.equal(invalida.status, 400);
    assert.equal(metodo.status, 405);
    assert.equal(chamadas, 0);
  });
});

test("requisições simultâneas para a mesma linha compartilham uma consulta", async () => {
  let chamadas = 0;
  let liberar;
  const consultaPendente = new Promise((resolve) => { liberar = resolve; });
  await comServidor({ buscarOnibus: async () => { chamadas++; return consultaPendente; } }, async (base, servidor) => {
    const duasRequisicoes = new Promise((resolve) => {
      let total = 0;
      servidor.on("request", () => { if (++total === 2) resolve(); });
    });
    const primeira = fetch(`${base}/api/onibus?linha=485`);
    const segunda = fetch(`${base}/api/onibus?linha=485`);
    await duasRequisicoes;
    assert.equal(chamadas, 1);
    liberar([]);
    const respostas = await Promise.all([primeira, segunda]);
    assert.deepEqual(respostas.map((r) => r.status), [200, 200]);
  });
});

test("cache respeita o limite configurado e a expiração", async () => {
  let chamadas = 0;
  await comServidor({ buscarOnibus: async () => (chamadas++, []), cacheMax: 1, cacheMs: 60_000 }, async (base) => {
    await fetch(`${base}/api/onibus?linha=485`);
    await fetch(`${base}/api/onibus?linha=232`);
    await fetch(`${base}/api/onibus?linha=485`);
    assert.equal(chamadas, 3);
  });
});

test("cache expira após o prazo configurado", async () => {
  let chamadas = 0;
  let instante = 1_000;
  await comServidor({ buscarOnibus: async () => (chamadas++, []), cacheMs: 100, agora: () => instante }, async (base) => {
    await fetch(`${base}/api/onibus?linha=485`);
    instante += 101;
    await fetch(`${base}/api/onibus?linha=485`);
    assert.equal(chamadas, 2);
  });
});

test("erro da API retorna mensagem segura e status 502", async () => {
  await comServidor({ buscarOnibus: async () => { throw new Error("erro interno confidencial"); }, logger: { error() {} } }, async (base) => {
    const resposta = await fetch(`${base}/api/onibus?linha=485`);
    const dados = await resposta.json();
    assert.equal(resposta.status, 502);
    assert.match(dados.erro, /indisponível/);
    assert.equal(JSON.stringify(dados).includes("confidencial"), false);
  });
});

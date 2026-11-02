const test = require("node:test");
const assert = require("node:assert/strict");
const { desenharFavoritos } = require("../public/favoritos");

function criarDocumento() {
  return {
    createElement(tag) {
      return {
        tag,
        children: [],
        attributes: {},
        listeners: {},
        setAttribute(nome, valor) { this.attributes[nome] = valor; },
        addEventListener(nome, callback) { this.listeners[nome] = callback; },
        append(...itens) { this.children.push(...itens); },
      };
    },
  };
}

function criarContainer() {
  return {
    children: [],
    replaceChildren() { this.children = []; },
    append(item) { this.children.push(item); },
  };
}

test("favoritos vazios mostram uma mensagem acessível", () => {
  const container = criarContainer();
  const resultado = desenharFavoritos({ documento: criarDocumento(), container, linhas: [] });
  assert.equal(resultado.total, 0);
  assert.equal(container.children[0].textContent, "Você ainda não tem linhas favoritas.");
});

test("favoritos permitem abrir e remover linhas por controles nomeados", () => {
  const container = criarContainer();
  const documento = criarDocumento();
  const abriu = [];
  const removeu = [];
  desenharFavoritos({
    documento,
    container,
    linhas: ["485", "349"],
    aoAbrir: (linha) => abriu.push(linha),
    aoRemover: (linha) => removeu.push(linha),
  });
  const linha485 = container.children[0];
  assert.equal(linha485.attributes.role, "listitem");
  assert.equal(linha485.children[0].attributes["aria-label"], "Abrir linha 485");
  linha485.children[0].listeners.click();
  linha485.children[1].listeners.click();
  assert.deepEqual(abriu, ["485"]);
  assert.deepEqual(removeu, ["485"]);
});

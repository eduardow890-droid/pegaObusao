(function disponibilizar(root, fabrica) {
  const api = fabrica();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PegaObusaoFavoritos = api;
}(globalThis, function criarApiFavoritos() {
  function desenharFavoritos({ documento, container, linhas, aoAbrir, aoRemover }) {
    container.replaceChildren();
    if (!linhas.length) {
      const vazio = documento.createElement("p");
      vazio.className = "favoritos-vazio";
      vazio.textContent = "Você ainda não tem linhas favoritas.";
      container.append(vazio);
      return { total: 0 };
    }

    linhas.forEach((linha) => {
      const item = documento.createElement("div");
      item.className = "favorito";
      item.setAttribute("role", "listitem");
      const abrir = documento.createElement("button");
      abrir.type = "button";
      abrir.textContent = linha;
      abrir.setAttribute("aria-label", `Abrir linha ${linha}`);
      abrir.addEventListener("click", () => aoAbrir(linha));
      const remover = documento.createElement("button");
      remover.type = "button";
      remover.textContent = "Remover";
      remover.setAttribute("aria-label", `Remover linha ${linha} dos favoritos`);
      remover.addEventListener("click", () => aoRemover(linha));
      item.append(abrir, remover);
      container.append(item);
    });
    return { total: linhas.length };
  }

  return { desenharFavoritos };
}));

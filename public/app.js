  const mapa = new maplibregl.Map({
    container: "mapa",
    center: [-43.2096, -22.9035], // Rio de Janeiro
    zoom: 11,
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: [document.querySelector('meta[name="map-tiles-url"]').content],
          tileSize: 256,
          attribution: "© Colaboradores do OpenStreetMap",
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
  });
  mapa.addControl(new maplibregl.NavigationControl(), "bottom-right");
  const DISTANCIA_MAXIMA_AJUSTE_ROTA_METROS = 300;

  const ICONE_ONIBUS =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="15" rx="3" fill="#14202E"/>' +
    '<rect x="6" y="6" width="12" height="5" rx="1" fill="#F2B01E"/><circle cx="8.5" cy="14.5" r="1.3" fill="#F2B01E"/>' +
    '<circle cx="15.5" cy="14.5" r="1.3" fill="#F2B01E"/><rect x="6" y="18" width="3" height="3" rx="1" fill="#14202E"/>' +
    '<rect x="15" y="18" width="3" height="3" rx="1" fill="#14202E"/></svg>';

  const statusEl = document.getElementById("status");
  const inputEl = document.getElementById("linha");
  const buscarBtn = document.querySelector(".busca button");
  const atualizarBtn = document.getElementById("atualizar");
  const favoritarBtn = document.getElementById("favoritar");
  const intervaloEl = document.getElementById("intervalo");
  const sentidoEl = document.getElementById("sentido");
  const sentidoSelect = document.getElementById("sentido-select");
  const sentidoOpcoesEl = document.getElementById("sentido-opcoes");
  const menuOpcoesEl = document.getElementById("menu-opcoes");
  const abrirMenuBtn = document.getElementById("abrir-menu");
  const painelEl = document.getElementById("form");
  const alternarPainelBtn = document.getElementById("alternar-painel");
  const painelResumoEl = document.getElementById("painel-resumo");
  const resultadoCardEl = document.getElementById("resultado-card");
  const estimativaEl = document.getElementById("estimativa");
  const resultadoLinhaEl = document.getElementById("resultado-linha");
  const resultadoParadaEl = document.getElementById("resultado-parada");
  const resultadoDetalheEl = document.getElementById("resultado-detalhe");
  const contadorEl = document.getElementById("contador");
  const tentarBtn = document.getElementById("tentar-novamente");
  const tentarGtfsBtn = document.getElementById("tentar-gtfs");
  const gtfsStatusEl = document.getElementById("gtfs-status");
  const favoritosEl = document.getElementById("favoritos");
  const compartilharBtn = document.getElementById("compartilhar");
  const enderecoEl = document.getElementById("endereco");
  const enderecosEl = document.getElementById("enderecos");
  const paradasBtn = document.getElementById("buscar-paradas");
  let marcadores = [];
  const marcadoresPorOrdem = new Map();
  let paradas = [];
  let paradasLinha = [];
  let sequencia = 0;       // muda a cada nova busca de linha: respostas antigas são ignoradas
  let controlador = null;  // permite cancelar a requisição em andamento
  let timer = null;
  let primeiraVez = true;
  let ultimaBoa = null;    // hora da última atualização bem-sucedida
  let ultimaConsultaGps = null;
  let linhaAtual = null;
  let intervaloMs = Number(intervaloEl.value);
  let localizacaoMarker = null;
  let dadosLinhaAtual = null;
  let indiceSentido = null;
  let ultimoDadosOnibus = null;
  let localizacao = null;
  let pontoEndereco = null;
  let estimativaAtual = null;
  let contadorTimer = null;
  let wakeLock = null;
  let cicloRodando = false;
  let emSegundoPlano = false;

  function arredondarCoordenada(valor) { return Math.round(valor * 1000) / 1000; }

  function aplicarEstado(estado, persistir = true) {
    const valido = ["aberto", "compacto", "oculto"].includes(estado) ? estado : "aberto";
    painelEl.classList.remove("estado-aberto", "estado-compacto", "estado-oculto");
    painelEl.classList.add(`estado-${valido}`);
    document.body.classList.toggle("painel-compacto", valido !== "aberto");
    document.body.classList.toggle("painel-oculto", valido === "oculto");
    alternarPainelBtn.setAttribute("aria-expanded", String(valido !== "oculto"));
    alternarPainelBtn.textContent = valido === "aberto" ? "⌃ Ocultar painel" : "⌄ Mostrar painel";
    if (persistir) {
      try { localStorage.setItem("pegaobusao:painel", valido); } catch {}
    }
    setTimeout(() => {
      mapa.resize();
      if (marcadores.length > 1) {
        const limites = new maplibregl.LngLatBounds();
        marcadores.forEach((marcador) => limites.extend(marcador.getLngLat()));
        mapa.fitBounds(limites, { padding: margens(), maxZoom: 15, duration: 0 });
      }
    }, 50);
    return valido;
  }

  function estadoPainel() {
    return ["aberto", "compacto", "oculto"].find((estado) => painelEl.classList.contains(`estado-${estado}`)) || "aberto";
  }

  function abrirPainel() {
    if (estadoPainel() === "oculto") aplicarEstado("compacto");
  }

  function atualizarResumoPainel() {
    const total = ultimoDadosOnibus?.onibus?.length;
    painelResumoEl.textContent = linhaAtual ? `${linhaAtual} · ${Number.isFinite(total) ? total : "aguardando"} ônibus` : "Escolha uma linha";
  }

  function mostrarResultado(linha, texto = "") {
    resultadoCardEl.hidden = false;
    resultadoCardEl.classList.remove("instrucao", "estimativa", "erro");
    resultadoCardEl.classList.add("instrucao");
    resultadoLinhaEl.textContent = linha ? `Linha ${linha}${indiceSentido !== null && dadosLinhaAtual?.variantes?.[indiceSentido]?.destino ? ` · ${dadosLinhaAtual.variantes[indiceSentido].destino}` : ""}` : "";
    estimativaEl.textContent = indiceSentido === null ? "Escolha o sentido" : localizacao ? "Consultando…" : "Toque em Usar minha localização";
    if (texto) resultadoParadaEl.textContent = "";
    resultadoDetalheEl.textContent = texto;
    atualizarResumoPainel();
  }

  function atualizarContador() {
    clearInterval(contadorTimer);
    if (!linhaAtual || emSegundoPlano) { contadorEl.textContent = ""; return; }
    let restante = Math.max(0, Math.ceil(intervaloMs / 1000));
    contadorEl.textContent = `Atualiza em ${restante} s · Atualizar agora`;
    contadorTimer = setInterval(() => {
      restante -= 1;
      contadorEl.textContent = restante > 0 ? `Atualiza em ${restante} s · Atualizar agora` : "Atualizando agora…";
      if (restante <= 0) clearInterval(contadorTimer);
    }, 1000);
  }

  async function manterTelaAcesa() {
    if (!navigator.wakeLock?.request || document.visibilityState !== "visible") return;
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
  }

  const hhmm = (d) => d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function limpar() {
    marcadoresPorOrdem.forEach((m) => {
      cancelAnimationFrame(m.__anim);
      m.remove();
    });
    marcadoresPorOrdem.clear();
    marcadores = [];
  }

  function moverSuave(marcador, destino, ms = 900) {
    const origem = marcador.getLngLat();
    cancelAnimationFrame(marcador.__anim);
    const inicio = performance.now();
    const passo = (agora) => {
      const fator = Math.min(1, (agora - inicio) / ms);
      marcador.setLngLat([
        origem.lng + (destino[0] - origem.lng) * fator,
        origem.lat + (destino[1] - origem.lat) * fator,
      ]);
      if (fator < 1) marcador.__anim = requestAnimationFrame(passo);
    };
    marcador.__anim = requestAnimationFrame(passo);
  }

  function limparParadas() {
    paradas.forEach((m) => m.remove());
    paradas = [];
  }

  function limparRotaLinha() {
    const fonte = mapa.getSource("rota-linha");
    if (fonte) fonte.setData({ type: "FeatureCollection", features: [] });
    paradasLinha.forEach((m) => m.remove());
    paradasLinha = [];
  }

  function mostrar(texto, erro) {
    statusEl.textContent = texto;
    statusEl.classList.toggle("erro", !!erro);
    statusEl.classList.toggle("secundario", !!linhaAtual);
    tentarBtn.hidden = !erro || !linhaAtual;
    if (resultadoCardEl && linhaAtual) {
      resultadoLinhaEl.textContent = `Linha ${linhaAtual}${indiceSentido !== null && dadosLinhaAtual?.variantes?.[indiceSentido]?.destino ? ` · ${dadosLinhaAtual.variantes[indiceSentido].destino}` : ""}`;
      if (erro) {
        resultadoCardEl.className = "resultado-cartao erro";
        estimativaEl.textContent = "Não foi possível atualizar";
        resultadoDetalheEl.textContent = texto;
        abrirPainel();
      } else if (resultadoCardEl.classList.contains("instrucao")) resultadoDetalheEl.textContent = texto;
    }
  }

  function escapar(texto) {
    return String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function idadeTexto(hora) {
    if (!hora) return "horário indisponível";
    const minutos = Math.max(0, Math.round((Date.now() - hora) / 60000));
    return minutos === 0 ? "agora" : `há ${minutos} min`;
  }

  function favoritos() {
    try { return JSON.parse(localStorage.getItem("pegaobusao:favoritos") || "[]"); }
    catch { return []; }
  }

  function desenharFavoritos() {
    PegaObusaoFavoritos.desenharFavoritos({
      documento: document,
      container: favoritosEl,
      linhas: favoritos().slice(0, 10),
      aoAbrir: (linha) => buscar(linha),
      aoRemover: (linha) => {
        localStorage.setItem("pegaobusao:favoritos", JSON.stringify(favoritos().filter((item) => item !== linha)));
        desenharFavoritos();
        atualizarFavorito();
      },
    });
  }

  function atualizarFavorito() {
    const ativo = linhaAtual && favoritos().includes(linhaAtual);
    favoritarBtn.disabled = !linhaAtual;
    favoritarBtn.textContent = ativo ? "★" : "☆";
    favoritarBtn.title = ativo ? "Remover linha dos favoritos" : "Favoritar linha";
    favoritarBtn.setAttribute("aria-label", favoritarBtn.title);
  }

  function adicionarRota(geometria) {
    const fonte = mapa.getSource("rota");
    if (fonte) {
      fonte.setData({ type: "Feature", properties: {}, geometry: geometria });
    } else {
      mapa.addSource("rota", { type: "geojson", data: { type: "Feature", properties: {}, geometry: geometria } });
      mapa.addLayer({ id: "rota", type: "line", source: "rota", paint: { "line-color": "#F2B01E", "line-width": 5, "line-opacity": .8 } });
    }
  }

  function adicionarRotaDaLinha(dados, indice) {
    const variante = dados.variantes[indice];
    if (!variante) return;
    const features = variante.rota ? [{
      type: "Feature",
      properties: { destino: variante.destino || "Sentido não informado", sentido: variante.sentido || "" },
      geometry: variante.rota,
    }] : [];
    const geojson = { type: "FeatureCollection", features };
    const fonte = mapa.getSource("rota-linha");
    if (fonte) {
      fonte.setData(geojson);
    } else {
      mapa.addSource("rota-linha", { type: "geojson", data: geojson });
    }
    if (!mapa.getLayer("rota-linha-contorno")) {
      mapa.addLayer({
        id: "rota-linha-contorno",
        type: "line",
        source: "rota-linha",
        layout: { "line-join": "miter", "line-cap": "butt" },
        paint: { "line-color": "#14202E", "line-width": 10, "line-opacity": .95 },
      });
    }
    if (!mapa.getLayer("rota-linha")) {
      mapa.addLayer({
        id: "rota-linha",
        type: "line",
        source: "rota-linha",
        layout: { "line-join": "miter", "line-cap": "butt" },
        paint: { "line-color": "#F2B01E", "line-width": 5, "line-opacity": .95 },
      });
    }
    variante.paradas.forEach((parada, ordem) => {
      const el = document.createElement("div");
      el.className = "parada";
      el.setAttribute("aria-label", `Parada ${ordem + 1}: ${parada.nome}`);
      const marcador = new maplibregl.Marker({ element: el })
        .setLngLat([parada.lng, parada.lat])
        .setPopup(new maplibregl.Popup({ offset: 15 }).setText(`${ordem + 1}. ${parada.nome}`))
        .addTo(mapa);
      paradasLinha.push(marcador);
    });
  }

  function sentidoDoOnibus(onibus) {
    if (!dadosLinhaAtual?.variantes?.length) return null;
    const texto = `${onibus.destino || ""} ${onibus.sentido || ""}`.toUpperCase();
    const porTrip = dadosLinhaAtual.variantes.findIndex((v) => v.tripIds?.includes(onibus.tripId));
    if (porTrip >= 0) return porTrip;
    const porDirecao = dadosLinhaAtual.variantes.findIndex((v) => v.sentido && v.sentido === onibus.directionId);
    if (porDirecao >= 0) return porDirecao;
    if (texto.trim()) {
      const porTexto = dadosLinhaAtual.variantes.findIndex((v) => {
        const alvo = `${v.destino || ""} ${v.sentido || ""}`.toUpperCase();
        return alvo.trim() && (texto.includes(alvo) || alvo.includes(texto));
      });
      if (porTexto >= 0) return porTexto;
    }
    let melhor = null;
    dadosLinhaAtual.variantes.forEach((variante, indice) => {
      const coordenadas = variante.rota?.coordinates || [];
      if (!coordenadas.length) return;
      const posicao = PegaObusaoMapa.projetarPonto(coordenadas, onibus);
      if (posicao && (!melhor || posicao.distanciaMetros < melhor.distancia)) {
        melhor = { indice, distancia: posicao.distanciaMetros };
      }
    });
    return melhor && melhor.distancia <= 1500 ? melhor.indice : null;
  }

  function onibusDoSentido(onibus) {
    return onibus.filter((item) => sentidoDoOnibus(item) === indiceSentido);
  }

  function ajustarOnibusAoTrajeto(onibus) {
    const variantes = dadosLinhaAtual?.variantes || [];
    if (!variantes.some((variante) => variante.rota?.coordinates?.length >= 2)) return onibus;
    const indiceVariante = indiceSentido === null ? sentidoDoOnibus(onibus) : indiceSentido;
    const coordenadas = variantes[indiceVariante]?.rota?.coordinates || [];
    if (coordenadas.length < 2) return null;
    const posicao = PegaObusaoMapa.ajustarAoTrajeto(
      onibus,
      [coordenadas],
      DISTANCIA_MAXIMA_AJUSTE_ROTA_METROS,
    );
    if (!posicao) return null;
    return { ...onibus, lat: posicao.lat, lng: posicao.lng };
  }

  async function carregarDadosDaLinha(linha, seq) {
    limparRotaLinha();
    dadosLinhaAtual = null;
    indiceSentido = null;
    sentidoSelect.replaceChildren(new Option("Escolha um destino", ""));
    sentidoOpcoesEl.replaceChildren();
    sentidoSelect.disabled = true;
    sentidoEl.classList.add("oculto");
    try {
      const dados = await jsonApi(`/api/linha?linha=${encodeURIComponent(linha)}`);
      if (seq !== sequencia) return;
      dadosLinhaAtual = dados;
      dados.variantes.forEach((variante, indice) => {
        const destino = variante.destino || `Sentido ${variante.sentido || indice + 1}`;
        sentidoSelect.append(new Option(destino, String(indice)));
        const botao = document.createElement("button");
        botao.type = "button";
        botao.textContent = destino;
        botao.setAttribute("aria-pressed", "false");
        botao.addEventListener("click", () => {
          sentidoSelect.value = String(indice);
          sentidoSelect.dispatchEvent(new Event("change"));
        });
        sentidoOpcoesEl.append(botao);
      });
      sentidoSelect.disabled = false;
      sentidoEl.classList.remove("oculto");
      tentarGtfsBtn.hidden = true;
      gtfsStatusEl.hidden = true;
      gtfsStatusEl.textContent = "";
      mostrar("Escolha o destino para mostrar apenas as paradas e os ônibus daquele sentido.");
      mostrarResultado(linha);
    } catch (erro) {
      if (seq !== sequencia) return;
      gtfsStatusEl.textContent = `Não foi possível carregar linhas e paradas do GTFS. ${erro.message}`;
      gtfsStatusEl.hidden = false;
      tentarBtn.hidden = true;
      tentarGtfsBtn.hidden = false;
    }
  }

  function enquadrarPontos(pontos) {
    const limites = new maplibregl.LngLatBounds();
    pontos.forEach((p) => limites.extend([p.lng, p.lat]));
    mapa.fitBounds(limites, { padding: margens(), maxZoom: 15 });
  }

  async function jsonApi(url, opcoes) {
    const resposta = await fetch(url, opcoes);
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(dados.erro || "Serviço indisponível.");
    return dados;
  }

  function formatarDistancia(metros) {
    if (!Number.isFinite(metros)) return "distância indisponível";
    return metros >= 1000 ? `${(metros / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(metros)} m`;
  }

  function aplicarDestaque(ordens = []) {
    marcadores.forEach((marcador) => {
      const ordem = marcador.__ordem;
      marcador.getElement().classList.toggle("destaque", ordens.includes(ordem));
    });
  }

  async function atualizarEstimativa() {
    if (!linhaAtual || indiceSentido === null) return;
    if (!localizacao) {
      resultadoCardEl.className = "resultado-cartao instrucao";
      estimativaEl.textContent = "Toque em Usar minha localização";
      resultadoParadaEl.textContent = "A localização ajuda a encontrar sua parada mais próxima.";
      resultadoDetalheEl.textContent = "A posição fica no navegador e não é armazenada.";
      return;
    }
    if (localizacao.accuracy > 500) {
      resultadoCardEl.className = "resultado-cartao instrucao";
      estimativaEl.textContent = "Localização pouco precisa";
      resultadoParadaEl.textContent = "Sua localização está pouco precisa.";
      resultadoDetalheEl.textContent = "Digite um endereço para melhorar o resultado.";
      return;
    }
    resultadoCardEl.className = "resultado-cartao instrucao";
    estimativaEl.textContent = "Consultando chegada…";
    try {
      const dados = await jsonApi(`/api/chegada?linha=${encodeURIComponent(linhaAtual)}&variante=${indiceSentido}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: arredondarCoordenada(localizacao.lat), lng: arredondarCoordenada(localizacao.lng) }),
      });
      estimativaAtual = dados;
      if (!dados.disponivel) {
        resultadoCardEl.className = "resultado-cartao instrucao";
        estimativaEl.textContent = "Nenhum ônibus a caminho";
        resultadoParadaEl.textContent = dados.parada ? `Parada mais próxima: ${dados.parada.nome}` : "Nenhuma parada encontrada nesse sentido.";
        resultadoDetalheEl.textContent = dados.motivo || "Importe os dados oficiais (GTFS) para ver a estimativa de chegada.";
        aplicarDestaque([]);
        return;
      }
      if (dados.confiavel === false) {
        resultadoCardEl.className = "resultado-cartao instrucao";
        estimativaEl.textContent = "Sem previsão confiável";
        resultadoParadaEl.textContent = `Parada ${dados.parada?.nome || "mais próxima"} · ônibus a ${formatarDistancia(dados.onibus?.[0]?.distanciaMetros)}`;
        resultadoDetalheEl.textContent = dados.motivo || "Velocidade do ônibus indisponível.";
        aplicarDestaque([]);
        return;
      }
      const faixa = dados.estimativa;
      const primeiro = dados.onibus?.[0];
      const seguinte = dados.onibus?.[1];
      resultadoCardEl.className = "resultado-cartao estimativa";
      estimativaEl.textContent = `Chega em ${faixa.minimo} a ${faixa.maximo} min`;
      resultadoParadaEl.textContent = `Parada ${dados.parada.nome || "mais próxima"} · ônibus a ${formatarDistancia(primeiro?.distanciaMetros)}`;
      resultadoDetalheEl.textContent = `${dados.aviso || `Atualizado há ${primeiro?.sinalSegundos || 0} s`}${seguinte ? " · há outro ônibus depois" : ""}${dados.comparacaoCaminhada ? ` · ${dados.comparacaoCaminhada.mensagem}` : ""}`;
      aplicarDestaque((dados.onibus || []).map((item) => String(item.ordem)));
    } catch (erro) {
      resultadoCardEl.className = "resultado-cartao erro";
      estimativaEl.textContent = "Não foi possível estimar";
      resultadoParadaEl.textContent = "Não foi possível consultar a estimativa agora.";
      resultadoDetalheEl.textContent = erro.message.includes("GTFS") ? erro.message : "Importe os dados oficiais (GTFS) para ver a estimativa de chegada.";
      aplicarDestaque([]);
    }
  }

  function mostrarEnderecos(resultados) {
    enderecosEl.replaceChildren();
    resultados.forEach((resultado) => {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.textContent = resultado.nome;
      botao.addEventListener("click", () => {
        pontoEndereco = resultado;
        localizacao = { lat: resultado.lat, lng: resultado.lng, accuracy: 100 };
        mapa.flyTo({ center: [resultado.lng, resultado.lat], zoom: 15 });
        paradasBtn.disabled = false;
        enderecoEl.value = resultado.nome;
        mostrar(`Endereço selecionado. Você pode ver as paradas próximas.`);
        atualizarEstimativa();
      });
      enderecosEl.append(botao);
    });
  }

  async function carregarParadas(ponto) {
    mostrar("Buscando paradas próximas…");
    try {
      const resultados = await jsonApi("/api/paradas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: arredondarCoordenada(ponto.lat), lng: arredondarCoordenada(ponto.lng), raio: 800 }),
      });
      limparParadas();
      resultados.forEach((parada) => {
        const el = document.createElement("div");
        el.className = "parada";
        el.setAttribute("aria-label", `Parada ${parada.nome}`);
        const marcador = new maplibregl.Marker({ element: el }).setLngLat([parada.lng, parada.lat]).setPopup(new maplibregl.Popup({ offset: 15 }).setText(`${parada.nome}${parada.linhas ? ` · Linhas: ${parada.linhas}` : ""}`)).addTo(mapa);
        paradas.push(marcador);
      });
      if (resultados.length) enquadrarPontos([ponto, ...resultados]);
      mostrar(resultados.length ? `${resultados.length} parada(s) encontrada(s) em até 800 metros.` : "Nenhuma parada encontrada nessa área.");
    } catch (erro) {
      mostrar(`Não foi possível buscar paradas. ${erro.message}`, true);
    }
  }

  function definirLocalizacao(coords, buscarParadasAutomaticamente = false) {
    localizacao = { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy };
    pontoEndereco = localizacao;
    localizacaoMarker?.remove();
    const el = document.createElement("div");
    el.setAttribute("aria-label", "Sua localização");
    el.style.cssText = "width:18px;height:18px;border-radius:0;background:#2F6FED;border:3px solid white;box-shadow:none";
    localizacaoMarker = new maplibregl.Marker({ element: el }).setLngLat([coords.longitude, coords.latitude]).addTo(mapa);
    paradasBtn.disabled = false;
    if (buscarParadasAutomaticamente) {
      mapa.flyTo({ center: [coords.longitude, coords.latitude], zoom: 14 });
      carregarParadas(localizacao);
    } else {
      mapa.flyTo({ center: [coords.longitude, coords.latitude], zoom: 14 });
      mostrar("Sua localização foi mostrada no mapa.");
    }
    atualizarEstimativa();
    manterTelaAcesa();
  }

  function buscarParadasSeAutorizado() {
    if (!navigator.geolocation || !navigator.permissions?.query) return;
    navigator.permissions.query({ name: "geolocation" }).then((permissao) => {
      if (permissao.state !== "granted") return;
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => definirLocalizacao(coords, true),
        () => mostrar("Não foi possível obter sua localização. Verifique a permissão do navegador.", true),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    }).catch((erro) => console.warn("Não foi possível verificar a permissão de localização:", erro));
  }

  async function geocodificar(valor) {
    const resultados = await jsonApi(`/api/endereco?q=${encodeURIComponent(valor)}`);
    if (!resultados.length) throw new Error(`Endereço não encontrado: ${valor}`);
    return resultados[0];
  }

  // Margens do enquadramento: deixa o painel e a marca livres
  function margens() {
    return innerWidth >= 700
      ? (estadoPainel() === "oculto" ? { top: 60, bottom: 60, left: 80, right: 60 } : { top: 60, bottom: 60, left: 420, right: 60 })
      : { top: 90, bottom: estadoPainel() === "aberto" ? Math.round(innerHeight * .42) + 20 : 85, left: 40, right: 40 };
  }

  function desenhar(dados, linha) {
    ultimaConsultaGps = new Date(dados.ultimaConsultaEm || Date.now());
    ultimaBoa = new Date(dados.obtidoEm || dados.atualizadoEm || Date.now());
    ultimoDadosOnibus = dados;
    mostrarResultado(linha);
    atualizarResumoPainel();
    const porSentido = indiceSentido === null ? dados.onibus : onibusDoSentido(dados.onibus);
    const alinhados = porSentido.map(ajustarOnibusAoTrajeto).filter(Boolean);
    const foraDoTrajeto = porSentido.length - alinhados.length;
    dados = { ...dados, total: alinhados.length, foraDoTrajeto, onibus: alinhados };
    if (dados.total === 0) {
      limpar();
      mostrar(foraDoTrajeto
        ? `Posições de ônibus muito distantes do trajeto foram ocultadas (${foraDoTrajeto}). Aguardando GPS mais preciso.`
        : dados.desatualizado
        ? `Nenhum ônibus ativo na última resposta. Última consulta às ${hhmm(ultimaConsultaGps)}; último sucesso ${idadeTexto(ultimaBoa.getTime())}.`
        : "Nenhum ônibus ativo indo para esse destino agora.");
      return;
    }
    const ordensAtuais = new Set(dados.onibus.map((o) => String(o.ordem)));
    marcadoresPorOrdem.forEach((marcador, ordem) => {
      if (!ordensAtuais.has(ordem)) {
        cancelAnimationFrame(marcador.__anim);
        marcador.remove();
        marcadoresPorOrdem.delete(ordem);
      }
    });
    const limites = new maplibregl.LngLatBounds();
    dados.onibus.forEach((o) => {
      const ordem = String(o.ordem);
      let marcador = marcadoresPorOrdem.get(ordem);
      let el;
      if (marcador) {
        el = marcador.getElement();
      } else {
        el = document.createElement("div");
        marcador = new maplibregl.Marker({ element: el }).setLngLat([o.lng, o.lat]).addTo(mapa);
        marcador.__ordem = ordem;
        marcadoresPorOrdem.set(ordem, marcador);
      }
      const velocidadeTexto = Number.isFinite(o.velocidade) ? `${Math.round(o.velocidade)} km/h` : "velocidade indisponível";
      el.className = "onibus" + (o.velocidade === 0 ? " parado" : "") + (dados.desatualizado ? " antigo" : "");
      const atualizado = o.hora ? hhmm(new Date(o.hora)) : "horário indisponível";
      const destino = o.destino || o.sentido || "Não informado pela API";
      el.title = `Ordem ${o.ordem} · ${velocidadeTexto} · ${atualizado}`;
      el.setAttribute("aria-label", `Ônibus ${o.ordem}, ${velocidadeTexto}, atualizado às ${atualizado}`);
      el.innerHTML = ICONE_ONIBUS;
      moverSuave(marcador, [o.lng, o.lat]);
      const conteudo = document.createElement("div");
      [`Linha ${linha}`, `Ordem: ${o.ordem}`, `Destino/sentido: ${destino}`, `Velocidade: ${velocidadeTexto}`, `Atualização: ${idadeTexto(o.hora)}`].forEach((texto) => {
        const linhaPopup = document.createElement("div");
        linhaPopup.textContent = texto;
        conteudo.append(linhaPopup);
      });
      marcador.setPopup(new maplibregl.Popup({ offset: 18 }).setDOMContent(conteudo));
      limites.extend([o.lng, o.lat]);
    });
    marcadores = [...marcadoresPorOrdem.values()];
    if (primeiraVez) {
      mapa.fitBounds(limites, { padding: margens(), maxZoom: 15 });
      primeiraVez = false;
    }
    // Avisa se o GPS mais recente já está velho
    const maisNovo = Math.max(...dados.onibus.map((o) => o.hora || 0));
    const idadeMin = maisNovo ? Math.round((Date.now() - maisNovo) / 60000) : 0;
    const aviso = idadeMin >= 3 ? ` Atenção: o sinal mais recente tem ${idadeMin} min.` : "";
    const refinamento = indiceSentido === null ? " Escolha um sentido para refinar o mapa." : "";
    const situacao = dados.desatualizado
      ? `Última consulta às ${hhmm(ultimaConsultaGps)}; usando última consulta com sucesso ${idadeTexto(ultimaBoa.getTime())} (${Math.floor((dados.idadeSegundos || 0) / 60)} min atrás).`
      : `Última consulta às ${hhmm(ultimaConsultaGps)}; última consulta com sucesso às ${hhmm(ultimaBoa)}.`;
    const avisoTrajeto = dados.foraDoTrajeto
      ? ` ${dados.foraDoTrajeto} posição(ões) muito distantes do trajeto foram ocultadas.`
      : "";
    mostrar(`${dados.total} ônibus da linha ${linha}. ${situacao} Sinal ${idadeTexto(maisNovo)}.${refinamento}${aviso}${avisoTrajeto}`, Boolean(dados.desatualizado) || idadeMin >= 3 || Boolean(dados.foraDoTrajeto));
    atualizarEstimativa();
  }

  async function atualizar(linha, seq) {
    const meu = new AbortController();
    controlador = meu;
    buscarBtn.disabled = true;
    // O backend pode fazer duas tentativas de até 15 s na API da SMTR.
    // O navegador precisa aguardar mais que esse ciclo antes de cancelar.
    const prazo = setTimeout(() => meu.abort(), 35_000);
    try {
      const r = await fetch("/api/onibus?linha=" + encodeURIComponent(linha), { signal: meu.signal });
      const dados = await r.json().catch(() => ({}));
      ultimaConsultaGps = new Date();
      if (seq !== sequencia) return; // o usuário já trocou de linha
      if (!r.ok) throw new Error(dados.erro || "Falha ao buscar ônibus.");
      desenhar(dados, linha);
      atualizarContador();
    } catch (e) {
      if (seq !== sequencia) return;
      // Marcadores antigos ficam esmaecidos para não parecerem atuais
      marcadores.forEach((m) => m.getElement().classList.add("antigo"));
      const quando = ultimaBoa ? ` Última consulta: ${hhmm(ultimaConsultaGps || new Date())}; última consulta com sucesso ${idadeTexto(ultimaBoa.getTime())} (ônibus esmaecidos).` : "";
      const motivo = e.name === "AbortError" ? "Tempo esgotado." : e.message;
      mostrar(`⚠ Não consegui atualizar. ${motivo}${quando}`, true);
    } finally {
      clearTimeout(prazo);
      if (seq === sequencia) buscarBtn.disabled = false;
      if (seq === sequencia) atualizarBtn.disabled = false;
    }
  }

  // Uma consulta por vez: a próxima só começa 15 s depois de a anterior terminar.
  async function ciclo(linha, seq) {
    cicloRodando = true;
    try {
      while (seq === sequencia) {
        if (emSegundoPlano) return;
        await atualizar(linha, seq);
        if (seq !== sequencia) return;
        await new Promise((ok) => { timer = setTimeout(ok, intervaloMs); });
      }
    } finally { cicloRodando = false; }
  }

  function buscar(valor) {
    valor = valor.trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(valor)) {
      mostrar("Informe uma linha válida, por exemplo 485.", true);
      inputEl.focus();
      return;
    }
    inputEl.value = valor;
    linhaAtual = valor;
    atualizarBtn.disabled = false;
    atualizarFavorito();
    ultimoDadosOnibus = null;
    history.replaceState(null, "", "?linha=" + encodeURIComponent(valor));
    sequencia += 1;
    clearTimeout(timer);
    controlador?.abort();
    limpar();
    ultimaBoa = null;
    primeiraVez = true;
    mostrar("Buscando…");
    mostrarResultado(valor, "Carregando ônibus e sentidos…");
    manterTelaAcesa();
    carregarDadosDaLinha(valor, sequencia);
    ciclo(valor, sequencia);
  }

  document.getElementById("form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    buscar(document.getElementById("linha").value);
  });
  document.querySelectorAll("[data-linha]").forEach((b) =>
    b.addEventListener("click", () => buscar(b.dataset.linha))
  );
  sentidoSelect.addEventListener("change", () => {
    indiceSentido = sentidoSelect.value === "" ? null : Number(sentidoSelect.value);
    sentidoOpcoesEl.querySelectorAll("button").forEach((botao, indice) => {
      const ativo = indice === indiceSentido;
      botao.classList.toggle("ativo", ativo);
      botao.setAttribute("aria-pressed", String(ativo));
    });
    limparRotaLinha();
    if (dadosLinhaAtual && indiceSentido !== null) {
      if (mapa.isStyleLoaded()) adicionarRotaDaLinha(dadosLinhaAtual, indiceSentido);
      else mapa.once("load", () => adicionarRotaDaLinha(dadosLinhaAtual, indiceSentido));
    }
    if (ultimoDadosOnibus && linhaAtual) desenhar(ultimoDadosOnibus, linhaAtual);
    atualizarEstimativa();
  });
  alternarPainelBtn.addEventListener("click", () => {
    const proximo = { aberto: "compacto", compacto: "oculto", oculto: "aberto" }[estadoPainel()];
    aplicarEstado(proximo);
  });
  let inicioArraste = null;
  alternarPainelBtn.addEventListener("pointerdown", (evento) => { inicioArraste = evento.clientY; alternarPainelBtn.setPointerCapture?.(evento.pointerId); });
  alternarPainelBtn.addEventListener("pointerup", (evento) => {
    if (inicioArraste === null) return;
    const delta = evento.clientY - inicioArraste;
    inicioArraste = null;
    if (Math.abs(delta) < 20) return;
    aplicarEstado(delta < 0 ? (estadoPainel() === "aberto" ? "compacto" : "oculto") : "aberto");
  });
  atualizarBtn.addEventListener("click", () => {
    if (!linhaAtual) return;
    clearTimeout(timer);
    controlador?.abort();
    mostrar("Atualizando…");
    atualizar(linhaAtual, sequencia);
  });
  tentarBtn.addEventListener("click", () => {
    if (!linhaAtual) return;
    clearTimeout(timer);
    mostrar("Atualizando…");
    atualizar(linhaAtual, sequencia);
  });
  tentarGtfsBtn.addEventListener("click", () => {
    if (!linhaAtual) return;
    tentarGtfsBtn.disabled = true;
    statusEl.textContent = "Carregando novamente os dados de linhas e paradas…";
    carregarDadosDaLinha(linhaAtual, sequencia).finally(() => { tentarGtfsBtn.disabled = false; });
  });
  intervaloEl.addEventListener("change", () => {
    intervaloMs = Number(intervaloEl.value);
    if (linhaAtual) mostrar(`Atualização automática a cada ${intervaloMs / 1000}s.`);
  });
  favoritarBtn.addEventListener("click", () => {
    if (!linhaAtual) return;
    const atuais = favoritos();
    const posicao = atuais.indexOf(linhaAtual);
    if (posicao >= 0) atuais.splice(posicao, 1); else atuais.unshift(linhaAtual);
    localStorage.setItem("pegaobusao:favoritos", JSON.stringify(atuais.slice(0, 10)));
    desenharFavoritos();
    atualizarFavorito();
  });
  document.getElementById("localizacao").addEventListener("click", () => {
    if (!navigator.geolocation) return mostrar("Seu navegador não oferece localização.", true);
    mostrar("Obtendo sua localização…");
    navigator.geolocation.getCurrentPosition(({ coords }) => definirLocalizacao(coords), () => mostrar("Não foi possível obter sua localização. Verifique a permissão do navegador.", true), { enableHighAccuracy: true, timeout: 10000 });
  });
  document.getElementById("buscar-endereco").addEventListener("click", async () => {
    const valor = enderecoEl.value.trim();
    if (valor.length < 3) return mostrar("Digite um endereço com pelo menos 3 caracteres.", true);
    try {
      mostrar("Buscando endereço…");
      mostrarEnderecos(await jsonApi(`/api/endereco?q=${encodeURIComponent(valor)}`));
      mostrar("Escolha um resultado para posicionar o mapa.");
    } catch (erro) { mostrar(`Não foi possível buscar o endereço. ${erro.message}`, true); }
  });
  enderecoEl.addEventListener("keydown", (evento) => { if (evento.key === "Enter") document.getElementById("buscar-endereco").click(); });
  paradasBtn.addEventListener("click", () => pontoEndereco && carregarParadas(pontoEndereco));
  compartilharBtn.addEventListener("click", async () => {
    if (!linhaAtual) return mostrar("Pesquise uma linha antes de compartilhar.", true);
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: `Linha ${linhaAtual} · PegaObusão`, url });
      else { await navigator.clipboard.writeText(url); mostrar("Link copiado para a área de transferência."); }
    } catch (erro) { if (erro.name !== "AbortError") mostrar("Não foi possível compartilhar o link.", true); }
  });
  abrirMenuBtn.addEventListener("click", () => {
    menuOpcoesEl.open = !menuOpcoesEl.open;
    abrirMenuBtn.setAttribute("aria-expanded", String(menuOpcoesEl.open));
  });
  document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape") {
      aplicarEstado("compacto");
      alternarPainelBtn.focus();
    }
  });
  document.addEventListener("visibilitychange", () => {
    emSegundoPlano = document.visibilityState !== "visible";
    if (emSegundoPlano) {
      clearTimeout(timer);
      clearInterval(contadorTimer);
      wakeLock?.release?.().catch?.(() => {});
      wakeLock = null;
    } else if (linhaAtual) {
      manterTelaAcesa();
      atualizarContador();
      if (!cicloRodando) ciclo(linhaAtual, sequencia);
    }
  });
  try {
    aplicarEstado(localStorage.getItem("pegaobusao:painel") || "aberto", false);
  } catch { aplicarEstado("aberto", false); }
  desenharFavoritos();
  const linhaInicial = new URLSearchParams(location.search).get("linha");
  if (linhaInicial) buscar(linhaInicial);
  buscarParadasSeAutorizado();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

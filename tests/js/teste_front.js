// Teste do front-end no jsdom: abas, filtros, GPX, risco, sugestão por desvios, planejamento, biblioteca e exportação.
// Requer Node >= 20:  cd tests/js && npm install && npm test
const assert = require("assert"), fs = require("fs"), path = require("path");
const {JSDOM, VirtualConsole} = require("jsdom");
const {indexedDB} = require("fake-indexeddb");
const OUT = path.join(__dirname, "out");
let html = fs.readFileSync(path.join(OUT, "mapa.html"), "utf8");
html = html.replace(/<script>\/\*!\s*\n \* Chart\.js[\s\S]*?<\/script>\n/, "");     // Chart.js real não roda em jsdom: usa stub
const erros = [], vc = new VirtualConsole();
vc.on("jsdomError", e => erros.push("jsdomError: " + (e.detail && e.detail.stack || e.message))); vc.on("error", e => erros.push("console.error: " + e));
const dom = new JSDOM(html, {runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, url: "http://localhost/",
  beforeParse(w) {
    const mk = () => new Proxy(function () {}, {get: (t, k) => k === "canvas" ? {} : (k === "data" ? new Uint8ClampedArray(1024) : mk()), apply: () => mk(), set: () => true});
    w.HTMLCanvasElement.prototype.getContext = () => mk();
    w.Chart = function (el, cfg) { this.data = cfg.data; this.update = () => {}; this.resize = () => {}; };
    Object.assign(w, {DecompressionStream, CompressionStream, Response, Blob, TextEncoder, File, indexedDB});
    w.alert = m => erros.push("alert: " + m);
    w.addEventListener("error", e => erros.push("window.error: " + e.message));
    w.addEventListener("unhandledrejection", e => erros.push("rejeição: " + e.reason));
  }});
const w = dom.window, d = w.document, sleep = ms => new Promise(r => setTimeout(r, ms)), txt = id => d.getElementById(id).textContent;
(async () => {
  await sleep(700);
  const R = w.__rotas, P = JSON.parse(fs.readFileSync(path.join(OUT, "pontos.json")));
  assert(w.__app && R.TEM_GRAFO, "app/grafo não iniciaram");

  // Panorama e filtros
  const k1 = txt("k1"); assert(k1 !== "–");
  d.querySelectorAll('#filtros .chip[data-k="ano"]')[0].click(); assert.notStrictEqual(txt("k1"), k1, "filtro de ano não alterou os KPIs");
  d.getElementById("reset").click(); assert.strictEqual(txt("k1"), k1);

  // camadas: ordem e opacidade
  const A = w.__app, z = id => +A.CAMADAS[id].pane.style.zIndex, antes = z("vias") - z("rotas");
  A.mover("vias", 1); assert(z("vias") - z("rotas") > antes, "ordem das camadas não mudou");

  // GPX: janela própria (±1 h), dia útil, perfil de risco
  const r = w.__gpx(fs.readFileSync(path.join(OUT, "aurora.gpx"), "utf8"), "x");
  assert.strictEqual(A.aba, "rota"); assert.strictEqual(JSON.stringify(r.jan), JSON.stringify({h1: 11, h2: 13, dias: "uteis"}));
  assert(+(txt("riscoCorpo").match(/(\d+)\/100/) || [])[1] >= 75, "via de maior risco deveria pontuar alto");
  assert(!d.querySelector('button[data-act="desvio"]'), "o botão de desvio antigo saiu: a busca principal faz o papel dele");

  // sugestão a partir da própria rota: contorna o trecho crítico com um desvio, acréscimo de distância limitado
  d.getElementById("btnAlt").click(); await sleep(150);
  assert(R.altAtiva && R.altAtiva.prop && R.altAtiva.prop.janelas.length === 1, "desvio local não gerado");
  assert(/Sugestão a partir da sua rota/.test(txt("altMsg")), "faltou o cartão da sugestão");
  // caixas por desvio: desligar devolve a rota original; ligar de novo restaura o desvio
  const distCom = R.altAtiva.alt.dist, cx = d.querySelector('#altMsg input[data-j="0"]'); assert(cx && cx.checked, "faltou a caixa do desvio");
  cx.checked = false; cx.dispatchEvent(new w.Event("change")); await sleep(50);
  assert(/0 de 1 desvio\(s\) ativo\(s\)/.test(txt("altMsg")), "o cartão deveria mostrar 0 de 1 desvio ativo: " + txt("altMsg"));
  assert(Math.abs(R.altAtiva.alt.dist - R.lista[0].dist) < 40, "sem desvios ativos a rota deveria voltar a ser a original");
  d.querySelector('#altMsg input[data-j="0"]').checked = true; d.querySelector('#altMsg input[data-j="0"]').dispatchEvent(new w.Event("change")); await sleep(50);
  assert(Math.abs(R.altAtiva.alt.dist - distCom) < 1 && /1 de 1 desvio\(s\) ativo\(s\)/.test(txt("altMsg")), "religar o desvio deveria restaurar a sugestão");
  const dvRota = R.altAtiva.alt; assert(dvRota.dist > R.lista[0].dist && dvRota.dist < R.lista[0].dist * 1.6 + 200, "acréscimo fora do limite");
  d.getElementById("altAdd").click(); await sleep(50);
  assert.strictEqual(R.lista.length, 2); assert.strictEqual(d.querySelectorAll("table.comp tbody tr").length, 2);

  // planejamento por clique: com peso de risco, evita a via crítica (usa o caminho paralelo)
  R.ativarPlano(true); R.addWp(P.A); R.addWp(P.B);
  const plano = R.lista.find(x => x.id === "plano"); assert(plano && plano.pts.length >= 4, "rota planejada ausente");
  assert(plano.dist > R.lista[0].dist, "com risco alto a rota planejada deveria contornar a via crítica");
  d.getElementById("plFixar").click(); assert(!R.lista.find(x => x.id === "plano")); R.ativarPlano(false);

  // biblioteca + exportação
  R.lista[0].sentido = "ida"; await R.salvarNaBiblioteca(R.lista[0]); await R.salvarNaBiblioteca(R.lista[R.lista.length - 1]);
  const salvos = await R.Lib.todos(); assert.strictEqual(salvos.length, 2); assert(R.Lib.persistente);
  await R.exportar("zip"); await R.exportar("tgz"); await R.exportar("json"); d.querySelector('button[data-act="gpx"]').click();
  const dl = w.__downloads; assert.strictEqual(JSON.stringify(Array.from(dl, x => x.nome.split(".").slice(1).join("."))), JSON.stringify(["zip", "tar.gz", "json", "gpx"]));
  for (const x of dl) fs.writeFileSync(path.join(OUT, "saida_" + x.nome), Buffer.from(await x.blob.arrayBuffer()));
  await R.Lib.excluir(salvos[0].id);
  await R.importar([new File([fs.readFileSync(path.join(OUT, "saida_" + dl.find(x => x.nome.endsWith(".json")).nome))], "rotas.json")]);
  assert.strictEqual((await R.Lib.todos()).length, 2, "importação JSON não restaurou a rota");

  // janela por rota
  const antesTab = txt("comp"), inp = d.querySelector('input[data-k="h1"]'); inp.value = "2"; inp.dispatchEvent(new w.Event("change", {bubbles: true}));
  assert.strictEqual(R.lista[0].jan.h1, 2); assert.notStrictEqual(txt("comp"), antesTab);

  // ---- layout de tela cheia: ids únicos, mapa único, painéis recolhíveis ----
  const ids = {}; d.querySelectorAll("[id]").forEach(el => { ids[el.id] = (ids[el.id] || 0) + 1; });
  const dup = Object.entries(ids).filter(([, n]) => n > 1);
  assert.deepStrictEqual(dup, [], "IDs duplicados no HTML: " + dup.map(x => x[0]).join(", "));
  assert.strictEqual(d.querySelectorAll("#map").length, 1, "#map deve existir uma única vez");
  assert.strictEqual(d.querySelectorAll("#mapwrap").length, 1, "#mapwrap deve existir uma única vez");

  // o mapa permanece no DOM ao alternar as abas
  A.irAba("rota"); assert(d.getElementById("map") && d.body.contains(d.getElementById("map")), "#map sumiu na aba de rotas");
  A.irAba("panorama"); assert(d.getElementById("map") && d.body.contains(d.getElementById("map")), "#map sumiu ao voltar ao panorama");

  // subabas do painel esquerdo: Filtros | Rotas | Camadas e estilo | Legendas (nada é flutuante)
  assert(!d.querySelector(".p-cam"), "o menu de camadas não deveria mais ser um painel flutuante");
  assert(d.getElementById("pLegenda").classList.contains("p-leg-off"), "a legenda flutuante antiga deveria estar desativada");
  const stF = d.getElementById("stFiltros"), stR = d.getElementById("stRotas"), stC = d.getElementById("stCamadas"), stL = d.getElementById("stLegenda");
  assert(stF && stR && stC && stL, "faltam as subabas Filtros/Rotas/Camadas/Legendas");
  assert(/Filtros, rotas, camadas e legendas/.test(d.querySelector("#pFiltros .pcab h2").textContent), "o painel esquerdo deveria se chamar 'Filtros, rotas, camadas e legendas'");
  // qual subaba fica ativa ao chegar depende do estado salvo no navegador (cfg): o teste
  // só exige que exatamente uma esteja selecionada e que a navegação entre elas funcione
  assert.strictEqual([stF, stR, stC, stL].filter(b => b.getAttribute("aria-selected") === "true").length, 1, "exatamente uma subaba deveria iniciar selecionada");
  A.irSubAba("filtros"); await sleep(30);
  assert.strictEqual(stF.getAttribute("aria-selected"), "true", "a subaba Filtros deveria ficar selecionada via irSubAba");
  assert(d.getElementById("secRotas").hidden, "#secRotas deveria começar oculto (subaba ativa é Filtros)");
  assert(d.getElementById("camadas").hidden, "#camadas deveria começar oculto (subaba ativa é Filtros)");
  assert(d.getElementById("secLegenda").hidden, "#secLegenda deveria começar oculto");
  stR.click(); await sleep(50);
  assert(!d.getElementById("secRotas").hidden && d.getElementById("secFiltros").hidden, "subaba Rotas não trocou a visibilidade");
  assert.strictEqual(stR.getAttribute("aria-selected"), "true") && assert.strictEqual(stF.getAttribute("aria-selected"), "false");
  assert(d.getElementById("btnPlan") && d.getElementById("lib"), "a aba Rotas deveria reunir as ferramentas de rota");
  stC.click(); await sleep(50);
  assert(!d.getElementById("camadas").hidden && d.getElementById("secRotas").hidden, "subaba Camadas não trocou a visibilidade");
  assert.strictEqual(stC.getAttribute("aria-selected"), "true") && assert.strictEqual(stF.getAttribute("aria-selected"), "false");
  assert(d.getElementById("selBase"), "o conteúdo do menu de camadas não foi montado na subaba");
  stL.click(); await sleep(50);
  assert(!d.getElementById("secLegenda").hidden && d.getElementById("camadas").hidden, "subaba Legendas não trocou a visibilidade");
  assert(d.getElementById("k5b").innerHTML.length > 0, "a legenda (#k5b) não foi espelhada na aba Legendas");
  stF.click(); await sleep(50);
  assert(d.getElementById("camadas").hidden && !d.getElementById("secFiltros").hidden, "voltar à subaba Filtros falhou");

  // ---- busca por rua/logradouro: painel flutuante próprio, entre a caixa de configurações
  // e os cartões/KPIs; campo de texto + lupa, autocompletar abaixo ----
  const inB = d.getElementById("buscaRua"), luB = d.getElementById("btnBusca"), wrB = d.getElementById("buscaWrap"), ulB = d.getElementById("buscaLista");
  assert(wrB.classList.contains("p-busca") && wrB.parentElement === d.querySelector(".overlay"), "a busca deveria ser um painel flutuante próprio, fora da caixa de configurações");
  assert(wrB !== d.querySelector("#pFiltros") && !d.querySelector("#pFiltros .busca"), "a busca não deveria mais viver dentro do painel 'Filtros, rotas, camadas e legendas'");
  assert(d.getElementById("pFiltros").compareDocumentPosition(wrB) & w.Node.DOCUMENT_POSITION_FOLLOWING, "a busca deveria vir logo depois da caixa de configurações (à sua direita na tela)");
  assert(inB.compareDocumentPosition(luB) & w.Node.DOCUMENT_POSITION_FOLLOWING, "a ordem deveria ser campo de texto, depois a lupa");
  assert(!luB.classList.contains("pbtn") && luB.id !== "btnPFiltros", "a lupa não deveria ser o botão de recolher o painel");
  // digitar sem acento/caixa encontra a via e lista as sugestões abaixo do campo
  inB.value = "aurora"; inB.dispatchEvent(new w.Event("input", {bubbles: true}));
  assert(!ulB.hidden && ulB.querySelectorAll("li").length >= 1, "o autocompletar não listou sugestões para 'aurora'");
  assert(/Aurora/i.test(ulB.querySelector("li b").textContent), "a primeira sugestão deveria ser a via buscada: " + ulB.textContent);
  // escolher uma sugestão preenche o campo e enquadra o mapa na via (como no ranking)
  let zoomAntes = A.MAPA.getZoom();
  ulB.querySelector("li").dispatchEvent(new w.MouseEvent("mousedown", {bubbles: true, cancelable: true})); await sleep(30);
  assert(/Aurora/i.test(inB.value), "escolher a sugestão deveria preencher o campo: " + inB.value);
  assert(ulB.hidden, "a lista deveria fechar após a escolha");
  assert(A.MAPA.getZoom() !== zoomAntes || wrB.classList.length, "o mapa deveria ter se movido para a via escolhida");
  // teclado: setas percorrem a lista, Enter escolhe
  inB.value = "aurora"; inB.dispatchEvent(new w.Event("input", {bubbles: true}));
  inB.dispatchEvent(new w.KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
  assert(!ulB.hidden && ulB.querySelector("li.on"), "ArrowDown deveria marcar a primeira sugestão");
  inB.dispatchEvent(new w.KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
  assert(ulB.hidden, "Enter deveria escolher a sugestão marcada e fechar a lista");
  // minimizar: clicando fora com o texto vazio a caixa encolhe (fica só a lupa)...
  inB.value = ""; d.body.dispatchEvent(new w.MouseEvent("click", {bubbles: true}));
  assert(wrB.classList.contains("min"), "clicar fora com o campo vazio deveria minimizar a busca");
  // ...e a lupa restaura a forma normal focando o campo
  luB.click(); await sleep(30);
  assert(!wrB.classList.contains("min"), "clicar na lupa deveria restaurar a busca");
  assert(d.activeElement === inB, "a lupa deveria devolver o foco ao campo de texto");
  // com texto digitado, clicar fora NÃO minimiza (só fecha o autocompletar)
  inB.value = "aurora"; inB.dispatchEvent(new w.Event("input", {bubbles: true}));
  d.body.dispatchEvent(new w.MouseEvent("click", {bubbles: true}));
  assert(!wrB.classList.contains("min"), "com texto no campo a busca não deveria minimizar");
  assert(ulB.hidden, "clicar fora deveria fechar o autocompletar");
  // o botão ▸ de recolher o painel não é travado pela busca expandida
  inB.value = ""; d.getElementById("btnPFiltros").click(); await sleep(50);
  assert(d.getElementById("pFiltros").classList.contains("fechado"), "o painel deveria recolher mesmo com a busca no cabeçalho");
  d.getElementById("btnPFiltros").click(); await sleep(50);
  assert(d.getElementById("pFiltros").classList.contains("aberto"), "o painel deveria expandir de novo");

  // a aba superior não troca mais o painel esquerdo: as ferramentas vivem na subaba Rotas,
  // visíveis nas duas abas; irAba("rota") abre a subaba automaticamente
  A.irSubAba("filtros"); A.irAba("panorama"); await sleep(50);
  assert(w.getComputedStyle(d.getElementById("gpx")).display !== "none", "as ferramentas de rota deveriam aparecer na subaba Rotas também no Panorama");
  assert(w.getComputedStyle(d.getElementById("filtros")).display !== "none", "os filtros deveriam continuar visíveis na aba Minha rota");
  A.irAba("rota"); await sleep(50);
  assert(!d.getElementById("secRotas").hidden && d.getElementById("stRotas").getAttribute("aria-selected") === "true", "entrar em 'Minha rota' deveria abrir a subaba Rotas");
  A.irSubAba("filtros"); A.irAba("panorama"); await sleep(50);

  // botão "rota alternativa": desativado/esmaecido sem rotas, ativo com rota em análise
  A.irAba("rota"); await sleep(50);
  R.lista.length = 0; R.atualizarRotas();
  const bAlt = d.getElementById("btnAlt");
  assert(bAlt.disabled, "btnAlt deveria estar desativado sem rotas em análise");
  w.__gpx(fs.readFileSync(path.join(OUT, "aurora.gpx"), "utf8"), "x"); await sleep(50);
  assert(!bAlt.disabled, "btnAlt deveria ficar ativo com uma rota carregada");

  // selecionar uma rota na lista destaca a linha (fundo) — indica a base da alternativa
  w.__gpx(fs.readFileSync(path.join(OUT, "aurora.gpx"), "utf8"), "y"); await sleep(50);
  const rts = d.querySelectorAll("#rotas .rt");
  assert.strictEqual(rts.length, R.lista.length, "a lista de rotas não espelha as rotas em análise");
  rts[1].querySelector(".nm").click(); await sleep(30);
  assert(d.querySelectorAll("#rotas .rt")[1].classList.contains("sel"), "clique na rota não marcou a seleção (.sel)");
  assert(!d.querySelectorAll("#rotas .rt")[0].classList.contains("sel"), "a outra rota não deveria continuar selecionada");

  // cada botão de painel alterna aria-expanded e a classe de estado correspondente
  // os gráficos inferiores são cartões SOLTOS e cada um tem botão próprio (sem contêiner "Detalhes")
  assert(!d.getElementById("pDetalhes"), "a gaveta aglutinadora 'Detalhes' não deveria mais existir");
  assert(d.querySelector(".cartoes-bot"), "faltam os cartões soltos na base (.cartoes-bot)");
  for (const [btnId, painelId] of [["btnPFiltros", "pFiltros"], ["btnPRisco", "risco"], ["btnPLegenda", "pLegenda"], ["btnPRank", "pRank"], ["btnGMes", "gMes"], ["btnGHora", "gHora"], ["btnGHeat", "gHeat"]]) {
    const btn = d.getElementById(btnId), painel = d.getElementById(painelId);
    assert(btn && painel, "faltam elementos do painel " + painelId);
    const ini = painel.classList.contains("aberto");
    btn.click(); await sleep(50);
    assert.strictEqual(painel.classList.contains("aberto"), !ini, painelId + ": classe de estado não alternou");
    assert.strictEqual(painel.classList.contains("fechado"), ini, painelId + ": classe oposta não alternou");
    assert.strictEqual(btn.getAttribute("aria-expanded"), String(!ini), painelId + ": aria-expanded incorreto");
    // o corpo precisa realmente sumir/aparecer no CSS computado (classes sozinhas não bastam)
    const corpo = painel.querySelector(":scope > .pcorpo");
    if (corpo && !painel.classList.contains("estatico") && painelId !== "pLegenda") {
      const oculto = w.getComputedStyle(corpo).display === "none";
      assert.strictEqual(oculto, ini, painelId + ": ao recolher, o corpo deveria ficar display:none (e visível ao expandir)");
    }
    btn.click(); await sleep(50);
    assert.strictEqual(painel.classList.contains("aberto"), ini, painelId + ": não restaurou o estado inicial");
  }

  // MAPA.invalidateSize é chamado ao recolher/expandir (nos dois timers de ajuste)
  let chamadas = 0; const invOriginal = A.MAPA.invalidateSize.bind(A.MAPA);
  A.MAPA.invalidateSize = (...a) => { chamadas++; return invOriginal(...a); };
  d.getElementById("btnPFiltros").click(); await sleep(400);
  d.getElementById("btnPFiltros").click(); await sleep(400);
  assert(chamadas >= 4, "MAPA.invalidateSize deveria ser chamado após recolher/expandir (chamadas: " + chamadas + ")");
  A.MAPA.invalidateSize = invOriginal;

  // aba "Minha rota": incidências recuam (opacidade baixa) p/ destacar a rota; trechos do
  // trajeto (camada rotas) mantêm opacidade máxima
  A.irAba("rota"); await sleep(50);
  assert(A.CAMADAS.vias.pane.style.opacity === "0.18", "vias deveria recuar na aba de rotas (op. " + A.CAMADAS.vias.pane.style.opacity + ")");
  assert(A.CAMADAS.rotas.pane.style.opacity === "1", "camada das rotas deveria manter opacidade máxima");
  A.irAba("panorama"); await sleep(50);
  assert(R.lista.length > 0, "o cenário deveria ter rota em análise");
  assert(A.CAMADAS.vias.pane.style.opacity === "0.18", "com rotas em análise, o Panorama deveria manter as vias com o mesmo recuo da aba de rotas (op. " + A.CAMADAS.vias.pane.style.opacity + ")");

  // atalhos "recolher tudo / expandir tudo" do menu de camadas. pLegenda é a legenda flutuante
  // desativada (vira aba do painel esquerdo): fecharTudo() pode recolhê-la, mas abrirTudo()
  // deve restaurar todos os demais painéis.
  A.abrirTudo(); assert(Object.values(A.posPainel).filter(p => p.el.id !== "pLegenda").every(p => p.aberto), "abrirTudo deveria expandir todos os painéis ativos");
  A.fecharTudo(); assert(Object.values(A.posPainel).every(p => !p.aberto), "fecharTudo deveria recolher todos os painéis");
  A.abrirTudo();

  // os cartões do topo central perderam o botão de minimizar (a pedido) e nunca se recolhem
  for (const id of ["pk1", "pk2", "pk3", "pk4"]) {
    const el = d.getElementById(id);
    assert(el.classList.contains("estatico"), id + ": cartão do topo deveria ser estático (sem minimizar)");
    assert(!d.querySelector("#" + id + " .pbtn"), id + ": não deveria haver botão de minimizar no topo central");
    assert(el.classList.contains("aberto") && !el.classList.contains("fechado"), id + ": deveria permanecer aberto");
  }

  // ---- alternativa tracejada: botão "✕ Limpar" descarta a sugestão (linha + bloco) ----
  A.irAba("rota"); await sleep(50);
  R.lista.length = 0; R.atualizarRotas();
  w.__gpx(fs.readFileSync(path.join(OUT, "aurora.gpx"), "utf8"), "x"); await sleep(50);
  d.getElementById("btnAlt").click(); await sleep(100);
  assert(R.altAtiva, "btnAlt deveria calcular uma rota alternativa");
  assert(/trechos críticos: \d+ → \d+/.test(d.getElementById("altMsg").textContent), "o bloco da alternativa deveria comparar os trechos críticos");
  assert(/ciclovia\/ciclofaixa\/faixa: \d+% → \d+%/.test(d.getElementById("altMsg").textContent), "o bloco deveria mostrar a infraestrutura cicloviária antes → depois");
  assert(R.altAtiva.Rd.crit.length === 0 || /ainda passa por: /.test(d.getElementById("altMsg").textContent), "se a alternativa ainda passa por trecho crítico, o bloco deve dizer qual");
  assert(R.altAtiva.Rd.score < R.altAtiva.R.score, "a alternativa sugerida nunca pode ter índice pior que o da rota atual (" + R.altAtiva.Rd.score + " vs " + R.altAtiva.R.score + ")");
  // o índice mostrado no bloco é o MESMO do cartão da rota (R.score), não outra média
  assert(new RegExp("índice " + R.altAtiva.R.score.toFixed(0) + " → " + R.altAtiva.Rd.score.toFixed(0)).test(d.getElementById("altMsg").textContent), "o bloco deveria mostrar a nota do cartão da rota: " + d.getElementById("altMsg").textContent);
  // adotar a alternativa e pedir outra a partir dela: nada a supera → o app AVISA em vez de sugerir um caminho pior
  d.getElementById("altAdd").click(); await sleep(50);
  assert.strictEqual(R.altAtiva, null, "ao adotar a alternativa o tracejado deveria sair");
  [...d.querySelectorAll("#rotas .nm")].pop().click(); await sleep(30);          // seleciona a rota adotada (a última)
  d.getElementById("btnAlt").click(); await sleep(100);
  assert.strictEqual(R.altAtiva, null, "sem caminho melhor, não deveria haver alternativa");
  assert(/nada a contornar|a sua rota já é a melhor sugestão/.test(txt("aviso")), "faltou o aviso de que não há o que melhorar: " + txt("aviso"));
  R.lista.length = 0; R.atualizarRotas(); w.__gpx(fs.readFileSync(path.join(OUT, "aurora.gpx"), "utf8"), "x"); await sleep(50);
  d.getElementById("btnAlt").click(); await sleep(100);
  assert(!d.getElementById("altMsg").hidden && d.getElementById("altLimparBtn"), "faltou o bloco da alternativa com o botão Limpar");
  d.getElementById("altLimparBtn").click(); await sleep(30);
  assert.strictEqual(R.altAtiva, null, "Limpar não descartou a alternativa");
  assert(d.getElementById("altMsg").hidden, "o bloco da alternativa deveria sumir");
  // remover a rota de origem também apaga a alternativa
  d.getElementById("btnAlt").click(); await sleep(100);
  assert(R.altAtiva, "alternativa não recalculada");
  d.querySelector("#rotas [data-x]").click(); await sleep(30);
  assert.strictEqual(R.altAtiva, null, "a alternativa deveria sumir quando a rota de origem sai da análise");

  // ---- Panorama relativo às rotas ----
  A.irAba("panorama"); await sleep(50);
  const kTudo = txt("k1"), rowsTudo = d.querySelectorAll("#rank tbody tr").length;
  assert(d.getElementById("escopoRota").hidden, "sem rotas, o aviso de escopo deveria estar oculto");
  w.__gpx(fs.readFileSync(path.join(OUT, "aurora.gpx"), "utf8"), "x"); await sleep(50);
  const aur = R.lista[0].id;
  // uma rota fora da malha (nenhum trecho com registro) para testar a seleção
  const longe = '<?xml version="1.0"?><gpx version="1.1"><trk><name>Longe</name><trkseg><trkpt lat="-7.0" lon="-34.0"/><trkpt lat="-7.001" lon="-34.001"/></trkseg></trk></gpx>';
  w.__gpx(longe, "longe"); await sleep(50);
  A.irAba("panorama"); await sleep(50);
  const num = t => +t.replace(/\D/g, "");
  assert(!d.getElementById("escopoRota").hidden, "com rotas, o Panorama deveria avisar o escopo");
  assert(/2 rotas/.test(txt("escopoTxt")), "o aviso deveria citar as 2 rotas: " + txt("escopoTxt"));
  const kRotas = num(txt("k1"));
  assert(kRotas > 0 && kRotas < num(kTudo), "KPIs deveriam cobrir só os trechos das rotas (" + kRotas + " vs " + kTudo + ")");
  assert(d.querySelectorAll("#rank tbody tr").length <= rowsTudo, "o ranking deveria listar só vias das rotas");
  // selecionar a rota "Longe" → nenhum trecho com ocorrência
  A.irAba("rota"); await sleep(50);
  [...d.querySelectorAll("#rotas .nm")].find(el => el.textContent === "Longe").click(); await sleep(30);
  A.irAba("panorama"); await sleep(50);
  assert(/Longe/.test(txt("escopoTxt")), "o aviso deveria citar a rota selecionada: " + txt("escopoTxt"));
  assert.strictEqual(num(txt("k1")), 0, "a rota selecionada não passa por trechos com registro");
  assert.strictEqual(d.querySelectorAll("#rank tbody tr").length, 0, "ranking deveria ficar vazio");
  // "Ver tudo" restaura o Panorama inteiro; "Filtrar pelas rotas" volta ao escopo
  d.getElementById("btnEscopo").click(); await sleep(30);
  assert.strictEqual(txt("k1"), kTudo, "Ver tudo deveria restaurar os KPIs do Panorama completo");
  d.getElementById("btnEscopo").click(); await sleep(30);
  assert.strictEqual(num(txt("k1")), 0, "Filtrar pelas rotas deveria reaplicar o escopo");
  // perfil antigo com "rotas" desligado no Panorama: ao voltar, as rotas precisam reaparecer
  A.irAba("panorama"); await sleep(30);
  A.mostrar("rotas", false);
  A.irAba("rota"); await sleep(30); A.irAba("panorama"); await sleep(50);
  assert(A.CAMADAS.rotas.vis && A.MAPA.hasLayer(A.CAMADAS.rotas.grp), "as rotas deveriam ficar visíveis no Panorama quando há rotas em análise");
  // transparência: no Panorama com rotas, as vias recuam como na aba "Minha rota"
  A.irAba("rota"); await sleep(30); const opRota = A.CAMADAS.vias.op;
  A.irAba("panorama"); await sleep(50);
  assert(opRota < 1, "a aba de rotas deveria recuar as vias");
  assert.strictEqual(A.CAMADAS.vias.op, opRota, "no Panorama com rotas as vias deveriam ter a mesma transparência da aba de rotas");
  // selecionar rotas pela lista nos filtros do Panorama
  assert(!d.getElementById("secRotasPan").hidden, "com rotas, os filtros do Panorama deveriam listá-las");
  assert.strictEqual(d.querySelectorAll("#rotasPan .rt").length, R.lista.length, "a lista do Panorama não espelha as rotas");
  const nomeOutra = [...d.querySelectorAll("#rotasPan .nm")].map(el => el.textContent).find(n => n !== "Longe");
  [...d.querySelectorAll("#rotasPan .nm")].find(el => el.textContent === nomeOutra).click(); await sleep(30);
  assert(txt("escopoTxt").includes(nomeOutra), "selecionar no Panorama deveria filtrar por essa rota: " + txt("escopoTxt"));
  assert(num(txt("k1")) > 0, "a rota selecionada passa por trechos com registro");
  d.querySelector("#rotasPan .rt.sel .nm").click(); await sleep(30);
  assert(/2 rotas/.test(txt("escopoTxt")), "clicar de novo deveria voltar a todas as rotas: " + txt("escopoTxt"));
  // "Limpar rotas": zera tudo e o Panorama volta ao completo
  A.irAba("rota"); await sleep(50);
  assert(!d.getElementById("rotasLimpar").disabled, "Limpar rotas deveria estar ativo com rotas em análise");
  d.getElementById("btnAlt").click(); await sleep(100);
  d.getElementById("rotasLimpar").click(); await sleep(30);
  assert.strictEqual(R.lista.length, 0, "Limpar rotas não removeu as rotas");
  assert.strictEqual(R.altAtiva, null, "Limpar rotas não removeu a alternativa");
  assert(d.getElementById("rotasLimpar").disabled, "Limpar rotas deveria ficar desativado sem nada para limpar");
  assert(d.getElementById("btnAlt").disabled, "btnAlt deveria ficar desativado após limpar");
  A.irAba("panorama"); await sleep(50);
  assert.strictEqual(txt("k1"), kTudo, "sem rotas o Panorama deveria voltar ao completo");
  assert(d.getElementById("escopoRota").hidden, "sem rotas o aviso de escopo deveria sumir");

  // ---- limpar rotas direto do Panorama ----
  w.__gpx(fs.readFileSync(path.join(OUT, "aurora.gpx"), "utf8"), "x"); await sleep(50);
  A.irAba("rota"); await sleep(30); const opRota2 = A.CAMADAS.vias.op;
  A.irAba("panorama"); await sleep(50);
  assert.strictEqual(A.CAMADAS.vias.op, opRota2, "vias deveriam recuar no Panorama com rota");
  d.getElementById("rotasLimparPan").click(); await sleep(50);
  assert.strictEqual(R.lista.length, 0, "Limpar rotas (Panorama) não removeu as rotas");
  assert(d.getElementById("secRotasPan").hidden && d.getElementById("escopoRota").hidden, "sem rotas, a lista e o aviso deveriam sumir");
  assert.strictEqual(txt("k1"), kTudo, "sem rotas o Panorama deveria voltar ao completo");
  assert.strictEqual(A.CAMADAS.vias.op, 1, "sem rotas as vias deveriam voltar à opacidade própria do Panorama");
  // o recuo não contamina os perfis salvos de cada aba
  A.irAba("rota"); await sleep(30); assert.strictEqual(A.CAMADAS.vias.op, opRota2, "perfil da aba de rotas alterado");
  A.irAba("panorama"); await sleep(30); assert.strictEqual(A.CAMADAS.vias.op, 1, "perfil do Panorama contaminado pelo recuo");

  assert.deepStrictEqual(erros, [], "erros de JS:\n" + erros.join("\n"));
  console.log("front-end OK");
  process.exit(0);
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });

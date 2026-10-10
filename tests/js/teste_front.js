// Teste do front-end no jsdom: abas, filtros, GPX, risco, desvio, planejamento, biblioteca e exportação.
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
  assert(d.querySelector('button[data-act="desvio"]'), "sem botão de desvio");

  // desvio: menor risco, acréscimo de distância limitado
  R.sugerirDesvio(R.lista[0]); const dv = R.lista[0].desvio;
  assert(dv && dv.trocas.length === 1, "desvio não gerado");
  assert(dv.rota.dist > R.lista[0].dist && dv.rota.dist < R.lista[0].dist * 1.6 + 200, "acréscimo fora do limite");
  d.querySelector('button[data-act="dv-add"]').click();
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

  assert.deepStrictEqual(erros, [], "erros de JS:\n" + erros.join("\n"));
  console.log("front-end OK");
  process.exit(0);
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });

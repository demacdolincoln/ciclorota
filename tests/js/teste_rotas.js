// Qualidade do roteador (jsdom, sem mapa): respeita a mão única, evita as vias de maior ocorrência
// quando há caminho razoável e obedece o teto de acréscimo de distância.
//   mapa.html    : rua paralela de mão dupla     |  mapa_mu.html : a mesma rua, mas só no sentido B' -> A'
const assert = require("assert"), fs = require("fs"), path = require("path");
const {JSDOM, VirtualConsole} = require("jsdom");
const {indexedDB} = require("fake-indexeddb");
const OUT = path.join(__dirname, "out");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function abrir(arquivo) {
  let html = fs.readFileSync(path.join(OUT, arquivo), "utf8");
  html = html.replace(/<script>\/\*!\s*\n \* Chart\.js[\s\S]*?<\/script>\n/, "");
  const erros = [], vc = new VirtualConsole();
  vc.on("jsdomError", e => erros.push("jsdomError: " + (e.detail && e.detail.stack || e.message))); vc.on("error", e => erros.push("console.error: " + e));
  const dom = new JSDOM(html, {runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, url: "http://localhost/",
    beforeParse(w) {
      const mk = () => new Proxy(function () {}, {get: (t, k) => k === "canvas" ? {} : (k === "data" ? new Uint8ClampedArray(1024) : mk()), apply: () => mk(), set: () => true});
      w.HTMLCanvasElement.prototype.getContext = () => mk();
      w.Chart = function (el, cfg) { this.data = cfg.data; this.update = () => {}; this.resize = () => {}; };
      Object.assign(w, {DecompressionStream, CompressionStream, Response, Blob, TextEncoder, File, indexedDB});
      w.addEventListener("error", e => erros.push("window.error: " + e.message));
    }});
  await sleep(700);
  return {w: dom.window, erros};
}

(async () => {
  const P = JSON.parse(fs.readFileSync(path.join(OUT, "pontos.json"), "utf8"));
  const JAN = {h1: 0, h2: 23, dias: "todos"};

  for (const arq of ["mapa.html", "mapa_mu.html"]) {
    const mu = arq === "mapa_mu.html", {w, erros} = await abrir(arq), R = w.__rotas;
    assert(R.TEM_GRAFO, arq + ": sem grafo");
    const B = R.baseDe(JAN), F = R.fatores(R.PLAN, B, null);
    let hot = 0; B.rk.forEach((v, i) => { if (v > B.rk[hot]) hot = i; });                       // via de maior risco
    const A = R.snapNo(P.A[0], P.A[1]), Bn = R.snapNo(P.B[0], P.B[1]);
    const usaHot = c => R.fidsDosArcos(c.arcs).includes(hot), metros = c => R.comprimentoArcos(c.arcs).m;
    const curto = (s, t) => R.melhorCaminho(s, t, new Float32Array(F.length).fill(1));
    const ab = R.caminhoSeguro(A, Bn, F, R.PLAN.extra), ba = R.caminhoSeguro(Bn, A, F, R.PLAN.extra);
    assert(ab && ba, arq + ": sem caminho");

    // 1) mão única: em NENHUM par de nós o caminho pode andar contra o sentido
    let pares = 0;
    for (let s = 0; s < R.nNos; s++) for (let t = 0; t < R.nNos; t++) {
      if (s === t) continue;
      const c = R.caminhoSeguro(s, t, F, R.PLAN.extra); if (!c) continue;
      assert.strictEqual(R.contramao(c.arcs), 0, arq + ": caminho " + s + "→" + t + " anda na contramão"); pares++;
    }
    assert(pares >= 6, arq + ": poucos pares testados (" + pares + ")");

    // 2) evita a via de maior ocorrência quando existe caminho dentro do teto
    const ref = metros(curto(Bn, A)), cheio = R.melhorCaminho(Bn, A, F);
    if (!mu) {
      assert(!usaHot(ab) && !usaHot(ba), "com a paralela de mão dupla, nenhum sentido deveria usar a via mais perigosa");
      assert(metros(ab) > metros(curto(A, Bn)) && metros(ab) <= metros(curto(A, Bn)) * (1 + R.PLAN.extra) + 50, "A→B fora do teto de distância");
    } else {
      // A→B: a paralela só existe no sentido B'→A' → contramão proibida → única opção legal é a via perigosa
      assert(usaHot(ab), "A→B: sem caminho legal alternativo, deveria seguir pela via de maior ocorrência (e NÃO pela paralela contra a mão)");
      assert.strictEqual(R.contramao(ab.arcs), 0);
      // B→A: a paralela está liberada → evita a via perigosa
      assert(!usaHot(ba), "B→A: deveria usar a paralela liberada em vez da via de maior ocorrência");
    }

    // 3) teto de distância: com acréscimo 0 o resultado é o caminho mais curto (com 50 m de tolerância), mesmo passando pela via crítica
    const c0 = R.caminhoSeguro(Bn, A, F, 0);
    assert(metros(c0) <= ref + 50, arq + ": acréscimo 0 deveria ficar no menor caminho (" + metros(c0) + " vs " + ref + ")");
    assert(c0.limitado === true, arq + ": com acréscimo 0 o resultado deveria indicar que o teto limitou o desvio");
    assert(!ba.limitado, arq + ": com o teto padrão o desvio cabe e não deveria ser marcado como limitado");
    // a penalidade do risco é convexa: percorrer a via de maior ocorrência custa MUITO mais que uma via sem registro
    // (com a fórmula linear antiga a razão era ~1,6; o roteador trocava poucos metros por passar na via mais perigosa)
    const fHot = Math.max(...curto(A, Bn).arcs.filter(a => R.fidsDosArcos([a])[0] === hot).map(a => F[a >> 1]));
    const fSem = Math.min(...ba.arcs.filter(a => R.fidsDosArcos([a])[0] !== hot).map(a => F[a >> 1]));
    assert(fHot >= 3 * fSem, arq + ": via de maior ocorrência deveria custar ≥3× uma via comum (" + fHot.toFixed(2) + " vs " + fSem.toFixed(2) + ")");
    // sem teto (extra negativo desliga) e com o teto padrão o desvio é o de menor custo, nunca pior em custo que o curto
    const custo = (c) => c.arcs.reduce((s, a) => s + R.comprimentoArcos([a]).m * F[a >> 1], 0);
    assert(custo(ba) <= custo(curto(Bn, A)) + 1e-3, arq + ": o caminho seguro não pode custar mais que o mais curto");
    assert.deepStrictEqual(erros, [], arq + ": erros de JS:\n" + erros.join("\n"));
    console.log("  ok " + arq + " — " + pares + " pares sem contramão; B→A " + Math.round(metros(ba)) + " m (curto " + Math.round(ref) + " m)" + (usaHot(ba) ? " pela via crítica" : " evitando a via crítica"));
  }
  console.log("roteador OK");
  process.exit(0);
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });

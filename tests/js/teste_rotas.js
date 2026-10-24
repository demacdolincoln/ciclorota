// Qualidade do roteador (jsdom, sem mapa): respeita a mão única, evita as vias de maior ocorrência
// quando há caminho razoável e obedece o teto de acréscimo de distância.
//   mapa.html    : rua paralela de mão dupla     |  mapa_mu.html : a mesma rua, mas só no sentido B' -> A'
//   mapa_muc.html: idem mapa_mu, porém é CICLOVIA (contraflow liberado só onde há infraestrutura)
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

  for (const arq of ["mapa.html", "mapa_mu.html", "mapa_muc.html"]) {
    const mu = arq === "mapa_mu.html", muc = arq === "mapa_muc.html", {w, erros} = await abrir(arq), R = w.__rotas;
    assert(R.TEM_GRAFO, arq + ": sem grafo");
    const B = R.baseDe(JAN), F = R.fatores(R.PLAN, B, null);
    let hot = 0; B.rk.forEach((v, i) => { if (v > B.rk[hot]) hot = i; });                       // via de maior risco
    // roteador e nota usam EXATAMENTE a mesma escala de risco por via (o desencontro fazia a "alternativa mais
    // segura" ter índice pior que a rota original: vias sem registro valiam mais no roteador do que na nota)
    const incerto = Object.assign({}, R.PLAN, {incerto: R.PARAMS.INCERTO / 100});
    for (let f = -1; f < B.pct.length; f++)
      assert.strictEqual(R.riscoAresta(f, incerto, B), R.riscoAmostra({fid: f}, B), arq + ": risco da via " + f + " difere entre roteador e nota");
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
    if (muc) {
      // paralela de mão única MAS com ciclovia: o contraflow é liberado (é o que quem pedala usa), com custo extra e aviso
      assert(!usaHot(ab) && !usaHot(ba), "com ciclovia na paralela, nenhum sentido deveria usar a via mais perigosa");
      assert(R.metrosContraInfra(ab.arcs) > 0, "A→B deveria usar a ciclovia contra o sentido (liberado onde há infraestrutura)");
      assert.strictEqual(R.contramao(ab.arcs), 0, "contraflow só é permitido em ciclovia/ciclofaixa");
      assert.strictEqual(R.metrosContraInfra(ba.arcs), 0, "B→A segue o sentido permitido");
    } else if (!mu) {
      assert(!usaHot(ab) && !usaHot(ba), "com a paralela de mão dupla, nenhum sentido deveria usar a via mais perigosa");
      assert(metros(ab) > metros(curto(A, Bn)) && metros(ab) <= metros(curto(A, Bn)) * (1 + R.PLAN.extra) + 50, "A→B fora do teto de distância");
    } else {
      // A→B: a paralela só existe no sentido B'→A' e NÃO tem infraestrutura → contramão proibida → única opção legal é a via perigosa
      assert(usaHot(ab), "A→B: sem caminho legal alternativo, deveria seguir pela via de maior ocorrência (e NÃO pela paralela contra a mão)");
      assert.strictEqual(R.contramao(ab.arcs), 0);
      assert.strictEqual(R.metrosContraInfra(ab.arcs), 0, "sem infraestrutura, nada de contraflow");
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
    if (arq === "mapa.html") {
      // zonas críticas: trechos a menos de 300 m um do outro viram uma zona só (um desvio só); mais afastados ficam separados
      const cr = (i0, i1, m, f) => ({i0, i1, m, fids: new Set(f)});
      let zs = R.zonasCriticas([cr(100, 110, 200, [1]), cr(120, 125, 100, [2]), cr(300, 310, 200, [3])]);
      assert.strictEqual(zs.length, 2, "os dois primeiros trechos (a 10 amostras = 200 m) deveriam fundir");
      assert(zs[0].i0 === 100 && zs[0].i1 === 125 && zs[0].m === 300 && zs[0].fids.has(1) && zs[0].fids.has(2), "zona fundida errada");
      zs = R.zonasCriticas([cr(300, 310, 200, [3]), cr(100, 110, 200, [1])]);
      assert(zs[0].i0 === 100, "as zonas devem sair ordenadas pela posição na rota");
      // regra de aceite da alternativa, com os números dos casos reais relatados
      const rota = (score, critM, infra) => ({score, crit: critM ? [{m: critM}] : [], ciclo: [infra, 0, 0]});
      const ac = (R0, Rd) => R.avaliarAceite(R0, Rd);
      // almoço: índice 75 → 69, mas infraestrutura 93% → 43%: melhora o índice e PERDE ciclovia → reprovada
      let x = ac(rota(75, 600, .93), rota(69, 600, .43)); assert(x.melhora && !x.infraOk && !x.ok, "perder 50 pontos de infraestrutura deveria reprovar");
      // matinal: índice 68 → 60, mas trecho crítico 920 → 1020 m (entra numa avenida crítica) → reprovada
      x = ac(rota(68, 920, .54), rota(60, 1020, .46)); assert(x.melhora && !x.critOk && !x.ok, "mais metros críticos deveria reprovar");
      // melhora de verdade: índice menor, críticos iguais ou menores, infraestrutura mantida → aceita
      x = ac(rota(68, 920, .54), rota(60, 700, .52)); assert(x.ok, "melhora em tudo deveria ser aceita");
      // dentro da tolerância (+50 m, −10 pp) ainda vale
      x = ac(rota(68, 920, .54), rota(60, 960, .46)); assert(x.ok, "pequenas perdas dentro da tolerância deveriam ser aceitas");
      // índice igual ou pior nunca vale
      x = ac(rota(68, 920, .54), rota(68, 0, 1)); assert(!x.melhora && !x.ok, "sem melhora de índice não há alternativa");
    }
    // 4) alternativas DISTINTAS por penalização iterativa: a 1ª é o caminho seguro padrão; as demais compartilham
    //    ≤ MAX_SOBREP dos metros com as anteriores, respeitam a mão única e o teto de distância
    {
      const alts = R.alternativasPenalizadas(A, Bn, F, 3);
      assert(alts.length >= 1, arq + ": nenhuma alternativa");
      assert.deepStrictEqual(alts[0].arcs, ab.arcs, arq + ": a 1ª alternativa deveria ser o caminho seguro padrão");
      const es = alts.map(c => R.arestasDe(c.arcs));
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++)
        assert(R.sobreposicao(es[i], es[j]) <= R.MAX_SOBREP && R.sobreposicao(es[j], es[i]) <= R.MAX_SOBREP, arq + ": alternativas " + i + " e " + j + " parecidas demais");
      alts.forEach(c => { assert.strictEqual(R.contramao(c.arcs), 0, arq + ": alternativa na contramão");
        assert(metros(c) <= metros(curto(A, Bn)) * (1 + R.PLAN.extra) + 50, arq + ": alternativa fora do teto de distância"); });
      if (arq === "mapa.html") {
        assert(alts.length >= 2, "com a paralela de mão dupla deveria haver pelo menos 2 caminhos distintos (achou " + alts.length + ")");
        assert(alts.some(usaHot) && alts.some(c => !usaHot(c)), "as alternativas deveriam incluir o caminho pela via crítica e o que a evita");
      }
    }
    if (arq === "mapa.html") {
      // seleção das opções: rótulos por propriedade, sem repetir rotas parecidas e sem aceitar o que não melhora
      assert(R.nArestas >= 4, "grafo de teste pequeno demais");
      const R0 = {score: 70, crit: [], ciclo: [.5, 0, 0]};
      const mk = (score, dist, custo, edges, ciclo = [.5, 0, 0]) => ({Rd: {score, crit: [], ciclo}, alt: {dist}, custo, edges: new Set(edges)});
      const c1 = mk(50, 1200, 900, [0, 1]), c2 = mk(52, 1210, 880, [0, 1]), c3 = mk(60, 1000, 950, [2, 3]), c4 = mk(69.8, 900, 1000, [2, 3]);
      let o = R.selecionarOpcoes([c4, c3, c2, c1], R0, 1000);
      assert.deepStrictEqual(Array.from(o, x => x.rotulo), ["Mais segura", "Equilibrada"], "rótulos");
      assert(o[0].c === c1 && o[1].c === c3, "c2 é quase igual a c1 (descartar) e c4 não melhora índice nem custo");
      // piora o índice mas é bem mais barata no custo do roteador, sem perder infraestrutura → entra (antes só o índice valia)
      o = R.selecionarOpcoes([mk(75, 800, 700, [2, 3])], R0, 1000); assert.strictEqual(o.length, 1, "melhora de custo deveria bastar");
      // perde ciclovia (−50 pp) → nunca entra, mesmo melhorando índice e custo
      o = R.selecionarOpcoes([mk(40, 800, 500, [2, 3], [0, 0, 0])], R0, 1000); assert.strictEqual(o.length, 0, "perda de infraestrutura deveria reprovar");
    }
    assert.deepStrictEqual(erros, [], arq + ": erros de JS:\n" + erros.join("\n"));
    console.log("  ok " + arq + " — " + pares + " pares sem contramão; B→A " + Math.round(metros(ba)) + " m (curto " + Math.round(ref) + " m)" + (usaHot(ba) ? " pela via crítica" : " evitando a via crítica"));
  }
  console.log("roteador OK");
  process.exit(0);
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });

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
      // passada de atalhos: só troca um desvio por um caminho direto se o direto NÃO aumenta a exposição ao risco.
      // (a paralela da fixture é só ~27% maior que a corda; razao baixa para ela virar candidata)
      const op = {razao: 1.05, minM: 100};
      const seguro = R.podarDesvios(ab, R.PLAN, B, op);
      assert.deepStrictEqual(Array.from(seguro.arcs), Array.from(ab.arcs), "o atalho pela via crítica não pode ser aceito: aumenta a exposição ao risco");
      assert(!seguro.podado, "nada deveria ter sido podado com o risco ligado");
      // com o risco desligado (e sem penalidade de arterial) a paralela é só um desvio sem motivo → vira o caminho direto
      const semRisco = Object.assign({}, R.PLAN, {risco: 0, arterial: 0});
      const podada = R.podarDesvios(ab, semRisco, B, op);
      assert(podada.podado && podada.podado.n >= 1, "sem risco o desvio deveria ser removido");
      assert(metros(podada) < metros(ab) - 40, "o caminho podado deveria ser bem mais curto (" + metros(podada) + " vs " + metros(ab) + ")");
      assert.strictEqual(R.contramao(podada.arcs), 0, "a poda não pode andar na contramão");
      assert(Math.abs(podada.podado.m - (metros(ab) - metros(podada))) < 1, "o ganho informado deveria bater com a diferença de metros");
      // continuidade: o caminho podado começa e termina nos mesmos nós
      // controle negativo da trava de risco: com um risco BAIXO o custo de segurança passa a preferir a via crítica
      // (mais curta, porém mais exposta); só a trava impede a troca. Sem a trava (folga enorme) a troca acontece.
      const baixos = [.01, .02, .03, .05, .08, .12, .2].map(r => Object.assign({}, R.PLAN, {risco: r, arterial: 0}));
      const sem = baixos.find(P => (R.podarDesvios(ab, P, B, Object.assign({folgaRisco: 1e9, tolRisco: 1e9}, op)).podado || {}).n >= 1);
      assert(sem, "nenhum risco baixo fez o custo de segurança preferir a via crítica: o teste da trava ficou sem cobertura");
      const com = R.podarDesvios(ab, sem, B, op);
      assert(!com.podado, "a trava de exposição deveria impedir a troca pela via crítica (risco " + sem.risco + ")");
      assert.deepStrictEqual(Array.from(com.arcs), Array.from(ab.arcs), "a rota deveria ficar como estava");
      // todas as janelas candidatas são tentadas (uma janela sem alternativa, como uma ponte obrigatória, não esconde as demais),
      // e o orçamento de buscas é TOTAL por rota
      const largo = {razao: 1.0001, minM: 20, minGanhoM: 1e9};            // ganho exigido impossível: toda janela falha
      R.podarDesvios(ab, R.PLAN, B, Object.assign({maxTentativas: 100}, largo)); let up = R.ultimaPoda();
      assert(up.candidatas >= 3, "a rota deveria ter ao menos 3 janelas candidatas (" + up.candidatas + ")");
      assert.strictEqual(up.tentativas, up.candidatas, "janelas que falham não podem impedir que as outras sejam tentadas");
      R.podarDesvios(ab, R.PLAN, B, Object.assign({maxTentativas: 2}, largo)); up = R.ultimaPoda();
      assert.strictEqual(up.tentativas, 2, "o orçamento de buscas deveria limitar o total");
      // sem B ou com rota curta não faz nada
      assert.strictEqual(R.podarDesvios(ab, R.PLAN, null, op), ab, "sem base de risco não há o que podar");
      // ATALHO padrão (razao 1.25) não mexe na rota normal da fixture
      assert.deepStrictEqual(Array.from(R.podarDesvios(ab, R.PLAN, B).arcs), Array.from(ab.arcs), "com os padrões a rota segura da fixture fica como está");
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
    if (arq === "mapa.html") {
      // ---- map matching (experimental): HMM/Viterbi do traçado ruidoso -> arestas do grafo ----
      const dens = (pts, passo) => { const out = [pts[0]]; for (let i = 1; i < pts.length; i++) {      // ~passo metros entre pontos
        const [a, b] = [pts[i - 1], pts[i]], k = 111320, dy = (b[0] - a[0]) * k, dx = (b[1] - a[1]) * k * Math.cos(a[0] * Math.PI / 180), n = Math.max(1, Math.round(Math.hypot(dx, dy) / passo));
        for (let j = 1; j <= n; j++) out.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]); } return out; };
      let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
      const ruido = (pts, sd) => pts.map(p => [p[0] + gauss() * sd / 111320, p[1] + gauss() * sd / (111320 * Math.cos(p[0] * Math.PI / 180))]);
      // métricas em METROS percorridos: fração da rota verdadeira recuperada e fração do casamento que não está nela
      const verdade = cam => { const r = new Map(); cam.arcs.forEach(a => r.set(a >> 1, R.EL ? R.EL[a >> 1] : 0)); return r; };
      const pesos = m => { const r = new Map(); m.partes.forEach(p => r.set(p.e, (r.get(p.e) || 0) + p.m)); return r; };
      const cobre = (m, v) => { const w = pesos(m); let ok = 0, tot = 0; v.forEach((L, e) => { tot += L; ok += Math.min(L, w.get(e) || 0); }); return ok / tot; };
      const extra = (m, v) => { const w = pesos(m); let fora = 0, tot = 0; w.forEach((L, e) => { tot += L; if (!v.has(e)) fora += L; }); return tot ? 1 - fora / tot : 1; };   // = fração correta
      const hotCam = curto(A, Bn), paraCam = ab;
      const ptsHot = dens(R.arcosParaPontos(hotCam.arcs), 8), ptsPar = dens(R.arcosParaPontos(paraCam.arcs), 8);

      // 1) sem ruído: recupera exatamente as arestas; com ruído de GPS de 6 m: recupera >= 95% e quase nada a mais
      let m = R.casarGrafo(ptsHot); assert(!m.erro, "casamento falhou: " + m.erro);
      assert(cobre(m, verdade(hotCam)) >= .99 && extra(m, verdade(hotCam)) >= .99, "sem ruído deveria recuperar a rota exata");
      m = R.casarGrafo(ruido(ptsHot, 6));
      assert(cobre(m, verdade(hotCam)) >= .95 && extra(m, verdade(hotCam)) >= .95, "com ruído de 6 m: cobre " + cobre(m, verdade(hotCam)).toFixed(2) + ", extra " + extra(m, verdade(hotCam)).toFixed(2));
      assert(m.fracCasada === 1 && m.quebras === 0, "nenhum ponto deveria ficar de fora nem haver ruptura");
      // 2) não confunde a rua crítica com a paralela a ~66 m (a que o roteador seguro escolhe)
      const mp = R.casarGrafo(ruido(ptsPar, 6));
      assert(cobre(mp, verdade(paraCam)) >= .95 && R.sobreposicao(new Set(mp.arestas), new Set(verdade(hotCam).keys())) < .1, "a rota paralela não pode ser casada com a via crítica");
      // 3) determinismo e sem resíduo de estado entre chamadas
      assert.deepStrictEqual(Array.from(R.casarGrafo(ruido(ptsHot, 6)).arestas).length > 0, true);
      seed = 99; const x1 = Array.from(R.casarGrafo(ruido(ptsHot, 6)).arestas); seed = 99; const x2 = Array.from(R.casarGrafo(ruido(ptsHot, 6)).arestas);
      assert.deepStrictEqual(x1, x2, "mesma entrada deveria dar o mesmo casamento");
      // 4) buraco de ~100 m no GPS: o caminho é preenchido pela rede
      const n0 = ptsHot.length, buraco = ptsHot.filter((_, i) => i < n0 * .4 || i > n0 * .4 + 12);
      m = R.casarGrafo(ruido(buraco, 4));
      assert(cobre(m, verdade(hotCam)) >= .95, "o buraco no traçado deveria ser preenchido pelo caminho mínimo (cobre " + cobre(m, verdade(hotCam)).toFixed(2) + ")");
      // 5) ponto isolado a 200 m: descartado, não arrasta o casamento
      const com = ruido(ptsHot, 4); com[Math.floor(com.length / 2)] = [com[0][0] + .002, com[0][1] + .002];
      m = R.casarGrafo(com); assert(m.semCandidato >= 1, "o ponto fora da malha deveria ser contado"); assert(cobre(m, verdade(hotCam)) >= .95, "o outlier não pode degradar o casamento");
      // 5b) rotas de VÁRIAS arestas, todos os pares de nós, ruído de 5 m: recupera quase tudo e quase nada a mais
      {
        const cob = [], cor = []; seed = 777;
        for (let a = 0; a < R.nNos; a++) for (let b = 0; b < R.nNos; b++) {
          if (a === b) continue; const c = R.caminhoSeguro(a, b, F, R.PLAN.extra);
          if (!c || c.arcs.length < 2 || metros(c) < 150) continue;
          const mm = R.casarGrafo(ruido(dens(R.arcosParaPontos(c.arcs), 8), 5)); assert(!mm.erro, "par " + a + "→" + b + ": " + mm.erro);
          cob.push(cobre(mm, verdade(c))); cor.push(extra(mm, verdade(c)));
        }
        assert(cob.length >= 4, "poucas rotas de várias arestas para testar (" + cob.length + ")");
        const med = v => v.reduce((x, y) => x + y, 0) / v.length;
        console.log("    map matching (" + cob.length + " rotas multi-aresta, ruído 5 m): cobertura média " + (100 * med(cob)).toFixed(1) + "% (pior " + (100 * Math.min(...cob)).toFixed(1) + "%), acerto médio " + (100 * med(cor)).toFixed(1) + "% (pior " + (100 * Math.min(...cor)).toFixed(1) + "%)");
        assert(med(cob) >= .93 && Math.min(...cob) >= .8, "cobertura multi-aresta baixa: " + med(cob).toFixed(3) + " / pior " + Math.min(...cob).toFixed(3));
        assert(med(cor) >= .93 && Math.min(...cor) >= .8, "acerto multi-aresta baixo: " + med(cor).toFixed(3) + " / pior " + Math.min(...cor).toFixed(3));
      }
      // 6) entradas inválidas
      assert(R.casarGrafo([]).erro, "traçado vazio deveria dar erro");
      assert(R.casarGrafo([[0, 0], [0.001, 0.001]]).erro, "traçado longe da cidade deveria dar erro");
      // 7) comparação aresta por aresta: hot x paralela -> quase nada em comum, e as parcelas fecham
      const mh = R.casarGrafo(ptsHot), mq = R.casarGrafo(ptsPar), c = R.compararCaminhosGrafo(mh, mq, B);
      assert(Math.abs(c.comumM + c.soA.m - c.totalA) < 1 && Math.abs(c.comumM + c.soB.m - c.totalB) < 1, "comum + exclusivo deveria fechar com o total de cada rota");
      assert(c.jaccard < .3, "rotas por ruas diferentes deveriam ter pouca sobreposição (" + c.jaccard.toFixed(2) + ")");
      assert(c.soA.exposicao > c.soB.exposicao, "o trecho exclusivo da via crítica deveria ter mais exposição que o da paralela");
      const cc = R.compararCaminhosGrafo(mh, mh, B); assert(cc.jaccard === 1 && cc.soA.m === 0 && cc.soB.m === 0, "uma rota comparada com ela mesma é idêntica");
    }
    assert.deepStrictEqual(erros, [], arq + ": erros de JS:\n" + erros.join("\n"));
    console.log("  ok " + arq + " — " + pares + " pares sem contramão; B→A " + Math.round(metros(ba)) + " m (curto " + Math.round(ref) + " m)" + (usaHot(ba) ? " pela via crítica" : " evitando a via crítica"));
  }
  console.log("roteador OK");
  process.exit(0);
})().catch(e => { console.error("FALHOU:", e); process.exit(1); });

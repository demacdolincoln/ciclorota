// ================================================================================================================
// EXPERIMENTAL — map matching (HMM + Viterbi, Newson & Krumm 2009) de um traçado na malha de bicicleta do app.
// Concatenado depois de rotas.js pelo build (mesmo escopo: usa EU/EV/EL/EF/EC, Grid, Heap, toXY, interior, L, MAPA…).
//
// Para que serve: transformar um traçado GPS (ruidoso) ou planejado numa SEQUÊNCIA DE ARESTAS do grafo. Com as
// arestas de duas rotas dá para compará-las aresta por aresta (trecho em comum, só numa, risco, infraestrutura,
// vias sem registro de ocorrências) em vez de comparar linhas desenhadas.
//
// Modelo:
//   - estados: arestas candidatas a menos de MM.raio metros de cada ponto (até MM.K, as mais próximas);
//   - emissão:   log p = −d² / (2σ²)            (d = distância do ponto à aresta);
//   - transição: log p = −|n − g| / β            (g = distância em linha reta entre pontos consecutivos,
//                                                 n = distância pela rede entre os pontos projetados);
//   - n usa a malha SEM mão única (quem pedala contra o sentido existe; o contrafluxo não é julgado aqui);
//   - pontos sem nenhuma aresta por perto são descartados (contados em semCandidato); se nenhuma transição é
//     viável (buraco no GPS maior que o alcance), a cadeia é cortada e recomeça (contado em quebras).
// As arestas das pontas de cada cadeia contam só o trecho PERCORRIDO (do ponto até onde a rota sai/entra), e ponta com
// menos de MM.minExt metros é descartada (evita arestas de cruzamento escolhidas por ruído perto de um nó).
// Limitações conhecidas: não usa timestamps nem velocidade; não trata túneis/viadutos sobrepostos (o grafo não tem a coordenada Z).
// ================================================================================================================
const MM = {passo: 20, raio: 35, sigma: 10, beta: 15, K: 6, capMax: 600, folga: 80, minExt: 10};
let _mmUA = null, _mmGrid = null, _mmD = null, _mmP = null;
const _mmPoli = new Map();

function mmAdjacencia() {                         // adjacência NÃO dirigida (aresta -> os dois nós), construída uma vez
  if (_mmUA) return _mmUA;
  const E = EU.length, st = new Int32Array(NN + 1);
  for (let e = 0; e < E; e++) { st[EU[e] + 1]++; st[EV[e] + 1]++; }
  for (let i = 0; i < NN; i++) st[i + 1] += st[i];
  const adj = new Int32Array(st[NN]), pos = st.slice(0, NN);
  for (let e = 0; e < E; e++) { adj[pos[EU[e]]++] = e; adj[pos[EV[e]]++] = e; }
  return (_mmUA = {st, adj});
}
function mmPoli(e, guardar = true) {              // polilinha da aresta em metros: nó u, pontos intermediários, nó v
  const c = _mmPoli.get(e); if (c) return c;
  const x = [NXm[EU[e]]], y = [NYm[EU[e]]];
  interior(e).forEach(p => { const q = toXY(p[0], p[1]); x.push(q[0]); y.push(q[1]); });
  x.push(NXm[EV[e]]); y.push(NYm[EV[e]]);
  const cum = [0]; for (let i = 1; i < x.length; i++) cum.push(cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]));
  const p = {x, y, cum, tot: cum[cum.length - 1]};
  if (guardar) _mmPoli.set(e, p);
  return p;
}
function mmIndice() {                             // índice espacial dos segmentos de TODAS as arestas (construído na 1ª vez)
  if (_mmGrid) return _mmGrid;
  const g = new Grid(100);
  for (let e = 0; e < EU.length; e++) { const p = mmPoli(e, false); for (let i = 1; i < p.x.length; i++) g.add(p.x[i - 1], p.y[i - 1], p.x[i], p.y[i], e); }
  return (_mmGrid = g);
}
function mmProjetar(p, px, py) {                  // ponto -> polilinha: distância e posição (m) ao longo dela
  let melhor = Infinity, s = 0;
  for (let i = 1; i < p.x.length; i++) {
    const x1 = p.x[i - 1], y1 = p.y[i - 1], dx = p.x[i] - x1, dy = p.y[i] - y1, L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = x1 + t * dx - px, qy = y1 + t * dy - py, d2 = qx * qx + qy * qy;
    if (d2 < melhor) { melhor = d2; s = p.cum[i - 1] + t * Math.sqrt(L2); }
  }
  return {d: Math.sqrt(melhor), s};
}
function mmCandidatos(x, y, o) {
  const m = new Map();
  mmIndice().query(x, y, o.raio, (e, d2) => { const a = m.get(e); if (a === undefined || d2 < a) m.set(e, d2); });
  const out = [];
  m.forEach((_, e) => { const p = mmPoli(e), pr = mmProjetar(p, x, y);
    out.push({e, d: pr.d, s: p.tot > 0 ? pr.s * EL[e] / p.tot : 0, L: EL[e], u: EU[e], v: EV[e]}); });
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, o.K);
}
function mmReamostrar(pts, passo) {               // mantém um ponto a cada `passo` metros (descarta paradas e excesso de ruído)
  const out = []; let ult = null;
  for (const p of pts) {
    const q = toXY(p[0], p[1]);
    if (!ult || Math.hypot(q[0] - ult[0], q[1] - ult[1]) >= passo) { out.push({x: q[0], y: q[1]}); ult = q; }
  }
  if (pts.length > 1) { const q = toXY(pts[pts.length - 1][0], pts[pts.length - 1][1]); if (ult && (q[0] !== ult[0] || q[1] !== ult[1])) out.push({x: q[0], y: q[1]}); }   // o último ponto nunca se perde
  return out;
}
// Dijkstra local (rede sem mão única) a partir de `src`, limitado a `cap` metros; reutiliza os vetores globais e
// os restaura ao final. Devolve, para cada alvo, a distância e (opcional) as arestas do caminho.
function mmDijkstra(src, cap, alvos, comCaminho) {
  if (!_mmD || _mmD.length !== NN) { _mmD = new Float64Array(NN).fill(Infinity); _mmP = new Int32Array(NN).fill(-1); }
  const {st, adj} = mmAdjacencia(), D = _mmD, P = _mmP, tocados = [src], hp = new Heap();
  D[src] = 0; hp.push(0, src);
  while (hp.size) {
    const [k, u] = hp.pop(); if (k > D[u]) continue;
    for (let i = st[u]; i < st[u + 1]; i++) {
      const e = adj[i], v = EU[e] === u ? EV[e] : EU[e], nd = k + EL[e];
      if (nd <= cap && nd < D[v]) { if (D[v] === Infinity) tocados.push(v); D[v] = nd; P[v] = e; hp.push(nd, v); }
    }
  }
  const res = alvos.map(b => {
    const d = D[b]; let edges = null;
    if (comCaminho && d < Infinity) { edges = []; let n = b; while (n !== src) { const e = P[n]; edges.push(e); n = EU[e] === n ? EV[e] : EU[e]; } edges.reverse(); }
    return {d, edges};
  });
  for (const n of tocados) { D[n] = Infinity; P[n] = -1; }
  return res;
}
const mmCap = (g, o) => Math.min(o.capMax, 2 * g + o.folga);
// melhor forma de ir de c1 a c2 pela rede: distância e o par de extremidades usado
function mmLigacao(c1, c2, tab) {
  if (c1.e === c2.e) return {n: Math.abs(c2.s - c1.s), mesma: true};
  const A = [[c1.u, c1.s], [c1.v, c1.L - c1.s]], B = [[c2.u, c2.s], [c2.v, c2.L - c2.s]];
  let melhor = {n: Infinity};
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const d = tab.get(A[i][0]).get(B[j][0]), n = A[i][1] + d + B[j][1];
    if (n < melhor.n) melhor = {n, a: A[i][0], b: B[j][0]};
  }
  return melhor;
}
function mmTabela(C1, C2, cap) {                  // distâncias de cada nó das candidatas C1 a cada nó das candidatas C2
  const fontes = [...new Set(C1.flatMap(c => [c.u, c.v]))], alvos = [...new Set(C2.flatMap(c => [c.u, c.v]))], tab = new Map();
  fontes.forEach(f => { const r = mmDijkstra(f, cap, alvos, false), m = new Map(); alvos.forEach((a, i) => m.set(a, r[i].d)); tab.set(f, m); });
  return tab;
}

// pts: [[lat, lon], ...]  ->  {arestas, metros, pontos, casados, semCandidato, quebras, fracCasada, erroMedio} | {erro}
function casarGrafo(pts, opt) {
  if (!TEM_GRAFO) return {erro: "Grafo de bicicleta ausente neste mapa."};
  const o = Object.assign({}, MM, opt), amo = mmReamostrar(pts || [], o.passo);
  const cands = amo.map(a => mmCandidatos(a.x, a.y, o)), idx = [];
  cands.forEach((c, i) => { if (c.length) idx.push(i); });
  if (!idx.length) return {erro: "Nenhum ponto está a menos de " + o.raio + " m de uma via do grafo de bicicleta."};
  const T = idx.length, P = idx.map(i => amo[i]), C = idx.map(i => cands[i]);
  const emissao = c => -(c.d * c.d) / (2 * o.sigma * o.sigma);

  // Viterbi, com cadeias: se nenhuma transição é viável a cadeia termina e outra começa no ponto atual
  const cadeias = []; let ini = 0, score = C[0].map(emissao); const back = [C[0].map(() => -1)];
  const fechar = fim => {
    let j = 0; score.forEach((s, k) => { if (s > score[j]) j = k; });
    const esc = new Array(fim - ini + 1); esc[fim - ini] = j;
    for (let t = fim; t > ini; t--) { j = back[t][j]; esc[t - 1 - ini] = j; }
    cadeias.push({ini, fim, esc});
  };
  for (let t = 1; t < T; t++) {
    const g = Math.hypot(P[t].x - P[t - 1].x, P[t].y - P[t - 1].y), cap = mmCap(g, o), tab = mmTabela(C[t - 1], C[t], cap);
    const novo = C[t].map(() => -Infinity), bk = C[t].map(() => -1);
    C[t].forEach((c2, j) => C[t - 1].forEach((c1, i) => {
      if (score[i] === -Infinity) return;
      const n = mmLigacao(c1, c2, tab).n; if (!(n <= cap)) return;
      const s = score[i] - Math.abs(n - g) / o.beta + emissao(c2);
      if (s > novo[j]) { novo[j] = s; bk[j] = i; }
    }));
    if (novo.every(s => s === -Infinity)) { fechar(t - 1); ini = t; score = C[t].map(emissao); back[t] = C[t].map(() => -1); }
    else { score = novo; back[t] = bk; }
  }
  fechar(T - 1);

  // reconstrução: arestas candidatas escolhidas + caminho mínimo entre elas; nas pontas só conta o trecho percorrido
  const partes = []; let soma = 0, nErro = 0;
  cadeias.forEach(ch => {
    const seq = []; let saidaIni, entradaFim;
    const poe = e => { if (seq[seq.length - 1] !== e) seq.push(e); };
    for (let t = ch.ini; t <= ch.fim; t++) {
      const c2 = C[t][ch.esc[t - ch.ini]]; soma += c2.d; nErro++;
      if (t === ch.ini) { poe(c2.e); continue; }
      const c1 = C[t - 1][ch.esc[t - 1 - ch.ini]], g = Math.hypot(P[t].x - P[t - 1].x, P[t].y - P[t - 1].y), cap = mmCap(g, o);
      if (c1.e !== c2.e) {
        const tab = mmTabela([c1], [c2], cap), lig = mmLigacao(c1, c2, tab);
        if (lig.a !== undefined) {
          if (saidaIni === undefined) saidaIni = lig.a;
          entradaFim = lig.b;
          const r = mmDijkstra(lig.a, cap, [lig.b], true)[0]; if (r.edges) r.edges.forEach(poe);
        }
      }
      poe(c2.e);
    }
    const sIni = C[ch.ini][ch.esc[0]].s, sFim = C[ch.fim][ch.esc[ch.fim - ch.ini]].s, m = seq.map(e => EL[e]);
    if (seq.length === 1) m[0] = Math.abs(sFim - sIni);
    else {
      if (saidaIni !== undefined) m[0] = saidaIni === EU[seq[0]] ? sIni : EL[seq[0]] - sIni;
      const k = seq.length - 1; if (entradaFim !== undefined) m[k] = entradaFim === EU[seq[k]] ? sFim : EL[seq[k]] - sFim;
    }
    let a = 0, b = seq.length;
    while (b - a > 1 && m[a] < o.minExt) a++;
    while (b - a > 1 && m[b - 1] < o.minExt) b--;
    for (let k = a; k < b; k++) partes.push({e: seq[k], m: Math.max(0, Math.min(EL[seq[k]], m[k]))});
  });
  return {arestas: partes.map(p => p.e), partes, metros: partes.reduce((t, p) => t + p.m, 0), pontos: amo.length, casados: T, semCandidato: amo.length - T,
    quebras: cadeias.length - 1, fracCasada: T / amo.length, erroMedio: nErro ? soma / nErro : 0};
}

// ---------------------------------------------------------------- comparação aresta por aresta
const MM_CLASSES = ["sem infraestrutura", "ciclovia", "ciclofaixa", "faixa compartilhada"];
const nomeAresta = e => { const f = EF[e]; return f >= 0 ? D.geo.features[f].properties.n : ""; };
function compararCaminhosGrafo(A, B, base) {
  const comp = m => { const r = new Map(); (m.partes || m.arestas.map(e => ({e, m: EL[e]}))).forEach(p => r.set(p.e, Math.min(EL[p.e], (r.get(p.e) || 0) + p.m))); return r; };
  const a = comp(A), b = comp(B), soA = [], soB = []; let comum = 0, mA = 0, mB = 0;
  a.forEach((L, e) => { mA += L; if (b.has(e)) comum += Math.min(L, b.get(e)); else soA.push(e); });
  b.forEach((L, e) => { mB += L; if (!a.has(e)) soB.push(e); });
  const Fs = base ? fatoresSeguranca(PLAN, base) : null;
  const registrada = e => EF[e] >= 0 && base && base.pct[EF[e]] > 0;
  const resumo = (es, W) => {
    let m = 0, infra = 0, semReg = 0, expo = 0; const vias = new Map();
    es.forEach(e => {
      const L = W.get(e); m += L; if (EC[e] > 0) infra += L; if (base && !registrada(e)) semReg += L; if (Fs) expo += L * (Fs[e] - 1);
      const f = EF[e], chave = f >= 0 ? "f" + f : "sem", o = vias.get(chave) || {nome: f >= 0 ? D.geo.features[f].properties.n : "(sem registro de ocorrências)",
        bairro: f >= 0 ? (D.geo.features[f].properties.b || "") : "", m: 0, classe: EC[e], pct: f >= 0 && base ? base.pct[f] : 0};
      o.m += L; vias.set(chave, o);
    });
    return {m, infraFrac: m ? infra / m : 0, semRegFrac: m ? semReg / m : 0, exposicao: m ? expo / m : 0, arestas: es,
      vias: [...vias.values()].sort((x, y) => y.m - x.m)};
  };
  return {totalA: mA, totalB: mB, comumM: comum, jaccard: (mA + mB - comum) ? comum / (mA + mB - comum) : 1, soA: resumo(soA, a), soB: resumo(soB, b)};
}

// ---------------------------------------------------------------- interface (botão na aba Rotas)
const mmGrp = L.layerGroup().addTo(MAPA);
const mmLatLngs = e => [[NLAT[EU[e]], NLON[EU[e]]], ...interior(e), [NLAT[EV[e]], NLON[EV[e]]]];
function mmDesenhar(es, cor, peso, tracejado) {
  es.forEach(e => L.polyline(mmLatLngs(e), {pane: "p_rotas", renderer: CAMADAS.rotas.rend, interactive: false, color: cor, weight: peso, opacity: .9, dashArray: tracejado || null, lineCap: "round"}).addTo(mmGrp));
}
function mmExecutar() {
  const msg = $("mmMsg"); mmGrp.clearLayers(); msg.hidden = false;
  const limpar = '<button class="btn" id="mmLimparBtn">✕ Limpar</button>';
  const fim = html => { msg.innerHTML = html + "<br>" + limpar; $("mmLimparBtn").onclick = () => { mmGrp.clearLayers(); msg.hidden = true; msg.innerHTML = ""; }; };
  if (!TEM_GRAFO) return fim("Grafo de bicicleta ausente neste mapa.");
  const rA = (rotaSel && rotas.find(x => x.id === rotaSel)) || rotas[0];
  if (!rA) return fim("Carregue um GPX ou planeje uma rota primeiro.");
  const rB = rotas.find(x => x !== rA && x.id === "plano") || rotas.find(x => x !== rA);
  const mA = casarGrafo(rA.pts); if (mA.erro) return fim(esc(rA.nome) + ": " + esc(mA.erro));
  const linha = (r, m) => "<b>" + esc(r.nome) + "</b>: " + f1(m.fracCasada) + " dos pontos casados (erro médio " + m.erroMedio.toFixed(1) + " m), " + (m.metros / 1000).toFixed(2) + " km no grafo" +
    (m.quebras ? ", " + m.quebras + " ruptura(s) por buraco no traçado" : "") + (m.semCandidato ? ", " + m.semCandidato + " ponto(s) fora da malha" : "");
  if (!rB) { mmDesenhar(mA.arestas, rA.cor, 5); return fim("<b>Casamento com o grafo (experimental)</b><br>" + linha(rA, mA) + "<br><span class=\"mut\">Carregue ou planeje uma segunda rota para compará-las aresta por aresta.</span>"); }
  const mB = casarGrafo(rB.pts); if (mB.erro) return fim(esc(rB.nome) + ": " + esc(mB.erro));
  const base = baseDe(JAN_PADRAO()), c = compararCaminhosGrafo(mA, mB, base);
  const COR_A = "#e65100", COR_B = "#00897b";
  mmDesenhar([...new Set(mA.arestas)].filter(e => !c.soA.arestas.includes(e)), "#757575", 5);
  mmDesenhar(c.soA.arestas, COR_A, 5); mmDesenhar(c.soB.arestas, COR_B, 5);
  const lado = (rot, cor, s, mt) => '<br><span style="color:' + cor + '">■</span> só em <b>' + esc(rot.nome) + "</b>: " + (s.m / 1000).toFixed(2) + " km" +
    (s.m ? " · infra " + f1(s.infraFrac) + " · sem registro " + f1(s.semRegFrac) + " · exposição " + s.exposicao.toFixed(2) + "/m" : "") +
    (s.vias.length ? "<ul>" + s.vias.slice(0, 5).map(v => "<li>" + esc(v.nome) + (v.bairro ? " (" + esc(v.bairro.toLowerCase()) + ")" : "") + " — " + Math.round(v.m) + " m · " + MM_CLASSES[v.classe] + "</li>").join("") + "</ul>" : "");
  fim("<b>Comparação no grafo (experimental)</b><br>" + linha(rA, mA) + "<br>" + linha(rB, mB) +
    '<br><span style="color:#757575">■</span> em comum: ' + (c.comumM / 1000).toFixed(2) + " km (" + f1(c.jaccard) + " de sobreposição)" +
    lado(rA, COR_A, c.soA) + lado(rB, COR_B, c.soB) +
    '<br><span class="mut">Exposição = excesso médio de custo de segurança por metro (0 = sem risco). Comprimentos aproximados (arestas inteiras nas pontas).</span>');
}
if ($("btnMM")) $("btnMM").onclick = mmExecutar;
Object.assign(window.__rotas, {casarGrafo, compararCaminhosGrafo, nomeAresta, MM, mmExecutar, EL, EF, EC});

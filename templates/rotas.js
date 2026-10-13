// =====================================================================
// 5. ROTAS: índice espacial, GPX, risco por trecho, roteamento (planejar e
//    desviar), comparador, perfil de risco, biblioteca e exportação
// =====================================================================
const LAT0 = -8.05, LON0 = -34.9, MXF = 111320 * Math.cos(LAT0 * Math.PI / 180), MYF = 110574;
const toXY = (lat, lon) => [(lon - LON0) * MXF, (lat - LAT0) * MYF];
function dist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x1 + t * dx - px, qy = y1 + t * dy - py; return qx * qx + qy * qy;
}
class Grid {
  constructor(c) { this.c = c; this.m = new Map(); this.s = []; }
  add(x1, y1, x2, y2, tag) {
    const id = this.s.length / 5, c = this.c; this.s.push(x1, y1, x2, y2, tag);
    const i0 = Math.floor(Math.min(x1, x2) / c), i1 = Math.floor(Math.max(x1, x2) / c);
    const j0 = Math.floor(Math.min(y1, y2) / c), j1 = Math.floor(Math.max(y1, y2) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * 100003 + j; let a = this.m.get(k); if (!a) { a = []; this.m.set(k, a); } a.push(id); }
  }
  addLine(cs, tag) { for (let n = 1; n < cs.length; n++) { const a = toXY(cs[n-1][1], cs[n-1][0]), b = toXY(cs[n][1], cs[n][0]); this.add(a[0], a[1], b[0], b[1], tag); } }
  addGeom(g, tag) { if (g.type === "LineString") this.addLine(g.coordinates, tag); else if (g.type === "MultiLineString") g.coordinates.forEach(c => this.addLine(c, tag)); }
  query(x, y, r, fn) {
    const c = this.c, s = this.s, r2 = r * r;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((y - r) / c), j1 = Math.floor((y + r) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = this.m.get(i * 100003 + j); if (!a) continue;
      for (const id of a) { const o = id * 5, d2 = dist2(x, y, s[o], s[o+1], s[o+2], s[o+3]); if (d2 <= r2) fn(s[o+4], d2); } }
  }
}
const roadGrid = new Grid(100), cicloGrid = new Grid(100);
D.geo.features.forEach((f, i) => roadGrid.addGeom(f.geometry, i));
D.ciclo.feats.forEach(f => cicloGrid.addGeom(f.geometry, f.c));

// ---------------------------------------------------------------- estado e utilitários
const PALR = ["#1f3a93", "#7a1fa2", "#00838f", "#6d4c41", "#455a64", "#c2185b"];
let rotas = [], seqRota = 0;
const STEP = 20, R_VIA = 25, R_CICLO = 15;
const JAN_PADRAO = () => ({h1: +$("h1").value, h2: +$("h2").value, dias: $("dias").value});
const DIAS_TXT = {todos: "todos os dias", uteis: "dias úteis", fds: "fins de semana"};
const FH = new Intl.DateTimeFormat("en-GB", {timeZone: "America/Recife", hour: "2-digit", minute: "2-digit", hour12: false});
const FD = new Intl.DateTimeFormat("en-US", {timeZone: "America/Recife", weekday: "short"});
const DEN = {Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6};
function horaLocal(ms) { const p = FH.formatToParts(new Date(ms)); return {h: (+p.find(x => x.type === "hour").value) % 24, m: +p.find(x => x.type === "minute").value}; }
const hhmm = o => String(o.h).padStart(2, "0") + "h" + String(o.m).padStart(2, "0");
const slug = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 70) || "rota";
const novoId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const AVISO_LACUNAS = "Vias sem ocorrências registradas aparecem como incertas, não como seguras: as chamadas do SAMU são localizadas pelo nome da via, e a ausência de registro pode ser apenas falta de dado. Confira a infraestrutura e o tráfego no local.";

function simplificar(pts, tolM) {                // Douglas-Peucker (metros)
  if (pts.length < 3) return pts.slice();
  const xy = pts.map(p => toXY(p[0], p[1])), keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const pilha = [[0, pts.length - 1]];
  while (pilha.length) {
    const [a, b] = pilha.pop(); let dm = 0, im = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.sqrt(dist2(xy[i][0], xy[i][1], xy[a][0], xy[a][1], xy[b][0], xy[b][1])); if (d > dm) { dm = d; im = i; } }
    if (im >= 0 && dm > tolM) { keep[im] = 1; pilha.push([a, im], [im, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------- GPX (leitura e escrita)
function lerGpx(txt, nome) {
  const doc = new DOMParser().parseFromString(txt, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("arquivo GPX inválido");
  let nodes = [...doc.getElementsByTagName("trkpt")];
  if (!nodes.length) nodes = [...doc.getElementsByTagName("rtept")];
  const pts = [], times = [];
  nodes.forEach(n => { const lat = +n.getAttribute("lat"), lon = +n.getAttribute("lon");
    if (isFinite(lat) && isFinite(lon)) { pts.push([lat, lon]); const t = n.getElementsByTagName("time")[0]; times.push(t ? Date.parse(t.textContent) : NaN); } });
  if (pts.length < 2) throw new Error("GPX sem pontos de trilha");
  const nm = doc.getElementsByTagName("name")[0];
  return {nome: (nm && nm.textContent.trim()) || nome, pts, times};
}
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
function tempos(o) {                              // timestamps por ponto: originais ou interpolados por distância
  const n = o.pts.length;
  if (o.times && o.times.length === n && o.times.every(isFinite)) return o.times;
  if (o.tIni != null && o.tFim != null && n > 1) {
    const cum = [0]; for (let i = 1; i < n; i++) { const a = toXY(o.pts[i-1][0], o.pts[i-1][1]), b = toXY(o.pts[i][0], o.pts[i][1]); cum.push(cum[i-1] + Math.hypot(b[0]-a[0], b[1]-a[1])); }
    const tot = cum[n-1] || 1; return cum.map(c => o.tIni + (o.tFim - o.tIni) * c / tot);
  }
  return null;
}
function gpxDe(o) {
  const t = tempos(o);
  const pts = o.pts.map((p, i) => '<trkpt lat="' + p[0].toFixed(6) + '" lon="' + p[1].toFixed(6) + '">' + (t ? "<time>" + new Date(t[i]).toISOString() + "</time>" : "") + "</trkpt>").join("");
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="samu-risco" xmlns="http://www.topografix.com/GPX/1/1">' +
    "<metadata><name>" + xmlEsc(o.nome) + "</name></metadata><trk><name>" + xmlEsc(o.nome) + "</name><trkseg>" + pts + "</trkseg></trk></gpx>\n";
}

// ---------------------------------------------------------------- criação/preparo de rotas
function prepararRota(r) {
  const xy = []; let lx = null, ly = null;
  r.pts.forEach(p => { const q = toXY(p[0], p[1]); if (lx === null || Math.hypot(q[0] - lx, q[1] - ly) >= 3) { xy.push(q); lx = q[0]; ly = q[1]; } });
  const cum = [0]; for (let i = 1; i < xy.length; i++) cum.push(cum[i-1] + Math.hypot(xy[i][0] - xy[i-1][0], xy[i][1] - xy[i-1][1]));
  const total = cum[cum.length - 1]; r.dist = total; r.samples = [];
  let k = 0;
  for (let s = 0; s <= total; s += STEP) {
    while (k < cum.length - 2 && cum[k+1] < s) k++;
    const seg = (cum[k+1] - cum[k]) || 1, t = (s - cum[k]) / seg;
    const x = xy[k][0] + t * (xy[k+1][0] - xy[k][0]), y = xy[k][1] + t * (xy[k+1][1] - xy[k][1]);
    let fid = -1, bd = Infinity; roadGrid.query(x, y, R_VIA, (tag, d2) => { if (d2 < bd) { bd = d2; fid = tag; } });
    let ci = -1; cicloGrid.query(x, y, R_CICLO, tag => { if (ci < 0 || tag < ci) ci = tag; });
    r.samples.push({lat: LAT0 + y / MYF, lon: LON0 + x / MXF, fid, ciclo: ci});
  }
  const ok = (r.times || []).filter(isFinite);
  r.t0 = ok.length ? ok[0] : (r.tIni != null ? r.tIni : null);
  r.t1 = ok.length ? ok[ok.length - 1] : (r.tFim != null ? r.tFim : null);
  if (r.t0 !== null && r.t1 !== null) {
    const a = horaLocal(r.t0), b = horaLocal(r.t1), dn = DEN[FD.format(new Date(r.t0))];
    r.ini = a; r.fim = b; r.util = dn < 5; r.dia = D.dias[dn].toLowerCase();
    r.dur = (r.t1 - r.t0) / 1000;
    r.janAuto = {h1: Math.max(0, a.h - 1), h2: b.h < a.h ? 23 : Math.min(23, b.h + 1), dias: r.util ? "uteis" : "fds"};
  }
  if (!r.jan) r.jan = r.janAuto ? Object.assign({}, r.janAuto) : JAN_PADRAO();
  return r;
}
function criarRota(o) {
  seqRota++;
  return prepararRota(Object.assign({id: "r" + seqRota, cor: PALR[(seqRota - 1) % PALR.length], times: [], origem: "gpx", sentido: "", desvio: null, meta: {}}, o));
}

// ---------------------------------------------------------------- risco por trecho
// MÉTRICA: a mesma régua por QUANTIL do Panorama (rankQuantil/classes em app.js). Cada trecho
// (via×bairro) recebe um valor = contagem ponderada por gravidade (atropelamento = W_ATR × acidente)
// no recorte dos filtros de rota; para a rota, a contagem mistura a janela de horário e o dia todo
// (taxa por hora nos dois lados). Vale o posto percentil entre os trechos COM registro, e a classe
// (baixo/moderado/elevado/alto/crítico) vem dos mesmos cortes do Panorama.
//  • Sem suavização bayesiana nem tendência: elas puxavam hotspots localizados para a média da
//    cidade (as chamadas só são localizadas pelo NOME da via, não há ponto exato).
//  • Cortes recalculados a cada filtro; o nível de uma via é relativo às demais vias com registro.
//  • Via sem registro = "incerto" (INCERTO), nunca "seguro"; fica abaixo de qualquer via registrada.
//  • Ciclovia NÃO reduz a cor/nota (é informação à parte, exibida na tabela); o roteador segue
//    usando PARAMS.PROT na escolha do caminho.
// Parâmetros (expostos em __rotas.PARAMS):
//  W_ATR — peso de um ATROPELAMENTO relativo a um ACIDENTE (naturezas: 0=Acidente, 1=Atropelamento).
//  INCERTO — valor (0–100) de via sem registro e de fora da malha.
//  CLASSE_CRIT — menor classe considerada "trecho crítico" (3 = alto, top 10% das vias).
//  PROT/V_BIKE/V_MIN/V_MAX — proteção cicloviária no roteador; velocidades p/ tempo de exposição.
const PARAMS = {W_ATR: 1.5, INCERTO: 35, CLASSE_CRIT: 3, PROT: .5, V_BIKE: 15, V_MIN: 5, V_MAX: 35};
const INC = () => PARAMS.INCERTO / 100;           // versão 0–1 usada internamente (pct/perfil)
const W_NAT = () => [1, PARAMS.W_ATR];            // peso por natureza (0 Acidente, 1 Atropelamento)
const AI = D.anos.length ? D.anos : [2026];       // anos reais (índice e[10] é posição em D.anos)
const NAI = () => AI.length - 1;                  // índice do ano mais recente
// fração dos ANOS DE COBERTURA efetivamente selecionada no filtro: entra na banda ± como incerteza amostral.
const FR_AMOSTRA = () => { const cob = AI[NAI()] - AI[0] + 1; return cob > 0 ? Math.min(1, SR.ano.size / cob) : 1; };
// escala 0–1 do risco exibido: sem registro = INCERTO (< .4); com registro, PCT_MIN + (1−PCT_MIN)×posto.
const PCT_MIN = .4;
const pctDe = pr => PCT_MIN + (1 - PCT_MIN) * pr;
const PCT_CORTES = QCORTES.map(pctDe);            // limites de classe na escala exibida
const classeDePct = p => { let k = 0; while (k < PCT_CORTES.length && p >= PCT_CORTES[k] - 1e-6) k++; return k; };

function riscoBase(jan) {
  const h1 = jan.h1, h2 = jan.h2, dm = jan.dias, wn = W_NAT();
  // janela horária (pode passar da meia-noite, ex. 22h→2h)
  const normH = h => ((h % 24) + 24) % 24;
  const h1n = normH(h1), h2n = normH(h2);
  const dentroHora = hr => h1n <= h2n ? (hr >= h1n && hr <= h2n) : (hr >= h1n || hr <= h2n);
  const nHjan = h1n <= h2n ? h2n - h1n + 1 : 24 - h1n + h2n + 1, nHdia = 24;
  const cw = new Float64Array(NF), ca = new Float64Array(NF), cwv = new Int32Array(NF * NV);
  const cwW = new Float64Array(NF), caW = new Float64Array(NF);   // idem, ponderados por gravidade
  let nw = 0, na = 0;
  for (const e of D.ev) {
    if (!(SR.ano.has(e[10]) && SR.veic.has(e[1]) && SR.nat.has(e[2]))) continue;
    if (dm === "uteis" && e[4] > 4) continue; if (dm === "fds" && e[4] < 5) continue;
    na++; const dentro = dentroHora(e[5]); if (dentro) nw++;
    if (e[0] >= 0) {
      const w = wn[e[2]];
      ca[e[0]]++; caW[e[0]] += w;
      if (dentro) { cw[e[0]]++; cwW[e[0]] += w; cwv[e[0] * NV + e[1]]++; }
    }
  }
  // fração do ano que o filtro de dias representa (5/7, 2/7): equilibra janela × dia todo
  const fDia = dm === "uteis" ? 5 / 7 : dm === "fds" ? 2 / 7 : 1;
  const val = new Float64Array(NF);
  for (let i = 0; i < NF; i++) val[i] = cwW[i] / nHjan + caW[i] * fDia / nHdia;
  const Q = rankQuantil(val);
  const pct = new Float32Array(NF), rk = new Float32Array(NF);
  for (let i = 0; i < NF; i++) if (Q.cls[i] >= 0) { rk[i] = Q.pr[i]; pct[i] = pctDe(Q.pr[i]); }
  return {cw, ca, cwv, pct, rk, cls: Q.cls, faixas: Q.faixas, nReg: Q.n, nw, na, h1, h2, dias: dm};
}
let BC = new Map();
// a chave do cache inclui os filtros de rota (ano, veículo, natureza) e a janela
function baseDe(jan) {
  const key = jan.h1 + "-" + jan.h2 + "-" + jan.dias + "|" + [...SR.ano].join(",") + "|" + [...SR.veic].join(",") + "|" + [...SR.nat].join(",");
  if (!BC.has(key)) BC.set(key, riscoBase(jan));
  return BC.get(key);
}

// risco 0–1 de uma amostra: via registrada → pct (posto percentil na escala exibida); via sem
// registro ou fora da malha → incerto (coerente com o roteador). Sem redução por ciclovia.
const riscoAmostra = (s, B) => (s.fid >= 0 && B.pct[s.fid] > 0) ? B.pct[s.fid] : INC();
// cores por classe (mesmos cortes do Panorama); incerto em marrom, sem dado em cinza
const COR_CL = ["#2fb344", "#f2c200", "#f08a24", "#d62d20", "#7f1010"];   // perfil/legenda (Chart.js)
// no mapa, a rota é um traço contínuo e as marcações de risco são trechos coloridos POR CIMA
// dela: usamos cores mais escuras/saturadas para as marcações não se perderem junto à linha da
// rota (contraste), mantendo a mesma ordem de classes do restante da interface.
const COR_RISCO = ["#1b7837", "#b57f00", "#c85a10", "#a51d12", "#5c0a0a"];
const corRisco = p => p <= 0 ? "#9aa5b1" : p < INC() + 1e-6 ? "#8a6248" : COR_RISCO[classeDePct(p)];
// nível do índice 0–100 (média dos pct ponderada pela exposição): faixas sobre a escala exibida
function nivel(sc) { return sc < 55 ? ["Baixo", "#2fb344"] : sc < 70 ? ["Moderado", "#d9a900"] : sc < 85 ? ["Elevado", "#f08a24"] : ["Alto", "#d62d20"]; }
const T_CRIT_1 = () => PCT_CORTES[PARAMS.CLASSE_CRIT - 1];

function trechosCriticos(r, B) {                 // sequências de amostras na classe crítica (>= CLASSE_CRIT)
  const T = T_CRIT_1() - 1e-6, brutos = []; let cur = null;
  r.samples.forEach((s, i) => {
    const p = riscoAmostra(s, B);
    if (p >= T) { if (!cur) cur = {i0: i, i1: i, fids: new Set(), soma: 0, n: 0}; cur.i1 = i; if (s.fid >= 0) cur.fids.add(s.fid); cur.soma += p; cur.n++; }
    else if (cur) { brutos.push(cur); cur = null; }
  });
  if (cur) brutos.push(cur);
  const un = [];
  brutos.forEach(c => { const u = un[un.length - 1]; if (u && c.i0 - u.i1 <= 2) { u.i1 = c.i1; c.fids.forEach(f => u.fids.add(f)); u.soma += c.soma; u.n += c.n; } else un.push(c); });
  return un.map(c => ({i0: c.i0, i1: c.i1, fids: c.fids, pct: c.soma / c.n, m: (c.i1 - c.i0 + 1) * STEP}))
           .filter(c => c.m >= 60).sort((a, b) => b.pct * b.m - a.pct * a.m).slice(0, 5);
}
// posição aproximada (lat/lon) da amostra i: r.pts pode ser mais densa ou esparsa que as
// amostras; interpola pela contagem acumulada de pontos entre elas.
function posAmostra(r, i) {
  const s = r.samples[i]; if (!s) return null;
  if (!r.pts || !r.pts.length) return [s.lat, s.lon];
  if (r.pts.length === r.samples.length) return [r.pts[i][0], r.pts[i][1]];
  const q = i / Math.max(1, r.samples.length - 1), j = Math.round(q * (r.pts.length - 1));
  return [r.pts[j][0], r.pts[j][1]];
}
function avaliar(r, B) {
  const n = r.samples.length; let soma = 0, sem = 0; const ciclo = [0, 0, 0], porF = new Map();
  r.samples.forEach(s => {
    const p = riscoAmostra(s, B); soma += p;
    if (s.fid < 0 || B.pct[s.fid] <= 0) sem++;
    if (s.fid >= 0) porF.set(s.fid, (porF.get(s.fid) || 0) + 1);
    if (s.ciclo >= 0) ciclo[s.ciclo]++;
  });
  let cw = 0, ca = 0; const veic = new Int32Array(NV);
  const hot = [...porF.entries()].map(([f, c]) => { cw += B.cw[f]; ca += B.ca[f]; for (let v = 0; v < NV; v++) veic[v] += B.cwv[f * NV + v];
    return {f, m: c * STEP, pct: B.pct[f], rk: B.rk[f], cls: B.cls[f], cw: B.cw[f], ca: B.ca[f]}; })
    .filter(x => x.pct > 0).sort((a, b) => b.pct * b.m - a.pct * a.m).slice(0, 5);
  // score de EXPOSIÇÃO: pondera o risco de cada amostra pela velocidade local (amostra mais
  // lenta = mais tempo exposto). Usa a velocidade real do GPX se houver; senão, V_BIKE.
  const temVel = r.t0 !== null && r.t1 !== null && r.dur > 0;
  const vBase = temVel ? Math.min(PARAMS.V_MAX, Math.max(PARAMS.V_MIN, r.dist / 1000 / (r.dur / 3600))) : PARAMS.V_BIKE;
  let wsum = 0, wtot = 0;
  for (let i = 0; i < n; i++) {
    let v = vBase;
    if (temVel && i + 1 < n && r.times && isFinite(r.times[i]) && isFinite(r.times[i + 1])) {
      const dt = (r.times[i + 1] - r.times[i]) / 1000;
      if (dt > 0.5) v = Math.min(PARAMS.V_MAX, Math.max(PARAMS.V_MIN, STEP / 1000 / (dt / 3600)));
    }
    const w = vBase / v;                          // peso ~ tempo de exposição
    wsum += w * riscoAmostra(r.samples[i], B); wtot += w;
  }
  const scoreExp = n ? 100 * wsum / wtot : 0;
  const scoreMed = n ? 100 * soma / n : 0;
  // banda de incerteza: cresce com a fração de trajeto sem registro E com a
  // amostra temporal (marcar poucos anos do histórico deixa a estimativa da TAXA ANUAL menos
  // confiável — o NÍVEL não muda com os anos, mas a largura do ± sim).
  const frSem = n ? sem / n : 0;
  const fa = FR_AMOSTRA();
  const incerteza = Math.round(100 * frSem * 0.25 + 12 * (1 - fa));
  // extensão (m) dentro de cada classe de risco — alimenta o tooltip ao passar o cursor nos trechos
  const clsM = [0, 0, 0, 0, 0]; let mInc = 0, mSem = 0;
  r.samples.forEach(s => {
    if (s.fid >= 0 && B.pct[s.fid] > 0) clsM[classeDePct(B.pct[s.fid])] += STEP;
    else if (s.fid >= 0) mSem += STEP; else mInc += STEP;
  });
  return {score: scoreExp, scoreMed, sem: frSem, incerteza, ciclo: ciclo.map(c => c / n), cw, ca, veic, hot, clsM, mInc, mSem,
          perfil: r.samples.map(s => riscoAmostra(s, B) * 100), crit: trechosCriticos(r, B)};
}

// ---------------------------------------------------------------- grafo de bicicleta e roteamento
const GR = D.grafo;
let NN = 0, EU, EV, EL, EF, EC, ET, EO, EG, NLON, NLAT, NXm, NYm, adjStart, adjArc, nodeGrid;
const interCache = new Map();
function iniciarGrafo() {
  if (!GR || !GR.u || !GR.u.length) return false;
  NN = GR.n.length / 2; const E = GR.u.length;
  EU = Int32Array.from(GR.u); EV = Int32Array.from(GR.v); EL = Float32Array.from(GR.l); EF = Int32Array.from(GR.f);
  EC = Uint8Array.from(GR.c); ET = Uint8Array.from(GR.t); EO = Uint8Array.from(GR.o); EG = Int32Array.from(GR.g);
  NLON = new Float64Array(NN); NLAT = new Float64Array(NN); NXm = new Float64Array(NN); NYm = new Float64Array(NN);
  nodeGrid = new Grid(100);
  for (let i = 0; i < NN; i++) {
    NLON[i] = GR.n[2*i] / GR.esc; NLAT[i] = GR.n[2*i+1] / GR.esc;
    const q = toXY(NLAT[i], NLON[i]); NXm[i] = q[0]; NYm[i] = q[1]; nodeGrid.add(q[0], q[1], q[0], q[1], i);
  }
  adjStart = new Int32Array(NN + 1);
  for (let e = 0; e < E; e++) { adjStart[EU[e] + 1]++; if (!EO[e]) adjStart[EV[e] + 1]++; }
  for (let i = 0; i < NN; i++) adjStart[i + 1] += adjStart[i];
  adjArc = new Int32Array(adjStart[NN]); const pos = adjStart.slice(0, NN);
  for (let e = 0; e < E; e++) { adjArc[pos[EU[e]]++] = e << 1; if (!EO[e]) adjArc[pos[EV[e]]++] = (e << 1) | 1; }
  return true;
}
const TEM_GRAFO = iniciarGrafo();

function interior(e) {                            // pontos intermediários [lat,lon] da aresta, de u para v
  if (interCache.has(e)) return interCache.get(e);
  const g = EG[e], out = [];
  if (g >= 0) { let x = GR.n[2*EU[e]], y = GR.n[2*EU[e]+1]; const d = GR.gl[g]; for (let i = 0; i < d.length; i += 2) { x += d[i]; y += d[i+1]; out.push([y / GR.esc, x / GR.esc]); } }
  interCache.set(e, out); return out;
}
function snapNo(lat, lon, raio = 300) {
  const [x, y] = toXY(lat, lon); let best = -1, bd = Infinity;
  nodeGrid.query(x, y, raio, (tag, d2) => { if (d2 < bd) { bd = d2; best = tag; } });
  return best;
}
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) { let i = this.k.length; this.k.push(key); this.v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val; }
  pop() { const k0 = this.k[0], v0 = this.v[0], kl = this.k.pop(), vl = this.v.pop(), n = this.k.length;
    if (n > 0) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && this.k[c+1] < this.k[c]) c++; if (this.k[c] >= kl) break; this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c; } this.k[i] = kl; this.v[i] = vl; }
    return [k0, v0]; }
}

// parâmetros editáveis do planejamento
const PLAN = {risco: 1.5, ciclo: .6, arterial: .5, incerto: .35, extra: .6, lentidao: .5};
const W_CICLO = [0, 1, .7, .35];                  // peso por classe (1 ciclovia, 2 ciclofaixa, 3 compartilhada)
const HMIN = 0.3;
// risco 0–1 de uma aresta do grafo: usa o MESMO valor "incerto" da avaliação no mapa
// (PARAMS.INCERTO), escalado para a escala 0–1 do roteador — antes havia dois valores
// independentes (P.incerto editável vs. cinza/zero no mapa).
// MESMA escala da nota e das cores do mapa (pct = PCT_MIN + (1−PCT_MIN)·posto; sem registro = incerto).
// Antes o roteador usava o posto puro: via sem registro (0,35 no posto) ficava PIOR que vias de 1 ocorrência
// (posto baixo), enquanto a nota faz o contrário — a alternativa "otimizada" saía pior no próprio índice do app.
const riscoAresta = (f, P, B) => (f >= 0 && B.pct[f] > 0) ? B.pct[f] : Math.max(0, Math.min(1, P.incerto));
// Penalidade do risco CONVEXA. O percentil `r` é uniforme: a via mediana (r≈.5) e uma das 10% mais
// perigosas (r≈.9) diferem pouco em r, e com custo linear o hotspot saía só ~34% mais caro — o roteador
// atravessava as vias de maior ocorrência para economizar poucos metros. A curva exponencial deixa
// o topo dominar o custo (via comum ≈ +0,5…1,3×, top 10% ≈ +4,4×, top 3% ≈ +5× com os parâmetros padrão)
// sem mexer na base da maioria das vias.
const K_RISCO = 4, CONV_RISCO = 5;
const gRisco = r => (Math.exp(CONV_RISCO * r) - 1) / (Math.exp(CONV_RISCO) - 1);   // 0→0, 1→1, convexa
function fatores(P, B, evitar) {                  // fator de custo por aresta
  const E = EU.length, F = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const c = EC[e], w = W_CICLO[c] * P.ciclo, f = EF[e];
    const r = riscoAresta(f, P, B);                                    // sem registro = incerto, não seguro
    // infraestrutura cicloviária protege de fato: ciclovia ≈ −80%, ciclofaixa ≈ −55%, compartilhada ≈ −30%
    // da penalidade de risco (antes só ~−36% para a ciclovia, e a via perigosa seguia competitiva)
    const prot = Math.min(0.9, 1.35 * w);
    let x = 1 + P.risco * K_RISCO * gRisco(r) * (1 - prot);
    // sem infraestrutura, via arterial/coletora é pior para quem pedala: tráfego rápido e pesado
    if (c === 0) { if (ET[e] === 2) x *= 1 + 2 * P.arterial; else if (ET[e] === 1) x *= 1 + (2 / 3) * P.arterial; }
    x *= (1 - 0.4 * w);
    if (EC[e] === 1) x *= 1 - 0.15 * P.lentidao;                       // ciclovia: mais segura, porém mais lenta
    else if (EC[e] === 3) x *= 1 + 0.10 * P.lentidao;                  // calçada compartilhada: pedestres reduzem velocidade
    if (evitar && f >= 0 && evitar.has(f)) x *= 6;
    F[e] = Math.max(HMIN, x);
  }
  return F;
}
function melhorCaminho(src, dst, F) {
  const g = new Float64Array(NN).fill(Infinity), prev = new Int32Array(NN).fill(-1), fechado = new Uint8Array(NN);
  const h = n => Math.hypot(NXm[n] - NXm[dst], NYm[n] - NYm[dst]) * HMIN;
  const hp = new Heap(); g[src] = 0; hp.push(h(src), src);
  while (hp.size) {
    const u = hp.pop()[1]; if (fechado[u]) continue; fechado[u] = 1; if (u === dst) break;
    for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
      const a = adjArc[k], e = a >> 1, v = (a & 1) ? EU[e] : EV[e], ng = g[u] + EL[e] * F[e];
      if (ng < g[v]) { g[v] = ng; prev[v] = a; hp.push(ng + h(v), v); }
    }
  }
  if (g[dst] === Infinity) return null;
  const arcs = []; let n = dst;
  while (n !== src) { const a = prev[n]; arcs.push(a); n = (a & 1) ? EV[a >> 1] : EU[a >> 1]; }
  arcs.reverse(); return {arcs, custo: g[dst]};
}
// Menor caminho "seguro" com TETO de acréscimo de distância sobre o menor caminho legal (que respeita
// a mão única). Se o de menor custo estoura o teto, o peso dos fatores é reduzido por bisseção
// (F' = 1 + t·(F−1)) até caber; t = 0 é o caminho mais curto. Vale para planejamento, alternativa e desvio:
// sem isso um custo de risco alto produzia voltas enormes e um baixo ignorava as vias críticas.
let _UNI = null;
const UNI = () => _UNI && _UNI.length === EU.length ? _UNI : (_UNI = new Float32Array(EU.length).fill(1));
function caminhoSeguro(src, dst, F, extra) {
  const c0 = melhorCaminho(src, dst, F);
  if (!c0 || !(extra >= 0)) return c0;
  const base = melhorCaminho(src, dst, UNI());
  if (!base) return c0;
  const teto = comprimentoArcos(base.arcs).m * (1 + extra) + 50;     // +50 m: tolerância de nós de partida/chegada
  if (comprimentoArcos(c0.arcs).m <= teto) return c0;
  let lo = 0, hi = 1, melhor = base; const Ft = new Float32Array(F.length);   // lo cabe no teto, hi não
  for (let it = 0; it < 7; it++) {
    const t = (lo + hi) / 2;
    for (let e = 0; e < F.length; e++) Ft[e] = Math.max(HMIN, 1 + t * (F[e] - 1));
    const c = melhorCaminho(src, dst, Ft);
    if (c && comprimentoArcos(c.arcs).m <= teto) { lo = t; melhor = c; } else hi = t;
  }
  melhor.limitado = true;                                // o teto de distância impediu um desvio maior
  return melhor;
}
function arcosParaPontos(arcs) {
  const pts = [];
  arcs.forEach(a => { const e = a >> 1, dir = a & 1, de = dir ? EV[e] : EU[e];
    pts.push([NLAT[de], NLON[de]]);
    const it = interior(e); (dir ? it.slice().reverse() : it).forEach(p => pts.push(p)); });
  if (arcs.length) { const a = arcs[arcs.length - 1], para = (a & 1) ? EU[a >> 1] : EV[a >> 1]; pts.push([NLAT[para], NLON[para]]); }
  return pts;
}
// arcos percorridos CONTRA o sentido de uma aresta de mão única (deve ser sempre 0) e fids por onde passam
const contramao = arcs => arcs.filter(a => (a & 1) && EO[a >> 1]).length;
const fidsDosArcos = arcs => arcs.map(a => EF[a >> 1]);
function comprimentoArcos(arcs) { let m = 0, art = 0; arcs.forEach(a => { const e = a >> 1; m += EL[e]; if (ET[e] === 2 && EC[e] === 0) art += EL[e]; }); return {m, art}; }

function rotearPontos(wps, F) {                   // waypoints [[lat,lon],...] -> {pts, m, art}
  const nos = wps.map(p => snapNo(p[0], p[1]));
  if (nos.some(n => n < 0)) return {erro: "Um dos pontos está a mais de 300 m de qualquer via do grafo de bicicleta."};
  let pts = [wps[0]], m = 0, art = 0;
  for (let i = 0; i + 1 < nos.length; i++) {
    if (nos[i] === nos[i+1]) continue;
    const c = caminhoSeguro(nos[i], nos[i+1], F, PLAN.extra);
    if (!c) return {erro: "Não há caminho entre os pontos " + String.fromCharCode(65 + i) + " e " + String.fromCharCode(66 + i) + " (grafo desconexo)."};
    pts = pts.concat(arcosParaPontos(c.arcs)); const cm = comprimentoArcos(c.arcs); m += cm.m; art += cm.art;
  }
  pts.push(wps[wps.length - 1]);
  return {pts, m, art};
}

// ---------------------------------------------------------------- planejamento por clique
let planAtivo = false, wps = [];
const planGrp = L.layerGroup().addTo(MAPA);
function letra(i) { return String.fromCharCode(65 + (i % 26)); }
function ativarPlano(v) {
  if (v && !TEM_GRAFO) { aviso("Grafo de bicicleta ausente. Rode `samu-risco geodados` (malha OSM de bicicleta) e gere o HTML de novo."); return; }
  planAtivo = v; $("planUI").classList.toggle("vazio", !v);
  $("btnPlan").textContent = v ? "Encerrar planejamento" : "Planejar rota no mapa";
  MAPA.getContainer().style.cursor = v ? "crosshair" : "";
  if (!v) { wps = []; planGrp.clearLayers(); rotas = rotas.filter(r => r.id !== "plano"); atualizarRotas(); }
}
function desenharWps() {
  planGrp.clearLayers();
  wps.forEach((p, i) => {
    const m = L.marker(p, {draggable: true, icon: L.divIcon({className: "wp", html: "<span>" + letra(i) + "</span>", iconSize: [22, 22]})}).addTo(planGrp);
    m.on("dragend", () => { const ll = m.getLatLng(); wps[i] = [ll.lat, ll.lng]; recalcularPlano(); });
  });
  $("wps").innerHTML = wps.map((p, i) => "<div><span><b>" + letra(i) + "</b> " + p[0].toFixed(4) + ", " + p[1].toFixed(4) + '</span><button data-w="' + i + '" title="remover">×</button></div>').join("");
  $("wps").querySelectorAll("button").forEach(b => b.onclick = () => { wps.splice(+b.dataset.w, 1); recalcularPlano(); });
}
function recalcularPlano() {
  desenharWps();
  rotas = rotas.filter(r => r.id !== "plano");
  $("planMsg").textContent = "";
  if (wps.length >= 2) {
    const jan = JAN_PADRAO(), F = fatores(PLAN, baseDe(jan), null), res = rotearPontos(wps, F);
    if (res.erro) $("planMsg").textContent = res.erro;
    else {
      const nome = ($("planNome").value || "").trim() || "Planejada: " + letra(0) + " → " + letra(wps.length - 1);
      const r = criarRota({id: "plano", cor: "#d81b60", nome, pts: res.pts, origem: "planejada", jan});
      r.meta = {arterialM: res.art, totalM: res.m};
      rotas.push(r);
    }
  }
  limparAlt();   // a alternativa anterior não vale mais para waypoints/parâmetros novos
  atualizarRotas();
}
function fixarPlano() {
  const r = rotas.find(x => x.id === "plano"); if (!r) return;
  seqRota++; r.id = "r" + seqRota; r.cor = PALR[(seqRota - 1) % PALR.length];
  wps = []; planGrp.clearLayers(); $("planNome").value = ""; desenharWps(); atualizarRotas();
}
MAPA.on("click", e => { if (planAtivo) { wps.push([e.latlng.lat, e.latlng.lng]); recalcularPlano(); } });
$("btnPlan").onclick = () => ativarPlano(!planAtivo);
$("plFixar").onclick = fixarPlano;
$("plLimpar").onclick = () => { wps = []; recalcularPlano(); };
$("planNome").onchange = () => { if (wps.length >= 2) recalcularPlano(); };
[["plRisco", "risco"], ["plCiclo", "ciclo"], ["plArt", "arterial"], ["plInc", "incerto"], ["plExtra", "extra"], ["plLent", "lentidao"]].forEach(([id, k]) => {
  $(id).value = PLAN[k]; $(id).oninput = e => { PLAN[k] = +e.target.value; if (wps.length >= 2) recalcularPlano(); };
});

// ---------------------------------------------------------------- rota alternativa mais segura (início → fim)
// pega a primeira e a última amostra da rota, calcula o caminho mais seguro entre elas no
// grafo de bicicleta (com os pesos do planejamento) e apresenta como traçado TRACEJADO roxo,
// com índice comparativo e botões para adicionar à análise, salvar na biblioteca e baixar GPX.
let altAtiva = null;
let rotaSel = null;   // rota escolhida na lista p/ buscar alternativa (declaração antes de buscarAlternativa)
const altGrp = L.layerGroup().addTo(MAPA);
function limparAlt() {
  altAtiva = null; altGrp.clearLayers();
  const m = $("altMsg"); if (m) { m.hidden = true; m.textContent = ""; }
}
// remove TUDO da análise: rotas, pontos do planejamento, seleção, alternativa tracejada e desvios
function limparRotas() {
  rotas = []; rotaSel = null; wps = []; escopoOff = false;
  planGrp.clearLayers(); desenharWps();
  const pn = $("planNome"); if (pn) pn.value = "";
  const pm = $("planMsg"); if (pm) pm.textContent = "";
  removerHover(); limparAlt(); aposMudarRotas();
}
// depois de mudar o conjunto de rotas: no Panorama também refaz estatísticas e transparência do fundo
function aposMudarRotas() { if (aba === "panorama") { ajustarFundo(); update(); } else atualizarRotas(); }
// escopo do Panorama: com rotas em análise, KPIs/gráficos/ranking valem só para os trechos
// (via×bairro) por onde passam — da rota selecionada na lista ou, sem seleção, de todas elas.
let escopoOff = false;   // o usuário pediu para ver o Panorama inteiro mesmo com rotas
function escopoRota() {
  if (!rotas.length) return null;
  const sel = rotaSel && rotas.find(x => x.id === rotaSel), alvo = sel ? [sel] : rotas, fids = new Set();
  alvo.forEach(r => r.samples.forEach(s => { if (s.fid >= 0) fids.add(s.fid); }));
  return {fids, off: escopoOff, nome: sel ? sel.nome : (rotas.length === 1 ? rotas[0].nome : rotas.length + " rotas")};
}
function renderBlocoAlt() {
  const m = $("altMsg"); if (!m) return;
  if (!altAtiva) { m.hidden = true; m.innerHTML = ""; return; }
  const {orig, alt, Rd, R, dm} = altAtiva;
  const ds = Rd.score - R.score;                              // a MESMA nota exibida no cartão da rota
  const infra = x => 100 * x.ciclo.reduce((a, b) => a + b, 0);
  // trechos críticos que a alternativa AINDA percorre (nome da via e metros), para o usuário julgar
  const critTxt = x => x.crit.map(c => c.m + " m (" + [...c.fids].map(f => esc(D.geo.features[f].properties.n)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(", ") + ")").join("; ");
  m.hidden = false;
  m.innerHTML = "<b>Rota alternativa mais segura</b> (" + esc(orig.nome) + "): índice <b>" + R.score.toFixed(0) + " → " + Rd.score.toFixed(0) + "</b> " +
    (ds <= 0 ? '<span style="color:#2fb344">(−' + Math.abs(ds).toFixed(0) + ")</span>" : '<span style="color:#d62d20">(+' + ds.toFixed(0) + ", não é mais segura)</span>") +
    " · " + (alt.dist / 1000).toFixed(2) + " km (" + (dm >= 0 ? "+" : "") + Math.round(dm) + " m)" +
    "<br>trechos críticos: <b>" + R.crit.length + " → " + Rd.crit.length + "</b> · com ciclovia/ciclofaixa/faixa: " + infra(R).toFixed(0) + "% → " + infra(Rd).toFixed(0) + "% · segue só no sentido permitido (mão única do OSM)" +
    (Rd.crit.length ? "<br>ainda passa por: " + critTxt(Rd) : "") +
    (altAtiva.limitado ? '<br><span style="color:#d68a00">⚠ o limite de acréscimo de distância (+' + Math.round(PLAN.extra * 100) + '%) impediu desviar mais; aumente <i>Acréscimo máx. de distância</i> em Planejar para evitar mais vias críticas.</span>' : "") +
    '<div class="racoes" style="margin-top:6px"><button id="altAdd">Ver na análise</button><button id="altSalvarBtn">💾 Salvar</button><button id="altBaixarBtn">⬇ Baixar GPX</button><button id="altLimparBtn" title="Descartar a sugestão tracejada">✕ Limpar</button></div>';
  const bAdd = $("altAdd"), bSal = $("altSalvarBtn"), bBx = $("altBaixarBtn"), bLim = $("altLimparBtn");
  if (bLim) bLim.onclick = limparAlt;
  // a alternativa vira rota da análise (traço cheio): o tracejado de sugestão deixa de existir
  if (bAdd) bAdd.onclick = () => { rotas.push(alt); limparAlt(); if (aba !== "rota") irAba("rota"); else atualizarRotas(); MAPA.fitBounds(L.latLngBounds(alt.pts).pad(.1)); };
  if (bSal) bSal.onclick = async () => { await salvarNaBiblioteca(alt); m.innerHTML += " salva na biblioteca ✔"; };
  if (bBx) bBx.onclick = () => baixar(slug(alt.nome) + ".gpx", new Blob([gpxDe(alt)], {type: "application/gpx+xml"}));
}
function buscarAlternativa() {
  if (!TEM_GRAFO) { aviso("Grafo de bicicleta ausente. Rode `samu-risco geodados` (malha OSM de bicicleta) e gere o HTML de novo."); return; }
  const r = (rotaSel && rotas.find(x => x.id === rotaSel)) || rotas.find(x => x.id === "plano") || rotas[0];   // respeita a rota selecionada na lista; senão o plano, senão a primeira
  if (!r) { aviso("Carregue ou planeje uma rota primeiro: a alternativa usa o início e o fim dela."); return; }
  const B = baseDe(r.jan), R = avaliar(r, B);
  const ini = r.samples[0], fim = r.samples[r.samples.length - 1];
  const na = snapNo(ini.lat, ini.lon, 300), nb = snapNo(fim.lat, fim.lon, 300);
  if (na < 0 || nb < 0) { limparAlt(); aviso("Não encontrei vias do grafo próximas ao início/destino desta rota."); return; }
  if (na === nb) { limparAlt(); aviso("Início e destino coincidem no grafo — nada a sugerir."); return; }
  // Candidatos com pesos de risco crescentes (e o caminho mais curto). A escolha é pela NOTA que o app
  // mostra no cartão da rota (o mesmo `score`), não pelo custo interno do roteador:
  // assim a sugestão nunca é pior que a rota original e, se nada a supera, o app diz isso.
  const vistos = new Set(), cands = [];
  const tenta = (cam, rotulo) => {
    if (!cam) return; const chave = cam.arcs.join(",");
    if (vistos.has(chave)) return; vistos.add(chave);
    const pts = [[ini.lat, ini.lon]]; arcosParaPontos(cam.arcs).forEach(p => pts.push(p)); pts.push([fim.lat, fim.lon]);
    const a = criarRota({id: "alt", cor: "#8e24aa", nome: r.nome + " (alternativa)", pts, origem: "alternativa", jan: r.jan});
    cands.push({cam, pts, alt: a, Rd: avaliar(a, B), rotulo});
  };
  for (const m of [1, 2, 4, 8]) tenta(caminhoSeguro(na, nb, fatores({...PLAN, risco: PLAN.risco * m, arterial: PLAN.arterial * Math.sqrt(m)}, B, null), PLAN.extra), "risco ×" + m);
  tenta(melhorCaminho(na, nb, UNI()), "mais curto");
  if (!cands.length) { limparAlt(); aviso("Não há caminho no grafo entre o início e o fim da rota."); return; }
  cands.sort((x, y) => x.Rd.score - y.Rd.score || x.alt.dist - y.alt.dist);
  const melhor = cands[0], limitado = !!melhor.cam.limitado || cands.some(c => c.cam.limitado);
  if (melhor.Rd.score >= R.score - 0.5) {
    limparAlt();
    aviso("Não achei um caminho entre o início e o fim com índice menor que o da sua rota (" + R.score.toFixed(0) + ") dentro do limite de +" +
      Math.round(PLAN.extra * 100) + "% de distância — a sua rota já é a melhor sugestão. Para procurar mais longe, aumente \"Acréscimo máx. de distância\" em Planejar.");
    return;
  }
  const {pts, alt, Rd} = melhor, cam = melhor.cam;
  altAtiva = {orig: r, alt, R, Rd, dm: alt.dist - r.dist, limitado};
  const ll = alt.samples.map(s => [s.lat, s.lon]);
  L.polyline(ll, {pane: "p_rotas", renderer: CAMADAS.rotas.rend, interactive: false, color: "#fff", weight: 9, opacity: .7, dashArray: "9 8", lineCap: "round"}).addTo(altGrp);
  L.polyline(ll, {pane: "p_rotas", renderer: CAMADAS.rotas.rend, interactive: false, color: "#8e24aa", weight: 5, opacity: .95, dashArray: "9 8", lineCap: "round"})
    .bindTooltip("<b>rota alternativa mais segura</b><br>índice " + Rd.score.toFixed(0) + "/100 · " + (alt.dist / 1000).toFixed(2) + " km<br>traço tracejado: sugestão (use os botões do painel para salvar/baixar)", {sticky: true})
    .addTo(altGrp);
  MAPA.fitBounds(L.latLngBounds(pts).pad(.15));
  renderBlocoAlt();
}

// ---------------------------------------------------------------- desvio de trechos críticos
function sugerirDesvio(r) {
  if (!TEM_GRAFO) { aviso("Grafo de bicicleta ausente: rode `samu-risco geodados` e gere o HTML de novo."); return; }
  const B = baseDe(r.jan), R = avaliar(r, B);
  if (!R.crit.length) { aviso("Nenhum trecho de classe alta ou crítica (top 10% das vias com registro) nesta rota."); return; }
  const S = r.samples; let pts = [], ultimo = 0; const trocas = [];
  for (const c of R.crit.slice().sort((a, b) => a.i0 - b.i0)) {
    const i0 = Math.max(c.i0 - 1, 0), i1 = Math.min(c.i1 + 1, S.length - 1);
    if (i0 < ultimo) continue;
    const na = snapNo(S[i0].lat, S[i0].lon, 150), nb = snapNo(S[i1].lat, S[i1].lon, 150);
    if (na < 0 || nb < 0 || na === nb) continue;
    const cam = caminhoSeguro(na, nb, fatores(PLAN, B, c.fids), PLAN.extra);
    if (!cam) continue;
    let tot = 0, usado = 0; cam.arcs.forEach(a => { const e = a >> 1; tot += EL[e]; if (EF[e] >= 0 && c.fids.has(EF[e])) usado += EL[e]; });
    const mTrecho = (i1 - i0) * STEP;
    if (usado > 0.2 * tot || tot > mTrecho * (1 + PLAN.extra) + 200) continue;      // ainda passa pelo trecho / longo demais
    for (let i = ultimo; i <= i0; i++) pts.push([S[i].lat, S[i].lon]);
    arcosParaPontos(cam.arcs).forEach(p => pts.push(p));
    ultimo = i1; trocas.push({i0, i1, antes: mTrecho, depois: tot});
  }
  if (!trocas.length) { aviso("Não encontrei desvio viável (sem alternativa próxima ou acréscimo acima do limite)."); return; }
  for (let i = ultimo; i < S.length; i++) pts.push([S[i].lat, S[i].lon]);
  r.desvio = {rota: criarRota({id: "dv-" + r.id, nome: r.nome + " (desvio)", pts, origem: "desvio", jan: r.jan, sentido: r.sentido}), trocas};
  atualizarRotas();
}
function aplicarDesvio(r, substituir) {
  const d = r.desvio; if (!d) return;
  const nova = d.rota; seqRota++; nova.id = "r" + seqRota; nova.cor = substituir ? r.cor : PALR[(seqRota - 1) % PALR.length];
  if (substituir) { nova.nome = r.nome + " (com desvio)"; nova.libId = r.libId; rotas[rotas.indexOf(r)] = nova; }
  else rotas.push(nova);
  r.desvio = null; atualizarRotas();
}

// ---------------------------------------------------------------- exportação (GPX, zip, tar.gz, JSON)
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function empacotarZip(arqs) {                     // método "store" (GPX é pequeno)
  const enc = new TextEncoder(), partes = [], cen = []; let off = 0; const d = new Date();
  const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  arqs.forEach(f => {
    const nm = enc.encode(f.nome), crc = crc32(f.bytes), sz = f.bytes.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, tm, true); lh.setUint16(12, dt, true); lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nm.length, true);
    partes.push(new Uint8Array(lh.buffer), nm, f.bytes);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, tm, true); ch.setUint16(14, dt, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    cen.push(new Uint8Array(ch.buffer), nm); off += 30 + nm.length + sz;
  });
  const csz = cen.reduce((a, b) => a + b.length, 0), fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arqs.length, true); fim.setUint16(10, arqs.length, true); fim.setUint32(12, csz, true); fim.setUint32(16, off, true);
  return new Blob([...partes, ...cen, new Uint8Array(fim.buffer)], {type: "application/zip"});
}
function empacotarTar(arqs) {
  const enc = new TextEncoder(), blocos = [], mt = Math.floor(Date.now() / 1000);
  arqs.forEach(f => {
    const h = new Uint8Array(512), put = (s, o, l) => h.set(enc.encode(s).slice(0, l), o);
    put(f.nome, 0, 100); put("0000644\0", 100, 8); put("0000000\0", 108, 8); put("0000000\0", 116, 8);
    put(f.bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12); put(mt.toString(8).padStart(11, "0") + "\0", 136, 12);
    put("        ", 148, 8); h[156] = 48; put("ustar\0", 257, 6); put("00", 263, 2);
    let soma = 0; for (let i = 0; i < 512; i++) soma += h[i];
    put(soma.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocos.push(h, f.bytes); const pad = (512 - f.bytes.length % 512) % 512; if (pad) blocos.push(new Uint8Array(pad));
  });
  blocos.push(new Uint8Array(1024)); return new Blob(blocos);
}
async function empacotarTgz(arqs) { return new Response(empacotarTar(arqs).stream().pipeThrough(new CompressionStream("gzip"))).blob(); }
function baixar(nome, blob) {
  (window.__downloads = window.__downloads || []).push({nome, blob});
  try { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nome; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); } catch (e) {}
}
function arquivosGpx(lista) {                     // [{nome, bytes}] com nomes únicos
  const enc = new TextEncoder(), usados = new Set();
  return lista.map(o => { let n = slug(o.nome), k = 2, base = n; while (usados.has(n)) n = base + "_" + k++; usados.add(n);
    return {nome: n + ".gpx", bytes: enc.encode(gpxDe(o))}; });
}

// ---------------------------------------------------------------- biblioteca (IndexedDB com fallback em memória)
const Lib = (() => {
  let db = null, mem = [], tentou = false;
  const abrir = () => new Promise(res => {
    if (db || tentou) return res(db); tentou = true;
    if (typeof indexedDB === "undefined" || !indexedDB) return res(null);
    try { const rq = indexedDB.open("samu_risco_rotas", 1); rq.onupgradeneeded = () => rq.result.createObjectStore("rotas", {keyPath: "id"});
      rq.onsuccess = () => { db = rq.result; res(db); }; rq.onerror = rq.onblocked = () => res(null); } catch (e) { res(null); }
  });
  const tx = async (modo, fn) => { const d = await abrir(); if (!d) return null;
    return new Promise(res => { const t = d.transaction("rotas", modo), q = fn(t.objectStore("rotas")); t.oncomplete = () => res(q && q.result !== undefined ? q.result : true); t.onerror = t.onabort = () => res(null); }); };
  return {
    async todos() { const r = await tx("readonly", s => s.getAll()); return r === null ? mem.slice() : (r === true ? [] : r); },
    async salvar(o) { const r = await tx("readwrite", s => s.put(o)); if (r === null) mem = mem.filter(x => x.id !== o.id).concat([o]); },
    async excluir(id) { const r = await tx("readwrite", s => s.delete(id)); if (r === null) mem = mem.filter(x => x.id !== id); },
    get persistente() { return !!db; },
  };
})();
const selecionadas = new Set();
function registroDe(r) {
  return {id: r.libId || novoId("L"), nome: r.nome, sentido: r.sentido || "", origem: r.origem, criado: Date.now(), jan: r.jan,
          tIni: r.t0, tFim: r.t1, pts: simplificar(r.pts, 3).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)])};
}
async function salvarNaBiblioteca(r) {
  const o = registroDe(r); r.libId = o.id; await Lib.salvar(o); await renderLib();
  $("libMsg").textContent = "Salva na biblioteca: " + o.nome + (Lib.persistente ? "" : " (apenas nesta sessão: o navegador bloqueou o armazenamento local)");
}
async function renderLib() {
  const todos = (await Lib.todos()).sort((a, b) => b.criado - a.criado);
  $("lib").innerHTML = todos.length ? todos.map(o =>
    '<div class="lib-item"><input type="checkbox" data-sel="' + o.id + '"' + (selecionadas.has(o.id) ? " checked" : "") + '><div class="nm" title="' + esc(o.nome) + '">' + esc(o.nome) +
    "<small>" + (o.sentido ? esc(o.sentido) + " · " : "") + o.jan.h1 + "–" + o.jan.h2 + "h · " + (DIAS_TXT[o.jan.dias] || "") + " · " + o.pts.length + " pts</small></div>" +
    '<span><button data-ac="add" data-id="' + o.id + '" title="analisar">＋</button> <button data-ac="gpx" data-id="' + o.id + '" title="baixar GPX">⬇</button> <button data-ac="del" data-id="' + o.id + '" title="excluir">🗑</button></span></div>').join("")
    : '<p class="hint">Nenhuma rota salva. Use “Salvar na biblioteca” no painel de risco.</p>';
}
async function exportar(formato) {
  const todos = await Lib.todos(), sel = todos.filter(o => selecionadas.has(o.id)), lista = sel.length ? sel : todos;
  if (!lista.length) { $("libMsg").textContent = "Nada para exportar."; return; }
  const data = new Date().toISOString().slice(0, 10);
  if (formato === "json") baixar("rotas_" + data + ".json", new Blob([JSON.stringify({versao: 1, rotas: lista})], {type: "application/json"}));
  else if (formato === "zip") baixar("rotas_" + data + ".zip", empacotarZip(arquivosGpx(lista)));
  else baixar("rotas_" + data + ".tar.gz", await empacotarTgz(arquivosGpx(lista)));
  $("libMsg").textContent = lista.length + " rota(s) exportada(s).";
}
async function importar(arquivos) {
  let n = 0;
  for (const f of arquivos) {
    try {
      const txt = await f.text();
      if (/\.json$/i.test(f.name)) { for (const o of (JSON.parse(txt).rotas || [])) { if (o.id && o.pts && o.pts.length > 1) { await Lib.salvar(Object.assign({sentido: "", origem: "importada", criado: Date.now(), jan: {h1: 0, h2: 23, dias: "todos"}}, o)); n++; } } }
      else if (/\.gpx$/i.test(f.name)) { const g = lerGpx(txt, f.name.replace(/\.gpx$/i, "")), ok = g.times.filter(isFinite);
        const r = prepararRota({nome: g.nome, pts: g.pts, times: g.times, origem: "gpx"});
        await Lib.salvar({id: novoId("L"), nome: g.nome, sentido: "", origem: "gpx", criado: Date.now(), jan: r.jan, tIni: ok.length ? ok[0] : null, tFim: ok.length ? ok[ok.length-1] : null,
          pts: simplificar(g.pts, 3).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)])}); n++; }
    } catch (e) { alert("Não foi possível importar " + f.name + ": " + e.message); }
  }
  await renderLib(); $("libMsg").textContent = n + " rota(s) importada(s).";
}
$("lib").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const todos = await Lib.todos(), o = todos.find(x => x.id === b.dataset.id); if (!o) return;
  if (b.dataset.ac === "add") { const r = criarRota({nome: o.nome, pts: o.pts, origem: "biblioteca", jan: o.jan, sentido: o.sentido, tIni: o.tIni, tFim: o.tFim, libId: o.id});
    rotas.push(r); if (aba !== "rota") irAba("rota"); else atualizarRotas(); MAPA.fitBounds(L.latLngBounds(r.pts).pad(.1)); }
  else if (b.dataset.ac === "gpx") baixar(slug(o.nome) + ".gpx", new Blob([gpxDe(o)], {type: "application/gpx+xml"}));
  else if (b.dataset.ac === "del") { selecionadas.delete(o.id); await Lib.excluir(o.id); await renderLib(); }
});
$("lib").addEventListener("change", e => { const id = e.target.dataset && e.target.dataset.sel; if (id) { e.target.checked ? selecionadas.add(id) : selecionadas.delete(id); } });
$("libZip").onclick = () => exportar("zip"); $("libTgz").onclick = () => exportar("tgz"); $("libJson").onclick = () => exportar("json");
$("libImp").onchange = ev => { importar(ev.target.files); ev.target.value = ""; };

// ---------------------------------------------------------------- apresentação: desenho, blocos, comparador, perfil
// contraste rota × marcações: a linha da rota é um TRAÇO ÚNICO na cor da rota (com halo claro
// por baixo, para ler sobre qualquer base) e NÃO recebe coloração por risco; as marcações de
// incidência são desenhadas numa camada própria, LEVE, deslocada ~7 m para o lado (efeito
// "cordão umbilical"), fora da linha da rota — assim os dois nunca se confundem.
// interatividade: cada trecho colorido é um polyline INTERATIVO cujo tooltip traz a via, a
// classe, o posto percentil, as ocorrências no horário/dia todo, veículos, extensão percorrida
// e aviso de destaque para vias de maior incidência.
const haloGrp = L.layerGroup();     // halos (abaixo de tudo na pane p_rotas)
const trGru = L.layerGroup();       // trechos de risco interativos (acima dos traços das rotas)
if (CAMADAS.rotas.vis) { haloGrp.addTo(MAPA); trGru.addTo(MAPA); }   // acompanham a visibilidade da camada "rotas"
window.__camExtra.rotas = (id, v) => {   // mostrar("rotas", …) no app.js liga/desliga os grupos junto
  if (id !== "rotas") return;
  [haloGrp, trGru].forEach(g => { if (v && !MAPA.hasLayer(g)) MAPA.addLayer(g); if (!v && MAPA.hasLayer(g)) MAPA.removeLayer(g); });
};
const fmtData = new Intl.DateTimeFormat("pt-BR", {timeZone: "America/Recife", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"});
function janelaTxt(r) { return (r.t0 != null && r.t1 != null) ? fmtData.format(new Date(r.t0)) + " → " + fmtData.format(new Date(r.t1)) : "sem horário no arquivo"; }
function trechoInfo(i0, i1, r, B, R) {   // texto rico do tooltip de um trecho da rota (amostras i0..i1)
  const cntF = new Map(); let cw = 0, ca = 0, inc = 0, sem = 0; const veic = new Int32Array(NV);
  for (let i = i0; i <= i1; i++) {
    const s = r.samples[i];
    if (s.fid < 0) { inc++; continue; }
    if (!(B.pct[s.fid] > 0)) { sem++; continue; }
    cntF.set(s.fid, (cntF.get(s.fid) || 0) + 1);
    cw += B.cw[s.fid]; ca += B.ca[s.fid];
    for (let v = 0; v < NV; v++) veic[v] += B.cwv[s.fid * NV + v];
  }
  const nTot = i1 - i0 + 1, m = nTot * STEP;
  const top = [...cntF.entries()].sort((a, b) => (B.pct[b[0]] || 0) - (B.pct[a[0]] || 0))[0];
  const k = top ? classeDePct(B.pct[top[0]]) : -1;
  const nome = top ? D.geo.features[top[0]].properties.n : (inc === nTot ? "fora da malha viária" : "sem via identificada");
  const bairro = top && D.geo.features[top[0]].properties.b ? " (" + esc(D.geo.features[top[0]].properties.b.toLowerCase()) + ")" : "";
  const kmVia = top ? D.geo.features[top[0]].properties.km : 0;
  const topPct = top && B.rk[top[0]] > 0 ? Math.max(1, Math.round(100 * (1 - B.rk[top[0]]))) : null;
  const vm = [...veic].map((v, i) => [D.veic[i], v]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1])
    .slice(0, 2).map(x => x[0] + " " + x[1]).join(" · ") || "–";
  const ext = top && cntF.get(top[0]) ? Math.round(cntF.get(top[0]) * STEP) : m;
  const cic = r.samples.slice(i0, i1 + 1).some(s => s.ciclo >= 0);
  const posIni = Math.round(i0 * STEP / 100) / 10, posFim = Math.round((i1 + 1) * STEP / 100) / 10;
  let h = "<b>" + esc(nome) + "</b>" + bairro +
    "<br>do trajeto: " + m + " m (km " + posIni.toFixed(1) + "–" + posFim.toFixed(1) + " de " + (Math.round(r.dist / 10) / 100).toFixed(2) + " km)" +
    "<br>classe <span style='color:" + COR_CL[Math.max(0, k)] + "'>■</span> <b>" + (k >= 0 ? NOMES_CL[k] : "sem registro") + "</b>" +
    (topPct ? " · top " + topPct + "% entre os trechos com registro" : "") +
    "<br>" + m + " m neste trecho da rota" + (ext < m ? " · " + ext + " m na via " + esc(nome) : "") +
    (kmVia ? " · via inteira: " + (+kmVia).toFixed(2) + " km" : "") +
    "<br>" + cw + " ocorr. no horário da rota · " + ca + " no dia todo" +
    "<br>veículos no horário: " + vm +
    "<br>janela considerada: " + r.jan.h1 + "h–" + r.jan.h2 + "h · " + (DIAS_TXT[r.jan.dias] || r.jan.dias) + " · " + janelaTxt(r) +
    (cic ? "<br>possui infraestrutura cicloviária neste trecho" : "") +
    (topPct && topPct <= 10 ? "<br>⚠ destaque: via de maior incidência (classe alta ou crítica)" : "");
  if (sem === nTot) h += "<br>via SEM ocorrências registradas: valor <b>incerto</b>, não é evidência de segurança";
  else if (inc === nTot) h += "<br>ponto fora da malha: tratado como <b>incerto</b>";
  return h;
}
function desenhar(r, B, R) {
  const c = CAMADAS.rotas;
  const o = x => Object.assign({pane: "p_rotas", renderer: c.rend, interactive: false, lineCap: "round"}, x);
  const oi = x => Object.assign({pane: "p_rotas", renderer: c.rend, interactive: true}, x);   // trechos: recebem mouse
  const ll = r.samples.map(s => [s.lat, s.lon]);
  // deslocamento perpendicular (~7 m) para as marcações ficarem AO LADO da linha da rota
  const off = ll.map((_, i) => {
    const a = ll[Math.max(0, i - 1)], b = ll[Math.min(ll.length - 1, i + 1)];
    const dx = (b[1] - a[1]) * MXF, dy = (b[0] - a[0]) * MYF, L = Math.hypot(dx, dy) || 1;
    return [ll[i][0] + (-dy / L) * 7 / MYF, ll[i][1] + (dx / L) * 7 / MXF];
  });
  L.polyline(ll, o({color: "#ffffff", weight: 14, opacity: .8})).addTo(haloGrp);        // halo claro: separa a rota das marcações
  L.polyline(ll, o({color: "#10151b", weight: 8, opacity: .5})).addTo(haloGrp);         // contorno escuro: contraste sobre bases claras
  L.polyline(ll, o({color: r.cor, weight: 5.5, opacity: 1})).addTo(c.grp);              // traço único da rota
  let cur = null, run = [], runI = [];
  const flush = () => { if (run.length > 1) {
    L.polyline(run, oi({color: cur.c, weight: 4, opacity: 1}))
      .bindTooltip(() => trechoInfo(runI[0], runI[runI.length - 1], r, B, R), {sticky: true})
      .addTo(trGru);
  } };
  r.samples.forEach((s, i) => {
    const p = riscoAmostra(s, B), col = corRisco(p);   // sem registro aparece como INCERTO (marrom), não cinza
    if (!cur || cur.c !== col || cur.f !== s.fid) { if (run.length) { run.push(off[i]); flush(); } cur = {c: col, f: s.fid}; run = [off[i]]; runI = [i]; }
    else { run.push(off[i]); runI.push(i); }
  });
  if (run.length > 1) { runI.push(r.samples.length - 1); flush(); }
  if (r.desvio) {
    const dl = r.desvio.rota.samples.map(s => [s.lat, s.lon]);
    L.polyline(dl, o({color: "#fff", weight: 9, opacity: .7, dashArray: "9 8"})).addTo(haloGrp);
    L.polyline(dl, oi({color: "#8e24aa", weight: 5, opacity: .95, dashArray: "9 8"}))
      .bindTooltip(() => "<b>" + esc(r.nome) + " — desvio sugerido</b><br>traço tracejado roxo: substitui " + r.desvio.trocas.length +
        " trecho(s) crítico(s) · acréscimo de ~" + Math.round(r.desvio.trocas.reduce((a, t) => a + t.depois - t.antes, 0)) + " m<br>use os botões do bloco da rota para adicionar/substituir", {sticky: true})
      .addTo(trGru);
  }
}
const f1 = x => (100 * x).toFixed(0) + "%";
function quando(r) {
  return r.t0 !== null && r.t1 !== null && r.ini ? hhmm(r.ini) + "–" + hhmm(r.fim) + " (" + r.dia + ")" + (r.dur > 0 ? " · " + (r.dist / 1000 / (r.dur / 3600)).toFixed(1) + " km/h" : "") : "sem horário no arquivo";
}
const ORIGEM_TXT = {gpx: "GPX", planejada: "planejada", desvio: "desvio", alternativa: "alternativa", biblioteca: "biblioteca", importada: "importada"};
function blocoRota(r, R, B) {
  const [lbl, cl] = nivel(R.score);
  const cic = R.ciclo.reduce((a, b) => a + b, 0), temC = D.ciclo.feats.length > 0;
  const ct = temC ? (cic > 0 ? f1(Math.min(1, cic)) + " do trajeto em infraestrutura cicloviária (" + R.ciclo.map((c, i) => D.ciclo.classes[i].toLowerCase() + " " + f1(c)).join(", ") + ")" : "nenhum trecho sobre infraestrutura cicloviária mapeada") : "ciclovias indisponíveis neste mapa";
  const vt = R.veic.reduce((a, b) => a + b, 0);
  const vtxt = vt ? [...R.veic].map((v, i) => [D.veic[i], v]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0] + " " + x[1]).join(" · ") : "–";
  const hot = R.hot.length ? "<ul>" + R.hot.map(h => { const p = D.geo.features[h.f].properties;
    return "<li><b>" + esc(p.n) + "</b>" + (p.b ? " (" + esc(p.b.toLowerCase()) + ")" : "") + " — " + h.m + " m no trajeto · " + h.cw + " no horário / " + h.ca + " no total"
      + ' · <span class="mut" title="posição entre os trechos com registro, pela contagem ponderada por gravidade (atropelamento pesa ' + PARAMS.W_ATR + 'x um acidente)"><span style="color:' + COR_CL[h.cls] + '">■</span> ' + NOMES_CL[h.cls] + " (top " + Math.max(1, Math.round(100 * (1 - h.rk))) + "% dos trechos)</span></li>"; }).join("") + "</ul>" : " nenhum registrado";
  const dopts = Object.entries(DIAS_TXT).map(([k, v]) => '<option value="' + k + '"' + (r.jan.dias === k ? " selected" : "") + ">" + v + "</option>").join("");
  const sopts = ["", "ida", "volta", "outro"].map(k => '<option value="' + k + '"' + (r.sentido === k ? " selected" : "") + ">" + (k || "sentido…") + "</option>").join("");
  const avisoSem = R.sem >= .3 ? '<div class="aviso-lac">' + f1(R.sem) + " do trajeto está em vias sem ocorrências registradas (avaliadas como incertas, com valor " + PARAMS.INCERTO + "). " + AVISO_LACUNAS + "</div>" : "";
  const extraArt = r.meta && r.meta.arterialM > 50 ? "<br>• " + Math.round(r.meta.arterialM) + " m em via arterial sem infraestrutura cicloviária" : "";
  const crit = R.crit.length ? "<br>• Trechos críticos (classe alta ou crítica, top 10% das vias): " + R.crit.map(c => (c.m) + " m (" + [...c.fids].map(f => esc(D.geo.features[f].properties.n)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(", ") + ")").join("; ") : "";
  // extensão do trajeto dentro de cada classe de risco — mesma régua por quantil do Panorama
  const clsTxt = R.clsM.map((m, k) => m >= STEP ? '<span style="color:' + COR_CL[k] + '">■</span> ' + NOMES_CL[k] + " " + Math.round(m) + " m" : "").filter(Boolean).join(" · ");
  const clsLinha = (clsTxt ? "<br>• No trajeto: " + clsTxt : "") +
    (R.mSem >= STEP ? " · <span class='mut'>sem registro " + Math.round(R.mSem) + " m</span>" : "") +
    (R.mInc >= STEP ? " · fora da malha " + Math.round(R.mInc) + " m" : "");
  let dv = "";
  if (r.desvio) {
    const rd = r.desvio.rota, Rd = avaliar(rd, B), dscore = Rd.score - R.score, dm = rd.dist - r.dist;
    dv = '<div class="dv"><b>Desvio sugerido</b> em ' + r.desvio.trocas.length + " trecho(s): índice <b>" + R.score.toFixed(0) + " → " + Rd.score.toFixed(0) + "</b> (" + (dscore > 0 ? "+" : "") + dscore.toFixed(0) +
      "), distância " + (rd.dist / 1000).toFixed(2) + " km (" + (dm >= 0 ? "+" : "") + Math.round(dm) + " m)." +
      '<div class="racoes"><button data-act="dv-add" data-rid="' + r.id + '">Adicionar como nova rota</button><button data-act="dv-sub" data-rid="' + r.id + '">Substituir a original</button><button data-act="dv-no" data-rid="' + r.id + '">Descartar</button></div></div>';
  }
  const rid = ' data-rid="' + r.id + '"';
  return '<div class="rota"' + rid + '><div><span class="rt" style="display:inline-flex"><span class="sw" style="background:' + r.cor + '"></span></span><b>' + esc(r.nome) + '</b> <span class="tag">' + (ORIGEM_TXT[r.origem] || r.origem) + '</span> <span class="mut">· ' + (r.dist / 1000).toFixed(1) + " km · " + quando(r) + "</span></div>" +
    '<div class="rjan">Horário de risco: <input class="num" type="number" min="0" max="23" value="' + r.jan.h1 + '"' + rid + ' data-k="h1">h a <input class="num" type="number" min="0" max="23" value="' + r.jan.h2 + '"' + rid + ' data-k="h2">h <select' + rid + ' data-k="dias">' + dopts + "</select><select" + rid + ' data-k="sentido">' + sopts + "</select></div>" +
    '<div style="margin-top:6px"><span class="badge" style="background:' + cl + '">' + lbl + '</span> <b>' + R.score.toFixed(0) + '/100</b>' +
    ' <span class="mut">±' + R.incerteza + "</span> <span class=\"mut\">índice de risco (média " + R.scoreMed.toFixed(0) + ", ponderado por tempo de exposição)</span></div>" +
    '<div class="meter"><i style="left:calc(' + Math.min(99, R.score) + '% - 1px)"></i><s style="left:calc(' + Math.max(0, Math.min(99, R.score - R.incerteza)) + '%);right:calc(' + Math.max(0, Math.min(99, 100 - R.score - R.incerteza)) + '%)"></s></div>' +
    '<div style="font-size:13px">• ' + ct + "<br>• " + f1(R.sem) + " do trajeto sem ocorrências registradas nas vias<br>• Nas vias percorridas: <b>" + R.cw + "</b> ocorrências no horário (" + R.ca + " no dia todo)<br>• Veículos (no horário): " + vtxt + clsLinha + extraArt + crit + "<br>• Trechos de maior risco:" + hot + "</div>" +
    avisoSem + dv +
    '<div class="racoes"><button data-act="salvar"' + rid + '>💾 Salvar na biblioteca</button><button data-act="gpx"' + rid + '>⬇ GPX</button>' +
    (R.crit.length && !r.desvio ? '<button data-act="desvio"' + rid + '>↪ Sugerir desvio</button>' : "") +
    (r.id === "plano" ? '<button data-act="fixar"' + rid + ">📌 Fixar rota</button>" : "") + "</div></div>";
}
function tabelaComparativa(res) {
  if (res.length < 2) return "";
  const melhor = Math.min(...res.map(x => x.R.score));
  return '<table class="comp"><thead><tr><th>Rota</th><th class="n">km</th><th>Horário</th><th class="n">Índice</th><th>Nível</th><th class="n">Ciclovia</th><th class="n">Sem registro</th><th class="n">Críticos</th><th class="n">Ocorr. no horário</th></tr></thead><tbody>' +
    res.map(({r, R}) => '<tr' + (R.score === melhor ? ' class="melhor"' : "") + "><td>" + '<span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + r.cor + '"></span> ' + esc(r.nome) + '</td><td class="n">' + (r.dist / 1000).toFixed(1) + "</td><td>" + r.jan.h1 + "–" + r.jan.h2 + "h</td><td class=\"n\">" + R.score.toFixed(0) + " ±" + R.incerteza + "</td><td>" + nivel(R.score)[0] + '</td><td class="n">' + f1(Math.min(1, R.ciclo.reduce((a, b) => a + b, 0))) + '</td><td class="n">' + f1(R.sem) + '</td><td class="n">' + R.crit.length + '</td><td class="n">' + R.cw + "</td></tr>").join("") + "</tbody></table>";
}
let cRisco = null;
function suavizar(a, w = 5) { return a.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - w); j <= Math.min(a.length - 1, i + w); j++) { s += a[j]; n++; } return s / n; }); }
// ---- interação gráfico ⇄ mapa: ao passar o cursor na curva de risco, um marcador temporário
// aparece no mapa na posição correspondente da rota, com um CARTÃO informativo (via, classe,
// ocorrências no horário/total, veículos, posição na rota e distância até o fim) — e some ao
// tirar o cursor. Os listeners vão no WRAPPER .chartbox (não no canvas): é ele quem recebe os
// eventos de mouse; listener só no canvas não disparava em muitos navegadores.
let hoverMarc = null, hoverRes = [];
function removerHover() { if (hoverMarc) { MAPA.removeLayer(hoverMarc); hoverMarc = null; } }
function marcarHover(pos, r, i, R, B) {
  if (!pos || !r) { removerHover(); return; }
  const pct = (R.perfil[i] || 0), cor = corRisco(Math.max(0, Math.min(1, pct / 100)));
  const s = r.samples[i], temF = s && s.fid >= 0 && B.pct[s.fid] > 0;
  const nome = temF ? D.geo.features[s.fid].properties.n : (s && s.fid >= 0 ? "sem registro" : "fora da malha");
  const bairro = temF && D.geo.features[s.fid].properties.b ? " (" + esc(D.geo.features[s.fid].properties.b.toLowerCase()) + ")" : "";
  const k = temF ? classeDePct(B.pct[s.fid]) : -1;
  const topPct = temF && B.rk[s.fid] > 0 ? Math.max(1, Math.round(100 * (1 - B.rk[s.fid]))) : null;
  const km = i * STEP / 1000, falta = Math.max(0, (r.samples.length - 1 - i) * STEP) / 1000;
  let h = "<b>" + esc(r.nome) + "</b><br>km " + km.toFixed(2) + " de " + (r.dist / 1000).toFixed(2) + " · faltam " + falta.toFixed(2) + " km" +
    "<br><span style='color:" + cor + "'>■</span> <b>" + esc(nome) + "</b>" + bairro +
    (k >= 0 ? " · classe " + NOMES_CL[k] + (topPct ? " (top " + topPct + "%)" : "") : k < 0 && temF === false ? " · valor incerto" : "") +
    (temF ? "<br>" + Math.round(B.cw[s.fid]) + " ocorr. no horário · " + Math.round(B.ca[s.fid]) + " no total" : "") +
    (temF ? "<br>risco neste ponto: " + pct.toFixed(0) + "/100" : "");
  if (hoverMarc) { hoverMarc.setIcon(L.divIcon({className: "hover-marc", iconSize: [18, 18], iconAnchor: [9, 9], html: "<span style='background:" + cor + "'></span><i>" + h + "</i>"})); hoverMarc.setLatLng(pos); }
  else hoverMarc = L.marker(pos, {icon: L.divIcon({className: "hover-marc", iconSize: [18, 18], iconAnchor: [9, 9], html: "<span style='background:" + cor + "'></span><i>" + h + "</i>"}), interactive: false, pane: "p_rotas", keyboard: false}).addTo(MAPA);
}
function hoverEm(ev) {                              // gráfico -> mapa: marcador na posição da rota
  const res = hoverRes;
  if (!res.length || !cRisco) return;
  const cv = $("cRisco").parentNode;                // wrapper .chartbox (o canvas é o elemento do Chart)
  const rect = cv.getBoundingClientRect(), fx = (ev.clientX - rect.left) / rect.width;
  if (fx < 0 || fx > 1) { removerHover(); return; }
  const xa = cRisco.scales && cRisco.scales.x;
  const x = (xa && isFinite(xa.min) && isFinite(xa.max)) ? xa.min + fx * (xa.max - xa.min) : fx * res[0].r.dist / 1000;
  let alvo = res[0];                               // rota mais próxima da curva no ponto (limiar ~40 px)
  if (res.length > 1 && cRisco.chartArea && cRisco.scales && cRisco.scales.y) {
    const ca = cRisco.chartArea, fy = (ev.clientY - rect.top) / (rect.height || 1);
    const yPix = ca.bottom - fy * (ca.bottom - ca.top), ys = [];
    for (const it of res) { const sc = it.R.perfil[Math.round(x * 1000 / STEP)] || 0;
      ys.push(cRisco.scales.y.getPixelForValue(sc) - yPix); }
    let bi = 0; ys.forEach((d, i) => { if (Math.abs(d) < Math.abs(ys[bi])) bi = i; });
    if (Math.abs(ys[bi]) > 40) { removerHover(); return; }
    alvo = res[bi];
  }
  const i = Math.max(0, Math.min(alvo.r.samples.length - 1, Math.round(x * 1000 / STEP)));
  const s = alvo.r.samples[i];
  marcarHover(posAmostra(alvo.r, i), alvo.r, i, alvo.R, alvo.B);
}
(() => {                                           // listeners montados uma única vez (res via closure)
  const cv = $("cRisco"); if (!cv) return;
  const box = cv.parentNode || cv;                 // wrapper .chartbox: é ele quem recebe os eventos
  box.addEventListener("mousemove", hoverEm);
  box.addEventListener("mouseleave", removerHover);
  cv.addEventListener("mousemove", hoverEm);       // por garantia, também no próprio canvas
  cv.addEventListener("mouseleave", removerHover);
})();
function atualizarPerfil(res) {
  if (!cRisco) cRisco = new Chart($("cRisco"), {type: "line", data: {datasets: []}, options: {responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
    scales: {x: {type: "linear", title: {display: true, text: "distância (km)"}}, y: {min: 0, max: 100, title: {display: true, text: "risco do trecho (0–100)"}}},
    plugins: {legend: {position: "bottom"}, tooltip: {callbacks: {afterBody: () => "passe o cursor: o ponto aparece no mapa"}}}, elements: {point: {radius: 0}}}});
  cRisco.data.datasets = res.map(({r, R}) => ({label: r.nome, borderColor: r.cor, backgroundColor: r.cor + "22", fill: true, borderWidth: 1.6, data: suavizar(R.perfil).map((y, i) => ({x: i * STEP / 1000, y}))}));
  if (res.length === 1) {                        // banda de incerteza da rota única (±incerteza)
    const R = res[0].R, su = suavizar(R.perfil);
    cRisco.data.datasets.push({label: "+ incerteza", borderColor: "rgba(0,0,0,0)", backgroundColor: res[0].r.cor + "26", fill: false, pointRadius: 0, borderWidth: 0,
      data: su.map((y, i) => ({x: i * STEP / 1000, y: Math.min(100, y + R.incerteza)}))});
    cRisco.data.datasets.push({label: "− incerteza", backgroundColor: res[0].r.cor + "55", fill: "-1", borderWidth: 0, pointRadius: 0, showLine: false,
      data: su.map((y, i) => ({x: i * STEP / 1000, y: Math.max(0, y - R.incerteza)}))});
  }
  hoverRes = res;
  cRisco.update();
}
function renderListaRotas() {
  const html = rotas.map((r, i) => '<div class="rt' + (rotaSel === r.id ? " sel" : "") + '"><span class="sw" style="background:' + r.cor + '"></span><span class="nm" data-z="' + i + '" title="' + esc(r.nome) + '">' + esc(r.nome) + '</span><button data-x="' + i + '" title="remover da análise">×</button></div>').join("");
  // a mesma lista aparece na aba \"Minha rota\" (#rotas) e nos filtros do Panorama (#rotasPan)
  ["rotas", "rotasPan"].forEach(id => {
    const box = $(id); if (!box) return;
    box.innerHTML = html;
    box.querySelectorAll("[data-z]").forEach(el => el.onclick = () => {
      const r = rotas[+el.dataset.z];
      rotaSel = rotaSel === r.id ? null : r.id;               // clicar de novo na selecionada volta a \"todas\"
      if (aba === "panorama") update(); else renderListaRotas();
      if (rotaSel) MAPA.fitBounds(L.latLngBounds(r.pts).pad(.1));
    });
    box.querySelectorAll("[data-x]").forEach(el => el.onclick = () => {
      const r = rotas[+el.dataset.x]; if (rotaSel === r.id) rotaSel = null;
      rotas.splice(+el.dataset.x, 1); if (r.id === "plano") { wps = []; desenharWps(); }
      aposMudarRotas();
    });
  });
  const sp = $("secRotasPan"); if (sp) sp.hidden = !rotas.length;
}
function atualizarRotas() {
  BC = new Map();
  CAMADAS.rotas.grp.clearLayers(); haloGrp.clearLayers(); trGru.clearLayers(); renderListaRotas();
  const box = $("risco"); if (box) box.classList.toggle("vazio", !rotas.length);
  // botão "rota alternativa": ativo só com alguma rota em análise; desativado e esmaecido sem rotas
  const bAlt = $("btnAlt");
  if (altAtiva && !rotas.some(x => x.id === altAtiva.orig.id)) limparAlt();   // a rota de origem saiu da análise
  const bLimp = $("rotasLimpar"); if (bLimp) bLimp.disabled = !rotas.length && !wps.length;
  if (bAlt) { bAlt.disabled = !rotas.length; bAlt.title = rotas.length ? "Buscar rota mais segura entre o início e o fim da rota selecionada" : "Carregue ou planeje uma rota primeiro"; }
  if (!rotas.length) { rotaSel = null; return; }
  if (rotaSel && !rotas.some(x => x.id === rotaSel)) rotaSel = null;   // a rota selecionada saiu da análise
  const res = rotas.map(r => { const B = baseDe(r.jan), R = avaliar(r, B); desenhar(r, B, R); return {r, R, B}; });
  $("comp").innerHTML = tabelaComparativa(res);
  atualizarPerfil(res);
  $("riscoCorpo").innerHTML = res.map(({r, R, B}) => blocoRota(r, R, B)).join("") + '<p class=\u0022nota\u0022>As cores seguem a mesma régua por QUANTIL do Panorama: cada trecho (via×bairro) é posicionado entre os trechos com registro pela contagem de ocorrências ponderada por gravidade (atropelamento vale ' + PARAMS.W_ATR + '× um acidente), no horário/dias da rota e nos filtros de risco, e cai em uma de 5 classes (baixo &lt; P50 &lt; moderado &lt; P75 &lt; elevado &lt; P90 &lt; alto &lt; P97 &lt; crítico). Os cortes são recalculados a cada filtro: o nível é relativo às demais vias com registro (' + res[0].B.nReg + ' trechos no recorte). O índice (0–100) é a média da posição ao longo do trajeto, ponderada pelo tempo de exposição (velocidade local do GPX; sem horários, ' + PARAMS.V_BIKE + ' km/h). Vias sem registro recebem o valor \u201cincerto\u201d (' + PARAMS.INCERTO + '), o mesmo usado pelo roteador — não são consideradas seguras. Ciclovia/ciclofaixa não reduz a cor nem o índice; aparece à parte. O ± cresce com a fração do trajeto sem registros e com a amostra temporal escolhida. É uma medida comparativa, não uma probabilidade: as chamadas do SAMU são localizadas pelo nome da via (não pelo ponto exato) e não há dado de volume de tráfego nem de quilometragem pedalada. ' + AVISO_LACUNAS + '</p>';
}
$("riscoCorpo").addEventListener("click", e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const r = rotas.find(x => x.id === b.dataset.rid); if (!r) return;
  const a = b.dataset.act;
  if (a === "salvar") salvarNaBiblioteca(r);
  else if (a === "gpx") baixar(slug(r.nome) + ".gpx", new Blob([gpxDe(r)], {type: "application/gpx+xml"}));
  else if (a === "desvio") sugerirDesvio(r);
  else if (a === "dv-add") aplicarDesvio(r, false);
  else if (a === "dv-sub") aplicarDesvio(r, true);
  else if (a === "dv-no") { r.desvio = null; atualizarRotas(); }
  else if (a === "fixar") fixarPlano();
});
$("riscoCorpo").addEventListener("change", e => {
  const el = e.target, r = rotas.find(x => x.id === el.dataset.rid); if (!r || !el.dataset.k) return;
  const k = el.dataset.k;
  if (k === "sentido") r.sentido = el.value;
  else { r.jan = Object.assign({}, r.jan, {[k]: k === "dias" ? el.value : Math.max(0, Math.min(23, +el.value || 0))}); r.desvio = null; }
  atualizarRotas();
});

// ---------------------------------------------------------------- entrada de arquivos e ligações finais
function adicionarTexto(txt, nome) {
  const g = lerGpx(txt, nome);
  const r = criarRota({nome: g.nome || nome, pts: g.pts, times: g.times, origem: "gpx"});
  rotas.push(r); escopoOff = false;
  limparAlt();   // a alternativa exibida não corresponde mais à rota ativa
  if (aba !== "rota") irAba("rota"); else atualizarRotas();
  MAPA.fitBounds(L.latLngBounds(r.pts).pad(.1));
  return r;
}
async function lerArquivos(lista) {
  for (const f of lista) {
    if (!/\.gpx$/i.test(f.name)) continue;
    try { adicionarTexto(await f.text(), f.name.replace(/\.gpx$/i, "")); }
    catch (e) { alert("Não foi possível ler " + f.name + ": " + e.message); }
  }
}
$("gpx").onchange = ev => { lerArquivos(ev.target.files); ev.target.value = ""; };
$("btnAlt").onclick = buscarAlternativa;
$("rotasLimpar").onclick = limparRotas;
$("rotasLimparPan").onclick = limparRotas;
$("btnEscopo").onclick = () => { escopoOff = !escopoOff; update(); };
// "salvar" = adicionar a sugestão à análise (ela ganha um bloco próprio, com índice de risco,
// botão de salvar na biblioteca e botão de baixar GPX); "baixar" = GPX direto da sugestão.
$("altSalvar").onclick = () => {
  if (!altAtiva) { aviso("Busque uma rota alternativa primeiro."); return; }
  rotas.push(altAtiva.alt); limparAlt(); atualizarRotas();
};
$("altBaixar").onclick = () => {
  if (!altAtiva) { aviso("Busque uma rota alternativa primeiro."); return; }
  baixar(slug(altAtiva.alt.nome) + ".gpx", new Blob([gpxDe(altAtiva.alt)], {type: "application/gpx+xml"}));
};
["h1", "h2", "dias"].forEach(id => $(id).onchange = () => { if (wps.length >= 2) recalcularPlano(); });
["dragover", "dragenter"].forEach(t => document.body.addEventListener(t, e => { e.preventDefault(); $("map").classList.add("drop"); }));
["dragleave", "drop"].forEach(t => document.body.addEventListener(t, e => { e.preventDefault(); $("map").classList.remove("drop"); }));
document.body.addEventListener("drop", e => { if (e.dataTransfer && e.dataTransfer.files) lerArquivos(e.dataTransfer.files); });
renderLib();
// ganchos para testes automatizados
window.__gpx = adicionarTexto;
window.__rotas = {get lista() { return rotas; }, PLAN, fatores, riscoAresta, riscoAmostra, melhorCaminho, caminhoSeguro, snapNo, arcosParaPontos, comprimentoArcos, contramao, fidsDosArcos, get nArestas() { return EU.length; }, get nNos() { return NN; }, PARAMS, TEM_GRAFO, baseDe, avaliar, hoverEm, marcarHover, removerHover, get hoverMarc() { return hoverMarc; }, ativarPlano, addWp: ll => { wps.push(ll); recalcularPlano(); }, sugerirDesvio, aplicarDesvio, salvarNaBiblioteca, renderLib, exportar, importar, Lib, gpxDe, lerGpx, empacotarZip, empacotarTar, empacotarTgz, atualizarRotas, limparRotas, limparAlt, escopoRota, get altAtiva() { return altAtiva; }};

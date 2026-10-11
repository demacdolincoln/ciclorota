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
// MÉTRICA (v5, "taxa anual esperada + limiares de atenção"): a unidade básica é a TAXA ANUAL
// PONDERADA POR GRAVIDADE — occ-peso/km/ano. É a medida padrão da literatura de segurança
// viária para comparar pontos com comprimentos e exposições temporais diferentes:
//  • Høye et al. (2019), "Review of methods and indicators used to evaluate the safety of
//    the road network" (ETSC/TOI): taxas por km (ou por fluxo) são o indicador básico;
//    contagens BRUTAS favorecem vias longas e períodos maiores — exatamente o artefato que
//    fazia o risco "subir ao marcar mais anos".
//  • Empirical Bayes (Hauer et al., 1986; FHWA Roadway Safety Data Analysis, 2013): o número
//    observado de ocorrências é suavizado pela média da rede proporcionalmente à confiança
//    (comprimento × tempo observado) — aqui feito NA RAZÃO via/cidade, para nunca empurrar
//    uma avenida longa de volta à média (erro da v3, que subestimava as vias mais registradas).
//  • Weighted / severity-based counts (Sri Muthiah/ATSI "weighted collision count"; Elvik
//    Power Model): cada ocorrência pesa pela gravidade — atropelamento vale W_ATR × acidente.
//  • Kernel Density Estimation de acidentes (Xie & Yan 2008; Chen et al. 2016): hotspots são
//    densidades espaciais normalizadas pela exposição — é o papel do mapa de calor e das
//    faixas fixas abaixo.
// CONTRASTE VISÍVEL (o ponto central da v5): em cidades reais a distribuição de ocorrências
// é altamente concentrada (poucas vias acumulam a maioria — "concentration of traffic
// crashes", Kallén 1984; Song et al. 2001; Magistroni/Hauer 2007: ~10% das vias ≈ metade dos
// acidentes). Por isso NÃO se deve ancorar a cor no máximo relativo (tudo sai amarelo e só a
// via nº1 fica vermelha) nem no P99 puro (uma única rua extrema espreme as demais). A escala
// usa ÂNCORA ABSOLUTA E ESTÁVEL (riscoBase._anc = P_REF das taxas brutas anuais da rede
// inteira, sem filtros laterais) e, sobretudo, FAIXAS FIXAS DE ATENÇÃO derivadas dela:
//  < 25% da âncora .... verde (nível baixo)
//  25–50% ............. verde→amarelo (moderado)
//  50–100% ............ laranja (ELEVADO — já exige atenção)
//  ≥ 100% ............. vermelho (ALTO — hotspot; satura em PARAMS.SAT × âncora)
// Assim, QUALQUER via com volume realmente alto por trecho aparece em laranja/vermelho no
// panorama e na rota — não apenas a líder absoluta — e mudar filtros laterais não comprime
// nem estica a régua (só a taxa de cada via muda). O valor "incerto" de vias sem registro é
// mantido abaixo do limiar de trechos críticos (T_CRIT = 70 > INCERTO = 35): lacuna de dado
// não vira alerta visual.
// Correções estruturais herdadas da v4 (e reforçadas):
//  • taxa ANUAL real (÷ anos de COBERTURA do dataset, não ÷ anos marcados): o recorte temporal
//    é amostra da taxa — menos anos alarga a banda ±, mas NÃO altera o nível;
//  • mix de horário como TAXA POR HORA nos dois componentes (janela e dia todo): janelas
//    curtas (±1h dos GPX) não diluem mais artificialmente o nível de uma avenida perigosa;
//  • tendência temporal explícita (razão exponencial meia-vida H_ANOS entre massa recente e
//    média histórica, limitada a [1/T_SUP, T_SUP]): capturas recentes pesam mais.
// Parâmetros (expostos em __rotas.PARAMS para calibração/testes):
//  KAPPA  — força da suavização bayesiana, em KM-PSEUDO (pseudo-extensão equivalente à
//           média da cidade). Cresce com o tamanho da malha (≈ K_FRAC da extensão total,
//           entre K_MIN e K_MAX). Agora atua só sobre a confiança (razão via/cidade), não
//           sobre o nível absoluto.
//  W_ATR  — peso de um ATROPELAMENTO relativo a um ACIDENTE (naturezas: 0=Acidente,
//           1=Atropelamento). Atropelar ciclista é a agressão mais grave contra quem pedala.
//  H_ANOS — meia-vida (anos) do fator de tendência: ocorrências recentes pesam mais que as
//           antigas (ponderação exponencial). 0 desliga a ponderação temporal.
//  T_LIM  — piso de massa temporal (em peso-ano/km) p/ aplicar a tendência (vias com
//           histórico muito curto ficam em 1, neutras — evita inflar vias com 2 ocorrências).
//  T_SUP  — teto do fator de tendência (uma via nova não pode parecer infinitamente pior).
//  R_REF  — âncora da escala (occ-anual-peso/km): se > 0, teto FIXO de calibração. Se 0
//           (padrão), percentil P_REF das taxas BRUTAS (sem shrinkage) de TODA a rede,
//           SEM os filtros do painel e recalculada ao mudar QUALQUER filtro (inclusive os
//           anos — a âncora antiga só mudava com a janela de dias: bug de inconsistência).
//  P_REF/SAT/R_MAX/INCERTO/T_CRIT/V_BIKE/V_MIN/V_MAX — âncora percentil, saturação, teto
//           de reserva, valor "incerto" unificado com o roteador, limiar único de trecho
//           crítico e velocidades p/ tempo de exposição.
//  PROT   — proteção cicloviária aplicada TAMBÉM na avaliação (0–1). Antes o roteador
//           tratava ciclovia/ciclofaixa como protegidas, mas a nota exibida ignorava isso:
//           uma rota toda em ciclovia podia pontuar MAIS que uma rota em avenida sem
//           estrutura — incoerência corrigida aqui e no roteador (fator (1 − PROT·w)).
const PARAMS = {KAPPA: 0, K_MIN: .3, K_MAX: 8, K_FRAC: .10, W_ATR: 1.5, H_ANOS: 3, T_LIM: 3, T_SUP: 2,
  R_REF: 0, P_REF: .99, SAT: 2, R_MAX: 10, INCERTO: 35, T_CRIT: 70, PROT: .5, V_BIKE: 15, V_MIN: 5, V_MAX: 35};
const INC = () => PARAMS.INCERTO / 100;           // versão 0–1 usada internamente (pct/perfil)
const W_NAT = () => [1, PARAMS.W_ATR];            // peso por natureza (0 Acidente, 1 Atropelamento)
const LAM = () => PARAMS.H_ANOS > 0 ? Math.LN2 / PARAMS.H_ANOS : 0;
const AI = D.anos.length ? D.anos : [2026];       // anos reais (índice e[10] é posição em D.anos)
const NAI = () => AI.length - 1;                  // índice do ano mais recente
// anos de COBERTURA do dataset (não dos anos selecionados): é o divisor fixo que torna a
// taxa realmente ANUAL — com o nº de anos marcados no lugar, a métrica voltaria a ser um
// somatório e oscilaria com o filtro.
const N_ANOS_COB = () => Math.max(1, AI[NAI()] - AI[0] + 1);
// fração dos ANOS DE COBERTURA efetivamente selecionada no filtro (2 de 5 anos → 0,4):
// entra na banda ± como incerteza amostral — a taxa anual é estimada a partir dessa amostra.
const FR_AMOSTRA = () => { const cob = AI[NAI()] - AI[0] + 1; return cob > 0 ? Math.min(1, SR.ano.size / cob) : 1; };

function riscoBase(jan) {
  const h1 = jan.h1, h2 = jan.h2, dm = jan.dias;
  const wn = W_NAT(), lam = LAM(), amax = NAI(), nAnos = N_ANOS_COB();
  // horas cobertas pela janela e pelo "dia todo" (janelas que passam da meia-noite, ex.
  // 22h→2h, somam as voltas); o mix de horário passa a ser TAXA POR HORA em ambos os lados
  // — antes era contagem mista e janelas curtas diluíam artificialmente o risco da via.
  const normH = h => ((h % 24) + 24) % 24;
  const h1n = normH(h1), h2n = normH(h2);
  const dentroHora = hr => h1n <= h2n ? (hr >= h1n && hr <= h2n) : (hr >= h1n || hr <= h2n);
  const nHjan = Math.abs(h2 - h1) + 1, nHdia = 24;
  const cw = new Float64Array(NF), ca = new Float64Array(NF), cwv = new Int32Array(NF * NV);
  const ix = new Float64Array(NF), it = new Float64Array(NF);   // taxa anual e massa temporal p/ tendência
  let nw = 0, na = 0;
  for (const e of D.ev) {
    if (!(SR.ano.has(e[10]) && SR.veic.has(e[1]) && SR.nat.has(e[2]))) continue;
    if (dm === "uteis" && e[4] > 4) continue; if (dm === "fds" && e[4] < 5) continue;
    na++; const dentro = dentroHora(e[5]); if (dentro) nw++;
    if (e[0] >= 0) {
      ca[e[0]]++;
      const w = wn[e[2]], dti = Math.max(0, amax - e[10]);      // idade em anos (relativa ao mais recente)
      ix[e[0]] += w / nAnos;                                    // TAXA ANUAL (÷ anos de cobertura —
      it[e[0]] += w * Math.exp(-lam * dti) / nAnos;             // não ÷ nº de anos marcados)
      if (dentro) { cw[e[0]]++; cwv[e[0] * NV + e[1]]++; }
    }
  }
  // fração do dia que a amostra "dia todo" representa no recorte: dias úteis ≈ 5/7 do ano,
  // fins de semana ≈ 2/7 — sem isso, filtrar por dias mudava a ESCALA relativa entre o
  // componente horário e o componente dia-todo (mais uma fonte de oscilação com os filtros).
  const fDia = dm === "uteis" ? 5 / 7 : dm === "fds" ? 2 / 7 : 1;
  // extensão total da malha (base p/ o prior, o kappa relativo e a âncora)
  let totKm = 0; for (let i = 0; i < NF; i++) totKm += Math.max(KM[i], 0.2);
  // kappa RELATIVO ao tamanho da rede: em cidades pequenas quase não suaviza (preserva o
  // contraste entre vias); em redes grandes sobe até K_MAX. Em testes, PARAMS.KAPPA > 0 fixa.
  const k = PARAMS.KAPPA > 0 ? PARAMS.KAPPA : Math.min(PARAMS.K_MAX, Math.max(PARAMS.K_MIN, PARAMS.K_FRAC * totKm));
  riscoBase._k = k;
  // ÂNCORA DA ESCALA (onde 100 ≈ as vias mais críticas): P_REF das taxas ANUAIS brutas por km
  // de TODA a rede — sem shrinkage (comprimir o topo apagava os vermelhos do mapa) e SEM os
  // filtros de veículo/natureza/dias/horário: a escala fica ABSOLUTA e estável, mudar chips
  // laterais não comprime nem estica as cores (só a taxa de cada via muda). Só os ANOS
  // entram, já normalizados pela cobertura. Cache separadinho da base (invalida junto com BC).
  const ancKey = [...SR.ano].join(",") + "|" + k;
  if (riscoBase._anc === undefined || riscoBase._ancKey !== ancKey) {
    let ig = null, tg = 0;
    for (const e of D.ev) {
      if (e[0] < 0 || !SR.ano.has(e[10])) continue;
      if (!ig) ig = new Float64Array(NF);
      ig[e[0]] += wn[e[2]] / nAnos; tg += wn[e[2]] / nAnos;     // taxa anual bruta por via
    }
    riscoBase._ancKey = ancKey; riscoBase._ancTot = tg;
    if (PARAMS.R_REF > 0) riscoBase._anc = PARAMS.R_REF;
    else if (!ig || tg === 0) riscoBase._anc = null;
    else {
      const ds = [];
      for (let i = 0; i < NF; i++) if (ig[i] > 0) ds.push(ig[i] / Math.max(KM[i], 0.2));
      ds.sort((a, b) => a - b);                                // só vias com registro (a cauda é 0)
      riscoBase._anc = ds.length ? Math.max(ds[Math.floor(PARAMS.P_REF * (ds.length - 1))], 1e-9) : null;
    }
  }
  // prior = média da cidade no recorte (taxa anual ponderada, mesma unidade de ix)
  let totIx = 0; for (let i = 0; i < NF; i++) totIx += ix[i];
  const prior = totKm ? totIx / totKm : 0;
  const Rtop = (riscoBase._anc !== null && riscoBase._ancTot > 0 ? riscoBase._anc * PARAMS.SAT : 0) || PARAMS.R_MAX;
  const dens = new Float64Array(NF), pct = new Float32Array(NF), conf = new Float32Array(NF), tend = new Float32Array(NF);
  for (let i = 0; i < NF; i++) {
    const km = Math.max(KM[i], 0.2);
    // TAXA POR HORA em ambos os componentes: cw/nHjan (janela) e ca·fDia/nHdia (dia todo,
    // ajustado pela fração do ano que o filtro de dias representa). O fator comum
    // nAnos·nHdia cancela na razão via/cidade — a métrica é estável quanto aos filtros.
    const mix = ((cw[i] * nHdia + ca[i] * fDia * nHjan) / (nHjan * nHdia)) * nAnos;
    const dBruta = prior > 0 ? mix / prior : 0;                // razão via/cidade (adimensional)
    // tendência temporal: massa recente vs. média histórica (1 = estável; >1 piorando).
    let t = 1;
    if (lam > 0 && it[i] >= PARAMS.T_LIM / nAnos) {            // piso em peso-ano/km coberto
      const media = ix[i] * ((1 - Math.exp(-lam * (amax + 1))) / (lam * (amax + 1)));
      if (media > 1e-9) t = Math.min(PARAMS.T_SUP, Math.max(1 / PARAMS.T_SUP, it[i] / media));
    }
    tend[i] = t;
    const ratio = dBruta * t;                                  // taxa relativa à média, com tendência
    conf[i] = km / (km + k);                                   // confiança ∝ comprimento observado
    // SHRINKAGE NA RAZÃO (adimensional): uma avenida LONGA mantém o próprio nível — na v3 o
    // shrinkage em escala absoluta empurrava as vias com km grande (justamente as avenidas de
    // maior registro) de volta para a média da cidade, subestimando-as.
    const rs = ratio * conf[i] + 1 * (1 - conf[i]);
    dens[i] = prior * rs;                                      // taxa anual esperada (occ-peso/km/ano)
    pct[i] = Math.min(1, Math.sqrt(Math.max(dens[i], 0) / Rtop));   // raiz: resolução na base
  }
  return {cw, ca, cwv, pct, conf, dens, tend, prior, rref: riscoBase._anc, k, nw, na, h1, h2, dias: dm};
}
let BC = new Map();
// a chave do cache inclui os filtros de rota: antes, mudar os ANOS não invalidava a base
// (a âncora só dependia da janela de dias) — o índice subia/escondia de forma incoerente.
function baseDe(jan) {
  const key = jan.h1 + "-" + jan.h2 + "-" + jan.dias + "|" + [...SR.ano].join(",") + "|" + [...SR.veic].join(",") + "|" + [...SR.nat].join(",");
  if (!BC.has(key)) BC.set(key, riscoBase(jan));
  return BC.get(key);
}

// risco 0–1 de uma amostra: via registrada → pct × proteção cicloviária; via sem registro →
// incerto (não zero); fora da malha → incerto também (âmbar-acinzentado, coerente com o
// roteador). A proteção (PARAMS.PROT) é o MESMO conceito usado pelo roteador (W_CICLO):
// antes a nota da rota ignorava ciclovias, e uma rota em avenida perigosa podia parecer
// mais segura que uma rota toda em ciclovia.
const protCiclo = c => c > 0 ? 1 - PARAMS.PROT * (W_CICLO[c] || 0) : 1;
const riscoAmostra = (s, B) => (s.fid >= 0 && B.pct[s.fid] > 0) ? B.pct[s.fid] * protCiclo(s.ciclo) : INC();
// FAIXAS FIXAS DE ATENÇÃO (v5, ancoradas na régua absoluta — ver comentário da métrica):
// p = sqrt(taxa/Rtop) ∈ [0,1]; 1.0 ↔ taxa = âncora P_REF da rede inteira.
//  < .375 verde | .375–.62 amarelo | .62–.84 laranja | ≥ .84 vermelho (~taxa ≥ 70% da âncora).
// Qualquer via com volume realmente alto por trecho (≥ metade da âncora) aparece laranja/
// vermelha — antes, com a escala relativa ao máximo, só a líder absoluta saturava e as
// demais se espremeam no amarelo ("não há diferenças de cores no panorama geral").
const corRisco = p => p <= 0 ? "#9aa5b1" : p < INC() + 1e-6 ? "#b08968"
  : p < .375 ? "#2fb344" : p < .62 ? "#f2c200" : p < .84 ? "#f08a24" : "#d62d20";
// nível em TAXA ABSOLUTA (occ-peso/km/ano), não em percentil relativo: "Alto" significa que a
// via chegou à faixa das mais críticas da cidade inteira, independentemente da rota atual.
function nivel(sc) { const tx = sc / 100 * ((riscoBase._anc || PARAMS.R_MAX / PARAMS.SAT) * PARAMS.SAT);
  return tx < .25 ? ["Baixo", "#2fb344"] : tx < .5 ? ["Moderado", "#d9a900"] : tx < 1 ? ["Elevado", "#f08a24"] : ["Alto", "#d62d20"]; }
const T_CRIT_1 = () => PARAMS.T_CRIT / 100;

function trechosCriticos(r, B) {                 // sequências de amostras com risco >= T_CRIT
  const T = T_CRIT_1(), brutos = []; let cur = null;
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
  const n = r.samples.length; let soma = 0, sem = 0, confS = 0; const ciclo = [0, 0, 0], porF = new Map();
  r.samples.forEach(s => {
    const p = riscoAmostra(s, B); soma += p;
    if (s.fid < 0 || B.pct[s.fid] <= 0) sem++; else confS += B.conf[s.fid];
    if (s.fid >= 0) porF.set(s.fid, (porF.get(s.fid) || 0) + 1);
    if (s.ciclo >= 0) ciclo[s.ciclo]++;
  });
  let cw = 0, ca = 0; const veic = new Int32Array(NV);
  const hot = [...porF.entries()].map(([f, c]) => { cw += B.cw[f]; ca += B.ca[f]; for (let v = 0; v < NV; v++) veic[v] += B.cwv[f * NV + v];
    return {f, m: c * STEP, pct: B.pct[f], dens: B.dens[f], tend: B.tend[f], conf: B.conf[f], cw: B.cw[f], ca: B.ca[f]}; })
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
  // banda de incerteza: cresce com a fração de trajeto sem registro/confiança baixa E com a
  // amostra temporal (marcar poucos anos do histórico deixa a estimativa da TAXA ANUAL menos
  // confiável — o NÍVEL não muda com os anos, mas a largura do ± sim).
  const frSem = n ? sem / n : 0, confMedia = n ? confS / (n - sem || 1) : 0;
  const fa = FR_AMOSTRA();
  const incerteza = Math.round(100 * frSem * (1 - confMedia) * 0.6 + 100 * frSem * 0.25 + 12 * (1 - fa));
  return {score: scoreExp, scoreMed, sem: frSem, confMedia, incerteza, ciclo: ciclo.map(c => c / n), cw, ca, veic, hot,
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
const riscoAresta = (f, P, B) => (f >= 0 && B.pct[f] > 0) ? B.pct[f] : Math.max(0, Math.min(1, P.incerto));
function fatores(P, B, evitar) {                  // fator de custo por aresta
  const E = EU.length, F = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const c = EC[e], w = W_CICLO[c] * P.ciclo, f = EF[e];
    const r = riscoAresta(f, P, B);                                    // sem registro = incerto, não seguro
    // proteção cicloviária com o MESMO PARAMS.PROT da avaliação no mapa — roteador e nota
    // passam a concordar sobre o que significa "estar numa ciclovia".
    let x = 1 + P.risco * r * (1 - Math.max(0.6, PARAMS.PROT) * w);
    if (c === 0) { if (ET[e] === 2) x *= 1 + P.arterial; else if (ET[e] === 1) x *= 1 + P.arterial / 3; }
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
function arcosParaPontos(arcs) {
  const pts = [];
  arcs.forEach(a => { const e = a >> 1, dir = a & 1, de = dir ? EV[e] : EU[e];
    pts.push([NLAT[de], NLON[de]]);
    const it = interior(e); (dir ? it.slice().reverse() : it).forEach(p => pts.push(p)); });
  if (arcs.length) { const a = arcs[arcs.length - 1], para = (a & 1) ? EU[a >> 1] : EV[a >> 1]; pts.push([NLAT[para], NLON[para]]); }
  return pts;
}
function comprimentoArcos(arcs) { let m = 0, art = 0; arcs.forEach(a => { const e = a >> 1; m += EL[e]; if (ET[e] === 2 && EC[e] === 0) art += EL[e]; }); return {m, art}; }

function rotearPontos(wps, F) {                   // waypoints [[lat,lon],...] -> {pts, m, art}
  const nos = wps.map(p => snapNo(p[0], p[1]));
  if (nos.some(n => n < 0)) return {erro: "Um dos pontos está a mais de 300 m de qualquer via do grafo de bicicleta."};
  let pts = [wps[0]], m = 0, art = 0;
  for (let i = 0; i + 1 < nos.length; i++) {
    if (nos[i] === nos[i+1]) continue;
    const c = melhorCaminho(nos[i], nos[i+1], F);
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

// ---------------------------------------------------------------- desvio de trechos críticos
function sugerirDesvio(r) {
  if (!TEM_GRAFO) { aviso("Grafo de bicicleta ausente: rode `samu-risco geodados` e gere o HTML de novo."); return; }
  const B = baseDe(r.jan), R = avaliar(r, B);
  if (!R.crit.length) { aviso("Nenhum trecho de risco alto (≥ " + PARAMS.T_CRIT + ") nesta rota."); return; }
  const S = r.samples; let pts = [], ultimo = 0; const trocas = [];
  for (const c of R.crit.slice().sort((a, b) => a.i0 - b.i0)) {
    const i0 = Math.max(c.i0 - 1, 0), i1 = Math.min(c.i1 + 1, S.length - 1);
    if (i0 < ultimo) continue;
    const na = snapNo(S[i0].lat, S[i0].lon, 150), nb = snapNo(S[i1].lat, S[i1].lon, 150);
    if (na < 0 || nb < 0 || na === nb) continue;
    const cam = melhorCaminho(na, nb, fatores(PLAN, B, c.fids));
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
function desenhar(r, B) {
  const c = CAMADAS.rotas, o = x => Object.assign({pane: "p_rotas", renderer: c.rend, interactive: false, lineCap: "round"}, x);
  L.polyline(r.samples.map(s => [s.lat, s.lon]), o({color: r.cor, weight: 10, opacity: .8})).addTo(c.grp);
  let cur = null, run = [];
  const flush = () => { if (run.length > 1) L.polyline(run, o({color: cur.c, weight: 5, opacity: 1})).addTo(c.grp); };
  r.samples.forEach(s => {
    const p = riscoAmostra(s, B), col = corRisco(p);   // sem registro aparece como INCERTO (marrom), não cinza
    if (!cur || cur.c !== col || cur.f !== s.fid) { if (run.length) run.push([s.lat, s.lon]); flush(); cur = {c: col, f: s.fid}; run = [[s.lat, s.lon]]; }
    else run.push([s.lat, s.lon]);
  });
  flush();
  if (r.desvio) L.polyline(r.desvio.rota.samples.map(s => [s.lat, s.lon]), o({color: "#8e24aa", weight: 5, opacity: .95, dashArray: "9 8"})).addTo(c.grp);
}
const f1 = x => (100 * x).toFixed(0) + "%";
function quando(r) {
  return r.t0 !== null && r.t1 !== null && r.ini ? hhmm(r.ini) + "–" + hhmm(r.fim) + " (" + r.dia + ")" + (r.dur > 0 ? " · " + (r.dist / 1000 / (r.dur / 3600)).toFixed(1) + " km/h" : "") : "sem horário no arquivo";
}
const ORIGEM_TXT = {gpx: "GPX", planejada: "planejada", desvio: "desvio", biblioteca: "biblioteca", importada: "importada"};
function blocoRota(r, R, B) {
  const [lbl, cl] = nivel(R.score);
  const cic = R.ciclo.reduce((a, b) => a + b, 0), temC = D.ciclo.feats.length > 0;
  const ct = temC ? (cic > 0 ? f1(Math.min(1, cic)) + " do trajeto em infraestrutura cicloviária (" + R.ciclo.map((c, i) => D.ciclo.classes[i].toLowerCase() + " " + f1(c)).join(", ") + ")" : "nenhum trecho sobre infraestrutura cicloviária mapeada") : "ciclovias indisponíveis neste mapa";
  const vt = R.veic.reduce((a, b) => a + b, 0);
  const vtxt = vt ? [...R.veic].map((v, i) => [D.veic[i], v]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0] + " " + x[1]).join(" · ") : "–";
  const hot = R.hot.length ? "<ul>" + R.hot.map(h => { const p = D.geo.features[h.f].properties;
    const tt = h.tend > 1.05 ? " \u2191 em alta" : h.tend < .95 ? " \u2193 em queda" : "";
    return "<li><b>" + esc(p.n) + "</b>" + (p.b ? " (" + esc(p.b.toLowerCase()) + ")" : "") + " — " + h.m + " m no trajeto · " + h.cw + " no horário / " + h.ca + " no total"
      + " · <span class=\"mut\" title=\"taxa ANUAL esperada de ocorrências por km (atropelamento pesa " + PARAMS.W_ATR + "x um acidente), suavizada com a média da cidade; seta = tendência recente\">" + h.dens.toFixed(1) + " occ-anuais/km" + tt + "</span>"
      + " · <span class=\"mut\" title=\"confiança proporcional ao comprimento observado da via: vias curtas/pouco observadas ficam próximas da média\">" + f1(h.conf) + " de confiança</span></li>"; }).join("") + "</ul>" : " nenhum registrado";
  const dopts = Object.entries(DIAS_TXT).map(([k, v]) => '<option value="' + k + '"' + (r.jan.dias === k ? " selected" : "") + ">" + v + "</option>").join("");
  const sopts = ["", "ida", "volta", "outro"].map(k => '<option value="' + k + '"' + (r.sentido === k ? " selected" : "") + ">" + (k || "sentido…") + "</option>").join("");
  const avisoSem = R.sem >= .3 ? '<div class="aviso-lac">' + f1(R.sem) + " do trajeto está em vias sem ocorrências registradas (avaliadas como incertas, com valor " + PARAMS.INCERTO + "). " + AVISO_LACUNAS + "</div>" : "";
  const extraArt = r.meta && r.meta.arterialM > 50 ? "<br>• " + Math.round(r.meta.arterialM) + " m em via arterial sem infraestrutura cicloviária" : "";
  const crit = R.crit.length ? "<br>• Trechos críticos (risco ≥ " + PARAMS.T_CRIT + "): " + R.crit.map(c => (c.m) + " m (" + [...c.fids].map(f => esc(D.geo.features[f].properties.n)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(", ") + ")").join("; ") : "";
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
    '<div style="font-size:13px">• ' + ct + "<br>• " + f1(R.sem) + " do trajeto sem ocorrências registradas nas vias<br>• Nas vias percorridas: <b>" + R.cw + "</b> ocorrências no horário (" + R.ca + " no dia todo)<br>• Veículos (no horário): " + vtxt + extraArt + crit + "<br>• Trechos de maior risco:" + hot + "</div>" +
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
// aparece no mapa na posição correspondente da rota, rotulado com a via daquele ponto — e
// some ao tirar o cursor. Os listeners vão no WRAPPER .chartbox (não no canvas): é ele quem
// recebe os eventos de mouse; listener só no canvas não disparava em muitos navegadores.
let hoverMarc = null, hoverRes = [];
function removerHover() { if (hoverMarc) { MAPA.removeLayer(hoverMarc); hoverMarc = null; } }
function marcarHover(pos, nome, pct) {
  if (!pos) { removerHover(); return; }
  const cor = corRisco(Math.max(0, Math.min(1, (pct || 0) / 100)));
  const icone = L.divIcon({className: "hover-marc", iconSize: [18, 18], iconAnchor: [9, 9],
    html: "<span style='background:" + cor + "'></span>" + (nome ? "<i>" + esc(nome) + "</i>" : "")});
  if (hoverMarc) { hoverMarc.setIcon(icone); hoverMarc.setLatLng(pos); }
  else hoverMarc = L.marker(pos, {icon: icone, interactive: false, pane: "p_rotas", keyboard: false}).addTo(MAPA);
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
  const nome = s && s.fid >= 0 ? D.geo.features[s.fid].properties.n : "";
  marcarHover(posAmostra(alvo.r, i), nome, alvo.R.perfil[i]);
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
  $("rotas").innerHTML = rotas.map((r, i) => '<div class="rt"><span class="sw" style="background:' + r.cor + '"></span><span class="nm" data-z="' + i + '" title="' + esc(r.nome) + '">' + esc(r.nome) + '</span><button data-x="' + i + '" title="remover da análise">×</button></div>').join("");
  $("rotas").querySelectorAll("[data-z]").forEach(el => el.onclick = () => MAPA.fitBounds(L.latLngBounds(rotas[+el.dataset.z].pts).pad(.1)));
  $("rotas").querySelectorAll("[data-x]").forEach(el => el.onclick = () => { const r = rotas[+el.dataset.x]; rotas.splice(+el.dataset.x, 1); if (r.id === "plano") { wps = []; desenharWps(); } atualizarRotas(); });
}
function atualizarRotas() {
  BC = new Map();
  CAMADAS.rotas.grp.clearLayers(); renderListaRotas();
  const box = $("risco"); box.classList.toggle("vazio", !rotas.length);
  if (!rotas.length) return;
  const res = rotas.map(r => { const B = baseDe(r.jan), R = avaliar(r, B); desenhar(r, B); return {r, R, B}; });
  $("comp").innerHTML = tabelaComparativa(res);
  atualizarPerfil(res);
  $("riscoCorpo").innerHTML = res.map(({r, R, B}) => blocoRota(r, R, B)).join("") + '<p class=\u0022nota\u0022>O índice (0–100) é a taxa ANUAL esperada de ocorrências do SAMU por km em cada via — o número de anos selecionados NÃO altera o nível (a métrica é uma taxa por ano, não um somatório; marcar menos anos apenas alarga a banda ± de incerteza amostral); ponderada por gravidade: atropelamento vale ' + PARAMS.W_ATR + '× um acidente; suavizada pela média da cidade com força proporcional ao comprimento observado da via (bayesiano, κ≈' + (riscoBase._k || PARAMS.KAPPA) + ' km-pseudo — atua só sobre a confiança, nunca empurrando avenidas longas de volta à média) e convertida numa escala estável (100 ≈ ' + ((riscoBase._anc ?? PARAMS.R_MAX) * PARAMS.SAT).toFixed(1) + ' ocorrências anuais/km, ancorada nas vias mais críticas da rede inteira, fixável em PARAMS.R_REF), reduzida pela proteção cicloviária (ciclovia/ciclofaixa: até −' + Math.round(PARAMS.PROT * 100) + '%) e ponderada pelo tempo de exposição (velocidade local estimada do GPX; sem horários, assume-se ' + PARAMS.V_BIKE + ' km/h). Vias sem registro recebem o valor \u201cincerto\u201d (' + PARAMS.INCERTO + '), o mesmo usado pelo roteador — não são consideradas seguras. O ± cresce com a fração do trajeto sem registros/confiança baixa e com a amostra temporal escolhida. Usa os filtros do risco (ano, veículo, natureza). É uma medida comparativa, não uma probabilidade: as chamadas do SAMU são localizadas pelo nome da via (não pelo ponto exato) e não há dado de volume de tráfego nem de quilometragem pedalada. ' + AVISO_LACUNAS + '</p>';
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
  rotas.push(r);
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
["h1", "h2", "dias"].forEach(id => $(id).onchange = () => { if (wps.length >= 2) recalcularPlano(); });
["dragover", "dragenter"].forEach(t => document.body.addEventListener(t, e => { e.preventDefault(); $("map").classList.add("drop"); }));
["dragleave", "drop"].forEach(t => document.body.addEventListener(t, e => { e.preventDefault(); $("map").classList.remove("drop"); }));
document.body.addEventListener("drop", e => { if (e.dataTransfer && e.dataTransfer.files) lerArquivos(e.dataTransfer.files); });
renderLib();
// ganchos para testes automatizados
window.__gpx = adicionarTexto;
window.__rotas = {get lista() { return rotas; }, PLAN, PARAMS, TEM_GRAFO, baseDe, avaliar, hoverEm, marcarHover, removerHover, get hoverMarc() { return hoverMarc; }, ativarPlano, addWp: ll => { wps.push(ll); recalcularPlano(); }, sugerirDesvio, aplicarDesvio, salvarNaBiblioteca, renderLib, exportar, importar, Lib, gpxDe, lerGpx, empacotarZip, empacotarTar, empacotarTgz, atualizarRotas};

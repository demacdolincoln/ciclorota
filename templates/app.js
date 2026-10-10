(async function () {
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// =====================================================================
// 1. DADOS (gzip+base64 ou JSON) e decodificação das geometrias
// =====================================================================
async function carregarDados() {
  const el = $("dados"), txt = el.textContent.trim();
  let out;
  if (el.dataset.enc === "json") out = txt;
  else {
    const bin = Uint8Array.from(atob(txt), c => c.charCodeAt(0));
    out = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }
  el.remove();
  return JSON.parse(out);
}
let D;
try { D = await carregarDados(); }
catch (e) { document.body.insertAdjacentHTML("afterbegin", '<p style="padding:20px">Não foi possível ler os dados ('+esc(e.message)+'). Use um navegador atualizado.</p>'); return; }

function decLinhas(partes) {                       // [x0,y0,dx,dy,...] (graus*1e5) -> [[lon,lat],...]
  return partes.map(a => { const o = [[a[0]/1e5, a[1]/1e5]]; let x = a[0], y = a[1];
    for (let i = 2; i < a.length; i += 2) { x += a[i]; y += a[i+1]; o.push([x/1e5, y/1e5]); } return o; });
}
function geom(partes) {
  const l = decLinhas(partes);
  return l.length === 1 ? {type:"LineString", coordinates:l[0]} : {type:"MultiLineString", coordinates:l};
}
D.geo.features.forEach(f => { f.type = "Feature"; f.geometry = geom(f.g); });
D.ciclo.feats.forEach(f => { f.geometry = geom(f.g); });

const NV = D.veic.length, NF = D.geo.features.length;
const FR = D.geo.features.map(f => f.properties.r);
const KM = D.geo.features.map(f => f.properties.km);
const COR_V = ["#e4572e", "#2e86ab", "#3fa34d", "#7a4fa3"];

// =====================================================================
// 2. FILTROS (Panorama: S; Minha rota: SR)
// =====================================================================
const idx = a => a.map((_, i) => i);
const GRUPOS = [
  ["ano", "Ano", D.anos, idx(D.anos), 10],
  ["veic", "Veículo", D.veic, idx(D.veic), 1],
  ["nat", "Natureza", D.nat, idx(D.nat), 2],
  ["mes", "Mês", D.meses, D.meses_ok, 3],
  ["dow", "Dia da semana", D.dias, [0,1,2,3,4,5,6], 4],
  ["per", "Período do dia", D.per, idx(D.per), 6],
  ["sexo", "Sexo", D.sexo, idx(D.sexo), 7],
  ["faixa", "Faixa etária", D.faixa, idx(D.faixa), 8],
];
const GRUPOS_ROTA = GRUPOS.filter(g => ["ano", "veic", "nat"].includes(g[0]));
const S = {}, SR = {};
let bairroSel = -1;
const ANOS_PADRAO = (D.anos_padrao && D.anos_padrao.length) ? D.anos_padrao : idx(D.anos);
function resetEstado() {
  GRUPOS.forEach(g => { const ini = g[0] === "ano" ? ANOS_PADRAO : g[3]; S[g[0]] = new Set(ini); SR[g[0]] = new Set(ini); });
  bairroSel = -1;
}
resetEstado();

function montarChips(box, grupos, E, cb) {
  box.innerHTML = "";
  grupos.forEach(([k, rot, lbls, vals]) => {
    const d = document.createElement("div"); d.className = "grp";
    d.innerHTML = "<b>" + rot + "</b>";
    const c = document.createElement("div"); c.className = "chips"; d.appendChild(c);
    vals.forEach(v => {
      const b = document.createElement("button"); b.className = "chip" + (E[k].has(v) ? " on" : ""); b.textContent = lbls[v];
      b.dataset.k = k; b.dataset.v = v;
      b.onclick = () => {
        const s = E[k];
        if (s.size === vals.length) { s.clear(); s.add(v); }
        else if (s.has(v)) { s.delete(v); if (!s.size) vals.forEach(x => s.add(x)); }
        else s.add(v);
        c.querySelectorAll(".chip").forEach(x => x.classList.toggle("on", s.has(+x.dataset.v)));
        cb();
      };
      c.appendChild(b);
    });
    box.appendChild(d);
  });
}
function montarFiltros() {
  montarChips($("filtros"), GRUPOS, S, update);
  montarChips($("filtrosRota"), GRUPOS_ROTA, SR, atualizarRotas);
  if (D.aviso_anos) ["filtros", "filtrosRota"].forEach(id => {
    const h = document.createElement("p"); h.className = "hint"; h.textContent = D.aviso_anos; $(id).children[0].appendChild(h);
  });
  const sel = $("bairro");
  sel.innerHTML = '<option value="-1">Todos</option>' + D.bairros.map((b, i) => '<option value="'+i+'">'+esc(b)+'</option>').join("");
  sel.onchange = () => { bairroSel = +sel.value; update(); };
}
$("reset").onclick = () => { resetEstado(); montarFiltros(); update(); };

// =====================================================================
// 3. MAPA, BASES, CAMADAS (panes = ordem; opacidade por pane)
// =====================================================================
const MAPA = L.map("map", {zoomControl: true}).setView([-8.05, -34.92], 12);
MAPA.attributionControl.addAttribution("Dados: Prefeitura do Recife, SAMU, © OpenStreetMap contributors (ODbL)");
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const BASES = {
  osm:    {nome: "OpenStreetMap", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attr: "© OpenStreetMap contributors", max: 19},
  claro:  {nome: "Cinza claro (Esri)", url: ESRI + "Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", attr: "Tiles © Esri", max: 16},
  escuro: {nome: "Cinza escuro (Esri)", url: ESRI + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", attr: "Tiles © Esri", max: 16},
  sat:    {nome: "Satélite (Esri)", url: ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", attr: "Tiles © Esri", max: 19},
  nenhum: {nome: "Nenhum (somente base vetorial)"},
};
let baseAtual = null, tileLayer = null;
function aviso(txt) { const a = $("aviso"); a.textContent = txt; a.hidden = !txt; if (txt) setTimeout(() => { a.hidden = true; }, 9000); }
function trocarBase(id, salvar = true) {
  if (tileLayer) { MAPA.removeLayer(tileLayer); tileLayer = null; }
  baseAtual = id; const b = BASES[id];
  if (b.url) {
    let ok = 0, erros = 0;
    tileLayer = L.tileLayer(b.url, {attribution: b.attr, maxZoom: b.max});
    tileLayer.on("tileload", () => { ok++; });
    tileLayer.on("tileerror", () => {
      erros++;
      if (ok === 0 && erros >= 6 && baseAtual === id) {
        aviso("Sem acesso aos mapas de fundo (offline?). Usando a base vetorial embutida.");
        mostrar("malha", true); mostrar("bairros", true); trocarBase("nenhum"); montarPainel();
      }
    });
    tileLayer.addTo(MAPA);
  }
  $("mapwrap").classList.toggle("sem-base", id === "nenhum");
  if (salvar) salvarCfg();
}

const CAMADAS = {};
const DEF = [   // ordem inicial, de baixo para cima
  ["bairros", "Limites de bairros", "#8a97a6"],
  ["malha", "Malha viária (base vetorial)", "#aab4bf"],
  ["ciclo2", "Faixa compartilhada", "#7fcf8a"],
  ["ciclo1", "Ciclofaixa", "#2fb344"],
  ["ciclo0", "Ciclovia / via exclusiva", "#0a8f3c"],
  ["vias", "Vias por ocorrência", "#d62d20"],
  ["calor", "Mapa de calor", "#f08a24"],
  ["sem", "Semáforos", "#7a1fa2"],
  ["para", "Paraciclos", "#0b6bcb"],
  ["rotas", "Rotas (GPX)", "#1f3a93"],
];
let ORDEM = [];
DEF.forEach(([id, nome, cor]) => {
  const classe = id.startsWith("ciclo") ? +id.slice(5) : -1;
  if (classe >= 0 && !D.ciclo.feats.some(f => f.c === classe)) return;
  MAPA.createPane("p_" + id);
  const rend = L.canvas({pane: "p_" + id, padding: .5});
  MAPA.addLayer(rend);
  if (id !== "vias" && rend._container) rend._container.style.pointerEvents = "none";   // só 'vias' recebe mouse
  CAMADAS[id] = {id, nome, cor, pane: MAPA.getPane("p_" + id), rend, grp: L.layerGroup(), vis: false, op: 1};
  ORDEM.push(id);
});
function aplicarOrdem() { ORDEM.forEach((id, i) => { CAMADAS[id].pane.style.zIndex = 410 + i * 5; }); }
function pOpts(id, extra) { return Object.assign({pane: "p_" + id, renderer: CAMADAS[id].rend, interactive: false}, extra); }

// -- camadas estáticas
const CIC_EST = [{color: "#0a8f3c", weight: 4}, {color: "#2fb344", weight: 3}, {color: "#7fcf8a", weight: 3, dashArray: "6 6"}];
D.ciclo.feats.forEach(f => {
  const id = "ciclo" + f.c;
  L.geoJSON({type: "Feature", properties: {}, geometry: f.geometry},
            Object.assign(pOpts(id), {style: Object.assign({opacity: .95}, CIC_EST[f.c])})).addTo(CAMADAS[id].grp);
  CAMADAS[id].cor = CIC_EST[f.c].color;
});
if (D.base) {
  const linhas = (partes, estilo, id) => L.polyline(decLinhas(partes).map(l => l.map(p => [p[1], p[0]])), pOpts(id, estilo));
  if (D.base.bairros.length) linhas(D.base.bairros, {color: "#8a97a6", weight: 1.2, dashArray: "4 4", opacity: .9}, "bairros").addTo(CAMADAS.bairros.grp);
  if (D.base.vias[1].length) linhas(D.base.vias[1], {color: "#c9d0d7", weight: .8, opacity: .9}, "malha").addTo(CAMADAS.malha.grp);
  if (D.base.vias[0].length) linhas(D.base.vias[0], {color: "#98a3ae", weight: 1.8, opacity: .95}, "malha").addTo(CAMADAS.malha.grp);
}
const PT = D.pontos || {semaforos: [], paraciclos: []};
[["sem", "semaforos", "#7a1fa2"], ["para", "paraciclos", "#0b6bcb"]].forEach(([id, k, cor]) => {
  PT[k].forEach(p => L.circleMarker(p, pOpts(id, {radius: 3, color: cor, weight: 1, fillOpacity: .7})).addTo(CAMADAS[id].grp));
});

function mostrar(id, v) {
  const c = CAMADAS[id]; if (!c) return; c.vis = v;
  if (id === "calor") desenharCalor();
  else if (v) MAPA.addLayer(c.grp); else MAPA.removeLayer(c.grp);
}
function opacidade(id, o) { const c = CAMADAS[id]; c.op = o; c.pane.style.opacity = o; }

// -- perfis por aba (visibilidade, opacidade e ordem)
const offline = typeof navigator !== "undefined" && navigator.onLine === false;
function perfilPadrao(aba) {
  const vis = {bairros: offline, malha: offline, ciclo0: true, ciclo1: true, ciclo2: true, vias: true, calor: false, sem: false, para: false, rotas: true};
  const op = Object.fromEntries(ORDEM.map(id => [id, 1]));
  if (aba === "rota") op.vias = .35;
  return {ordem: DEF.map(d => d[0]).filter(id => CAMADAS[id]), vis, op};
}
let perfis = {panorama: perfilPadrao("panorama"), rota: perfilPadrao("rota")};
let aba = null;
const EST = {pal: "quente", esp: 1, raio: 20, desf: 22, porKm: false};
function capturar() { return {ordem: [...ORDEM], vis: Object.fromEntries(ORDEM.map(id => [id, CAMADAS[id].vis])), op: Object.fromEntries(ORDEM.map(id => [id, CAMADAS[id].op]))}; }
function aplicarPerfil(p) {
  ORDEM = p.ordem.filter(id => CAMADAS[id]).concat(Object.keys(CAMADAS).filter(id => !p.ordem.includes(id)));
  aplicarOrdem();
  ORDEM.forEach(id => { opacidade(id, p.op[id] ?? 1); mostrar(id, !!p.vis[id]); });
}

// -- persistência (opcional)
const CHAVE = "samu_risco_cfg_v1";
function salvarCfg() {
  try { if (aba) perfis[aba] = capturar(); localStorage.setItem(CHAVE, JSON.stringify({base: baseAtual, est: EST, perfis})); } catch (e) {}
}
function carregarCfg() {
  try { const c = JSON.parse(localStorage.getItem(CHAVE) || "null"); if (c) { Object.assign(EST, c.est || {}); if (c.perfis) perfis = c.perfis; return c.base; } } catch (e) {}
  return null;
}

// -- painel de camadas
const PAL = {quente: [[255,226,80],[245,130,32],[198,40,40]], viridis: [[68,1,84],[33,145,140],[253,231,37]], azul: [[198,219,239],[66,146,198],[8,48,107]]};
function cor(t) {
  const s = PAL[EST.pal], x = Math.max(0, Math.min(1, t)) * (s.length - 1), i = Math.min(s.length - 2, Math.floor(x)), f = x - i;
  return "rgb(" + s[i].map((v, k) => Math.round(v + (s[i+1][k] - v) * f)).join(",") + ")";
}
let painelFechado = typeof window !== "undefined" && window.innerWidth < 700;
function montarPainel() {
  const p = $("camadas");
  p.className = "painel" + (painelFechado ? " fechado" : "");
  const lista = [...ORDEM].reverse().map((id, i) => {
    const c = CAMADAS[id];
    return '<div class="lr" data-id="'+id+'"><input type="checkbox" '+(c.vis ? "checked" : "")+' data-a="vis">'+
      '<span class="sw" style="border-color:'+c.cor+'"></span><span class="nm" title="'+esc(c.nome)+'">'+esc(c.nome)+'</span>'+
      '<span><button data-a="up" title="trazer para frente"'+(i === 0 ? " disabled" : "")+'>▲</button><button data-a="dn" title="enviar para trás"'+(i === ORDEM.length - 1 ? " disabled" : "")+'>▼</button></span>'+
      '<div class="ctl"><input type="range" min="0" max="1" step=".05" value="'+c.op+'" data-a="op" title="opacidade"></div></div>';
  }).join("");
  p.innerHTML =
    '<div class="cab" id="cab"><span>Camadas e estilo</span><span>'+(painelFechado ? "▾" : "▴")+'</span></div><div class="corpo">'+
    '<div class="sec" style="border:0;margin:0;padding:0"><b>Mapa de fundo</b><select id="selBase">'+
      Object.entries(BASES).map(([k, b]) => '<option value="'+k+'"'+(k === baseAtual ? " selected" : "")+'>'+b.nome+'</option>').join("")+'</select></div>'+
    '<div class="sec"><b>Camadas (topo = frente)</b>'+lista+'</div>'+
    '<div class="sec"><b>Estilo dos dados</b>'+
      '<label>Paleta <select id="selPal">'+Object.keys(PAL).map(k => '<option'+(k === EST.pal ? " selected" : "")+'>'+k+'</option>').join("")+'</select></label>'+
      '<label>Espessura <input type="range" id="rEsp" min=".5" max="2.5" step=".1" value="'+EST.esp+'"></label>'+
      '<label>Calor: raio <input type="range" id="rRaio" min="8" max="40" value="'+EST.raio+'"></label>'+
      '<label>Calor: desfoque <input type="range" id="rDesf" min="5" max="40" value="'+EST.desf+'"></label>'+
      '<label><input type="checkbox" id="cKm"'+(EST.porKm ? " checked" : "")+'> Cor por ocorrências/km</label></div>'+
    '<div class="sec"><button class="mini" id="bPad">Restaurar padrão desta aba</button></div></div>';
  L.DomEvent.disableClickPropagation(p); L.DomEvent.disableScrollPropagation(p);
  $("cab").onclick = () => { painelFechado = !painelFechado; montarPainel(); };
  $("selBase").onchange = e => trocarBase(e.target.value);
  p.querySelectorAll(".lr").forEach(row => {
    const id = row.dataset.id;
    row.querySelector('[data-a="vis"]').onchange = e => { mostrar(id, e.target.checked); salvarCfg(); };
    row.querySelector('[data-a="op"]').oninput = e => { opacidade(id, +e.target.value); salvarCfg(); };
    row.querySelector('[data-a="up"]').onclick = () => mover(id, 1);
    row.querySelector('[data-a="dn"]').onclick = () => mover(id, -1);
  });
  $("selPal").onchange = e => { EST.pal = e.target.value; update(); salvarCfg(); };
  $("rEsp").oninput = e => { EST.esp = +e.target.value; update(); };
  $("rEsp").onchange = salvarCfg;
  $("rRaio").oninput = e => { EST.raio = +e.target.value; desenharCalor(); };
  $("rDesf").oninput = e => { EST.desf = +e.target.value; desenharCalor(); };
  $("rRaio").onchange = $("rDesf").onchange = salvarCfg;
  $("cKm").onchange = e => { EST.porKm = e.target.checked; update(); salvarCfg(); };
  $("bPad").onclick = () => { perfis[aba] = perfilPadrao(aba); aplicarPerfil(perfis[aba]); montarPainel(); update(); salvarCfg(); };
}
function mover(id, d) {
  const i = ORDEM.indexOf(id), j = i + d;
  if (j < 0 || j >= ORDEM.length) return;
  [ORDEM[i], ORDEM[j]] = [ORDEM[j], ORDEM[i]];
  aplicarOrdem(); montarPainel(); salvarCfg();
}

// =====================================================================
// 4. PANORAMA: vias por ocorrência, calor, KPIs, gráficos, ranking
// =====================================================================
const cnt = new Int32Array(NF);
let RUA_TOT = new Int32Array(D.ruas.length);
const LAY = D.geo.features.map((f, i) => {
  const l = L.geoJSON(f, {pane: "p_vias", renderer: CAMADAS.vias.rend, style: {weight: 3, color: "#c00"}});
  l.bindTooltip(() => {
    const p = f.properties, tot = RUA_TOT[p.r] || 0;
    return "<b>" + esc(p.n) + "</b>" + (p.b ? " (" + esc(p.b.toLowerCase()) + ")" : "") + "<br>" + cnt[i] + " neste trecho · " + tot + " na via";
  }, {sticky: true});
  return l;
});
const LR = D.ruas.map(() => []);
FR.forEach((r, i) => LR[r].push(i));
if (NF) { const b = L.featureGroup(LAY).getBounds(); if (b.isValid()) MAPA.fitBounds(b.pad(.05)); }

let ULT = {pts: [], cmax: 1}, heat = null;
function desenharCalor() {
  const c = CAMADAS.calor;
  // o leaflet.heat remove o canvas do overlayPane: devolve-o antes de descartar a camada
  if (heat && heat._canvas) MAPA.getPane("overlayPane").appendChild(heat._canvas);
  c.grp.clearLayers(); heat = null;
  if (c.vis && L.heatLayer && ULT.pts.length) {
    heat = L.heatLayer(ULT.pts.map(i => [D.geo.features[i].properties.c[0], D.geo.features[i].properties.c[1], cnt[i] / ULT.cmax]),
                       {radius: EST.raio, blur: EST.desf, max: 1, minOpacity: .3});
    c.grp.addLayer(heat);
    if (heat._canvas) c.pane.appendChild(heat._canvas);
  }
  if (c.vis) MAPA.addLayer(c.grp); else MAPA.removeLayer(c.grp);
}

const chartOpts = {responsive: true, maintainAspectRatio: false, animation: false,
  scales: {x: {stacked: true}, y: {stacked: true, beginAtZero: true}}, plugins: {legend: {position: "bottom"}}};
const cMes = new Chart($("cMes"), {type: "bar", data: {labels: D.meses_ok.map(m => D.meses[m]),
  datasets: D.veic.map((v, i) => ({label: v, data: [], backgroundColor: COR_V[i]}))}, options: chartOpts});
const cHora = new Chart($("cHora"), {type: "bar", data: {labels: [...Array(24).keys()].map(h => h + "h"),
  datasets: D.veic.map((v, i) => ({label: v, data: [], backgroundColor: COR_V[i]}))}, options: chartOpts});

function passa(e) {
  return S.ano.has(e[10]) && S.veic.has(e[1]) && S.nat.has(e[2]) && S.mes.has(e[3]) && S.dow.has(e[4]) &&
         S.per.has(e[6]) && S.sexo.has(e[7]) && S.faixa.has(e[8]) && (bairroSel < 0 || e[9] === bairroSel);
}

function update() {
  const ev = D.ev.filter(passa);
  cnt.fill(0);
  RUA_TOT = new Int32Array(D.ruas.length);
  const ruaV = D.ruas.map(() => new Int32Array(NV));
  const mesV = D.meses_ok.map(() => new Int32Array(NV));
  const horaV = [...Array(24)].map(() => new Int32Array(NV));
  const hm = [...Array(7)].map(() => new Int32Array(24));
  const horaT = new Int32Array(24);
  const mpos = {}; D.meses_ok.forEach((m, i) => mpos[m] = i);
  let loc = 0;
  for (const e of ev) {
    if (e[0] >= 0) { loc++; cnt[e[0]]++; const r = FR[e[0]]; RUA_TOT[r]++; ruaV[r][e[1]]++; }
    mesV[mpos[e[3]]][e[1]]++; horaV[e[5]][e[1]]++; hm[e[4]][e[5]]++; horaT[e[5]]++;
  }

  // mapa: vias coloridas + insumo do calor
  let vmax = 0; const val = new Float64Array(NF);
  for (let i = 0; i < NF; i++) if (cnt[i] > 0) { val[i] = EST.porKm ? cnt[i] / Math.max(KM[i], 0.05) : cnt[i]; if (val[i] > vmax) vmax = val[i]; }
  const g = CAMADAS.vias.grp; g.clearLayers();
  const pts = []; let cmax = 1;
  for (let i = 0; i < NF; i++) if (cnt[i] > 0) {
    const t = Math.sqrt(val[i] / vmax);
    LAY[i].setStyle({color: cor(t), weight: (2.5 + 5 * t) * EST.esp, opacity: .92});
    g.addLayer(LAY[i]); pts.push(i); if (cnt[i] > cmax) cmax = cnt[i];
  }
  ULT = {pts, cmax}; desenharCalor();

  // KPIs
  $("k1").textContent = ev.length.toLocaleString("pt-BR");
  $("k2").textContent = ev.length ? loc.toLocaleString("pt-BR") + " (" + Math.round(100 * loc / ev.length) + "%)" : "–";
  let top = -1, tv = 0; RUA_TOT.forEach((v, i) => { if (v > tv) { tv = v; top = i; } });
  $("k3").textContent = top >= 0 ? D.ruas[top].n + " (" + tv + ")" : "–";
  let ph = -1, pv = 0; horaT.forEach((v, h) => { if (v > pv) { pv = v; ph = h; } });
  $("k4").textContent = ph >= 0 ? ph + "h–" + (ph + 1) + "h (" + pv + ")" : "–";

  // gráficos
  D.veic.forEach((_, v) => { cMes.data.datasets[v].data = mesV.map(a => a[v]); cHora.data.datasets[v].data = horaV.map(a => a[v]); });
  cMes.update(); cHora.update();

  // dia × hora
  let hmax = 1; hm.forEach(r => r.forEach(v => { if (v > hmax) hmax = v; }));
  let h = "<tr><th></th>" + [...Array(24).keys()].map(x => "<th>" + x + "</th>").join("") + "</tr>";
  hm.forEach((r, d) => {
    h += "<tr><th>" + D.dias[d] + "</th>" + Array.from(r).map((v, x) =>
      '<td title="' + D.dias[d] + " " + x + "h: " + v + '" style="background:rgba(192,57,43,' + (v / hmax).toFixed(2) + ')">' + (v || "") + "</td>").join("") + "</tr>";
  });
  $("hm").innerHTML = h;

  // ranking
  const ord = [...RUA_TOT.keys()].filter(i => RUA_TOT[i] > 0).sort((a, b) => RUA_TOT[b] - RUA_TOT[a]).slice(0, 30);
  const tb = $("rank").tBodies[0];
  tb.innerHTML = ord.map((r, k) => {
    let vm = 0; ruaV[r].forEach((v, i) => { if (v > ruaV[r][vm]) vm = i; });
    const km = D.ruas[r].km;
    return '<tr class="rk" data-r="' + r + '"><td>' + (k + 1) + "</td><td>" + esc(D.ruas[r].n) + '</td><td class="n">' + RUA_TOT[r] +
      '</td><td class="n">' + (km > 0 ? (RUA_TOT[r] / km).toFixed(1) : "–") + "</td><td>" + D.veic[vm] + " (" + ruaV[r][vm] + ")</td></tr>";
  }).join("");
  tb.querySelectorAll("tr.rk").forEach(tr => tr.onclick = () => {
    const b = L.featureGroup(LR[+tr.dataset.r].map(i => LAY[i])).getBounds();
    if (b.isValid()) { MAPA.fitBounds(b.pad(.3)); window.scrollTo({top: $("map").offsetTop - 60, behavior: "smooth"}); }
  });
  atualizarRotas();
}

/*@@ROTAS@@*/

// =====================================================================
// 6. ABAS e INICIALIZAÇÃO
// =====================================================================
function irAba(a) {
  if (aba) perfis[aba] = capturar();
  aba = a; document.body.dataset.aba = a;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === a));
  aplicarPerfil(perfis[a]); montarPainel();
  setTimeout(() => { MAPA.invalidateSize(); if (a === "panorama") { cMes.resize(); cHora.resize(); } }, 0);
  update(); salvarCfg();
}
document.querySelectorAll(".tab").forEach(t => t.onclick = () => irAba(t.dataset.tab));

const q = D.qual;
$("qual").textContent = q.localizadas.toLocaleString("pt-BR") + " de " + q.total.toLocaleString("pt-BR") +
  " ocorrências localizadas em via (" + Math.round(100 * q.localizadas / Math.max(q.total, 1)) + "%; " + q.fuzzy.toLocaleString("pt-BR") + " por aproximação de nome)";
const baseSalva = carregarCfg();
trocarBase(offline ? "nenhum" : (baseSalva && BASES[baseSalva] ? baseSalva : "osm"), false);
montarFiltros();
irAba("panorama");
window.__app = {S, SR, CAMADAS, irAba, trocarBase, mover, get ORDEM() { return ORDEM; }, get aba() { return aba; }};
})();

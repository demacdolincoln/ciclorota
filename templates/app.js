(async function () {
"use strict";
const $ = id => { const el = document.getElementById(id); if (!el) console.warn("elemento ausente no HTML: #" + id); return el; };
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
  var mw = document.getElementById("mapwrap");   // defensivo: não quebrar a troca de base se faltar o contêiner
  if (mw) mw.classList.toggle("sem-base", id === "nenhum");
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

// ganchos para rotas.js: ao ligar/desligar a camada "rotas", os grupos auxiliares
// (halos das rotas e trechos de risco interativos) acompanham a visibilidade.
window.__camExtra = {};
function mostrar(id, v) {
  const c = CAMADAS[id]; if (!c) return; c.vis = v;
  if (id === "calor") desenharCalor();
  else if (v) MAPA.addLayer(c.grp); else MAPA.removeLayer(c.grp);
  Object.values(window.__camExtra).forEach(f => { try { f(id, v); } catch (e) {} });
}
function opacidade(id, o) { const c = CAMADAS[id]; c.op = o; c.pane.style.opacity = o; }

// -- perfis por aba (visibilidade, opacidade e ordem)
// Contraste rota × incidências: no Panorama as vias aparecem com força total; na aba
// "Minha rota" TODAS as marcações de ocorrência recuam (op. .22) para o traço da rota
// sobressair — só os trechos do trajeto (desenhados por rotas.js em camada própria,
// op. 1) ficam com destaque. O usuário pode ajustar cada opacidade no menu de camadas.
const offline = typeof navigator !== "undefined" && navigator.onLine === false;
const OP_PANORAMA = {bairros: .9, malha: .85, ciclo0: .9, ciclo1: .85, ciclo2: .8, vias: 1, calor: 1, sem: .8, para: .8};
const OP_ROTA     = {bairros: .5, malha: .5,  ciclo0: .45, ciclo1: .4, ciclo2: .35, vias: .18, calor: .3, sem: .35, para: .35};
function perfilPadrao(aba) {
  const vis = {bairros: offline, malha: offline, ciclo0: true, ciclo1: true, ciclo2: true, vias: true, calor: false, sem: false, para: false, rotas: true};
  const op = Object.fromEntries(ORDEM.map(id => [id, (aba === "rota" ? OP_ROTA : OP_PANORAMA)[id] ?? 1]));
  return {ordem: DEF.map(d => d[0]).filter(id => CAMADAS[id]), vis, op};
}
let perfis = {panorama: perfilPadrao("panorama"), rota: perfilPadrao("rota")};
let aba = null;
const EST = {pal: "quente", esp: 1, raio: 20, desf: 22};
// No Panorama com rotas em análise, a camada de vias recua (mesma transparência da aba "Minha rota").
// opViasPan guarda a opacidade PRÓPRIA do Panorama para o perfil não ficar "contaminado" por esse recuo.
let opViasPan = null, opViasFade = null;
function capturar() {
  const p = {ordem: [...ORDEM], vis: Object.fromEntries(ORDEM.map(id => [id, CAMADAS[id].vis])), op: Object.fromEntries(ORDEM.map(id => [id, CAMADAS[id].op]))};
  if (opViasPan !== null && CAMADAS.vias.op === opViasFade) p.op.vias = opViasPan;   // se o usuário mexeu no controle, vale o valor dele
  return p;
}
function ajustarFundo() {
  if (aba !== "panorama") return;
  if (rotas.length) {
    if (opViasPan === null) opViasPan = CAMADAS.vias.op;
    const pr = perfis.rota && perfis.rota.op && perfis.rota.op.vias;
    opViasFade = pr != null ? pr : OP_ROTA.vias;
    opacidade("vias", opViasFade); OP_FATOR = .6;          // vias e classes recuam como na aba de rotas
  } else {
    if (opViasPan !== null) { opacidade("vias", opViasPan); opViasPan = null; opViasFade = null; }
    OP_FATOR = 1;
  }
}
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
function montarPainel() {
  const p = $("camadas");   // vive na subaba "Camadas e estilo" do painel esquerdo
  const lista = [...ORDEM].reverse().map((id, i) => {
    const c = CAMADAS[id];
    return '<div class="lr" data-id="'+id+'"><input type="checkbox" '+(c.vis ? "checked" : "")+' data-a="vis">'+
      '<span class="sw" style="border-color:'+c.cor+'"></span><span class="nm" title="'+esc(c.nome)+'">'+esc(c.nome)+'</span>'+
      '<span><button data-a="up" title="trazer para frente"'+(i === 0 ? " disabled" : "")+'>▲</button><button data-a="dn" title="enviar para trás"'+(i === ORDEM.length - 1 ? " disabled" : "")+'>▼</button></span>'+
      '<div class="ctl"><input type="range" min="0" max="1" step=".05" value="'+c.op+'" data-a="op" title="opacidade"></div></div>';
  }).join("");
  // reconstrói o conteúdo SEM remover o próprio contêiner nem seus listeners.
  // O menu não tem mais botão próprio de recolher: ele vive na aba "Camadas e estilo"
  // do painel esquerdo — a subaba e o botão "▸" de Filtros e rotas já o minimizam.
  p.innerHTML =
    '<div class="pcorpo corpo">'+
    '<div class="sec" style="border:0;margin:0;padding:0"><b>Mapa de fundo</b><select id="selBase">'+
      Object.entries(BASES).map(([k, b]) => '<option value="'+k+'"'+(k === baseAtual ? " selected" : "")+'>'+b.nome+'</option>').join("")+'</select></div>'+
    '<div class="sec"><b>Camadas (topo = frente)</b>'+lista+'</div>'+
    '<div class="sec"><b>Estilo dos dados</b>'+
      '<label>Paleta <select id="selPal">'+Object.keys(PAL).map(k => '<option'+(k === EST.pal ? " selected" : "")+'>'+k+'</option>').join("")+'</select></label>'+
      '<label>Espessura <input type="range" id="rEsp" min=".5" max="2.5" step=".1" value="'+EST.esp+'"></label>'+
      '<label>Calor: raio <input type="range" id="rRaio" min="8" max="40" value="'+EST.raio+'"></label>'+
      '<label>Calor: desfoque <input type="range" id="rDesf" min="5" max="40" value="'+EST.desf+'"></label>'+
    '</div>'+
    '<div class="sec"><b style="display:flex;align-items:center;justify-content:space-between">Painéis da tela'+
      '<span><button class="mini" id="bFecharTudo" title="Recolher todos os painéis e deixar só o mapa">− Recolher tudo</button> '+
      '<button class="mini" id="bAbrirTudo" title="Expandir todos os painéis">+ Expandir tudo</button></span></b></div>'+
    '<div class="sec"><button class="mini" id="bPad">Restaurar padrão desta aba</button></div></div>';
  L.DomEvent.disableClickPropagation(p); L.DomEvent.disableScrollPropagation(p);
  $("selBase").onchange = e => trocarBase(e.target.value);
  $("bFecharTudo").onclick = () => { fecharTudo(); montarPainel(); };
  $("bAbrirTudo").onclick = () => { abrirTudo(); montarPainel(); };
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
  $("bPad").onclick = () => { perfis[aba] = perfilPadrao(aba); aplicarPerfil(perfis[aba]); montarPainel(); update(); salvarCfg(); };
}
function mover(id, d) {
  const i = ORDEM.indexOf(id), j = i + d;
  if (j < 0 || j >= ORDEM.length) return;
  [ORDEM[i], ORDEM[j]] = [ORDEM[j], ORDEM[i]];
  aplicarOrdem(); montarPainel(); salvarCfg();
}

// =====================================================================
// 3b. RÉGUA ÚNICA POR QUANTIL (Panorama e Minha rota usam a mesma)
// =====================================================================
// Cada via×bairro com registro recebe um POSTO PERCENTIL (rank médio, que trata empates: como
// ~70% das vias têm 1 ocorrência, quantis simples colapsariam) e uma CLASSE:
//   0: abaixo do P50 | 1: P50–P75 | 2: P75–P90 | 3: P90–P97 | 4: P97+ (topo, estreito)
// Os cortes são recalculados a cada filtro; a legenda mostra os valores de cada classe.
const NCL = 5, QCORTES = [.50, .75, .90, .97];
const NOMES_CL = ["baixo", "moderado", "elevado", "alto", "crítico"];
const ESP_CL = [1.6, 2.6, 4, 5.6, 7.6];             // espessura por classe (px)
// Na aba "Minha rota" as marcações de ocorrência recuam ainda mais (multiplicador da
// opacidade por classe) para o traço da rota sobressair; no Panorama a régua fica intacta.
let OP_FATOR = 1;
const opClasse = k => Math.min(1, OP_CL_BASE[k] * OP_FATOR);
const OP_CL_BASE = [.5, .65, .82, .94, 1];          // opacidade por classe: baixas recuam, altas saltam
const PESO_CALOR = [.08, .2, .45, .75, 1];          // peso no mapa de calor por classe
const classeDeRank = pr => { let k = 0; while (k < QCORTES.length && pr >= QCORTES[k]) k++; return k; };
function rankQuantil(v) {                           // v: valor por feature (0 = sem registro)
  const n = v.length, pr = new Float32Array(n), cls = new Int8Array(n).fill(-1), idx = [];
  for (let i = 0; i < n; i++) if (v[i] > 0) idx.push(i);
  idx.sort((a, b) => v[a] - v[b]);
  const m = idx.length, gr = [], faixas = Array.from({length: NCL}, () => ({n: 0, min: Infinity, max: -Infinity}));
  for (let i = 0; i < m;) { let j = i; while (j + 1 < m && v[idx[j + 1]] - v[idx[i]] < 1e-9) j++; gr.push([i, j]); i = j + 1; }
  gr.forEach(([a, b]) => {
    const p = gr.length === 1 ? .25 : (a + (b - a + 1) / 2) / m;     // valor único: sem contraste → classe baixa
    const k = classeDeRank(p), F = faixas[k];
    for (let t = a; t <= b; t++) { pr[idx[t]] = p; cls[idx[t]] = k; }
    F.n += b - a + 1; F.min = Math.min(F.min, v[idx[a]]); F.max = Math.max(F.max, v[idx[b]]);
  });
  return {pr, cls, faixas, n: m};
}
const fmtV = x => (+x.toFixed(1)).toLocaleString("pt-BR");
const faixaTxt = F => F.min === F.max ? fmtV(F.min) : fmtV(F.min) + "–" + fmtV(F.max);

// =====================================================================
// 4. PANORAMA: vias por ocorrência, calor, KPIs, gráficos, ranking
// =====================================================================
const cnt = new Int32Array(NF);
let RUA_TOT = new Int32Array(D.ruas.length);
const LAY = D.geo.features.map((f, i) => {
  const p = f.properties;
  const l = L.geoJSON(f, {pane: "p_vias", renderer: CAMADAS.vias.rend, style: {weight: 3, color: "#c00"}});
  l.bindTooltip(() => {
    const tot = RUA_TOT[p.r] || 0;
    // classe e posto percentil do trecho no filtro atual (calculados em update(); antes disso, neutro)
    const k = ULT.cls ? ULT.cls[i] : -1;
    const clTxt = k >= 0 ? NOMES_CL[k] : "sem registro";
    const corCl = k >= 0 ? COR_RISCO[k] : "#9aa5b1";
    const topPct = (ULT.pr && ULT.pr[i] > 0) ? Math.max(1, Math.round(100 * (1 - ULT.pr[i]))) : null;
    // veículos e período mais frequentes neste trecho (do filtro atual), quando disponíveis
    let vtxt = "", ptxt = "";
    if (ULT.veic && ULT.veic[i]) {
      const vs = D.veic.map((n, k) => [n, ULT.veic[i][k]]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
      if (vs.length) vtxt = "<br>veículos: " + vs.slice(0, 3).map(x => x[0] + " " + x[1]).join(" · ");
    }
    if (ULT.per && ULT.per[i]) {
      const ps = D.per.map((n, k) => [n, ULT.per[i][k]]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
      if (ps.length) ptxt = " · mais no período " + ps[0][0].toLowerCase();
    }
    return "<b>" + esc(p.n) + "</b>" + (p.b ? " (" + esc(p.b.toLowerCase()) + ")" : "") +
      "<br>" + cnt[i] + " neste trecho · " + tot + " na via" +
      (tot && cnt[i] ? " · este trecho concentra " + Math.round(100 * cnt[i] / tot) + "% da via" : "") +
      "<br><span style='color:" + corCl + "'>■</span> classe <b>" + clTxt + "</b>" +
      (topPct ? " · top " + topPct + "% dos trechos com registro" : "") + ptxt +
      (topPct && topPct <= 10 ? "<br>⚠ destaque: via de maior incidência (classe alta ou crítica)" : "") +
      vtxt +
      (p.km ? "<br>extensão do trecho: " + (+p.km).toFixed(2) + " km" + (p.km > 0 ? " · densidade " + (cnt[i] / p.km).toFixed(1) + "/km" : "") : "");
  }, {sticky: true});
  return l;
});
const LR = D.ruas.map(() => []);
FR.forEach((r, i) => LR[r].push(i));
if (NF) { const b = L.featureGroup(LAY).getBounds(); if (b.isValid()) MAPA.fitBounds(b.pad(.05)); }

let ULT = {pts: [], pw: [], cls: null, pr: null}, heat = null;   // cls/pr: classe e posto por trecho (tooltip)
function desenharCalor() {
  const c = CAMADAS.calor;
  // o leaflet.heat remove o canvas do overlayPane: devolve-o antes de descartar a camada
  if (heat && heat._canvas) MAPA.getPane("overlayPane").appendChild(heat._canvas);
  c.grp.clearLayers(); heat = null;
  if (c.vis && L.heatLayer && ULT.pts.length) {
    heat = L.heatLayer(ULT.pts.map((i, j) => [D.geo.features[i].properties.c[0], D.geo.features[i].properties.c[1], ULT.pw[j]]),
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
  const evAll = D.ev.filter(passa);
  // Panorama com rotas em análise: KPIs, gráficos, dia×hora e ranking valem só para os trechos
  // das rotas (a selecionada, ou todas). O mapa de classes e os tooltips seguem o filtro inteiro,
  // para a régua de quantis continuar comparável com a cidade toda.
  const E0 = aba === "panorama" ? escopoRota() : null, escFids = E0 && !E0.off ? E0.fids : null;
  const ev = escFids ? evAll.filter(e => e[0] >= 0 && escFids.has(e[0])) : evAll;
  cnt.fill(0);
  RUA_TOT = new Int32Array(D.ruas.length);
  const rtEsc = escFids ? new Int32Array(D.ruas.length) : RUA_TOT;     // totais por via das estatísticas
  for (const e of evAll) if (e[0] >= 0) { cnt[e[0]]++; RUA_TOT[FR[e[0]]]++; }
  const ruaV = D.ruas.map(() => new Int32Array(NV));
  const mesV = D.meses_ok.map(() => new Int32Array(NV));
  const horaV = [...Array(24)].map(() => new Int32Array(NV));
  const hm = [...Array(7)].map(() => new Int32Array(24));
  const horaT = new Int32Array(24);
  const mpos = {}; D.meses_ok.forEach((m, i) => mpos[m] = i);
  let loc = 0;
  for (const e of ev) {
    if (e[0] >= 0) { loc++; const r = FR[e[0]]; if (escFids) rtEsc[r]++; ruaV[r][e[1]]++; }
    mesV[mpos[e[3]]][e[1]]++; horaV[e[5]][e[1]]++; hm[e[4]][e[5]]++; horaT[e[5]]++;
  }

  // mapa: cor por QUANTIL da contagem ponderada por gravidade (atropelamento = W_ATR × acidente)
  // dos trechos (via×bairro) com registro no filtro atual. Classes altas ficam mais grossas,
  // opacas e por cima; classes baixas recuam. A localização é só pelo nome da via (o SAMU não
  // traz coordenada), então a contagem — e não a taxa por km — ordena os trechos.
  const wN = W_NAT(), tax = new Float64Array(NF);
  const veicF = [], perF = [];                       // por trecho: veículos e período (tooltip)
  for (const e of evAll) if (e[0] >= 0) {
    tax[e[0]] += wN[e[2]];
    (veicF[e[0]] || (veicF[e[0]] = new Int32Array(NV)))[e[1]]++;
    (perF[e[0]] || (perF[e[0]] = new Int32Array(D.per.length)))[e[6]]++;
  }
  const Q = rankQuantil(tax), g = CAMADAS.vias.grp; g.clearLayers();
  const lista = []; for (let i = 0; i < NF; i++) if (Q.cls[i] >= 0) lista.push(i);
  lista.sort((a, b) => Q.pr[a] - Q.pr[b] || tax[a] - tax[b]);          // topo por último = por cima
  const pts = [], pw = [];
  for (const i of lista) {
    const k = Q.cls[i];
    LAY[i].setStyle({color: cor(k / (NCL - 1)), weight: ESP_CL[k] * EST.esp, opacity: opClasse(k)});
    g.addLayer(LAY[i]); pts.push(i); pw.push(PESO_CALOR[k]);
  }
  ULT = {pts, pw, cls: Q.cls, pr: Q.pr, veic: veicF, per: perF}; desenharCalor();

  const leg = '<div class="legenda"><b>Classes por quantil (contagem ponderada por gravidade no filtro; atropelamento = ' + PARAMS.W_ATR + '×):</b> ' +
    Q.faixas.map((F, k) => F.n ? '<span style="background:' + cor(k / (NCL - 1)) + '"></span><span>' + NOMES_CL[k] + ': ' + faixaTxt(F) + ' (' + F.n + ' trechos)</span>' : "").join(" ") +
    '</div>';
  const k5 = $("k5"); if (k5) { k5.innerHTML = Q.n ? leg : ""; const pl = $("pLegenda"); if (pl) pl.hidden = !Q.n; }
  // a legenda mora hoje na aba "Legenda" do painel esquerdo: espelha o mesmo HTML em #k5b
  const k5b = $("k5b"); if (k5b) { k5b.innerHTML = Q.n ? leg : ""; const sl = $("secLegenda"); if (sl && !Q.n && subAba === "legenda") irSubAba("filtros"); }
  // a aba "Rotas" do painel esquerdo existe para as duas abas superiores: o bloco de
  // rotas em análise aparece mesmo no Panorama, onde antes ficava preso ao data-aba
  const sr = $("secRotas"); if (sr) sr.classList.toggle("rota-ui", aba === "rota");
  // KPIs
  $("k1").textContent = ev.length.toLocaleString("pt-BR");
  $("k2").textContent = ev.length ? loc.toLocaleString("pt-BR") + " (" + Math.round(100 * loc / ev.length) + "%)" : "–";
  let top = -1, tv = 0; rtEsc.forEach((v, i) => { if (v > tv) { tv = v; top = i; } });
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
  const ord = [...rtEsc.keys()].filter(i => rtEsc[i] > 0).sort((a, b) => rtEsc[b] - rtEsc[a]).slice(0, 20);
  const tb = $("rank").tBodies[0];
  tb.innerHTML = ord.map((r, k) => {
    let vm = 0; ruaV[r].forEach((v, i) => { if (v > ruaV[r][vm]) vm = i; });
    const km = D.ruas[r].km;
    return '<tr class="rk" data-r="' + r + '"><td>' + (k + 1) + "</td><td>" + esc(D.ruas[r].n) + '</td><td class="n">' + rtEsc[r] +
      '</td><td class="n">' + (km > 0 ? (rtEsc[r] / km).toFixed(1) : "–") + "</td><td>" + D.veic[vm] + " (" + ruaV[r][vm] + ")</td></tr>";
  }).join("");
  tb.querySelectorAll("tr.rk").forEach(tr => tr.onclick = () => {
    const b = L.featureGroup(LR[+tr.dataset.r].map(i => LAY[i])).getBounds();
    if (b.isValid()) MAPA.fitBounds(b.pad(.3));
  });
  const bar = $("escopoRota");
  if (bar) {
    bar.hidden = !E0;
    if (E0) {
      $("escopoTxt").textContent = E0.off ? "Panorama completo (as rotas em análise estão sendo ignoradas)"
        : "Somente trechos de " + E0.nome + " · " + E0.fids.size + " trecho" + (E0.fids.size === 1 ? "" : "s") + " (via × bairro)";
      $("btnEscopo").textContent = E0.off ? "Filtrar pelas rotas" : "Ver tudo";
    }
  }
  atualizarRotas();
}

// ---- busca por rua/logradouro (painel flutuante entre a caixa de configurações e os -----
// cartões/KPIs centrais): campo de texto + ícone de lupa, autocompletar listado abaixo.
// O catálogo vem da malha OSM inteira (D.ruas_osm: [nome, [bairros]]), não só das vias com
// ocorrência — a busca precisa achar qualquer logradouro. Cada linha sugere uma via; o
// texto aceita "rua", "rua bairro" e variações sem acento/caixa. Escolher uma via centraliza
// o mapa nela (mesmo comportamento do ranking). Minimiza: clicando fora com o campo vazio a
// caixa encolhe até virar só a lupa; um toque na lupa restaura a largura normal.
const normBusca = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const RUAS_BUSCA = (D.ruas_osm || []).map(([n, bs]) => ({n, b: (bs || []).join(", "), k: normBusca(n + " " + (bs || []).join(" "))}));
const MAXSUG = 12;
let sugAtiva = -1;
function fecharSugestoes() { const ul = $("buscaLista"); if (ul) { ul.hidden = true; ul.innerHTML = ""; } sugAtiva = -1; const i = $("buscaRua"); if (i) i.setAttribute("aria-expanded", "false"); }
function sugerirRuas(txtq) {
  const q = normBusca(txtq.trim());
  if (!q) return [];
  const exata = [], inicia = [], contem = [];
  for (const r of RUAS_BUSCA) {
    if (r.k === q || normBusca(r.n) === q) exata.push(r);
    else if (normBusca(r.n).startsWith(q) || r.k.includes(q)) inicia.push(r);
    else if (r.k.includes(q)) contem.push(r);   // (inacessível hoje; mantido por clareza de prioridade)
  }
  return exata.concat(inicia).slice(0, MAXSUG);
}
function pintarSugestoes(txtq) {
  const ul = $("buscaLista"); if (!ul) return;
  const rs = sugerirRuas(txtq);
  if (!rs.length) { fecharSugestoes(); return; }
  ul.innerHTML = rs.map((r, i) => '<li role="option" data-i="' + i + '"' + (i === sugAtiva ? ' class="on"' : "") + ">" +
    "<b>" + esc(r.n) + "</b>" + (r.b ? "<span>" + esc(r.b) + "</span>" : "") + "</li>").join("");
  ul.hidden = false;
  const inp = $("buscaRua"); if (inp) inp.setAttribute("aria-expanded", "true");
  ul.querySelectorAll("li").forEach(li => {
    li.onmousedown = e => { e.preventDefault(); escolherRua(rs[+li.dataset.i]); };
    li.onmouseenter = () => { sugAtiva = +li.dataset.i; ul.querySelectorAll("li").forEach(x => x.classList.toggle("on", x === li)); };
  });
}
function irParaRua(r) {
  const norm = normBusca(r.n);
  let ri = D.ruas.findIndex(x => normBusca(x.n) === norm);
  if (ri < 0) ri = D.ruas.findIndex(x => normBusca(x.n).includes(norm) || norm.includes(normBusca(x.n)));
  if (ri >= 0 && LR[ri].length) {                       // via com trechos no mapa: enquadra como no ranking
    const b = L.featureGroup(LR[ri].map(i => LAY[i])).getBounds();
    if (b.isValid()) MAPA.fitBounds(b.pad(.3));
    return true;
  }
  // "d" = nome legível (exibição + bairro), presente no mapa real; "n" é a forma canônica do
  // OSM ('R AURORA') — casar só por "n" deixava a busca muda em qualquer mapa gerado de verdade
  const f = D.geo.features.find(x => normBusca(x.properties.d || x.properties.n) === norm);
  if (f) { MAPA.setView([f.properties.c[0], f.properties.c[1]], Math.max(MAPA.getZoom(), 15)); return true; }
  aviso("Sem traçado no mapa para \"" + r.n + "\"");
  return false;
}
function escolherRua(r) {
  const inp = $("buscaRua");
  if (inp) inp.value = r.n + (r.b ? " — " + r.b : "");
  fecharSugestoes();
  irParaRua(r);
}
function minimizarBusca() { const wr = $("buscaWrap"); if (wr) wr.classList.add("min"); fecharSugestoes(); }
function expandirBusca() {
  const wr = $("buscaWrap"), inp = $("buscaRua");
  if (wr) wr.classList.remove("min");
  if (inp) { inp.removeAttribute("tabindex"); inp.focus(); }   // sem tabindex a caixa volta ao fluxo normal
  posicionarBusca();                                           // com os KPIs visíveis dá para medir a faixa livre
}
(function ligarBusca() {
  const inp = $("buscaRua"), btn = $("btnBusca"), wrap = $("buscaWrap");
  if (!inp || !btn || !wrap) return;
  inp.addEventListener("input", () => {
    if (wrap.classList.contains("min")) expandirBusca();       // começou minimizada: digitar direto na lupa abre a caixa
    sugAtiva = -1; pintarSugestoes(inp.value);
  });
  inp.addEventListener("focus", () => { if (wrap.classList.contains("min")) expandirBusca(); else if (inp.value) pintarSugestoes(inp.value); });
  inp.addEventListener("keydown", e => {
    const itens = Array.from($("buscaLista").querySelectorAll("li"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!itens.length) { pintarSugestoes(inp.value); return; }
      e.preventDefault();
      sugAtiva = (sugAtiva + (e.key === "ArrowDown" ? 1 : -1) + itens.length) % itens.length;
      pintarSugestoes(inp.value);
    } else if (e.key === "Enter") {
      const rs = sugerirRuas(inp.value);
      const r = rs[Math.max(sugAtiva, 0)];
      if (r) { e.preventDefault(); escolherRua(r); }
    } else if (e.key === "Escape") { fecharSugestoes(); inp.blur(); }
  });
  btn.onclick = e => {                                  // lupa: expande (fechada) ou minimiza (aberta, campo vazio)
    const estavaMin = wrap.classList.contains("min");
    if (estavaMin) expandirBusca();
    else if (!inp.value.trim()) minimizarBusca();
    else inp.focus();
    // o click se propaga até document; o handler de "clicar fora" precisa ignorar o
    // clique na própria lupa — senão reexpande logo após minimizar (toggle quebrado)
    window.__buscaToggle = Date.now();
  };
  // clicar fora com a caixa vazia minimiza (vira só a lupa); com texto, apenas fecha o autocompletar.
  document.addEventListener("click", e => {
    if (wrap.contains(e.target)) return;                 // clique dentro da busca: o toggle/blur cuidam dela
    if (!inp.value.trim()) minimizarBusca();
    fecharSugestoes();
  });
})();

/*@@ROTAS@@*/

// =====================================================================
// 6. ABAS, PAINÉIS SOBREPOSTOS e INICIALIZAÇÃO
// =====================================================================
// Painéis flutuam sobre o mapa em tela cheia (.overlay com pointer-events:none; cada painel
// reativa pointer-events:auto). Recolher/expandir troca as classes .aberto/.fechado do painel
// e o aria-expanded do botão da cabecalheira; depois de cada mudança chamamos MAPA.invalidateSize
// (fim da transição CSS) e redimensionamos os gráficos Chart.js visíveis.
const PAINEL_TRANS = 280;                       // deve bater com a transição do style.css
const posPainel = {};                           // estado recolhido/expandido (em memória)
const painelsCab = new Set();                   // cabeçalhos já ligados (evita listener duplicado ao remontar)
function registrarPainel(id, ini) {
  const el = $(id); if (!el) return;
  posPainel[id] = {el, btn: null, aberto: ini};
}
// atalhos para recolher/expandir tudo — usados pelos botões "−" e "+" do menu de camadas
function fecharTudo() { Object.keys(posPainel).forEach(id => { if (posPainel[id].aberto) alternarPainel(id); }); }
// pLegenda é a legenda flutuante desativada (virou aba do painel esquerdo): não volta a abrir
function abrirTudo() { Object.keys(posPainel).forEach(id => { if (id !== "pLegenda" && !posPainel[id].aberto) alternarPainel(id); }); }
function registrarBotao(btnId, painelId) {
  const b = $(btnId), st = posPainel[painelId];
  if (!b || !st) return;
  st.btn = b;
  b.onclick = e => { e.stopPropagation(); alternarPainel(painelId); };
  // a barra inteira é clicável; cliques em controles internos não recolhem o painel
  const cab = st.el.querySelector(":scope > .pcab");
  if (cab && !painelsCab.has(cab)) {
    painelsCab.add(cab);
    cab.addEventListener("click", e => { if (!e.target.closest("input,select,textarea,button")) alternarPainel(painelId); });
  }
}
function pintarPainel(id) {
  const st = posPainel[id]; if (!st) return;
  st.el.classList.toggle("aberto", st.aberto);
  st.el.classList.toggle("fechado", !st.aberto);
  if (st.btn) {
    st.btn.setAttribute("aria-expanded", st.aberto ? "true" : "false");
    st.btn.textContent = st.aberto ? "▾" : "▸";
  }
}
function aoMudarPainel() {
  setTimeout(ajustarMapa, PAINEL_TRANS);        // depois da transição CSS
  setTimeout(ajustarMapa, 30);                  // garante também sem transição (jsdom/redução de movimento)
  setTimeout(posicionarBusca, PAINEL_TRANS + 20);  // a busca flutua na faixa que sobra entre p-esq e os KPIs
}
// posição da busca: --pesq acompanha a largura do painel esquerdo (aberto/recolhido);
// --busca-top afasta a caixa para BAIXO dos cartões KPI ("ocorrências" etc. — nunca sobreposta,
// mesmo quando os KPIs quebram em duas linhas); --gap-busca preserva folga até a borda esquerda
// dos KPIs quando a busca está na mesma linha deles. Em telas estreitas (<768px) a busca sobe
// ao topo livre e as faixas de KPI/gráficos descem por CSS — o JS remove as variáveis medidas.
function posicionarBusca() {
  const raiz = document.documentElement.style, esq = $("pFiltros");
  if (esq) raiz.setProperty("--pesq", esq.offsetWidth + "px");
  const kp = document.querySelector(".kpis"), wr = $("buscaWrap");
  if (!kp || !wr) return;
  if (window.innerWidth < 768) {          // leiaute móvel: regras do media query mandam
    raiz.removeProperty("--busca-top"); raiz.removeProperty("--gap-busca");
    return;
  }
  const r = kp.getBoundingClientRect();
  if (r.width > 0) raiz.setProperty("--busca-top", Math.round(r.bottom) + 10 + "px");
  if (wr.offsetParent !== null && kp.children.length) {   // jsdom devolve tudo 0; layout real mede
    const livre = r.left - wr.getBoundingClientRect().right;
    raiz.setProperty("--gap-busca", Math.max(0, 10 - (livre || 0)) + "px");
  }
}
function alternarPainel(id) {
  const st = posPainel[id]; if (!st) return;
  st.aberto = !st.aberto;
  pintarPainel(id); aoMudarPainel();                    // só alterna classes: nada é remontado
}
// em telas pequenas os painéis viram faixas inferiores e iniciam recolhidos;
// no desktop: filtros abertos, ranking aberto; os cartões inferiores começam abertos
// (cada um com botão próprio de recolher). Os KPIs do topo central não têm mais botão
// de minimizar — as informações gerais ficam sempre visíveis, fora da tabela de vias.
const MOBILE = () => typeof window !== "undefined" && window.innerWidth <= 768;
const mobileIni = MOBILE();
registrarPainel("pFiltros", !mobileIni);
registrarPainel("risco", false);
registrarPainel("pLegenda", false);          // desativado (display:none): a legenda virou aba do painel esquerdo
registrarPainel("pRank", !mobileIni);
registrarPainel("gMes", !mobileIni);         // gráficos soltos na base: cada um com botão próprio
registrarPainel("gHora", !mobileIni);
registrarPainel("gHeat", !mobileIni);
[["btnPFiltros", "pFiltros"], ["btnPRisco", "risco"],
 ["btnPLegenda", "pLegenda"], ["btnPRank", "pRank"],
 ["btnGMes", "gMes"], ["btnGHora", "gHora"], ["btnGHeat", "gHeat"]].forEach(([b, p]) => registrarBotao(b, p));
Object.values(posPainel).forEach(pintarPainel);   // sincroniza classes, setas e aria-expanded

// -- subabas do painel esquerdo: Filtros | Rotas | Camadas e estilo | Legendas ---------
// o menu de camadas deixou de ser um painel flutuante (sobrepunha os cartões do topo);
// agora vive numa aba dentro de #pFiltros, junto da legenda de quantis. Quem esconde/
// mostra é a subaba selecionada; #camadas/#secLegenda usam [hidden] (sem regra que as
// reexiba), então nada é remontado ao minimizar/expansir — os listeners sobrevivem.
let subAba = "filtros";
const SUBABAS = [["filtros", "secFiltros", "stFiltros"], ["rotas", "secRotas", "stRotas"], ["camadas", "camadas", "stCamadas"], ["legenda", "secLegenda", "stLegenda"]];
const SUBABA_POR_BTN = {stRotas: "rotas", stCamadas: "camadas", stLegenda: "legenda", stFiltros: "filtros"};
function irSubAba(a) {
  subAba = a;
  for (const [nome, alvo, btn] of SUBABAS) {
    const el = $(alvo), b = $(btn);
    if (el) el.hidden = nome !== a;
    if (b) { b.classList.toggle("on", nome === a); b.setAttribute("aria-selected", String(nome === a)); }
  }
  if (a === "camadas") montarPainel();       // monta/atualiza o conteúdo do menu
  setTimeout(ajustarMapa, 0);
}
SUBABAS.forEach(([, , btnId]) => { const b = $(btnId); if (b) b.onclick = () => irSubAba(SUBABA_POR_BTN[btnId]); });
irSubAba("filtros");

function graficosVisiveis() {
  if (aba === "rota") { const c = window.__rotas && cRiscoRef(); if (c) c.resize(); }
  else { cMes.resize(); cHora.resize(); }
}
function cRiscoRef() { try { return typeof cRisco !== "undefined" && cRisco ? cRisco : null; } catch (e) { return null; } }
function ajustarMapa() {
  MAPA.invalidateSize();
  graficosVisiveis();
}
window.addEventListener("resize", () => { aoMudarPainel(); });   // ajusta após a transição/layout

function irAba(a) {
  if (aba) perfis[aba] = capturar();
  opViasPan = opViasFade = null;
  aba = a; document.body.dataset.aba = a;
  OP_FATOR = a === "rota" ? .6 : 1;   // incidências recuam p/ rota sobressair (reaplicado por update())
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === a));
  aplicarPerfil(perfis[a]);
  // com rotas em análise, o Panorama passa a falar delas (KPIs, gráficos e ranking só dos seus
  // trechos): a camada de rotas precisa estar visível mesmo que um perfil antigo, salvo no
  // navegador, a tenha deixado desligada nesta aba
  if (a === "panorama" && rotas.length && !CAMADAS.rotas.vis) mostrar("rotas", true);
  if (a === "panorama") ajustarFundo();
  // a nova aba superior não muda mais o conteúdo do painel esquerdo — quem decide o que
  // aparece é a subaba "Rotas". Ao entrar em "Minha rota", abre-a automaticamente.
  if (a === "rota") irSubAba("rotas");
  montarPainel();
  setTimeout(ajustarMapa, 0);
  setTimeout(ajustarMapa, PAINEL_TRANS);
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
posicionarBusca();                                // busca alinhada entre a caixa de configurações e os KPIs
window.__app = {S, SR, CAMADAS, MAPA, mostrar, irAba, trocarBase, mover, ajustarMapa, posPainel, fecharTudo, abrirTudo, irSubAba, posicionarBusca,
  get ORDEM() { return ORDEM; }, get aba() { return aba; }};
})();

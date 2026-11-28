// Vignettes de lignes : pictogrammes officiels Île-de-France Mobilités (métro, RER, Transilien, tram) quand on les a,
// sinon pastille aux couleurs de la ligne ou du type de train (TGV INOUI, OUIGO, TER…).
//   LPLines.ready                      promesse : référentiel chargé (data/lignes-pictos.json, 4 Ko)
//   LPLines.info({net, id, mode, name}) -> {text, color, fg, picto, label}
//   LPLines.badge(l)                    -> HTML (image ou pastille)
//   LPLines.forStory(l)                 -> promesse {img} ou {text, color, fg}, pour LPStory
(function () {
  "use strict";
  const en = () => document.documentElement.lang === "en";
  const SNCF = {OUI: ["TGV INOUI", "#9B1B4F"], OGO: ["OUIGO", "#E5007D"], IC: ["Intercités", "#26357F"], ICN: ["Intercités", "#26357F"],
    LYR: ["Lyria", "#B0182B"], ICE: ["ICE", "#5B6470"], TER: ["TER", "#0A74B8"], TT: ["Tram-train", "#0A74B8"], ES: ["Eurostar", "#14275A"],
    NAV: ["Navette", "#5B6470"], TGV: ["TGV", "#9B1B4F"]};
  const MODE_IDF = {METRO: "Métro", RER: "RER", TRANSILIEN: "Transilien", TRAM: "Tram", NAVETTE: "Navette", CABLE: "Câble"};
  let P = {};
  const ready = fetch("data/lignes-pictos.json", {signal: AbortSignal.timeout(10000)}).then(r => r.json()).then(j => { P = j || {}; }).catch(() => {});
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  function fgFor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return "#fff";
    const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? "#121417" : "#fff";
  }
  const strip = s => String(s || "").replace(/^(RER|Transilien|Métro|Metro|Tram|Ligne)\s+/i, "").trim();
  function info(l) {
    l = l || {};
    const mode = String(l.mode || "").toUpperCase();
    if (l.net === "idf" || MODE_IDF[mode]) {
      let id = P[l.id] ? l.id : null;
      if (!id && l.name) { const nm = strip(l.name); id = Object.keys(P).find(k => P[k].name === nm && (!mode || P[k].mode === mode)) || Object.keys(P).find(k => P[k].name === nm) || null; }
      const g = id ? P[id] : null, name = g ? g.name : strip(l.name);
      const m = (g && g.mode) || mode;
      const label = m === "RER" || m === "TRANSILIEN" ? `${MODE_IDF[m]} ${name}` : m === "METRO" ? (en() ? `Metro ${name}` : `Métro ${name}`) : m === "TRAM" ? `Tram ${name}` : `${MODE_IDF[m] || ""} ${name}`.trim();
      return {id, text: name || "?", color: (g && g.color) || "#5B6470", fg: fgFor(g && g.color), picto: g && g.picto ? g.picto : null, label, light: m === "TRAM"};
    }
    const s = SNCF[mode] || [l.mode || "Train", "#5B6470"];
    const code = l.name && !/^\d{3}[A-Z]$/.test(l.name) && l.name !== s[0] ? l.name : "";   // « K6 » oui, « 622E » (code interne) non
    return {text: code ? `${s[0] === "TER" ? "TER" : s[0]} ${code}` : s[0], color: s[1], fg: "#fff", picto: null, label: code ? `${s[0]} ${code}` : s[0]};
  }
  function badge(l, big) {
    const i = info(l);
    return i.picto ? `<img class="lpl-pic${big ? " lg" : ""}${i.light ? " light" : ""}" src="${esc(i.picto)}" alt="${esc(i.label)}" title="${esc(i.label)}">`
      : `<span class="lpl-pill${big ? " lg" : ""}" style="background:${esc(i.color)};color:${esc(i.fg)}" title="${esc(i.label)}">${esc(i.text)}</span>`;
  }
  function forStory(l) {
    const i = info(l);
    if (!i.picto) return Promise.resolve({text: i.text, color: i.color, fg: i.fg});
    return new Promise(res => { const im = new Image(); im.onload = () => res({img: im, light: !!i.light}); im.onerror = () => res({text: i.text, color: i.color, fg: i.fg}); im.src = i.picto; });
  }
  const css = document.createElement("style");
  css.textContent = ".lpl-pic{height:1.6em;width:1.6em;vertical-align:-.42em;display:inline-block;flex:none}.lpl-pic.lg{height:2.2em;width:2.2em}" +
    ".lpl-pic.light{background:#fff;border-radius:.3em;padding:.12em}" +
    ".lpl-pill{display:inline-flex;align-items:center;justify-content:center;height:1.6em;min-width:1.6em;padding:0 .5em;border-radius:.45em;font:800 .78em/1 'Manrope',system-ui,sans-serif;letter-spacing:.01em;white-space:nowrap;vertical-align:-.42em;flex:none}" +
    ".lpl-pill.lg{height:2.2em;font-size:.9em;padding:0 .65em}";
  document.head.appendChild(css);
  window.LPLines = {ready, info, badge, forStory};
})();

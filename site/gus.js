/* Gus, la mascotte de LateProof : dessin SVG (corps entier ou tête seule), humeurs,
   clignement des yeux et bouton assistant flottant. Aucune dépendance. */
(function () {
  "use strict";
  const L = "#D4FF3A", INK = "#121417", OR = "#FF8A5C", TXT = "#E6E6E0";
  const CAP = "#2B3036", CAPTOP = "#363C43", HEAD = "#4C535C", JACKET = "#3A4048", SLEEVE = "#454B54", GLOVE = "#D5D8DC", SHOE = "#0D0F11";
  const MOODS = ["neutre", "content", "retard", "ecoute", "reflexion", "bravo", "veille"];
  const FCX = 120, FCY = 106;
  const n = (v) => +v.toFixed(1);
  let uid = 0;
  const reduce = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function eyes(e, cx, cy) {
    let s = "";
    for (const sg of [-1, 1]) {
      const ex = cx + sg * 17, ey = cy - 5;
      if (e === "neutre" || e === "retard") {
        const h = e === "neutre" ? 18 : 14;
        s += `<rect x="${ex - 5}" y="${ey - h / 2}" width="10" height="${h}" rx="5" fill="${L}"/>`;
        if (e === "retard") {
          const [a, b] = sg < 0 ? [ey - 13, ey - 17] : [ey - 17, ey - 13];
          s += `<path d="M${ex - 8} ${a}L${ex + 8} ${b}" stroke="${L}" stroke-width="3.5" stroke-linecap="round"/>`;
        }
      } else if (e === "content" || (e === "bravo" && sg < 0)) {
        s += `<path d="M${ex - 7} ${ey + 3}Q${ex} ${ey - 9} ${ex + 7} ${ey + 3}" fill="none" stroke="${L}" stroke-width="4.5" stroke-linecap="round"/>`;
      } else if (e === "bravo") {
        s += `<rect x="${ex - 5}" y="${ey - 9}" width="10" height="18" rx="5" fill="${L}"/>`;
      } else if (e === "ecoute") {
        s += `<circle cx="${ex}" cy="${ey}" r="7" fill="${L}"/>`;
      } else if (e === "reflexion") {
        s += `<rect x="${ex - 1}" y="${ey - 12}" width="9" height="13" rx="4.5" fill="${L}"/>`;
      } else {
        s += `<path d="M${ex - 7} ${ey}Q${ex} ${ey + 6} ${ex + 7} ${ey}" fill="none" stroke="${L}" stroke-width="4" stroke-linecap="round" opacity=".7"/>`;
      }
    }
    return s;
  }
  function mouth(e, cx, cy) {
    const my = cy + 15;
    switch (e) {
      case "neutre": return `<path d="M${cx - 6} ${my}Q${cx} ${my + 4} ${cx + 6} ${my}" fill="none" stroke="${L}" stroke-width="3.5" stroke-linecap="round"/>`;
      case "content": return `<path d="M${cx - 10} ${my - 2}Q${cx} ${my + 8} ${cx + 10} ${my - 2}" fill="none" stroke="${L}" stroke-width="3.5" stroke-linecap="round"/>`;
      case "retard": return `<path d="M${cx - 9} ${my + 1}q4.5 -4 9 0q4.5 4 9 0" fill="none" stroke="${L}" stroke-width="3.2" stroke-linecap="round"/>`;
      case "ecoute": return [5, 10, 14, 10, 5].map((h, i) => `<rect class="gus-bar" style="--i:${i}" x="${n(cx + (i - 2) * 6 - 1.6)}" y="${my - h / 2}" width="3.2" height="${h}" rx="1.6" fill="${L}"/>`).join("");
      case "reflexion": return `<path d="M${cx - 2} ${my}h9" stroke="${L}" stroke-width="3.5" stroke-linecap="round"/>`;
      case "bravo": return `<path d="M${cx - 10} ${my - 3}Q${cx} ${my + 11} ${cx + 10} ${my - 3}Z" fill="${L}"/>`;
      default: return "";
    }
  }
  function ticket(hole) {
    return `<g transform="rotate(-12 176 214)"><rect x="160" y="200" width="48" height="30" rx="5" fill="${TXT}"/><rect x="160" y="200" width="11" height="30" rx="3" fill="${L}"/>` +
      `<path d="M178 209h22M178 216h16M178 223h19" stroke="#B7BBC1" stroke-width="2.4" stroke-linecap="round"/>` +
      (hole ? `<circle cx="196" cy="222" r="4.2" fill="${INK}"/>` : "") + `</g>`;
  }
  // Poses du corps entier : angle des bras (degrés) et billet tenu.
  const POSES = {
    repos: {l: 14, r: -14, ticket: true}, salut: {l: 14, r: -125, ticket: true}, billet: {l: 14, r: -95, ticket: true},
    composte: {l: 40, r: -95, ticket: true, hole: true}, bravo: {l: 125, r: -125, ticket: false},
  };

  function draw(o) {
    const mood = MOODS.includes(o.mood) ? o.mood : "neutre";
    const band = mood === "retard" ? OR : L;
    const face = `<g class="gus-eyes">${eyes(mood, FCX, FCY)}</g>${mouth(mood, FCX, FCY)}`;
    const head = `<rect x="110" y="128" width="20" height="14" fill="${CAP}"/>` +
      `<rect x="47" y="86" width="15" height="36" rx="7.5" fill="${JACKET}"/><rect x="178" y="86" width="15" height="36" rx="7.5" fill="${JACKET}"/>` +
      `<circle cx="54.5" cy="104" r="3" fill="${L}" opacity=".85"/><circle cx="185.5" cy="104" r="3" fill="${L}" opacity=".85"/>` +
      `<rect x="58" y="60" width="124" height="80" rx="30" fill="${HEAD}"/><rect x="82" y="64" width="50" height="4" rx="2" fill="#fff" opacity=".14"/>` +
      `<rect x="72" y="76" width="96" height="56" rx="19" fill="${INK}"/><path d="M150 80q12 2 14 16" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".07"/>` + face;
    const cap = `<path d="M71 64L77 28Q120 14 163 28L169 64Z" fill="${CAP}"/><ellipse cx="120" cy="28" rx="43" ry="8" fill="${CAPTOP}"/>` +
      `<path d="M72.6 52H167.4L169 62H71Z" fill="${band}"/><path d="M58 66Q120 82 182 66L182 60Q120 74 58 60Z" fill="${INK}"/>` +
      `<path d="M66 64Q120 76 174 64" fill="none" stroke="#fff" stroke-width="1.5" opacity=".12"/>` +
      `<circle cx="120" cy="38" r="7.5" fill="${CAP}" stroke="${L}" stroke-width="2.6"/><path d="M120 38l3.6 2.4" stroke="${L}" stroke-width="2.4" stroke-linecap="round"/>`;
    if (o.head) {
      return `<svg class="gus gus-head" viewBox="42 8 156 136" width="${o.size}" height="${Math.round(o.size * 136 / 156)}" aria-hidden="true" focusable="false">${head}${cap}</svg>`;
    }
    const p = POSES[o.pose] || POSES.repos;
    const armL = `<g class="gus-arm-l" transform="rotate(${p.l} 74 152)"><rect x="63" y="146" width="20" height="56" rx="10" fill="${SLEEVE}"/><rect x="63" y="190" width="20" height="6" fill="${JACKET}"/><circle cx="73" cy="206" r="11" fill="${GLOVE}"/></g>`;
    // Rotation autour de l'épaule : on ramène l'épaule à l'origine pour que l'animation CSS tourne autour de (0,0).
    const armR = `<g transform="translate(166 152)"><g class="gus-arm-r${o.pose === "salut" ? " gus-wave" : ""}" style="transform:rotate(${p.r}deg)"><g transform="translate(-166 -152)"><rect x="157" y="146" width="20" height="56" rx="10" fill="${SLEEVE}"/><rect x="157" y="190" width="20" height="6" fill="${JACKET}"/>${p.ticket ? ticket(p.hole) : ""}<circle cx="167" cy="206" r="11" fill="${GLOVE}"/></g></g></g>`;
    const legs = `<rect x="94" y="212" width="20" height="44" rx="9" fill="${JACKET}"/><rect x="126" y="212" width="20" height="44" rx="9" fill="${JACKET}"/>` +
      `<rect x="86" y="248" width="32" height="17" rx="8.5" fill="${SHOE}"/><rect x="122" y="248" width="32" height="17" rx="8.5" fill="${SHOE}"/>` +
      `<rect x="88" y="261" width="28" height="3" rx="1.5" fill="${L}" opacity=".9"/><rect x="124" y="261" width="28" height="3" rx="1.5" fill="${L}" opacity=".9"/>`;
    const body = `<rect x="70" y="138" width="100" height="86" rx="28" fill="${JACKET}"/><rect x="88" y="140" width="64" height="3" rx="1.5" fill="#fff" opacity=".1"/>` +
      `<path d="M104 139L120 168L136 139Z" fill="${GLOVE}"/><path d="M115.5 148h9l2 21-6.5 8-6.5-8z" fill="${L}"/>` +
      `<path d="M96 139L120 174L106 139Z" fill="${CAP}"/><path d="M144 139L120 174L134 139Z" fill="${CAP}"/>` +
      `<circle cx="120" cy="190" r="3.2" fill="${CAP}"/><circle cx="120" cy="204" r="3.2" fill="${CAP}"/><rect x="80" y="178" width="22" height="4" rx="2" fill="${CAP}"/>` +
      `<rect x="137" y="172" width="23" height="13" rx="3.5" fill="${L}"/><path d="M142 178.5h13" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`;
    const shadow = `<ellipse cx="120" cy="270" rx="58" ry="6" fill="#000" opacity=".38"/>`;
    return `<svg class="gus gus-full" viewBox="0 0 240 280" width="${o.size}" height="${Math.round(o.size * 280 / 240)}" aria-hidden="true" focusable="false" style="overflow:visible">${shadow}<g class="gus-body">${legs}${armL}${body}${armR}${head}${cap}</g></svg>`;
  }

  // Styles partagés : clignement, balancement, barres d'écoute, bouton flottant.
  const css = `
.gus{display:block}
.gus .gus-eyes{transform-box:fill-box;transform-origin:center;animation:gus-blink 4.2s infinite}
.gus-full .gus-body{animation:gus-bob 2.6s ease-in-out infinite}
.gus .gus-arm-r{transform-origin:0 0}
.gus .gus-wave{animation:gus-wave 1.1s ease-in-out infinite}
.gus .gus-bar{transform-box:fill-box;transform-origin:center;animation:gus-bar .9s ease-in-out infinite;animation-delay:calc(var(--i) * .12s)}
@keyframes gus-blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.12)}}
@keyframes gus-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes gus-wave{0%,100%{transform:rotate(-125deg)}50%{transform:rotate(-108deg)}}
@keyframes gus-bar{0%,100%{transform:scaleY(.5)}50%{transform:scaleY(1.15)}}
.gus-fab{position:fixed;right:max(16px,env(safe-area-inset-right,0px));bottom:calc(var(--gus-fab-bottom,24px) + env(safe-area-inset-bottom,0px));z-index:1500;display:grid;place-items:center;width:62px;height:62px;border-radius:50%;background:#2B3036;box-shadow:inset 0 1px 0 rgb(255 255 255/.12),0 10px 26px rgb(0 0 0/.45);text-decoration:none;transition:transform .2s}
.gus-fab:hover{transform:translateY(-2px)}
.gus-fab:focus-visible{outline:3px solid ${L};outline-offset:3px}
.gus-fab::before,.gus-fab::after{content:"";position:absolute;inset:0;border-radius:50%;border:3px solid ${L};opacity:0;pointer-events:none}
.gus-fab.ping::before{animation:gus-ring 1.8s ease-out 3}
.gus-fab.ping::after{animation:gus-ring 1.8s ease-out .9s 3}
.gus-fab .gus{width:56px;height:auto}
.gus-fab .tip{position:absolute;right:72px;bottom:12px;white-space:nowrap;padding:7px 12px;border-radius:16px 16px 4px 16px;background:#22262B;color:${TXT};font:600 13px "Manrope",system-ui,sans-serif;box-shadow:0 8px 20px rgb(0 0 0/.35);opacity:0;transform:translateX(6px);transition:opacity .25s,transform .25s;pointer-events:none}
.gus-fab:hover .tip,.gus-fab:focus-visible .tip,.gus-fab.hello .tip{opacity:1;transform:none}
@keyframes gus-ring{0%{transform:scale(1);opacity:.55}100%{transform:scale(1.6);opacity:0}}
@media (prefers-reduced-motion:reduce){.gus .gus-eyes,.gus-full .gus-body,.gus .gus-wave,.gus .gus-bar,.gus-fab.ping::before,.gus-fab.ping::after{animation:none}.gus-fab{transition:none}}
`;
  function injectCss() {
    if (document.getElementById("gus-css")) return;
    const st = document.createElement("style"); st.id = "gus-css"; st.textContent = css; document.head.appendChild(st);
  }

  // Langue du site (« lp-lang », partagée par toutes les pages) : textes du bouton flottant.
  const curLang = () => { try { return localStorage.getItem("lp-lang") || (navigator.language || "fr").slice(0, 2); } catch (e) { return "fr"; } };
  const FAB_TXT = {fr: ["Une question ? Demande à Gus.", "Parler à Gus, ton copilote"], en: ["Questions? Ask Gus.", "Talk to Gus, your trip copilot"]};
  function fabText(a, l) {
    const t = FAB_TXT[l] || FAB_TXT.fr;
    a.querySelector(".tip").textContent = t[0]; a.setAttribute("aria-label", t[1]);
  }

  const Gus = {
    MOODS,
    setLang(l) { const a = document.querySelector(".gus-fab"); if (a) fabText(a, l); },
    svg(opts = {}) { injectCss(); return draw({size: 120, ...opts}); },
    // Remplit un élément et renvoie un contrôleur pour changer d'humeur ou de pose.
    mount(el, opts = {}) {
      injectCss();
      const state = {size: 120, ...opts};
      const paint = () => { el.innerHTML = draw(state); };
      paint();
      return { set(patch) { Object.assign(state, patch); paint(); }, get mood() { return state.mood; } };
    },
    // Bouton assistant flottant (tête seule). Ne s'affiche pas sur la page du copilote.
    fab(opts = {}) {
      injectCss();
      if (document.querySelector(".gus-fab")) return null;
      const a = document.createElement("a");
      a.className = "gus-fab"; a.href = opts.href || "assistant.html";
      a.innerHTML = draw({head: true, size: 56, mood: opts.mood || "neutre"}) + `<span class="tip" aria-hidden="true"></span>`;
      fabText(a, curLang());
      if (opts.bottom) a.style.setProperty("--gus-fab-bottom", opts.bottom);
      if (opts.z) a.style.zIndex = opts.z;
      document.body.appendChild(a);
      if (!reduce()) {
        a.classList.add("ping");
        let seen = false;
        try { seen = sessionStorage.getItem("gus-hello") === "1"; sessionStorage.setItem("gus-hello", "1"); } catch (e) {}
        if (!seen) { setTimeout(() => a.classList.add("hello"), 1200); setTimeout(() => a.classList.remove("hello"), 5200); }
      }
      return { el: a, set(mood) { a.querySelector(".gus").outerHTML = draw({head: true, size: 56, mood}); } };
    },
  };
  window.Gus = Gus;
})();

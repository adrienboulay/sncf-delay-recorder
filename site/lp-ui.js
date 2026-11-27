/* LateProof : barre de navigation commune (mêmes liens sur toutes les pages, menu sur téléphone,
   pilule qui se resserre au défilement sur les pages vitrines), bandeau des nouveautés, apparitions au défilement.
   La langue suit <html lang> : les pages qui changent de langue sans recharger (accueil, carte) sont suivies. */
(function () {
  "use strict";
  const LINKS = [
    {href: "./#comment", fr: "Comment ça marche", en: "How it works"},
    {href: "./#avis", fr: "Avis", en: "Reviews"},
    {href: "./#faq", fr: "Questions", en: "FAQ"},
    {href: "carte.html", fr: "Ouvrir l'appli", en: "Open the app", cta: true},
  ];
  const lang = () => (document.documentElement.lang === "en" ? "en" : "fr");
  const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* navigation privée */ } },
  };

  function linkHtml() {
    return LINKS.map((l) => `<a href="${l.href}"${l.cta ? ' class="lpn-cta"' : ""}${here === l.href ? ' aria-current="page"' : ""} data-fr="${l.fr}" data-en="${l.en}">${l[lang()]}</a>`).join("");
  }
  function relabel() {
    document.querySelectorAll(".lpn-links a, .lpn-panel a").forEach((a) => { a.textContent = a.dataset[lang()]; });
    const b = document.querySelector(".lpn-menu");
    if (b) b.setAttribute("aria-label", lang() === "en" ? "Menu" : "Menu de navigation");
  }

  function mountNav() {
    const top = document.querySelector("header.top");
    if (!top || top.dataset.lpn) return;
    top.dataset.lpn = "1";
    top.classList.add("lpn-host");
    let nav = top.querySelector("nav.nav");
    if (!nav) { nav = document.createElement("nav"); nav.className = "nav"; top.appendChild(nav); }
    nav.setAttribute("aria-label", "Navigation");
    nav.querySelectorAll(":scope > a").forEach((a) => a.remove());   // les anciens liens, remplacés par la liste commune
    const links = document.createElement("div");
    links.className = "lpn-links";
    links.innerHTML = linkHtml();
    nav.prepend(links);

    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "lpn-menu"; btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "lpn-panel");
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="b" d="M4 7h16M4 12h16M4 17h10"/><path class="x" d="M6 6l12 12M18 6L6 18"/></svg>';
    nav.appendChild(btn);
    // Sélecteur FR | EN des pages qui le placent dans l'en-tête (lp-i18n.js) : juste avant le bouton de menu
    const lg = top.querySelector(":scope > .lp-lang");
    if (lg) nav.insertBefore(lg, btn);
    let panel = null;
    const close = () => { if (!panel) return; panel.remove(); panel = null; btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel) { close(); return; }
      panel = document.createElement("div");
      panel.className = "lpn-panel"; panel.id = "lpn-panel";
      panel.innerHTML = linkHtml();
      top.appendChild(panel);
      btn.setAttribute("aria-expanded", "true");
      panel.querySelector("a").focus({preventScroll: true});
    });
    document.addEventListener("click", (e) => { if (panel && !panel.contains(e.target)) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panel) { close(); btn.focus(); } });
    addEventListener("resize", () => { if (innerWidth >= 760) close(); });

    // Pages vitrines (accueil, avis) : barre collante qui devient une pilule au défilement
    if (document.body.dataset.lpnSticky !== undefined) {
      top.classList.add("lpn-sticky");
      const onScroll = () => top.classList.toggle("lpn-on", scrollY > 60);
      addEventListener("scroll", onScroll, {passive: true}); onScroll();
    }
    relabel();
    new MutationObserver(relabel).observe(document.documentElement, {attributes: true, attributeFilter: ["lang"]});
  }


  // Appli (carte, Gus, Mon espace) : une seule barre d'onglets, en bas sur téléphone, à gauche sur ordinateur
  const ICON = {
    carte: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
    home: '<path d="M4 11l8-7 8 7v8.5a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    voyages: '<rect x="5" y="3" width="14" height="14" rx="4"/><path d="M5 11h14M8 21l2-4M16 21l-2-4"/>',
    certs: '<path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6z"/><circle cx="12" cy="11.5" r="3"/><path d="M12 11.5l1.6 1"/>',
    gus: '<rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 7V4M9 13h.01M15 13h.01"/>',
    profil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.2-6 8-6s6.8 2 8 6"/>',
  };
  const TABS = [
    {id: "carte", href: "carte.html", fr: "Carte", en: "Map"},
    {id: "home", href: "app.html#/", fr: "Aujourd'hui", en: "Today"},
    {id: "voyages", href: "app.html#/voyages", fr: "Voyages", en: "Trips"},
    {id: "certs", href: "app.html#/justificatifs", fr: "Justificatifs", en: "Proofs"},
    {id: "gus", href: "assistant.html", fr: "Gus", en: "Gus", desk: true},   // sur téléphone, Gus est le bouton rond
    {id: "profil", href: "app.html#/profil", fr: "Profil", en: "Profile"},
  ];
  function appTab() {
    const app = document.body.dataset.app;
    if (app === "carte") return "carte";
    if (app === "gus") return "gus";
    const h = location.hash;
    return /^#\/(voyages?|nouveau)/.test(h) ? "voyages" : /^#\/justificatif/.test(h) ? "certs" : /^#\/profil/.test(h) ? "profil" : "home";
  }
  function mountTabs() {
    if (document.body.dataset.app === undefined || document.querySelector(".lpt")) return;
    const box = document.createElement("div");
    box.className = "lpt";
    box.innerHTML = `<a class="home" href="./" aria-label="LateProof"><svg width="40" height="40" viewBox="0 0 64 64" aria-hidden="true" style="fill:initial;stroke:none"><rect width="64" height="64" rx="18" fill="#D4FF3A"/><circle cx="32" cy="32" r="19" fill="none" stroke="#0B0C0F" stroke-opacity=".18" stroke-width="5"/><circle cx="32" cy="32" r="19" fill="none" stroke="#0B0C0F" stroke-width="5" stroke-linecap="round" pathLength="360" stroke-dasharray="120 360" transform="rotate(-90 32 32)"/><path d="M32 32L41.5 37.5" stroke="#0B0C0F" stroke-width="5" stroke-linecap="round"/><circle cx="32" cy="32" r="4" fill="#0B0C0F"/></svg></a>` +
      `<nav aria-label="${lang() === "en" ? "App" : "Appli"}">` + TABS.map((t) => `<a href="${t.href}" data-tab="${t.id}"${t.desk ? ' class="desk"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[t.id]}</svg><span data-fr="${t.fr}" data-en="${t.en}">${t[lang()]}</span></a>`).join("") + `</nav>`;
    document.body.appendChild(box);
    const mark = () => { const cur = appTab(); box.querySelectorAll("a[data-tab]").forEach((a) => a.dataset.tab === cur ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")); };
    mark(); addEventListener("hashchange", mark);
    // Ordinateur : le choix de la langue descend en bas du rail, la barre du haut disparaît
    const top = document.querySelector("header.top"), mq = matchMedia("(min-width:1024px)");
    const place = () => { const lg = document.querySelector(".lpn-host .lang, .lpn-host .lp-lang, .lpt .lang, .lpt .lp-lang"); if (!lg) return;
      if (mq.matches) box.appendChild(lg); else { const nav = top && top.querySelector("nav.nav"); if (nav) nav.insertBefore(lg, nav.querySelector(".lpn-menu")); } };
    place(); mq.addEventListener("change", place);
    new MutationObserver(() => box.querySelectorAll("[data-fr]").forEach((s) => { s.textContent = s.dataset[lang()]; })).observe(document.documentElement, {attributes: true, attributeFilter: ["lang"]});
  }

  // Bandeau des nouveautés : <div data-lp-banner="id" data-fr="..." data-en="..." data-href="..." data-link-fr="..." data-link-en="...">
  function mountBanner() {
    const el = document.querySelector("[data-lp-banner]");
    if (!el) return;
    const id = "lp-banner-" + el.dataset.lpBanner;
    if (store.get(id)) { el.remove(); return; }
    const draw = () => {
      const l = lang();
      el.innerHTML = `<div class="in"><span class="new">${l === "en" ? "New" : "Nouveau"}</span><span>${el.dataset[l]}</span>` +
        (el.dataset.href ? ` <a href="${el.dataset.href}">${el.dataset[l === "en" ? "linkEn" : "linkFr"]} →</a>` : "") +
        `</div><button type="button" class="close" aria-label="${l === "en" ? "Close" : "Fermer"}"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>`;
      el.querySelector(".close").addEventListener("click", () => { store.set(id, "1"); el.remove(); });
    };
    el.className = "lpb"; el.setAttribute("role", "region"); el.setAttribute("aria-label", lang() === "en" ? "News" : "Nouveautés");
    draw();
    new MutationObserver(() => { if (el.isConnected) draw(); }).observe(document.documentElement, {attributes: true, attributeFilter: ["lang"]});
  }

  // Apparition douce des blocs marqués .lp-rv, une seule fois
  function mountReveal() {
    const els = document.querySelectorAll(".lp-rv");
    if (!els.length) return;
    if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) { els.forEach((e) => e.classList.add("in")); return; }
    const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } }), {rootMargin: "0px 0px -8% 0px"});
    els.forEach((e) => io.observe(e));
  }

  const ready = () => { mountNav(); mountTabs(); mountBanner(); mountReveal(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
  window.LPNav = {relabel};
})();

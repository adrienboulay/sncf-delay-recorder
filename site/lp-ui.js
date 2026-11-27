/* LateProof : barre de navigation commune (mêmes liens sur toutes les pages, menu sur téléphone,
   pilule qui se resserre au défilement sur les pages vitrines), bandeau des nouveautés, apparitions au défilement.
   La langue suit <html lang> : les pages qui changent de langue sans recharger (accueil, carte) sont suivies. */
(function () {
  "use strict";
  const LINKS = [
    {href: "carte.html", fr: "Carte", en: "Map"},
    {href: "assistant.html", fr: "Copilote", en: "Copilot"},
    {href: "./#avis", fr: "Avis", en: "Reviews"},
    {href: "app.html", fr: "Mon espace", en: "My space", cta: true},
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

  const ready = () => { mountNav(); mountBanner(); mountReveal(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
  window.LPNav = {relabel};
})();

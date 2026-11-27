/* Langue du site (FR / EN), partagée par toutes les pages via « lp-lang ».
   L("texte français", "English text") renvoie le texte dans la langue choisie.
   Ajoute un sélecteur FR | EN dans l'en-tête (élément .top) ; changer de langue recharge la page. */
(function () {
  "use strict";
  let lang = "fr";
  try { lang = localStorage.getItem("lp-lang") || (navigator.language || "fr").slice(0, 2); } catch (e) {}
  if (lang !== "en") lang = "fr";
  document.documentElement.lang = lang;
  const L = (fr, en) => (lang === "en" ? en : fr);
  const locale = lang === "en" ? "en-GB" : "fr-FR";

  function setLang(l) {
    try { localStorage.setItem("lp-lang", l); } catch (e) {}
    location.reload();
  }
  function mountToggle() {
    const top = document.querySelector(".top");
    if (!top || top.querySelector(".lp-lang")) return;
    const box = document.createElement("div");
    box.className = "lp-lang"; box.setAttribute("role", "group"); box.setAttribute("aria-label", L("Langue", "Language"));
    box.innerHTML = ["fr", "en"].map((l) => `<button type="button" data-l="${l}" aria-pressed="${l === lang}">${l.toUpperCase()}</button>`).join("");
    box.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && b.dataset.l !== lang) setLang(b.dataset.l); });
    top.appendChild(box);
    if (!document.getElementById("lp-lang-css")) {
      const st = document.createElement("style"); st.id = "lp-lang-css";
      st.textContent = ".lp-lang{display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:var(--surface2,#22262B);flex:none}" +
        ".lp-lang button{border:0;border-radius:999px;background:none;color:var(--muted,#9DA2AA);font:700 .78rem/1 var(--display,system-ui);padding:7px 10px;min-height:32px;cursor:pointer}" +
        ".lp-lang button[aria-pressed=true]{background:var(--lime,#D4FF3A);color:#121417}";
      document.head.appendChild(st);
    }
  }
  // Texte fixe de la page : <p data-en="English">Français</p>, et data-en-placeholder / data-en-label / data-en-title.
  function applyStatic(root) {
    if (lang !== "en") return;
    (root || document).querySelectorAll("[data-en]").forEach((el) => { el.innerHTML = el.dataset.en; });
    (root || document).querySelectorAll("[data-en-placeholder]").forEach((el) => { el.placeholder = el.dataset.enPlaceholder; });
    (root || document).querySelectorAll("[data-en-label]").forEach((el) => { el.setAttribute("aria-label", el.dataset.enLabel); });
    (root || document).querySelectorAll("[data-en-title]").forEach((el) => { el.title = el.dataset.enTitle; });
  }
  const ready = () => { applyStatic(); mountToggle(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();

  window.LPI = {lang, L, locale, setLang, mountToggle, applyStatic};
})();

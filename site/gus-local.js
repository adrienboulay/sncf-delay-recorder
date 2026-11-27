/* Gus sans IA : comprend les questions courantes et répond directement avec nos données en direct
   (mêmes fonctions publiques que la carte). Rien n'est inventé : sans donnée, Gus le dit.
   Reprend la logique des outils du serveur (supabase/functions/assistant/tools.ts). */
(function () {
  "use strict";
  const rpc = (fn, body) => window.LP.rpc(fn, body);
  const TZ = "Europe/Paris";
  const fmtTime = new Intl.DateTimeFormat("fr-FR", {timeZone: TZ, hour: "2-digit", minute: "2-digit"});
  const fmtDay = new Intl.DateTimeFormat("fr-FR", {timeZone: TZ, weekday: "long", day: "numeric", month: "long"});
  const hhmm = (t) => (t ? fmtTime.format(new Date(t * 1000)).replace(":", "h") : "?");
  const day = (t) => (t ? fmtDay.format(new Date(t * 1000)) : "");
  const mins = (s) => Math.round((s || 0) / 60);
  const now = () => Math.floor(Date.now() / 1000);
  const norm = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’\-]/g, " ").replace(/\s+/g, " ").trim();
  const late = (s) => (mins(s) >= 1 ? `${mins(s)} min de retard` : "à l'heure");
  const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;

  // ---------------------------------------------------------------- lignes
  let linesCache = null;
  const allLines = async () => (linesCache = linesCache || (await rpc("public_lines").catch(() => [])) || []);
  const MODE_WORDS = {rer: ["RER"], metro: ["METRO"], tram: ["TRAM"], tramway: ["TRAM"], transilien: ["TRANSILIEN"], ter: ["TER"],
    tgv: ["OUI", "OGO", "LYR", "ICE", "TT"], inoui: ["OUI"], ouigo: ["OGO"], intercites: ["IC", "ICN"], lyria: ["LYR"]};
  const MODE_NAME = {RER: "RER", METRO: "métro", TRAM: "tram", TRANSILIEN: "ligne", TER: "TER", OUI: "TGV", OGO: "OUIGO", IC: "Intercités", ICN: "Intercités de nuit", LYR: "Lyria", ICE: "ICE", TT: "tram-train"};
  const lineName = (l) => (l.mode === "TRANSILIEN" ? `ligne ${l.name}` : `${MODE_NAME[l.mode] || l.mode} ${l.name}`);
  const onLine = (l) => (l.mode === "TRANSILIEN" ? `sur la ligne ${l.name}` : `sur le ${lineName(l)}`);
  // « A » seul ne dit rien : « RER A », « métro 1 », « TER C1 ».
  const depLine = (x) => (x.line && x.line.length <= 3 && MODE_NAME[x.mode] ? `${x.mode === "TRANSILIEN" ? "ligne" : MODE_NAME[x.mode]} ${x.line}` : x.line || MODE_NAME[x.mode] || "");
  // Une perturbation déjà commencée : « depuis le … » ; à venir : « le … ».
  const when = (it) => (!it.t_start ? "" : it.t_start <= now() ? (it.t_end ? `jusqu'au ${day(it.t_end)}` : "en cours") : `à partir du ${day(it.t_start)}`);
  // Référence à une ligne dans la phrase : « RER B », « métro 14 », « ligne P », « T3b », « TER C1 »
  const LINE_RE = /\b(?:rer|metro|tram|tramway|transilien|ter|ligne)\s+([a-z]?\d{1,2}[a-z]?|[a-z])\b|\b(t\d{1,2}[ab]?)\b/;
  function findLineRef(text) {
    const t = norm(text), m = t.match(LINE_RE);
    if (!m) return null;
    const mode = (t.match(/\b(rer|metro|tram|tramway|transilien|ter)\b/) || [])[1];
    return {key: (m[1] || m[2]).toLowerCase(), modes: mode ? MODE_WORDS[mode] : null};
  }
  async function matchLine(ref) {
    const lines = await allLines();
    const ok = (l) => !ref.modes || ref.modes.includes(l.mode);
    return lines.filter((l) => norm(l.name) === ref.key && ok(l))
      .sort((a, b) => (a.net === "idf" ? -1 : 1) - (b.net === "idf" ? -1 : 1) || (b.n || 0) - (a.n || 0))[0] || null;
  }

  // ---------------------------------------------------------------- réponses
  async function trainAnswer(num) {
    const t = await rpc("public_train", {p_num: num}).catch(() => null);
    if (!t || !(t.stops || []).length) return {text: `Je ne trouve pas le train ${num} aujourd'hui. Je suis les trains SNCF par leur numéro (TGV, Intercités, TER).`, mood: "neutre"};
    const stops = t.stops, last = stops[stops.length - 1], first = stops[0];
    const arrDelay = last[3] ?? last[4] ?? 0, skipped = stops.filter((s) => s[5]).length;
    let text = `Le train ${num}, ${first[0]} → ${last[0]} : `;
    if (/CANCEL|DELETED/i.test(t.status || "")) text += "il est supprimé aujourd'hui.";
    else text += `${late(arrDelay)} à l'arrivée, prévue à ${hhmm(last[1])}${mins(arrDelay) >= 1 ? ` (réelle ${hhmm(last[1] + arrDelay)})` : ""}.`;
    if (skipped) text += ` ${plural(skipped, "arrêt")} ${skipped > 1 ? "sont supprimés" : "est supprimé"}.`;
    if ((t.alerts || [])[0]) text += ` Alerte : ${String(t.alerts[0]).slice(0, 140)}.`;
    return {text, mood: mins(arrDelay) >= 5 || skipped || /CANCEL/i.test(t.status || "") ? "retard" : "content"};
  }

  async function lineAnswer(l) {
    const [d, disr] = await Promise.all([rpc("public_line", {p_net: l.net, p_id: l.id}).catch(() => null), rpc("public_disruptions", {days: 2}).catch(() => null)]);
    const n = d?.n ?? l.n ?? 0, l15 = d?.late15 ?? l.late15 ?? 0, cx = d?.cancelled ?? l.cancelled ?? 0;
    const items = ((disr && disr.items) || []).filter((it) => (it.line_ids || []).includes(l.id));
    let text = n ? `${lineName(l).replace(/^./, (c) => c.toUpperCase())} aujourd'hui : ${plural(n, "train")} relevé${n > 1 ? "s" : ""}, ${l15} en retard de 15 min ou plus, ${cx ? plural(cx, "supprimé") : "aucun supprimé"}.`
      : `${lineName(l)} : pas d'horaire publié en temps réel (métro ou tram), je regarde les perturbations.`;
    if (items.length) text += ` Perturbation : ${String(items[0].title).slice(0, 160)}${when(items[0]) ? ` (${when(items[0])})` : ""}.`;
    else text += " Aucune perturbation annoncée.";
    const bad = n && (l15 / n > 0.08 || cx > 0) || items.some((it) => it.severity === "bloquant" || /BLOQ/i.test(it.severity || ""));
    return {text, mood: bad ? "retard" : "content"};
  }

  const TRANSPORT = /\b(sncf|ratp|transports?|cheminots?|trains?|ter|tgv|rer|metros?|trams?|bus|transilien|ouigo|intercites|aiguilleurs|controleurs|conducteurs|idfm)\b/;
  async function disruptionAnswer(text, l) {
    const t = norm(text), days = /semaine|7 jours|prochains jours/.test(t) ? 7 : /demain/.test(t) ? 2 : 2;
    const d = await rpc("public_disruptions", {days}).catch(() => null);
    let items = ((d && d.items) || []).filter((it) => it.kind !== "greve" || it.lines || TRANSPORT.test(norm(it.title || "")));
    if (/greve|mouvement social/.test(t)) items = items.filter((it) => it.kind === "greve");
    if (l) items = items.filter((it) => (it.line_ids || []).includes(l.id));
    if (!items.length) return {text: `Aucune ${/greve/.test(t) ? "grève" : "perturbation"} annoncée ${days === 7 ? "cette semaine" : "dans les 2 prochains jours"}${l ? ` ${onLine(l)}` : ""}.`, mood: "content"};
    items.sort((x, y) => Number(!x.lines) - Number(!y.lines));
    const top = items.slice(0, 3).map((it) => `${String(it.title).slice(0, 110)}${when(it) ? ` (${when(it)})` : ""}`);
    return {text: `${plural(items.length, "perturbation")} annoncée${items.length > 1 ? "s" : ""}${l ? ` ${onLine(l)}` : ""}. ${top.join(" ; ")}.`, mood: "retard",
      link: {href: "carte.html", label: "Voir sur la carte →"}};
  }

  async function stationAnswer(name) {
    const found = await rpc("public_find_stop", {p_q: name.slice(0, 80)}).catch(() => []);
    if (!found || !found.length) return {text: `Je ne trouve pas la gare « ${name} ». Essaie avec son nom complet, par exemple « Lyon Part-Dieu ».`, mood: "neutre"};
    const s = found[0], st = await rpc("public_station", {p_net: s.net, p_id: s.id}).catch(() => null);
    const deps = ((st && st.next) || []).filter((x) => x.sched + Math.max(x.delay || 0, 0) >= now() - 60)
      .sort((x, y) => x.sched + Math.max(x.delay, 0) - (y.sched + Math.max(y.delay, 0))).slice(0, 3);
    const metro = ((st && st.metro_next) || []).slice(0, 2);
    if (!deps.length && !metro.length) return {text: `Pas de départ relevé à ${s.name} dans l'heure qui vient.`, mood: "neutre"};
    const parts = deps.map((x) => `${hhmm(x.sched)} ${depLine(x)} vers ${x.dest}, ${x.cancelled ? "supprimé" : late(x.delay)}`.replace(/\s+/g, " "));
    metro.forEach((m) => { const n = (m.t || [])[0]; if (n) parts.push(`${m.line} vers ${m.dest} dans ${Math.max(0, Math.round((n - now()) / 60))} min`); });
    const bad = deps.some((x) => x.cancelled || mins(x.delay) >= 5);
    return {text: `Prochains départs à ${s.name} : ${parts.join(" ; ")}.`, mood: bad ? "retard" : "content"};
  }

  async function homeTripAnswer(trajet) {
    const parts = (trajet || "").split(/\s*(?:→|->|>|–|—| - | à | a | vers )\s*/i).filter(Boolean);
    if (parts.length !== 2) return {text: "Indique ton trajet habituel juste au-dessus (par exemple « Lyon Part-Dieu → Grenoble ») et je le surveille.", mood: "neutre"};
    const [A, B] = await Promise.all(parts.map((p) => rpc("public_find_stop", {p_q: p}).catch(() => [])));
    const link = {href: `carte.html#de=${encodeURIComponent(parts[0])}&vers=${encodeURIComponent(parts[1])}`, label: "Voir l'itinéraire →"};
    if (!A.length || !B.length) return {text: `Je ne reconnais pas ${!A.length ? parts[0] : parts[1]}. Vérifie l'orthographe de ton trajet habituel.`, mood: "neutre"};
    for (const x of A.slice(0, 2)) for (const y of B.slice(0, 2)) {
      if (x.net !== y.net) continue;
      const t = await rpc("public_trip", {p_net: x.net, p_from: x.id, p_to: y.id}).catch(() => null);
      if (!t || !t.n) continue;
      const next = (t.trains || []).filter((r) => r.dep + Math.max(r.dep_delay || 0, 0) >= now() - 300).slice(0, 2);
      if (!next.length) return {text: `Plus de train direct ${x.name} → ${y.name} aujourd'hui. Aujourd'hui : ${t.late15} en retard de 15 min ou plus, ${t.cancelled} supprimé${t.cancelled > 1 ? "s" : ""}.`, mood: "neutre", link};
      const txt = next.map((r) => `${hhmm(r.dep)}, ${r.cancelled ? "supprimé" : late(r.arr_delay ?? r.dep_delay)}`).join(" ; ");
      const bad = next.some((r) => r.cancelled || mins(r.arr_delay ?? r.dep_delay) >= 5);
      return {text: `${x.name} → ${y.name}, prochains trains directs : ${txt}.${bad ? " Je t'ouvre les autres options si besoin." : ""}`, mood: bad ? "retard" : "content", link};
    }
    return {text: `Pas de train direct ${A[0].name} → ${B[0].name} dans nos relevés : regarde l'itinéraire avec correspondance.`, mood: "neutre", link};
  }

  function rightsAnswer(text) {
    const t = norm(text);
    if (/navigo|rer|metro|transilien|ile de france|ratp/.test(t)) return {text: "En Île-de-France, avec le Navigo, il n'y a pas d'indemnisation trajet par trajet. Île-de-France Mobilités annonce parfois un dédommagement des abonnés après de fortes perturbations. Ton justificatif LateProof prouve ton retard auprès de ton employeur. À vérifier sur le site de l'opérateur.", mood: "neutre"};
    if (/travail|employeur|patron|manager|boulot|cours|ecole/.test(t)) return {text: "Un retard justifié dû aux transports ne devrait pas être sanctionné, mais le temps non travaillé peut ne pas être payé. Crée un justificatif LateProof : ton manager le vérifie en 3 secondes. À vérifier avec ton employeur.", mood: "neutre", link: {href: "app.html#/voyages", label: "Créer un justificatif →"}};
    return {text: "Pour un TGV, un Intercités ou un TER : 25 % du prix du billet dès 60 min de retard à l'arrivée, 50 % dès 120 min (règlement européen). Sur TGV INOUI et Intercités, la SNCF compense aussi dès 30 min (Garantie G30), à demander en ligne. À vérifier sur le site de l'opérateur.", mood: "neutre"};
  }

  // ---------------------------------------------------------------- aiguillage
  const RIGHTS_RE = /\b(droits?|indemni\w*|rembours\w*|compens\w*|g30|dedommag\w*)\b/;
  const DISR_RE = /\b(greves?|travaux|perturbations?|perturbe\w*|incidents?|mouvement social|bloque\w*)\b/;
  const STATION_RE = /(?:prochains?\s+(?:departs?|trains?|passages?|rames?)|departs?|horaires?)\s+(?:a|de|depuis|en gare de|a la gare de|gare de)\s+(.+)$/;

  async function answer(raw, opts = {}) {
    const t = norm(raw).replace(/[?!.]+$/g, "").trim();
    if (!t || !window.LP || !window.LP.CFG.url) return null;
    // 1. Numéro de train
    const num = t.match(/\b(?:train|tgv|ter|intercites|ouigo|inoui|n°|numero|no)\s*(?:n°|no|numero)?\s*(\d{3,6})\b/);
    if (num) return trainAnswer(num[1]);
    // 2. Droits
    if (RIGHTS_RE.test(t)) return rightsAnswer(t);
    // 3. Grèves, travaux, perturbations (éventuellement sur une ligne)
    const ref = findLineRef(t), l = ref ? await matchLine(ref) : null;
    if (DISR_RE.test(t) && !/mon (trajet|train)/.test(t)) return disruptionAnswer(t, l);
    // 4. Mon trajet habituel
    if (/\bmon (trajet|train|ligne)( habituel)?\b/.test(t)) return homeTripAnswer(opts.trajet);
    // 5. État d'une ligne
    if (ref) return l ? lineAnswer(l) : {text: `Je ne trouve pas cette ligne. Exemples : « RER B », « métro 14 », « T3b », « ligne P ».`, mood: "neutre"};
    // 6. Départs d'une gare
    const sm = t.match(STATION_RE);
    if (sm) return stationAnswer(sm[1].replace(/\b(maintenant|aujourd hui|ce soir|ce matin)\b/g, "").trim());
    return null;
  }
  // Un « lieu » qui parle d'heure, de retard ou d'une ligne n'en est pas un : « le RER B va-t-il arriver à l'heure ».
  const badPlace = (p) => { const t = norm(p); return !t || !!(t.match(LINE_RE) || /\b(heure|heures|retard|avance|travail|boulot|cause|supprime|temps)\b/.test(t)); };

  window.GusLocal = {answer, badPlace};
})();

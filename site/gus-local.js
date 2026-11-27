/* Gus sans IA : comprend les questions courantes et répond directement avec nos données en direct
   (mêmes fonctions publiques que la carte). Rien n'est inventé : sans donnée, Gus le dit.
   Français et anglais (langue du site : lp-i18n.js). Reprend la logique des outils du serveur
   (supabase/functions/assistant/tools.ts). */
(function () {
  "use strict";
  const EN = !!(window.LPI && LPI.lang === "en");
  const L = (fr, en) => (EN ? en : fr);
  const rpc = (fn, body) => window.LP.rpc(fn, body);
  const TZ = "Europe/Paris";
  const fmtTime = new Intl.DateTimeFormat(EN ? "en-GB" : "fr-FR", {timeZone: TZ, hour: "2-digit", minute: "2-digit"});
  const fmtDay = new Intl.DateTimeFormat(EN ? "en-GB" : "fr-FR", {timeZone: TZ, weekday: "long", day: "numeric", month: "long"});
  const hhmm = (t) => (t ? (EN ? fmtTime.format(new Date(t * 1000)) : fmtTime.format(new Date(t * 1000)).replace(":", "h")) : "?");
  const day = (t) => (t ? fmtDay.format(new Date(t * 1000)) : "");
  const mins = (s) => Math.round((s || 0) / 60);
  const now = () => Math.floor(Date.now() / 1000);
  const norm = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’\-]/g, " ").replace(/\s+/g, " ").trim();
  const late = (s) => (mins(s) >= 1 ? L(`${mins(s)} min de retard`, `${mins(s)} min late`) : L("à l'heure", "on time"));
  const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
  const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());

  // ---------------------------------------------------------------- lignes
  let linesCache = null;
  const allLines = async () => (linesCache = linesCache || (await rpc("public_lines").catch(() => [])) || []);
  const MODE_WORDS = {rer: ["RER"], metro: ["METRO"], tram: ["TRAM"], tramway: ["TRAM"], transilien: ["TRANSILIEN"], ter: ["TER"],
    tgv: ["OUI", "OGO", "LYR", "ICE", "TT"], inoui: ["OUI"], ouigo: ["OGO"], intercites: ["IC", "ICN"], lyria: ["LYR"]};
  const MODE_NAME = {RER: "RER", METRO: L("métro", "metro"), TRAM: "tram", TRANSILIEN: L("ligne", "line"), TER: "TER", OUI: "TGV", OGO: "OUIGO", IC: "Intercités", ICN: L("Intercités de nuit", "Intercités night train"), LYR: "Lyria", ICE: "ICE", TT: "tram-train"};
  const lineName = (l) => (l.mode === "TRANSILIEN" ? `${L("ligne", "line")} ${l.name}` : `${MODE_NAME[l.mode] || l.mode} ${l.name}`);
  const onLine = (l) => (EN ? `on the ${lineName(l)}` : l.mode === "TRANSILIEN" ? `sur la ligne ${l.name}` : `sur le ${lineName(l)}`);
  // « A » seul ne dit rien : « RER A », « métro 1 », « TER C1 ».
  const depLine = (x) => (x.line && x.line.length <= 3 && MODE_NAME[x.mode] ? `${MODE_NAME[x.mode]} ${x.line}` : x.line || MODE_NAME[x.mode] || "");
  // Perturbation déjà commencée : « jusqu'au … » ; à venir : « à partir du … ».
  const when = (it) => (!it.t_start ? "" : it.t_start <= now()
    ? (it.t_end ? L(`jusqu'au ${day(it.t_end)}`, `until ${day(it.t_end)}`) : L("en cours", "ongoing"))
    : L(`à partir du ${day(it.t_start)}`, `from ${day(it.t_start)}`));
  // Référence à une ligne : « RER B », « métro 14 », « ligne P », « line P », « T3b », « TER C1 »
  const LINE_RE = /\b(?:rer|metro|tram|tramway|transilien|ter|ligne|line)\s+([a-z]?\d{1,2}[a-z]?|[a-z])\b|\b(t\d{1,2}[ab]?)\b/;
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
    if (!t || !(t.stops || []).length) return {text: L(`Je ne trouve pas le train ${num} aujourd'hui. Je suis les trains SNCF par leur numéro (TGV, Intercités, TER).`, `I can't find train ${num} today. I track SNCF trains by number (TGV, Intercités, TER).`), mood: "neutre"};
    const stops = t.stops, last = stops[stops.length - 1], first = stops[0];
    const arrDelay = last[3] ?? last[4] ?? 0, skipped = stops.filter((s) => s[5]).length;
    const cancelled = /CANCEL|DELETED/i.test(t.status || "");
    let text = L(`Le train ${num}, ${first[0]} → ${last[0]} : `, `Train ${num}, ${first[0]} → ${last[0]}: `);
    if (cancelled) text += L("il est supprimé aujourd'hui.", "it is cancelled today.");
    else text += L(`${late(arrDelay)} à l'arrivée, prévue à ${hhmm(last[1])}${mins(arrDelay) >= 1 ? ` (réelle ${hhmm(last[1] + arrDelay)})` : ""}.`,
      `${late(arrDelay)} at arrival, scheduled ${hhmm(last[1])}${mins(arrDelay) >= 1 ? ` (actual ${hhmm(last[1] + arrDelay)})` : ""}.`);
    if (skipped) text += L(` ${plural(skipped, "arrêt")} ${skipped > 1 ? "sont supprimés" : "est supprimé"}.`, ` ${plural(skipped, "stop")} ${skipped > 1 ? "are" : "is"} cancelled.`);
    if ((t.alerts || [])[0]) text += ` ${L("Alerte", "Alert")} : ${String(t.alerts[0]).slice(0, 140)}.`;
    return {text, mood: mins(arrDelay) >= 5 || skipped || cancelled ? "retard" : "content"};
  }

  async function lineAnswer(l) {
    const [d, disr] = await Promise.all([rpc("public_line", {p_net: l.net, p_id: l.id}).catch(() => null), rpc("public_disruptions", {days: 2}).catch(() => null)]);
    const n = d?.n ?? l.n ?? 0, l15 = d?.late15 ?? l.late15 ?? 0, cx = d?.cancelled ?? l.cancelled ?? 0;
    const items = ((disr && disr.items) || []).filter((it) => (it.line_ids || []).includes(l.id));
    let text = n
      ? L(`${cap(lineName(l))} aujourd'hui : ${plural(n, "train")} relevé${n > 1 ? "s" : ""}, ${l15} en retard de 15 min ou plus, ${cx ? plural(cx, "supprimé") : "aucun supprimé"}.`,
        `${cap(lineName(l))} today: ${plural(n, "train")} recorded, ${l15} late by 15 min or more, ${cx ? `${cx} cancelled` : "none cancelled"}.`)
      : L(`${cap(lineName(l))} : pas d'horaire publié en temps réel (métro ou tram), je regarde les perturbations.`, `${cap(lineName(l))}: no live timetable is published (metro or tram), so I check disruptions.`);
    if (items.length) text += ` ${L("Perturbation", "Disruption")} : ${String(items[0].title).slice(0, 160)}${when(items[0]) ? ` (${when(items[0])})` : ""}.`;
    else text += L(" Aucune perturbation annoncée.", " No disruption announced.");
    const bad = n && (l15 / n > 0.08 || cx > 0) || items.some((it) => /BLOQ/i.test(it.severity || ""));
    return {text, mood: bad ? "retard" : "content"};
  }

  const TRANSPORT = /\b(sncf|ratp|transports?|cheminots?|trains?|ter|tgv|rer|metros?|trams?|bus|transilien|ouigo|intercites|aiguilleurs|controleurs|conducteurs|idfm)\b/;
  async function disruptionAnswer(text, l) {
    const t = norm(text), days = /semaine|7 jours|prochains jours|week|7 days|next days/.test(t) ? 7 : 2;
    const d = await rpc("public_disruptions", {days}).catch(() => null);
    let items = ((d && d.items) || []).filter((it) => it.kind !== "greve" || it.lines || TRANSPORT.test(norm(it.title || "")));
    const strikes = /greve|mouvement social|strike/.test(t);
    if (strikes) items = items.filter((it) => it.kind === "greve");
    if (l) items = items.filter((it) => (it.line_ids || []).includes(l.id));
    if (!items.length) return {text: L(`Aucune ${strikes ? "grève" : "perturbation"} annoncée ${days === 7 ? "cette semaine" : "dans les 2 prochains jours"}${l ? ` ${onLine(l)}` : ""}.`,
      `No ${strikes ? "strike" : "disruption"} announced ${days === 7 ? "this week" : "in the next 2 days"}${l ? ` ${onLine(l)}` : ""}.`), mood: "content"};
    items.sort((x, y) => Number(!x.lines) - Number(!y.lines));
    const top = items.slice(0, 3).map((it) => `${String(it.title).slice(0, 110)}${when(it) ? ` (${when(it)})` : ""}`);
    return {text: L(`${plural(items.length, "perturbation")} annoncée${items.length > 1 ? "s" : ""}${l ? ` ${onLine(l)}` : ""}. ${top.join(" ; ")}.`,
      `${plural(items.length, "disruption")} announced${l ? ` ${onLine(l)}` : ""} (official French titles): ${top.join("; ")}.`), mood: "retard",
      link: {href: "carte.html", label: L("Voir sur la carte →", "See on the map →")}};
  }

  async function stationAnswer(name) {
    const found = await rpc("public_find_stop", {p_q: name.slice(0, 80)}).catch(() => []);
    if (!found || !found.length) return {text: L(`Je ne trouve pas la gare « ${name} ». Essaie avec son nom complet, par exemple « Lyon Part-Dieu ».`, `I can't find the station “${name}”. Try its full name, for example “Lyon Part-Dieu”.`), mood: "neutre"};
    const s = found[0], st = await rpc("public_station", {p_net: s.net, p_id: s.id}).catch(() => null);
    const deps = ((st && st.next) || []).filter((x) => x.sched + Math.max(x.delay || 0, 0) >= now() - 60)
      .sort((x, y) => x.sched + Math.max(x.delay, 0) - (y.sched + Math.max(y.delay, 0))).slice(0, 3);
    const metro = ((st && st.metro_next) || []).slice(0, 2);
    if (!deps.length && !metro.length) return {text: L(`Pas de départ relevé à ${s.name} dans l'heure qui vient.`, `No departure recorded at ${s.name} in the coming hour.`), mood: "neutre"};
    const parts = deps.map((x) => `${hhmm(x.sched)} ${depLine(x)} ${L("vers", "to")} ${x.dest}, ${x.cancelled ? L("supprimé", "cancelled") : late(x.delay)}`.replace(/\s+/g, " "));
    metro.forEach((m) => { const n = (m.t || [])[0]; if (n) parts.push(`${/^t/i.test(m.line) ? "tram " : L("métro ", "metro ")}${m.line} ${L("vers", "to")} ${m.dest} ${L("dans", "in")} ${Math.max(0, Math.round((n - now()) / 60))} min`); });
    const bad = deps.some((x) => x.cancelled || mins(x.delay) >= 5);
    return {text: L(`Prochains départs à ${s.name} : ${parts.join(" ; ")}.`, `Next departures at ${s.name}: ${parts.join("; ")}.`), mood: bad ? "retard" : "content"};
  }

  async function homeTripAnswer(trajet) {
    const parts = (trajet || "").split(/\s*(?:→|->|>|–|—| - | à | a | vers | to )\s*/i).filter(Boolean);
    if (parts.length !== 2) return {text: L("Indique ton trajet habituel juste au-dessus (par exemple « Lyon Part-Dieu → Grenoble ») et je le surveille.", "Enter your usual trip just above (for example “Lyon Part-Dieu → Grenoble”) and I'll watch it."), mood: "neutre"};
    const [A, B] = await Promise.all(parts.map((p) => rpc("public_find_stop", {p_q: p}).catch(() => [])));
    const link = {href: `carte.html#de=${encodeURIComponent(parts[0])}&vers=${encodeURIComponent(parts[1])}`, label: L("Voir l'itinéraire →", "See the journey →")};
    if (!A.length || !B.length) return {text: L(`Je ne reconnais pas ${!A.length ? parts[0] : parts[1]}. Vérifie l'orthographe de ton trajet habituel.`, `I don't recognise ${!A.length ? parts[0] : parts[1]}. Check the spelling of your usual trip.`), mood: "neutre"};
    for (const x of A.slice(0, 2)) for (const y of B.slice(0, 2)) {
      if (x.net !== y.net) continue;
      const t = await rpc("public_trip", {p_net: x.net, p_from: x.id, p_to: y.id}).catch(() => null);
      if (!t || !t.n) continue;
      const next = (t.trains || []).filter((r) => r.dep + Math.max(r.dep_delay || 0, 0) >= now() - 300).slice(0, 2);
      if (!next.length) return {text: L(`Plus de train direct ${x.name} → ${y.name} aujourd'hui. Aujourd'hui : ${t.late15} en retard de 15 min ou plus, ${t.cancelled} supprimé${t.cancelled > 1 ? "s" : ""}.`,
        `No more direct train ${x.name} → ${y.name} today. Today: ${t.late15} late by 15 min or more, ${t.cancelled} cancelled.`), mood: "neutre", link};
      const txt = next.map((r) => `${hhmm(r.dep)}, ${r.cancelled ? L("supprimé", "cancelled") : late(r.arr_delay ?? r.dep_delay)}`).join(L(" ; ", "; "));
      const bad = next.some((r) => r.cancelled || mins(r.arr_delay ?? r.dep_delay) >= 5);
      return {text: L(`${x.name} → ${y.name}, prochains trains directs : ${txt}.${bad ? " Je t'ouvre les autres options si besoin." : ""}`,
        `${x.name} → ${y.name}, next direct trains: ${txt}.${bad ? " I can open the other options if needed." : ""}`), mood: bad ? "retard" : "content", link};
    }
    return {text: L(`Pas de train direct ${A[0].name} → ${B[0].name} dans nos relevés : regarde l'itinéraire avec correspondance.`, `No direct train ${A[0].name} → ${B[0].name} in our records: see the journey with a connection.`), mood: "neutre", link};
  }

  function rightsAnswer(text) {
    const t = norm(text);
    if (/navigo|rer|metro|transilien|ile de france|ratp|paris/.test(t)) return {text: L("En Île-de-France, avec le Navigo, il n'y a pas d'indemnisation trajet par trajet. Île-de-France Mobilités annonce parfois un dédommagement des abonnés après de fortes perturbations. Ton justificatif LateProof prouve ton retard auprès de ton employeur. À vérifier sur le site de l'opérateur.",
      "In the Paris region, with a Navigo pass, there is no compensation per trip. Île-de-France Mobilités sometimes announces a refund for pass holders after major disruptions. Your LateProof certificate proves your delay to your employer. Check with the operator."), mood: "neutre"};
    if (/travail|employeur|patron|manager|boulot|cours|ecole|work|employer|boss|school/.test(t)) return {text: L("Un retard justifié dû aux transports ne devrait pas être sanctionné, mais le temps non travaillé peut ne pas être payé. Crée un justificatif LateProof : ton manager le vérifie en 3 secondes. À vérifier avec ton employeur.",
      "In France, a justified transport delay should not be sanctioned, but time not worked may be unpaid. Create a LateProof certificate: your manager checks it in 3 seconds. Check with your employer."), mood: "neutre", link: {href: "app.html#/voyages", label: L("Créer un justificatif →", "Create a certificate →")}};
    return {text: L("Pour un TGV, un Intercités ou un TER : 25 % du prix du billet dès 60 min de retard à l'arrivée, 50 % dès 120 min (règlement européen). Sur TGV INOUI et Intercités, la SNCF compense aussi dès 30 min (Garantie G30), à demander en ligne. À vérifier sur le site de l'opérateur.",
      "For a TGV, Intercités or TER train: 25% of the ticket price from 60 min late on arrival, 50% from 120 min (EU regulation). On TGV INOUI and Intercités, SNCF also compensates from 30 min (G30 guarantee), claimed online. Check with the operator."), mood: "neutre"};
  }

  // ---------------------------------------------------------------- aiguillage
  const RIGHTS_RE = /\b(droits?|indemni\w*|rembours\w*|compens\w*|g30|dedommag\w*|rights?|refund\w*|claim)\b/;
  const DISR_RE = /\b(greves?|travaux|perturbations?|perturbe\w*|incidents?|mouvement social|bloque\w*|strikes?|works|engineering|disruptions?|disrupted|closures?)\b/;
  const STATION_RE = /(?:prochains?\s+(?:departs?|trains?|passages?|rames?)|departs?|horaires?|next\s+(?:departures?|trains?)|departures?|timetable)\s+(?:a|de|depuis|en gare de|a la gare de|gare de|at|from|in)\s+(.+)$/;
  const MY_TRIP_RE = /\bmon (trajet|train|ligne)( habituel)?\b|\bmy (usual )?(trip|train|commute|journey|line)\b/;

  async function answer(raw, opts = {}) {
    const t = norm(raw).replace(/[?!.]+$/g, "").trim();
    if (!t || !window.LP || !window.LP.CFG.url) return null;
    // 1. Numéro de train
    const num = t.match(/\b(?:train|tgv|ter|intercites|ouigo|inoui|n°|numero|no|number)\s*(?:n°|no|numero|number)?\s*(\d{3,6})\b/);
    if (num) return trainAnswer(num[1]);
    // 2. Droits
    if (RIGHTS_RE.test(t)) return rightsAnswer(t);
    // 3. Grèves, travaux, perturbations (éventuellement sur une ligne)
    const ref = findLineRef(t), l = ref ? await matchLine(ref) : null;
    if (DISR_RE.test(t) && !MY_TRIP_RE.test(t)) return disruptionAnswer(t, l);
    // 4. Mon trajet habituel
    if (MY_TRIP_RE.test(t)) return homeTripAnswer(opts.trajet);
    // 5. État d'une ligne
    if (ref) return l ? lineAnswer(l) : {text: L("Je ne trouve pas cette ligne. Exemples : « RER B », « métro 14 », « T3b », « ligne P ».", "I can't find that line. Examples: “RER B”, “metro 14”, “T3b”, “line P”."), mood: "neutre"};
    // 6. Départs d'une gare
    const sm = t.match(STATION_RE);
    if (sm) return stationAnswer(sm[1].replace(/\b(maintenant|aujourd hui|ce soir|ce matin|now|today|tonight|this morning)\b/g, "").trim());
    return null;
  }
  // Un « lieu » qui parle d'heure, de retard ou d'une ligne n'en est pas un : « le RER B va-t-il arriver à l'heure ».
  const badPlace = (p) => { const t = norm(p); return !t || !!(t.match(LINE_RE) || /\b(heure|heures|retard|avance|travail|boulot|cause|supprime|temps|time|late|work|delay)\b/.test(t)); };

  window.GusLocal = {answer, badPlace};
})();

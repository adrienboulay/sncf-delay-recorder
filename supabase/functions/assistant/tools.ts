// Outils de l'assistant : ils lisent NOS donnees (fonctions publiques de la base) et les mettent en forme courte.
// Le modele ne fait que choisir l'outil et resumer : il n'invente jamais un horaire, un retard ou un droit.

// deno-lint-ignore no-explicit-any
export type Json = any;
export type Rpc = (fn: string, body?: Record<string, unknown>) => Promise<Json>;

const TZ = "Europe/Paris";
const fmtTime = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
export const hhmm = (t?: number | null) => (t ? fmtTime.format(new Date(t * 1000)).replace(":", "h") : null);
export const dayTime = (t?: number | null) => (t ? `${fmtDay.format(new Date(t * 1000))} ${hhmm(t)}` : null);
const mins = (s?: number | null) => (s == null ? null : Math.round(s / 60));
const now = () => Math.floor(Date.now() / 1000);

/** Meme normalisation que lp_norm() en SQL : minuscules, sans accents, sans tirets ni apostrophes. */
export const norm = (t: string) =>
  (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’\-]/g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- definitions (format « function calling » standard)
export const TOOLS = [
  {
    name: "etat_gare",
    description: "Etat en temps reel d'une gare ou station (France, et metro/RER/tram/Transilien en Ile-de-France) : " +
      "prochains departs avec retards et suppressions, prochaines rames de metro/tram estimees, ponctualite du jour par ligne.",
    parameters: {
      type: "object",
      properties: { nom: { type: "string", description: "Nom de la gare ou station, ex. « Gare de Lyon », « Chatelet », « Lyon Part-Dieu »" } },
      required: ["nom"],
    },
  },
  {
    name: "trajet",
    description: "Trains DIRECTS du jour entre deux gares, avec horaires prevus, retards au depart et a l'arrivee, suppressions. " +
      "Ne trouve pas les trajets avec correspondance : dans ce cas, interroger chaque troncon separement.",
    parameters: {
      type: "object",
      properties: {
        depart: { type: "string", description: "Gare de depart" },
        arrivee: { type: "string", description: "Gare d'arrivee" },
      },
      required: ["depart", "arrivee"],
    },
  },
  {
    name: "etat_ligne",
    description: "Ponctualite du jour d'une ligne (RER B, metro 14, T3b, Transilien P, TER, TGV...) : trains, retards de plus de 15 min, " +
      "suppressions, gares les plus touchees, et perturbations en cours sur la ligne.",
    parameters: {
      type: "object",
      properties: { nom: { type: "string", description: "Ex. « RER B », « metro 14 », « T3b », « ligne P », « TER Lyon Grenoble »" } },
      required: ["nom"],
    },
  },
  {
    name: "perturbations",
    description: "Greves annoncees, travaux et incidents en cours ou a venir (SNCF et Ile-de-France Mobilites). " +
      "Filtrer par ligne ou par mot (ville, gare) si possible.",
    parameters: {
      type: "object",
      properties: {
        filtre: { type: "string", description: "Ligne, gare ou ville, ex. « RER A », « Grenoble ». Vide = tout." },
        jours: { type: "integer", description: "Fenetre en jours (1 a 7). Par defaut 2." },
      },
    },
  },
  {
    name: "train",
    description: "Detail d'un train SNCF du jour par son numero (TGV, Intercites, TER) : arrets, horaires, retards, arrets supprimes, alertes.",
    parameters: {
      type: "object",
      properties: { numero: { type: "string", description: "Numero du train, ex. « 6611 »" } },
      required: ["numero"],
    },
  },
] as const;

// ---------------------------------------------------------------- helpers
async function findStops(rpc: Rpc, nom: string): Promise<Json[]> {
  const r = await rpc("public_find_stop", { p_q: String(nom || "").slice(0, 80) });
  return Array.isArray(r) ? r : [];
}

let linesCache: { at: number; data: Json[] } | null = null;
async function allLines(rpc: Rpc): Promise<Json[]> {
  if (linesCache && Date.now() - linesCache.at < 600_000) return linesCache.data;
  const d = await rpc("public_lines");
  linesCache = { at: Date.now(), data: Array.isArray(d) ? d : [] };
  return linesCache.data;
}
export function _resetCache() { linesCache = null; }

const MODE_WORDS: Record<string, string[]> = {
  rer: ["RER"], metro: ["METRO"], tram: ["TRAM"], tramway: ["TRAM"], transilien: ["TRANSILIEN"], ter: ["TER"],
  tgv: ["OUI", "OGO", "LYR", "ICE", "TT"], inoui: ["OUI"], ouigo: ["OGO"], intercites: ["IC", "ICN"], lyria: ["LYR"],
};
const FILLER = new Set(["ligne", "la", "le", "les", "du", "de", "des", "l", "d"]);

/** Trouve une ligne a partir d'un nom libre (« RER B », « metro 14 », « T3b », « TER Lyon Grenoble »). */
export function matchLine(lines: Json[], q: string): Json[] {
  const words = norm(q).split(" ").filter(Boolean);
  const modes = words.flatMap((w) => MODE_WORDS[w] || []);
  const rest = words.filter((w) => !MODE_WORDS[w] && !FILLER.has(w));
  const key = rest.join(" ");
  const okMode = (l: Json) => !modes.length || modes.includes(l.mode);
  const exact = lines.filter((l) => key && norm(l.name) === key && okMode(l));
  if (exact.length) return exact.sort((a, b) => (a.net === "idf" ? -1 : 1) - (b.net === "idf" ? -1 : 1) || b.n - a.n);
  if (!rest.length) return [];
  return lines.filter((l) => okMode(l) && rest.every((w) => norm(`${l.name} ${l.long || ""}`).includes(w)))
    .sort((a, b) => b.n - a.n);
}

// ---------------------------------------------------------------- outils
async function etatGare(rpc: Rpc, a: Json) {
  const found = await findStops(rpc, a.nom);
  if (!found.length) return { erreur: `Aucune gare trouvee pour « ${a.nom} ». Demander une orthographe plus precise.` };
  const best = found[0];
  // Tous les points d'arret du meme lieu (gare SNCF + quais RER/metro/tram), comme la fiche gare de la carte.
  let ids: Json[] = [best];
  if (best.lat != null) {
    const near = await rpc("public_nearby_ids", { p_lat: best.lat, p_lon: best.lon, p_name: best.name }).catch(() => []);
    if (Array.isArray(near) && near.length) ids = near;
  }
  ids = ids.slice(0, 5);
  const lignes: Json[] = [], deps: Json[] = [], metro: Json[] = [];
  const seenDep = new Set<string>(), seenMetro = new Set<string>();
  for (const s of ids) {
    const st = await rpc("public_station", { p_net: s.net, p_id: s.id }).catch(() => null);
    if (!st) continue;
    for (const l of st.lines || []) {
      lignes.push({
        ligne: l.name, mode: l.mode, passages_du_jour: l.n, retards_15min: l.late15, supprimes: l.cancelled,
        ...(l.gap != null ? { intervalle_moyen_min: l.gap, intervalle_prevu_min: l.planned } : {}),
      });
    }
    for (const d of st.next || []) {
      const k = `${d.num}|${d.sched}`;
      if (seenDep.has(k)) continue;
      seenDep.add(k);
      deps.push(d);
    }
    for (const m of st.metro_next || []) {
      const k = `${m.line}|${m.dest}`;
      if (seenMetro.has(k)) continue;
      seenMetro.add(k);
      metro.push({ ligne: m.line, direction: m.dest, dans_min: (m.t || []).map((t: number) => Math.max(0, Math.round((t - now()) / 60))) });
    }
  }
  deps.sort((x, y) => x.sched + Math.max(x.delay, 0) - (y.sched + Math.max(y.delay, 0)));
  return {
    gare: best.name,
    autres_resultats: found.slice(1, 4).map((f) => f.name),
    lignes: lignes.slice(0, 12),
    prochains_departs: deps.slice(0, 12).map((d) => ({
      heure_prevue: hhmm(d.sched), retard_min: mins(d.delay), ligne: d.line, mode: d.mode, destination: d.dest,
      train: d.num, supprime: !!d.cancelled,
    })),
    metro_tram_prochaines_rames: metro.slice(0, 12),
  };
}

async function trajet(rpc: Rpc, a: Json) {
  const [A, B] = [await findStops(rpc, a.depart), await findStops(rpc, a.arrivee)];
  if (!A.length) return { erreur: `Gare de depart introuvable : « ${a.depart} ».` };
  if (!B.length) return { erreur: `Gare d'arrivee introuvable : « ${a.arrivee} ».` };
  let calls = 0;
  for (const x of A.slice(0, 3)) {
    for (const y of B.slice(0, 3)) {
      if (x.net !== y.net || calls >= 5) continue;
      calls++;
      const t = await rpc("public_trip", { p_net: x.net, p_from: x.id, p_to: y.id }).catch(() => null);
      if (!t || !t.n) continue;
      const t0 = now() - 600;
      const upcoming = (t.trains || []).filter((r: Json) => r.dep + Math.max(r.dep_delay || 0, 0) >= t0);
      return {
        de: x.name, a: y.name, trains_directs_du_jour: t.n, retards_15min: t.late15, supprimes: t.cancelled,
        prochains: (upcoming.length ? upcoming : (t.trains || []).slice(-3)).slice(0, 8).map((r: Json) => ({
          train: r.num, ligne: r.line, mode: r.mode, depart: hhmm(r.dep), retard_depart_min: mins(r.dep_delay),
          arrivee: hhmm(r.arr), retard_arrivee_min: mins(r.arr_delay), supprime: !!r.cancelled,
        })),
        ...(upcoming.length ? {} : { note: "Plus de train direct a venir aujourd'hui : ce sont les derniers de la journee." }),
      };
    }
  }
  return {
    resultat: `Aucun train direct trouve aujourd'hui entre ${A[0].name} et ${B[0].name} dans nos donnees. ` +
      "Le trajet demande peut-etre une correspondance (interroger chaque troncon), ou c'est un metro/tram sans horaires publies.",
  };
}

async function etatLigne(rpc: Rpc, a: Json) {
  const cands = matchLine(await allLines(rpc), a.nom);
  if (!cands.length) return { erreur: `Ligne introuvable : « ${a.nom} ». Exemples : « RER B », « metro 14 », « T3b », « ligne P ».` };
  const l = cands[0];
  const d = await rpc("public_line", { p_net: l.net, p_id: l.id }).catch(() => null);
  const disr = await rpc("public_disruptions", { days: 2 }).catch(() => null);
  const stops = (d?.stops || []) as Json[];
  const metro = stops.some((s) => s.gap != null);
  const worst = [...stops].sort((x, y) => (metro ? (y.gap || 0) - (x.gap || 0) : (y.avg || 0) - (x.avg || 0))).slice(0, 6);
  return {
    ligne: `${l.mode} ${l.name}`, nom_long: l.long, autres_lignes_possibles: cands.slice(1, 4).map((c) => `${c.mode} ${c.name} (${c.long})`),
    trains_du_jour: d?.n ?? l.n, retards_15min: d?.late15 ?? l.late15, supprimes: d?.cancelled ?? l.cancelled,
    ...(metro
      ? { stations_les_plus_irregulieres: worst.map((s) => ({ station: s.name, intervalle_moyen_min: s.gap })) }
      : { gares_les_plus_en_retard: worst.map((s) => ({ gare: s.name, retard_moyen_min: s.avg, retards_15min: s.late15, supprimes: s.cancelled })) }),
    perturbations: ((disr?.items || []) as Json[])
      .filter((it) => (it.line_ids || []).includes(l.id))
      .slice(0, 6).map(shortDisruption),
  };
}

const shortDisruption = (it: Json) => ({
  type: it.kind, gravite: it.severity, titre: String(it.title || "").slice(0, 220), lignes: it.lines,
  debut: dayTime(it.t_start), fin: dayTime(it.t_end),
});

async function perturbations(rpc: Rpc, a: Json) {
  const days = Math.min(Math.max(parseInt(a.jours) || 2, 1), 7);
  const d = await rpc("public_disruptions", { days });
  let items = ((d?.items || []) as Json[]);
  const f = norm(a.filtre || "");
  if (f) {
    const words = f.split(" ").filter((w) => !FILLER.has(w) && !MODE_WORDS[w]);
    const lineIds = new Set(matchLine(await allLines(rpc), a.filtre).slice(0, 3).map((l) => l.id));
    items = items.filter((it) =>
      (it.line_ids || []).some((id: string) => lineIds.has(id)) ||
      (words.length && words.every((w) => norm(`${it.title} ${it.lines || ""} ${(it.stops || []).map((s: Json) => s[0]).join(" ")}`).includes(w)))
    );
  }
  return { nombre: items.length, fenetre_jours: days, elements: items.slice(0, 12).map(shortDisruption) };
}

async function train(rpc: Rpc, a: Json) {
  const num = String(a.numero || "").replace(/\D/g, "").slice(0, 6);
  if (!num) return { erreur: "Numero de train manquant." };
  const t = await rpc("public_train", { p_num: num }).catch(() => null);
  if (!t || !(t.stops || []).length) return { erreur: `Train ${num} introuvable aujourd'hui dans nos donnees (seuls les trains SNCF sont suivis par numero).` };
  return {
    train: num, type: t.mode, ligne: t.line, relation: t.long, statut: t.status, retard_max_min: mins(t.max_delay),
    arrets: (t.stops as Json[]).slice(0, 40).map(([gare, sa, sd, ad, dd, skipped]) => ({
      gare, arrivee: hhmm(sa), depart: hhmm(sd), retard_min: mins(ad ?? dd), supprime: !!skipped,
    })),
    alertes: t.alerts || [],
  };
}

const IMPL: Record<string, (rpc: Rpc, a: Json) => Promise<Json>> = {
  etat_gare: etatGare, trajet, etat_ligne: etatLigne, perturbations, train,
};

/** Execute un outil ; ne leve jamais d'exception (le modele recoit un message d'erreur lisible). */
export async function runTool(rpc: Rpc, name: string, args: Json): Promise<Json> {
  const f = IMPL[name];
  if (!f) return { erreur: `Outil inconnu : ${name}` };
  try {
    return await f(rpc, args || {});
  } catch (e) {
    return { erreur: `Donnees indisponibles pour le moment (${String((e as Error)?.message || e).slice(0, 80)}).` };
  }
}

// API payante « reseau » : l'état du réseau ferré en direct, payé à l'appel avec x402 (0,005 USDC sur Solana devnet).
//   GET /functions/v1/reseau                      -> France entière : chiffres du jour + perturbations (grèves, travaux, incidents)
//   GET /functions/v1/reseau?ligne=RER B          -> une ligne : trains du jour, retards, suppressions, ses perturbations
//   GET /functions/v1/reseau?gare=Lyon Part-Dieu  -> une gare : chiffres du jour et prochains départs
//   &jours=7                                      -> perturbations annoncées sur 1 à 14 jours (défaut 2)
//   &type=greve|travaux|incident                  -> un seul type de perturbation
// Le péage x402 (402, vérification, règlement sur Solana) est dans ../_shared/x402.ts.
import { rpc, serve } from "../_shared/x402.ts";

const norm = (t: string) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const iso = (t?: number) => (t ? new Date(t * 1000).toISOString() : null);
const TYPES = ["greve", "travaux", "incident", "info"];
// Mots qui désignent un mode : « RER B », « métro 14 », « ligne P », « TER C1 », « T3b »
const MODES: Record<string, string[]> = { rer: ["RER"], metro: ["METRO"], tram: ["TRAM"], ligne: ["TRANSILIEN", "RER", "METRO", "TRAM", "TER"], ter: ["TER"], transilien: ["TRANSILIEN"] };

// deno-lint-ignore no-explicit-any
type Any = any;
async function findLine(q: string) {
  const t = norm(q), m = t.match(/^(rer|metro|tram|ligne|ter|transilien)?\s*([a-z]?\d{0,2}[a-z]?)$/);
  if (!m || !m[2]) return null;
  const lines: Any[] = await rpc("public_lines");
  const modes = m[1] ? MODES[m[1]] : null;
  return (lines || []).filter((l) => norm(l.name) === m[2] && (!modes || modes.includes(l.mode)))
    .sort((a, b) => (a.net === "idf" ? -1 : 1) - (b.net === "idf" ? -1 : 1) || (b.n || 0) - (a.n || 0))[0] || null;
}
function disruption(it: Any) {
  return { type: it.kind, gravite: it.severity, titre: it.title, lignes: it.lines || null, debut: iso(it.t_start), fin: iso(it.t_end), source: it.src === "idf" ? "Île-de-France Mobilités" : it.kind === "greve" && !it.line_ids ? "cestlagreve.fr" : "SNCF" };
}

async function network(u: URL) {
  const jours = Math.min(14, Math.max(1, parseInt(u.searchParams.get("jours") || "2") || 2));
  const type = norm(u.searchParams.get("type") || "");
  const ligneQ = (u.searchParams.get("ligne") || "").trim(), gareQ = (u.searchParams.get("gare") || "").trim();
  const disr: Any = await rpc("public_disruptions", { days: jours }).catch(() => null);
  let items: Any[] = (disr && disr.items) || [];
  if (type) items = items.filter((it) => it.kind === type);
  const out: Record<string, unknown> = { ok: true, calcule_le: new Date().toISOString(), periode_jours: jours,
    source: "Données temps réel SNCF et Île-de-France Mobilités relevées par LateProof toutes les 2 minutes ; agenda public des grèves." };

  if (ligneQ) {
    const l = await findLine(ligneQ);
    if (!l) return { ok: false, error: `Ligne introuvable : ${ligneQ}. Exemples : RER B, métro 14, ligne P, TER C1, T3b.` };
    const d: Any = await rpc("public_line", { p_net: l.net, p_id: l.id }).catch(() => null);
    const n = d?.n ?? l.n ?? 0, l15 = d?.late15 ?? l.late15 ?? 0, cx = d?.cancelled ?? l.cancelled ?? 0;
    items = items.filter((it) => (it.line_ids || []).includes(l.id));
    out.ligne = { nom: l.name, mode: l.mode, reseau: l.net === "idf" ? "Île-de-France" : "SNCF",
      aujourd_hui: { trains: n, en_retard_15min: l15, supprimes: cx, part_en_retard_pct: n ? Math.round(1000 * l15 / n) / 10 : null } };
    out.etat = cx > 0 || (n && l15 / n > 0.08) || items.some((it) => it.severity === "bloquant") ? "perturbe" : "normal";
  } else if (gareQ) {
    const f: Any[] = await rpc("public_find_stop", { p_q: gareQ.slice(0, 80) }).catch(() => []);
    if (!f?.length) return { ok: false, error: `Gare introuvable : ${gareQ}` };
    const st: Any = await rpc("public_station", { p_net: f[0].net, p_id: f[0].id }).catch(() => null);
    const now = Math.floor(Date.now() / 1000);
    out.gare = { nom: f[0].name, aujourd_hui: { passages: st?.n ?? 0, en_retard_15min: st?.late15 ?? 0, supprimes: st?.cancelled ?? 0, retard_moyen_min: st?.avg ?? null },
      prochains_departs: ((st?.next) || []).filter((x: Any) => x.sched + Math.max(x.delay || 0, 0) >= now - 60).slice(0, 8)
        .map((x: Any) => ({ heure_prevue: iso(x.sched), retard_min: Math.round(Math.max(x.delay || 0, 0) / 60), supprime: !!x.cancelled, ligne: x.line || x.mode, vers: x.dest, numero: x.num })) };
    items = items.filter((it) => (it.stops || []).some((s: Any) => norm(s.name || s[0] || "") === norm(f[0].name)) || norm(it.title || "").includes(norm(f[0].name)));
  } else {
    const today: Any = await rpc("public_today_stats").catch(() => null);
    if (today) out.france_aujourd_hui = { trains_suivis: today.trains, en_retard_15min: today.late15, supprimes: today.cancelled, mis_a_jour: iso(today.updated_at) };
  }
  const by = (k: string) => items.filter((it) => it.kind === k).length;
  out.perturbations = { total: items.length, greves: by("greve"), travaux: by("travaux"), incidents: by("incident"),
    liste: items.sort((a, b) => Number(a.severity !== "bloquant") - Number(b.severity !== "bloquant") || (a.t_start || 0) - (b.t_start || 0)).slice(0, 30).map(disruption) };
  return out;
}

serve({
  route: "reseau", price: "5000",
  description: "LateProof : état du réseau ferré en direct (retards et suppressions du jour, grèves, travaux, incidents ; France, une ligne ou une gare)",
  check: (u) => {
    const t = norm(u.searchParams.get("type") || "");
    if (t && !TYPES.includes(t)) return "type attendu : greve, travaux, incident ou info";
    if (u.searchParams.get("ligne") && u.searchParams.get("gare")) return "Choisis ligne= OU gare=, pas les deux";
    return null;
  },
  answer: network,
});

// Controle sur les VRAIES donnees (lecture seule, sans modele d'IA) : chaque outil renvoie-t-il quelque chose d'utile ?
// Lance par le workflow « assistant » quand SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont disponibles.
import { runTool, type Rpc } from "./tools.ts";

const SB = Deno.env.get("SUPABASE_URL")!.replace(/\/+$/, "");
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const rpc: Rpc = async (fn, body = {}) => {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { apikey: KEY, ...(KEY.startsWith("eyJ") ? { Authorization: `Bearer ${KEY}` } : {}), "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}`);
  return r.json();
};

const cases: [string, Record<string, unknown>][] = [
  ["etat_gare", { nom: "Gare de Lyon" }],
  ["etat_gare", { nom: "Lyon Part-Dieu" }],
  ["trajet", { depart: "Lyon Part-Dieu", arrivee: "Grenoble" }],
  ["trajet", { depart: "Gare du Nord", arrivee: "Massy-Palaiseau" }],
  ["etat_ligne", { nom: "RER B" }],
  ["etat_ligne", { nom: "metro 14" }],
  ["perturbations", { filtre: "RER A" }],
  ["perturbations", {}],
];
let bad = 0;
for (const [name, args] of cases) {
  const t = Date.now();
  const out = await runTool(rpc, name, args);
  const s = JSON.stringify(out);
  if (out?.erreur) bad++;
  console.log(`\n### ${name} ${JSON.stringify(args)} (${Date.now() - t} ms, ${s.length} car.)\n${s.slice(0, 900)}`);
}
if (bad) { console.error(`${bad} outil(s) en erreur`); Deno.exit(1); }

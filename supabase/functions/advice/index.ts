// API payante « advice » : le conseil de trajet en direct, payé à l'appel avec x402 (0,01 USDC sur Solana devnet).
//   GET /functions/v1/advice?de=Lyon Part-Dieu&vers=Grenoble
// Le péage x402 (402, vérification, règlement sur Solana) est dans ../_shared/x402.ts.
import { rpc, serve } from "../_shared/x402.ts";

type Stop = { net: string; id: string; name: string };
const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });

async function advice(de: string, vers: string) {
  const [A, B] = await Promise.all([rpc("public_find_stop", { p_q: de.slice(0, 80) }), rpc("public_find_stop", { p_q: vers.slice(0, 80) })]) as Stop[][];
  if (!A?.length || !B?.length) return { ok: false, error: `Gare introuvable : ${!A?.length ? de : vers}` };
  const a = A[0], b = B[0];
  const d = await rpc("public_journey", { p_from_net: a.net, p_from_id: a.id, p_to_net: b.net, p_to_id: b.id }).catch(() => null);
  const now = Math.floor(Date.now() / 1000), real = (t: number, dl: number) => t + Math.max(dl || 0, 0);
  // deno-lint-ignore no-explicit-any
  const js = ((d && d.journeys) || []).map((j: any) => {
    const first = j.legs[0], last = j.legs[j.legs.length - 1];
    let risk = "ok";
    if (j.legs.length > 1) {
      const slack = real(j.legs[1].dep, j.legs[1].dep_delay) - real(first.arr, first.arr_delay) - (j.walk_s || 0);
      risk = slack < 120 ? "correspondance_compromise" : slack < 300 ? "correspondance_juste" : "ok";
    }
    if ((last.arr_delay || 0) >= 900 && risk === "ok") risk = "retard";
    return {
      depart: new Date(real(first.dep, first.dep_delay) * 1000).toISOString(), arrivee: new Date(real(last.arr, last.arr_delay) * 1000).toISOString(),
      retard_arrivee_min: Math.round(Math.max(last.arr_delay || 0, 0) / 60), correspondances: j.legs.length - 1, risque: risk,
      // deno-lint-ignore no-explicit-any
      trains: j.legs.map((l: any) => ({ ligne: l.info?.line || null, mode: l.info?.mode || null, numero: l.info?.num || null, de: l.from[0], vers: l.to[0] })),
      _arr: real(last.arr, last.arr_delay), _dep: real(first.dep, first.dep_delay),
    };
  // deno-lint-ignore no-explicit-any
  }).filter((j: any) => j._dep >= now - 120);
  // deno-lint-ignore no-explicit-any
  const byArr = (x: any, y: any) => x._arr - y._arr;
  // deno-lint-ignore no-explicit-any
  const best = js.filter((j: any) => j.risque === "ok" || j.risque === "correspondance_juste").sort(byArr)[0] || [...js].sort(byArr)[0] || null;
  // deno-lint-ignore no-explicit-any
  const clean = (j: any) => j && (({ _arr: _a, _dep: _d, ...r }) => r)(j);
  return {
    ok: true, de: a.name, vers: b.name, calcule_le: new Date().toISOString(),
    conseil: best ? `Prends le départ de ${hhmm(best._dep)} (arrivée ${hhmm(best._arr)})${best.risque === "ok" ? "" : ", correspondance juste"}.`
      : "Aucun train direct ou avec une correspondance dans les 3 prochaines heures.",
    meilleure_option: clean(best), options: js.slice(0, 6).map(clean),
    source: "Données temps réel SNCF et Île-de-France Mobilités relevées par LateProof toutes les 2 minutes.",
  };
}

serve({
  route: "advice", price: "10000",
  description: "LateProof : conseil de trajet en direct (meilleure option, risque de correspondance, retards relevés)",
  check: (u) => (u.searchParams.get("de") || u.searchParams.get("from")) && (u.searchParams.get("vers") || u.searchParams.get("to")) ? null
    : "Paramètres attendus : ?de=<gare>&vers=<gare> (ex. ?de=Lyon Part-Dieu&vers=Grenoble)",
  answer: (u) => advice((u.searchParams.get("de") || u.searchParams.get("from") || "").trim(), (u.searchParams.get("vers") || u.searchParams.get("to") || "").trim()),
});

// Fonction serveur « advice » : l'API payante de LateProof, payée à l'appel avec x402 (HTTP 402) en USDC sur Solana.
//
//   GET /functions/v1/advice?de=Lyon Part-Dieu&vers=Grenoble
//
// Sans paiement : réponse 402 et en-tête PAYMENT-REQUIRED (x402 v2, base64 JSON) : 0,01 USDC sur Solana devnet.
// Avec l'en-tête PAYMENT-SIGNATURE (transaction signée par le client) : le facilitateur x402 la vérifie (/verify),
// on calcule le conseil, puis le facilitateur la règle sur Solana (/settle) ; la réponse 200 porte PAYMENT-RESPONSE
// (transaction de règlement). Le facilitateur paie les frais en SOL : l'agent client n'a besoin que d'USDC.
//
// Pas de SDK : quelques appels fetch, selon la spécification x402 v2 (github.com/x402-foundation/x402, specs/).
// Variables : SUPABASE_URL, SUPABASE_ANON_KEY / LP_PUBLIC_KEY (données publiques), SUPABASE_SERVICE_ROLE_KEY (journal des
// paiements), X402_PAY_TO (adresse qui reçoit), X402_FACILITATOR (défaut : facilitateur de test x402.org).

const env = (k: string, d = "") => Deno.env.get(k) || d;
const SB = env("SUPABASE_URL");
const PUBLIC_KEY = env("LP_PUBLIC_KEY", env("SUPABASE_ANON_KEY"));
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const FACILITATOR = env("X402_FACILITATOR", "https://x402.org/facilitator").replace(/\/+$/, "");
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";          // Solana devnet (CAIP-2)
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";   // USDC de Circle sur devnet
const PAY_TO = env("X402_PAY_TO", "3pEkrEjgH5wYKZitvNtLWSmx9ELPmJPiwywJtWaP5s83");
const PRICE = env("X402_PRICE", "10000");                            // 0,01 USDC (6 décimales)

const keyHeaders = (k: string): Record<string, string> => (k.startsWith("eyJ") ? { apikey: k, Authorization: `Bearer ${k}` } : { apikey: k });
async function rpc(fn: string, body: unknown, key = PUBLIC_KEY || SERVICE_KEY) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    headers: { ...keyHeaders(key), "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}`);
  return r.json();
}

const b64 = (o: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))));
const unb64 = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, payment-signature, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...headers } });

// Le payeur de frais du facilitateur (il change rarement) : lu une fois sur /supported
let feePayer: { feePayer: string; transactionVersions?: number[] } | null = null;
async function svmExtra() {
  if (feePayer) return feePayer;
  const s = await fetch(`${FACILITATOR}/supported`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json());
  const k = (s.kinds || []).find((x: { x402Version: number; scheme: string; network: string }) => x.x402Version === 2 && x.scheme === "exact" && x.network === NETWORK);
  if (!k?.extra?.feePayer) throw new Error("facilitateur sans Solana devnet");
  feePayer = { feePayer: k.extra.feePayer, ...(k.extra.transactionVersions ? { transactionVersions: k.extra.transactionVersions } : {}) };
  return feePayer;
}
async function requirements() {
  return { scheme: "exact", network: NETWORK, amount: PRICE, asset: USDC_DEVNET, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: await svmExtra() };
}

// --------------------------------------------------------------------- le service payé : un conseil de trajet en direct
type Stop = { net: string; id: string; name: string };
async function advice(de: string, vers: string) {
  const [A, B] = await Promise.all([rpc("public_find_stop", { p_q: de.slice(0, 80) }), rpc("public_find_stop", { p_q: vers.slice(0, 80) })]) as Stop[][];
  if (!A?.length || !B?.length) return { ok: false, error: `Gare introuvable : ${!A?.length ? de : vers}` };
  const a = A[0], b = B[0];
  // deno-lint-ignore no-explicit-any
  const d: any = await rpc("public_journey", { p_from_net: a.net, p_from_id: a.id, p_to_net: b.net, p_to_id: b.id }).catch(() => null);
  const now = Math.floor(Date.now() / 1000), real = (t: number, dl: number) => t + Math.max(dl || 0, 0);
  // deno-lint-ignore no-explicit-any
  const js = ((d && d.journeys) || []).map((j: any) => {
    const first = j.legs[0], last = j.legs[j.legs.length - 1];
    let risk = "ok";
    if (j.legs.length > 1) {
      const slack = real(j.legs[1].dep, j.legs[1].dep_delay) - real(first.arr, first.arr_delay) - (j.walk_s || 0);
      risk = slack < 120 ? "correspondance_compromise" : slack < 300 ? "correspondance_juste" : "ok";
    }
    if ((last.arr_delay || 0) >= 900) risk = risk === "ok" ? "retard" : risk;
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
  const safe = js.filter((j: any) => j.risque === "ok" || j.risque === "correspondance_juste").sort((x: any, y: any) => x._arr - y._arr);
  // deno-lint-ignore no-explicit-any
  const best = safe[0] || js.sort((x: any, y: any) => x._arr - y._arr)[0] || null;
  // deno-lint-ignore no-explicit-any
  const clean = (j: any) => j && (({ _arr, _dep, ...r }) => r)(j);
  return {
    ok: true, de: a.name, vers: b.name, calcule_le: new Date().toISOString(),
    conseil: best ? `Prends le départ de ${new Date(best._dep * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })} (arrivée ${new Date(best._arr * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })})${best.risque === "ok" ? "" : ", correspondance juste"}.` : "Aucun train direct ou avec une correspondance dans les 3 prochaines heures.",
    meilleure_option: clean(best), options: js.slice(0, 6).map(clean),
    source: "Données temps réel SNCF et Île-de-France Mobilités relevées par LateProof toutes les 2 minutes.",
  };
}

// --------------------------------------------------------------------- journal public des paiements (preuve sur la chaîne)
async function logPayment(tx: string, payer: string | undefined, route: string) {
  if (!SERVICE_KEY) return;
  await fetch(`${SB}/rest/v1/x402_payments`, {
    method: "POST", signal: AbortSignal.timeout(6_000),
    headers: { ...keyHeaders(SERVICE_KEY), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ tx, payer: payer || null, amount: PRICE, asset: USDC_DEVNET, network: NETWORK, route }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json(405, { error: "GET seulement" });
  const url = new URL(req.url);
  const de = (url.searchParams.get("de") || url.searchParams.get("from") || "").trim();
  const vers = (url.searchParams.get("vers") || url.searchParams.get("to") || "").trim();
  if (!de || !vers) return json(400, { error: "Paramètres attendus : ?de=<gare>&vers=<gare>", exemple: "?de=Lyon Part-Dieu&vers=Grenoble" });

  let req0;
  try { req0 = await requirements(); } catch (e) { return json(503, { error: `Paiement indisponible : ${(e as Error).message}` }); }
  const resource = { url: `${SB.replace(/\/+$/, "")}/functions/v1/advice?de=${encodeURIComponent(de)}&vers=${encodeURIComponent(vers)}`,
    description: "LateProof : conseil de trajet en direct (meilleure option, risque de correspondance, retards relevés)", mimeType: "application/json" };
  const paymentRequired = (error: string) => json(402, {}, { "PAYMENT-REQUIRED": b64({ x402Version: 2, error, resource, accepts: [req0] }) });

  const sig = req.headers.get("PAYMENT-SIGNATURE") || req.headers.get("payment-signature");
  if (!sig) return paymentRequired("Paiement requis : 0,01 USDC (Solana devnet)");

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try { payload = unb64(sig); } catch { return paymentRequired("PAYMENT-SIGNATURE illisible"); }
  const acc = payload?.accepted || {};
  if (payload?.x402Version !== 2 || acc.scheme !== req0.scheme || acc.network !== req0.network || String(acc.amount) !== req0.amount || acc.asset !== req0.asset || acc.payTo !== req0.payTo)
    return paymentRequired("Le paiement ne correspond pas aux conditions annoncées");

  const body = JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: req0 });
  const post = (path: string) => fetch(`${FACILITATOR}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(30_000) })
    .then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

  const v = await post("verify");
  if (!v.j?.isValid) return paymentRequired(`Paiement refusé : ${v.j?.invalidReason || v.j?.invalidMessage || `facilitateur ${v.status}`}`);

  let result;
  try { result = await advice(de, vers); } catch (e) { return json(503, { error: `Service indisponible, rien n'a été prélevé : ${(e as Error).message}` }); }

  const s = await post("settle");
  if (!s.j?.success) return paymentRequired(`Règlement impossible : ${s.j?.errorReason || s.j?.errorMessage || `facilitateur ${s.status}`}`);
  await logPayment(s.j.transaction, s.j.payer || v.j.payer, "advice");
  return json(200, { ...result, paiement: { transaction: s.j.transaction, reseau: NETWORK, montant_usdc: Number(PRICE) / 1e6,
    explorateur: `https://explorer.solana.com/tx/${s.j.transaction}?cluster=devnet` } }, { "PAYMENT-RESPONSE": b64(s.j) });
});

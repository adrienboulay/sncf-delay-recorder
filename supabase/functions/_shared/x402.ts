// Péage x402 commun aux API payantes de LateProof (« advice », « reseau ») : HTTP 402, paiement en USDC sur Solana.
//
// Sans paiement : réponse 402 et en-tête PAYMENT-REQUIRED (x402 v2, base64 JSON).
// Avec l'en-tête PAYMENT-SIGNATURE (transaction signée par le client) : le facilitateur x402 la vérifie (/verify),
// on calcule la réponse, puis le facilitateur la règle sur Solana (/settle) ; la réponse 200 porte PAYMENT-RESPONSE.
// Si la réponse ne peut pas être calculée, rien n'est réglé. Le facilitateur paie les frais en SOL.
//
// Pas de SDK : quelques appels fetch, selon la spécification x402 v2 (github.com/x402-foundation/x402, specs/).
// Variables : SUPABASE_URL, SUPABASE_ANON_KEY / LP_PUBLIC_KEY (données publiques), SUPABASE_SERVICE_ROLE_KEY (journal des
// paiements), X402_PAY_TO (adresse qui reçoit), X402_FACILITATOR (défaut : facilitateur de test x402.org).

const env = (k: string, d = "") => Deno.env.get(k) || d;
export const SB = env("SUPABASE_URL").replace(/\/+$/, "");
const PUBLIC_KEY = env("LP_PUBLIC_KEY", env("SUPABASE_ANON_KEY"));
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const FACILITATOR = env("X402_FACILITATOR", "https://x402.org/facilitator").replace(/\/+$/, "");
export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";   // Solana devnet (CAIP-2)
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";  // USDC de Circle sur devnet
const PAY_TO = env("X402_PAY_TO", "3pEkrEjgH5wYKZitvNtLWSmx9ELPmJPiwywJtWaP5s83");

const keyHeaders = (k: string): Record<string, string> => (k.startsWith("eyJ") ? { apikey: k, Authorization: `Bearer ${k}` } : { apikey: k });
// deno-lint-ignore no-explicit-any
export async function rpc(fn: string, body: unknown = {}): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    headers: { ...keyHeaders(PUBLIC_KEY || SERVICE_KEY), "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}`);
  return r.json();
}

const b64 = (o: unknown) => { const b = new TextEncoder().encode(JSON.stringify(o)); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, payment-signature, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
};
export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...headers } });

let feePayer: Record<string, unknown> | null = null;   // payeur des frais du facilitateur, lu une fois sur /supported
async function svmExtra() {
  if (feePayer) return feePayer;
  const s = await fetch(`${FACILITATOR}/supported`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json());
  const k = (s.kinds || []).find((x: { x402Version: number; scheme: string; network: string }) => x.x402Version === 2 && x.scheme === "exact" && x.network === NETWORK);
  if (!k?.extra?.feePayer) throw new Error("facilitateur sans Solana devnet");
  feePayer = { feePayer: k.extra.feePayer, ...(k.extra.transactionVersions ? { transactionVersions: k.extra.transactionVersions } : {}) };
  return feePayer;
}

// Journal public des paiements réglés (la page « API » les liste). Renvoie "ok" ou la raison de l'échec.
async function logPayment(tx: string, payer: string | undefined, amount: string, route: string): Promise<string> {
  if (!SERVICE_KEY) return "sans clé de service";
  try {
    const r = await fetch(`${SB}/rest/v1/rpc/x402_log`, {
      method: "POST", signal: AbortSignal.timeout(6_000),
      headers: { ...keyHeaders(SERVICE_KEY), "Content-Type": "application/json" },
      body: JSON.stringify({ p_tx: tx, p_payer: payer || null, p_amount: amount, p_asset: USDC_DEVNET, p_network: NETWORK, p_route: route }),
    });
    return r.ok ? "ok" : `${r.status} ${(await r.text()).slice(0, 120)}`;
  } catch (e) { return (e as Error).message; }
}

export type Paid = {
  route: string;                 // nom de la fonction (journal)
  price: string;                 // unités atomiques USDC (6 décimales) : "10000" = 0,01 USDC
  description: string;
  // Valide les paramètres AVANT tout paiement : renvoie un message d'erreur (400) ou null
  check: (u: URL) => string | null;
  // Calcule la réponse (appelé seulement si le paiement est valide ; en cas d'erreur, rien n'est réglé)
  answer: (u: URL) => Promise<Record<string, unknown>>;
};

export function serve(p: Paid) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET") return json(405, { error: "GET seulement" });
    const url = new URL(req.url);
    const bad = p.check(url);
    if (bad) return json(400, { error: bad });

    let accepts;
    try {
      accepts = { scheme: "exact", network: NETWORK, amount: p.price, asset: USDC_DEVNET, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: await svmExtra() };
    } catch (e) { return json(503, { error: `Paiement indisponible : ${(e as Error).message}` }); }
    const resource = { url: `${SB}/functions/v1/${p.route}${url.search}`, description: p.description, mimeType: "application/json" };
    const usdc = (Number(p.price) / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 6 });
    const paymentRequired = (error: string) => json(402, {}, { "PAYMENT-REQUIRED": b64({ x402Version: 2, error, resource, accepts: [accepts] }) });

    const sig = req.headers.get("PAYMENT-SIGNATURE");
    if (!sig) return paymentRequired(`Paiement requis : ${usdc} USDC (Solana devnet)`);
    // deno-lint-ignore no-explicit-any
    let payload: any;
    try { payload = unb64(sig); } catch { return paymentRequired("PAYMENT-SIGNATURE illisible"); }
    const a = payload?.accepted || {};
    if (payload?.x402Version !== 2 || a.scheme !== accepts.scheme || a.network !== accepts.network || String(a.amount) !== accepts.amount || a.asset !== accepts.asset || a.payTo !== accepts.payTo)
      return paymentRequired("Le paiement ne correspond pas aux conditions annoncées");

    const body = JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: accepts });
    const post = (path: string) => fetch(`${FACILITATOR}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(30_000) })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

    const v = await post("verify");
    if (!v.j?.isValid) return paymentRequired(`Paiement refusé : ${v.j?.invalidReason || v.j?.invalidMessage || `facilitateur ${v.status}`}`);
    let result;
    try { result = await p.answer(url); } catch (e) { return json(503, { error: `Service indisponible, rien n'a été prélevé : ${(e as Error).message}` }); }
    const s = await post("settle");
    if (!s.j?.success) return paymentRequired(`Règlement impossible : ${s.j?.errorReason || s.j?.errorMessage || `facilitateur ${s.status}`}`);
    const journal = await logPayment(s.j.transaction, s.j.payer || v.j.payer, p.price, p.route);
    return json(200, { ...result, paiement: { transaction: s.j.transaction, reseau: NETWORK, montant_usdc: Number(p.price) / 1e6, journal,
      explorateur: `https://explorer.solana.com/tx/${s.j.transaction}?cluster=devnet` } }, { "PAYMENT-RESPONSE": b64(s.j) });
  });
}

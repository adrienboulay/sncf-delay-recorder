// Fonction serveur « admin » : le tableau de bord (statistiques et modération), réservé au propriétaire du site.
// Accès : en-tête « x-admin-token » égal au secret ADMIN_TOKEN (posé dans les secrets GitHub, recopié ici au déploiement).
// Sans ADMIN_TOKEN configuré, tout est refusé. Les données passent par des fonctions SQL réservées à la clé de service.
//   GET  ?do=stats | reviews | waitlist
//   POST {do: "review", id, approved}  |  {do: "review_delete", id}

const env = (k: string, d = "") => Deno.env.get(k) || d;
const SB = env("SUPABASE_URL").replace(/\/+$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const TOKEN = env("ADMIN_TOKEN");
const ORIGINS = env("ALLOWED_ORIGINS", "https://adrienboulay.github.io,http://localhost:8765").split(",").map((s) => s.trim());

const keyHeaders = (k: string): Record<string, string> => (k.startsWith("eyJ") ? { apikey: k, Authorization: `Bearer ${k}` } : { apikey: k });
async function rpc(fn: string, body: unknown = {}) {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    headers: { ...keyHeaders(SERVICE_KEY), "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`${fn} ${r.status} ${(await r.text()).slice(0, 160)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// Comparaison à temps constant (le temps de réponse ne révèle pas le mot de passe)
async function same(a: string, b: string) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "content-type, x-admin-token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!TOKEN || TOKEN.length < 16) return json(503, { error: "ADMIN_TOKEN n'est pas configuré (16 caractères minimum)" });
  const given = req.headers.get("x-admin-token") || "";
  if (!given || !(await same(given, TOKEN))) {
    await new Promise((r) => setTimeout(r, 800));   // freine les essais en série
    return json(401, { error: "Mot de passe incorrect" });
  }
  try {
    if (req.method === "GET") {
      const what = new URL(req.url).searchParams.get("do") || "stats";
      if (what === "stats") return json(200, await rpc("admin_stats"));
      if (what === "reviews") return json(200, await rpc("admin_reviews"));
      if (what === "waitlist") return json(200, await rpc("admin_waitlist"));
      return json(400, { error: "do = stats, reviews ou waitlist" });
    }
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const id = Number(b.id);
      if (!Number.isInteger(id) || id <= 0) return json(400, { error: "id invalide" });
      if (b.do === "review") { await rpc("admin_review_set", { p_id: id, p_approved: !!b.approved }); return json(200, { ok: true }); }
      if (b.do === "review_delete") { await rpc("admin_review_delete", { p_id: id }); return json(200, { ok: true }); }
      return json(400, { error: "do = review ou review_delete" });
    }
    return json(405, { error: "GET ou POST" });
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }
});

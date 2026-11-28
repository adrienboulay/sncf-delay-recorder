// Fonction serveur « voice » : le résumé vocal du mois, lu par une voix ElevenLabs.
// Elle n'accepte QUE des nombres (jamais de texte libre) : la phrase est écrite ici, ce qui empêche d'utiliser
// notre quota ElevenLabs comme synthèse vocale gratuite. Quota par visiteur et global par jour (assistant_hit).
//   POST {lang: "fr"|"en", month: 1-12, trips, late, minutes, worst, claims, euros?, demo?}  ->  audio/mpeg
// Secrets : ELEVENLABS_API_KEY (déjà posé pour la dictée), ELEVENLABS_VOICE_ID (facultatif).

const env = (k: string, d = "") => Deno.env.get(k) || d;
const ORIGINS = env("ALLOWED_ORIGINS", "https://adrienboulay.github.io,http://localhost:8765").split(",").map((s) => s.trim());
// « George », voix prédéfinie de la bibliothèque ElevenLabs (exemple de la documentation), multilingue avec eleven_flash_v2_5
const VOICE = env("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb");
const MODEL = "eleven_flash_v2_5";

export type Month = { lang?: string; month?: number; trips?: number; late?: number; minutes?: number; worst?: number; claims?: number; euros?: number | null; demo?: boolean };

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const int = (v: unknown, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0; };
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
function dur(min: number, en: boolean) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return en ? plural(m, "minute", "minutes") : plural(m, "minute", "minutes");
  return en ? `${plural(h, "hour", "hours")}${m ? ` and ${plural(m, "minute", "minutes")}` : ""}` : `${plural(h, "heure", "heures")}${m ? ` et ${plural(m, "minute", "minutes")}` : ""}`;
}

// La phrase lue (au plus ~350 caractères)
export function summaryText(b: Month): string {
  const en = b.lang === "en";
  const mo = int(b.month, 12), trips = int(b.trips, 999), late = Math.min(int(b.late, 999), trips), minutes = int(b.minutes, 99999), worst = int(b.worst, 9999), claims = int(b.claims, 999);
  const euros = b.euros == null ? 0 : Math.min(Math.max(Math.round(Number(b.euros) * 100) / 100, 0), 9999);
  const name = mo >= 1 ? (en ? MONTHS[mo - 1] : MOIS[mo - 1]) : (en ? "this month" : "ce mois-ci");
  const eur = euros ? (en ? `${euros.toFixed(2)} euros` : `${euros.toFixed(2).replace(".", ",")} euros`) : "";
  const parts: string[] = [];
  if (en) {
    parts.push(b.demo ? "Here is a demo of your monthly summary." : "Here is your LateProof month.");
    if (!trips) parts.push(`No trips recorded in ${name} yet.`);
    else {
      parts.push(`In ${name}, you took ${plural(trips, "train", "trains")}, and ${late ? `${late} ran late` : "none ran late"}.`);
      if (minutes) parts.push(`That's ${dur(minutes, true)} lost on the tracks${worst ? `, with a worst delay of ${dur(worst, true)}` : ""}.`);
      if (eur) parts.push(`You can still claim about ${eur}.`);
      else if (claims) parts.push(`${plural(claims, "trip qualifies", "trips qualify")} for compensation.`);
    }
    parts.push("Gus is watching your next trains.");
  } else {
    parts.push(b.demo ? "Voici une démo de ton bilan du mois." : "Voici ton mois avec LateProof.");
    if (!trips) parts.push(`Aucun trajet enregistré en ${name} pour l'instant.`);
    else {
      parts.push(`En ${name}, tu as pris ${plural(trips, "train", "trains")}, et ${late ? `${late} ${late > 1 ? "étaient" : "était"} en retard` : "aucun n'était en retard"}.`);
      if (minutes) parts.push(`Ça fait ${dur(minutes, false)} perdues sur les rails${worst ? `, avec un pire retard de ${dur(worst, false)}` : ""}.`);
      if (eur) parts.push(`Tu peux encore récupérer environ ${eur}.`);
      else if (claims) parts.push(`${plural(claims, "trajet ouvre", "trajets ouvrent")} droit à une compensation.`);
    }
    parts.push("Gus surveille tes prochains trains.");
  }
  return parts.join(" ");
}

async function fingerprint(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "inconnu";
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`voice|${new Date().toISOString().slice(0, 10)}|${ip}`));
  return "v:" + Array.from(new Uint8Array(h)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function quotaOk(who: string): Promise<boolean> {
  const sb = env("SUPABASE_URL").replace(/\/+$/, ""), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!sb || !key) return true;
  const r = await fetch(`${sb}/rest/v1/rpc/assistant_hit`, {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ p_who: who, p_limit: 6, p_global: 400 }),
  }).catch(() => null);
  return !r || !r.ok ? true : (await r.json()) === true;   // base indisponible : on laisse passer (le quota ElevenLabs reste la limite)
}

export async function handle(req: Request): Promise<Response> {
  const origin = req.headers.get("Origin") || "";
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "x-text",
    Vary: "Origin",
  };
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST uniquement" });
  const b = (await req.json().catch(() => null)) as Month | null;
  if (!b || typeof b !== "object") return json(400, { error: "JSON attendu" });
  const text = summaryText(b);
  const key = env("ELEVENLABS_API_KEY");
  if (!key) return json(503, { error: "voix non configurée", text });
  if (!(await quotaOk(await fingerprint(req)))) return json(429, { error: "quota du jour atteint", text });
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_64`, {
    method: "POST", signal: AbortSignal.timeout(25_000),
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: MODEL, language_code: b.lang === "en" ? "en" : "fr", voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  }).catch((e) => ({ ok: false, status: 502, text: async () => String(e) }) as unknown as Response);
  if (!r.ok) return json(502, { error: `ElevenLabs ${r.status}`, detail: (await r.text()).slice(0, 200), text });
  return new Response(r.body, { status: 200, headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "x-text": encodeURIComponent(text) } });
}

if (import.meta.main) Deno.serve(handle);

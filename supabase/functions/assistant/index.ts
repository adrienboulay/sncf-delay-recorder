// Fonction serveur Supabase « assistant » : la cle du fournisseur d'IA reste ici, jamais dans la page web.
// Secrets (Edge Functions > Secrets, poses par le workflow deploy-assistant) : MISTRAL_API_KEY, et en option
// MISTRAL_MODEL, ASSISTANT_DAILY_PER_USER, ASSISTANT_DAILY_TOTAL, ALLOWED_ORIGINS.

import { handle } from "./handler.ts";
import { mistralChat } from "./llm.ts";
import { pickStt } from "./stt.ts";
import type { Rpc } from "./tools.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const SB = env("SUPABASE_URL");
const PUBLIC_KEY = env("LP_PUBLIC_KEY", env("SUPABASE_ANON_KEY"));
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

const keyHeaders = (k: string): Record<string, string> =>
  k.startsWith("eyJ") ? { apikey: k, Authorization: `Bearer ${k}` } : { apikey: k };

const call = (key: string): Rpc => async (fn, body = {}) => {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
    headers: { ...keyHeaders(key), "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}`);
  return r.json();
};
const admin = call(SERVICE_KEY);       // compteur anti-abus (et secours ci-dessous)
// Donnees publiques avec les memes droits que la carte. Si l'ancienne cle « anon » est desactivee dans Supabase,
// on se rabat sur la cle de service, qui n'appelle ici que les memes fonctions publiques en lecture.
const pub = call(PUBLIC_KEY);
const rpc: Rpc = (fn, body) => (PUBLIC_KEY ? pub(fn, body) : Promise.reject(new Error("401")))
  .catch((e) => (/ 40[13]$|^401$/.test(String(e?.message)) ? admin(fn, body) : Promise.reject(e)));

const stt = pickStt({ elevenlabs: env("ELEVENLABS_API_KEY"), mistral: env("MISTRAL_API_KEY") });
const perUser = parseInt(env("ASSISTANT_DAILY_PER_USER", "30"));
const total = parseInt(env("ASSISTANT_DAILY_TOTAL", "800"));

Deno.serve((req) =>
  handle(req, {
    chat: mistralChat(env("MISTRAL_API_KEY"), env("MISTRAL_MODEL", "mistral-small-latest")),
    rpc,
    hit: (who) => admin("assistant_hit", { p_who: who, p_limit: perUser, p_global: total }).then((ok) => ok !== false),
    origins: env("ALLOWED_ORIGINS", "https://adrienboulay.github.io,http://localhost:8000,http://127.0.0.1:8000").split(","),
    salt: env("ASSISTANT_SALT", SERVICE_KEY.slice(-16)),
    stt,
  })
);

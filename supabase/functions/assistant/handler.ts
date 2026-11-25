// Requete HTTP -> conversation avec le modele -> outils -> reponse. Sans Deno.serve, pour pouvoir le tester.

import { type Json, type Rpc, runTool, TOOLS } from "./tools.ts";
import { type Chat, LlmError, type Msg } from "./llm.ts";
import { systemPrompt } from "./prompt.ts";

export type Deps = {
  chat: Chat;
  rpc: Rpc;
  /** Compte un message ; false = limite du jour atteinte. */
  hit: (who: string) => Promise<boolean>;
  origins: string[];
  salt: string;
};

const MAX_TURNS = 12, MAX_CHARS = 1200, MAX_TOOL_ROUNDS = 4;

function cors(origin: string | null, allowed: string[]): Record<string, string> {
  const ok = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

async function fingerprint(req: Request, salt: string): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "inconnu";
  const day = new Date().toISOString().slice(0, 10);
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${day}|${ip}`));
  return Array.from(new Uint8Array(h)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...cors(req.headers.get("origin"), deps.origins), "Content-Type": "application/json" };
  const reply = (status: number, body: Json) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply(405, { error: "POST uniquement" });

  // ---- validation : une conversation courte, en texte, qui finit par un message de l'utilisateur
  let body: Json;
  try { body = await req.json(); } catch { return reply(400, { error: "JSON invalide" }); }
  const raw = Array.isArray(body?.messages) ? body.messages.slice(-MAX_TURNS) : [];
  const history: Msg[] = raw
    .filter((m: Json) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
    .map((m: Json) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (!history.length || history[history.length - 1].role !== "user") return reply(400, { error: "Le dernier message doit venir de l'utilisateur" });

  // ---- anti-abus : protege l'offre gratuite du fournisseur
  if (!(await deps.hit(await fingerprint(req, deps.salt)).catch(() => true))) {
    return reply(429, { error: "limite", reply: "Tu as atteint la limite de questions pour aujourd'hui pendant la phase de test. Reviens demain !" });
  }

  const messages: Msg[] = [{ role: "system", content: systemPrompt({ trajet: body?.trajet }) }, ...history];
  const used: string[] = [];
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // Dernier tour : plus d'outils, le modele doit repondre avec ce qu'il a.
      const r = await deps.chat(messages, round === MAX_TOOL_ROUNDS ? [] : TOOLS);
      if (!r.toolCalls.length) return reply(200, { reply: r.text.trim() || "Je n'ai pas de réponse pour le moment.", tools: used });
      messages.push(r.raw);
      for (const c of r.toolCalls) {
        let args: Json = {};
        try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* arguments illisibles : l'outil le signalera */ }
        used.push(c.function.name);
        const out = await runTool(deps.rpc, c.function.name, args);
        messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: JSON.stringify(out).slice(0, 12_000) });
      }
    }
    return reply(200, { reply: "Je n'ai pas réussi à trouver la réponse, peux-tu reformuler ?", tools: used });
  } catch (e) {
    const busy = e instanceof LlmError && (e.status === 429 || e.status >= 500);
    console.error("assistant", e instanceof LlmError ? `${e.status} ${e.message}` : String(e));
    return reply(busy ? 503 : 502, {
      error: "fournisseur",
      reply: busy ? "L'assistant est très demandé en ce moment, réessaie dans une minute." : "L'assistant est indisponible pour le moment.",
    });
  }
}

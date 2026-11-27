// Fournisseur du modele de langage. Aujourd'hui : Mistral (offre gratuite « Experiment », europeen).
// Passer a l'offre payante de Mistral = changer de forfait, rien a coder. Passer a Claude = ajouter une fonction
// claudeChat() avec le SDK officiel d'Anthropic et la choisir via LLM_PROVIDER : le reste ne change pas.

import type { Json } from "./tools.ts";

export type ToolDef = { name: string; description: string; parameters: Json };
export type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type LlmReply = { text: string; toolCalls: ToolCall[]; raw: Msg };
export type Chat = (messages: Msg[], tools: readonly ToolDef[]) => Promise<LlmReply>;

export class LlmError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function mistralChat(apiKey: string, model = "mistral-small-latest", fetchImpl: typeof fetch = fetch): Chat {
  return openAiChat("https://api.mistral.ai/v1/chat/completions", apiKey, model, fetchImpl);
}

/** Groq : offre gratuite sans carte bancaire, meme format que Mistral/OpenAI, appels d'outils pris en charge. */
export function groqChat(apiKey: string, model = "llama-3.3-70b-versatile", fetchImpl: typeof fetch = fetch): Chat {
  return openAiChat("https://api.groq.com/openai/v1/chat/completions", apiKey, model, fetchImpl);
}

/** Tout fournisseur au format « chat completions » (Mistral, Groq, OpenAI, GitHub Models, Cerebras...). */
export function openAiChat(url: string, apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Chat {
  return async (messages, tools) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, messages, temperature: 0.3, max_tokens: 700,
        ...(tools.length ? {
          tool_choice: "auto", parallel_tool_calls: true,
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
        } : {}),
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new LlmError(res.status, (await res.text()).slice(0, 300));
    const data = await res.json();
    const m = data?.choices?.[0]?.message || {};
    const toolCalls: ToolCall[] = (m.tool_calls || []).map((c: Json) => ({
      id: c.id, type: "function",
      function: { name: c.function?.name, arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments || {}) },
    }));
    const text = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.map((p: Json) => p?.text || "").join("") : "";
    return { text, toolCalls, raw: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } };
  };
}

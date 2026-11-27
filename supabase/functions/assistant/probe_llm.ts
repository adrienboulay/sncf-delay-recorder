// Verifie la cle Gemini sans l'afficher : liste les modeles « flash », puis un appel avec un outil.
// Lancer : GEMINI_API_KEY=... deno run --allow-net --allow-env supabase/functions/assistant/probe_llm.ts
const key = Deno.env.get("GEMINI_API_KEY") || "";
if (!key) { console.log("pas de GEMINI_API_KEY : rien a tester"); Deno.exit(0); }
const base = "https://generativelanguage.googleapis.com/v1beta/openai";
const h = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const list = await fetch(`${base}/models`, { headers: h });
const ids: string[] = list.ok ? ((await list.json()).data || []).map((m: { id: string }) => m.id.replace(/^models\//, "")) : [];
console.log("liste des modeles :", list.status, "| flash :", ids.filter((i) => /flash/.test(i) && !/image|tts|audio|live|embed/.test(i)).join(", "));

const want = Deno.env.get("LLM_MODEL");
const cands = [want, "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", ...ids.filter((i) => /flash/.test(i) && !/image|tts|audio|live|embed|preview/.test(i))]
  .filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
for (const model of cands.slice(0, 6)) {
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST", headers: h,
    body: JSON.stringify({
      model, temperature: 0.3, max_tokens: 200,
      messages: [{ role: "user", content: "Quel est l'etat du RER B ? Utilise l'outil." }],
      tools: [{ type: "function", function: { name: "etat_ligne", description: "Etat d'une ligne", parameters: { type: "object", properties: { nom: { type: "string" } }, required: ["nom"] } } }],
      tool_choice: "auto",
    }),
  });
  const j = await r.json().catch(() => ({}));
  const call = j?.choices?.[0]?.message?.tool_calls?.[0]?.function;
  console.log(`${model} : HTTP ${r.status}${call ? ` | outil appele : ${call.name} ${call.arguments}` : ""}${!r.ok ? ` | ${JSON.stringify(j).slice(0, 160)}` : ""}`);
  if (r.ok && call) { console.log(`MODELE RETENU : ${model}`); break; }
}

// Appel complet comme en production : consignes + tous nos outils, pour voir l'erreur exacte du fournisseur.
const { geminiChat, LlmError } = await import("./llm.ts");
const { TOOLS } = await import("./tools.ts");
const { systemPrompt } = await import("./prompt.ts");
try {
  const r = await geminiChat(key)([{ role: "system", content: systemPrompt() }, { role: "user", content: "Le RER B est-il à l'heure ?" }], TOOLS);
  console.log("APPEL COMPLET OK | outils :", r.toolCalls.map((c) => c.function.name).join(", ") || "aucun", "| texte :", r.text.slice(0, 80));
} catch (e) {
  console.log("APPEL COMPLET ECHEC :", e instanceof LlmError ? `${e.status} ${e.message}` : String(e));
}

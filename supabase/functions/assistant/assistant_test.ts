// Tests sans reseau : la base et le modele sont simules. Lancer : deno test supabase/functions/assistant/
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _resetCache, hhmm, matchLine, norm, runTool, type Rpc } from "./tools.ts";
import { handle, type Deps } from "./handler.ts";
import { type Chat, LlmError, mistralChat, type Msg } from "./llm.ts";
import { systemPrompt } from "./prompt.ts";

const NOW = Math.floor(Date.now() / 1000);
const LINES = [
  { net: "idf", id: "C01743", name: "B", long: "B", mode: "RER", n: 353, late15: 12, cancelled: 0 },
  { net: "idf", id: "C01384", name: "14", long: "14", mode: "METRO", n: 0, late15: 0, cancelled: 0 },
  { net: "idf", id: "C01679", name: "T3b", long: "T3b", mode: "TRAM", n: 0, late15: 0, cancelled: 0 },
  { net: "idf", id: "C01730", name: "P", long: "P", mode: "TRANSILIEN", n: 157, late15: 1, cancelled: 0 },
  { net: "sncf", id: "L1", name: "P25", long: "Paris Bercy - Avallon", mode: "TER", n: 7, late15: 1, cancelled: 0 },
  { net: "sncf", id: "L2", name: "C1", long: "Lyon Part-Dieu - Grenoble", mode: "TER", n: 30, late15: 2, cancelled: 1 },
];

function fakeRpc(log: string[] = []): Rpc {
  return (fn, body = {}) => {
    log.push(fn);
    switch (fn) {
      case "public_find_stop":
        if (norm(String(body.p_q)).includes("introuvable")) return Promise.resolve([]);
        if (norm(String(body.p_q)).includes("grenoble")) return Promise.resolve([{ net: "sncf", id: "87747006", name: "Grenoble", lat: 45.19, lon: 5.71 }]);
        return Promise.resolve([{ net: "sncf", id: "87723197", name: "Lyon Part-Dieu", lat: 45.76, lon: 4.86 }]);
      case "public_nearby_ids":
        return Promise.resolve([{ net: "sncf", id: "87723197", name: "Lyon Part-Dieu", dist: 0 }]);
      case "public_station":
        return Promise.resolve({
          net: "sncf", id: "87723197", name: "Lyon Part-Dieu",
          lines: [{ id: "L2", name: "C1", mode: "TER", n: 30, late15: 2, cancelled: 1 }],
          next: [
            { num: "881000", mode: "TER", line_id: "L2", line: "C1", dest: "Grenoble", sched: NOW + 1200, delay: 600, cancelled: false },
            { num: "881002", mode: "TER", line_id: "L2", line: "C1", dest: "Grenoble", sched: NOW + 600, delay: 0, cancelled: true },
          ],
          metro_next: [],
        });
      case "public_trip":
        return Promise.resolve({
          net: "sncf", n: 30, late15: 2, cancelled: 1,
          trains: [{ num: "881000", mode: "TER", line: "C1", dep: NOW + 1200, dep_delay: 600, arr: NOW + 5400, arr_delay: 540, cancelled: false }],
        });
      case "public_lines":
        return Promise.resolve(LINES);
      case "public_line":
        return Promise.resolve({ n: 353, late15: 12, cancelled: 0, stops: [{ name: "Gare du Nord", avg: 4.2, late15: 5, cancelled: 0 }] });
      case "public_disruptions":
        return Promise.resolve({ items: [
          { kind: "travaux", severity: "perturbe", title: "Travaux RER B", lines: "B", line_ids: ["C01743"], t_start: NOW, t_end: NOW + 86400, stops: [] },
          { kind: "greve", severity: "bloquant", title: "Grève TER Auvergne-Rhône-Alpes", lines: null, line_ids: null, t_start: NOW, t_end: NOW + 86400, stops: [["Grenoble", 45.19, 5.71]] },
        ] });
      case "public_train":
        return Promise.resolve(body.p_num === "6611"
          ? { mode: "OUI", status: "ON_TIME", max_delay: 900, line: null, long: "Paris - Marseille",
              stops: [["Paris Gare de Lyon", null, NOW, null, 0, false, "1"], ["Marseille", NOW + 12000, null, 900, null, false, "2"]], alerts: ["Panne de signalisation"] }
          : null);
    }
    return Promise.reject(new Error("inconnu " + fn));
  };
}

Deno.test("norm ignore accents, tirets et apostrophes", () => {
  assertEquals(norm("Châtelet-Les Halles"), "chatelet les halles");
  assertEquals(norm("L'Île  Saint-Denis"), "l ile saint denis");
});

Deno.test("hhmm affiche l'heure de Paris", () => {
  assertEquals(hhmm(1764145800), "09h30"); // 26/11/2025 08:30 UTC = 09h30 Paris
  assertEquals(hhmm(null), null);
});

Deno.test("matchLine reconnait les noms courants", () => {
  assertEquals(matchLine(LINES, "RER B")[0].id, "C01743");
  assertEquals(matchLine(LINES, "métro 14")[0].id, "C01384");
  assertEquals(matchLine(LINES, "t3b")[0].id, "C01679");
  assertEquals(matchLine(LINES, "ligne P")[0].id, "C01730");
  assertEquals(matchLine(LINES, "TER Lyon Grenoble")[0].id, "L2");
  assertEquals(matchLine(LINES, "RER Z").length, 0);
});

Deno.test("etat_gare : departs tries, heures lisibles, suppression signalee", async () => {
  const r = await runTool(fakeRpc(), "etat_gare", { nom: "Part Dieu" });
  assertEquals(r.gare, "Lyon Part-Dieu");
  assertEquals(r.prochains_departs.length, 2);
  assertEquals(r.prochains_departs[0].train, "881002");
  assertEquals(r.prochains_departs[0].supprime, true);
  assertEquals(r.prochains_departs[1].retard_min, 10);
  assert(/^\d\dh\d\d$/.test(r.prochains_departs[1].heure_prevue));
});

Deno.test("etat_gare : gare inconnue -> message clair", async () => {
  const r = await runTool(fakeRpc(), "etat_gare", { nom: "introuvable" });
  assertStringIncludes(r.erreur, "Aucune gare");
});

Deno.test("trajet : trains directs avec retards", async () => {
  const r = await runTool(fakeRpc(), "trajet", { depart: "Lyon", arrivee: "Grenoble" });
  assertEquals(r.de, "Lyon Part-Dieu");
  assertEquals(r.a, "Grenoble");
  assertEquals(r.prochains[0].retard_arrivee_min, 9);
});

Deno.test("etat_ligne : chiffres du jour + perturbations de la ligne seulement", async () => {
  _resetCache();
  const r = await runTool(fakeRpc(), "etat_ligne", { nom: "RER B" });
  assertEquals(r.ligne, "RER B");
  assertEquals(r.retards_15min, 12);
  assertEquals(r.perturbations.length, 1);
  assertEquals(r.perturbations[0].titre, "Travaux RER B");
  assertEquals(r.perturbations[0].lignes, "RER B");
});

Deno.test("perturbations : filtre par ville via les gares touchees", async () => {
  _resetCache();
  const r = await runTool(fakeRpc(), "perturbations", { filtre: "Grenoble" });
  assertEquals(r.nombre, 1);
  assertEquals(r.elements[0].type, "greve");
});

Deno.test("perturbations : greves hors transport ecartees, « RER A » ne filtre pas sur la lettre a", async () => {
  _resetCache();
  const base = fakeRpc();
  const rpc: Rpc = (fn, body) => fn !== "public_disruptions" ? base(fn, body) : Promise.resolve({ items: [
    { kind: "greve", severity: "bloquant", title: "Grève des sapeurs-pompiers", lines: null, line_ids: null, t_start: NOW, t_end: NOW },
    { kind: "greve", severity: "bloquant", title: "Grève nationale SNCF", lines: null, line_ids: null, t_start: NOW, t_end: NOW },
    { kind: "travaux", severity: "perturbe", title: "Travaux à Nation", lines: "A", line_ids: ["C01742"], t_start: NOW, t_end: NOW },
    { kind: "incident", severity: "perturbe", title: "Panne à Lyon", lines: null, line_ids: null, t_start: NOW, t_end: NOW },
  ] });
  const all = await runTool(rpc, "perturbations", {});
  assertEquals(all.nombre, 3);
  assertEquals(all.elements[0].titre, "Travaux à Nation");
  const lines = [...LINES, { net: "idf", id: "C01742", name: "A", long: "A", mode: "RER", n: 400, late15: 3, cancelled: 0 }];
  const rpcA: Rpc = (fn, body) => fn === "public_lines" ? Promise.resolve(lines) : rpc(fn, body);
  _resetCache();
  const a = await runTool(rpcA, "perturbations", { filtre: "RER A" });
  assertEquals(a.nombre, 1);
});

Deno.test("train : arrets et alertes ; numero inconnu", async () => {
  const r = await runTool(fakeRpc(), "train", { numero: "TGV 6611" });
  assertEquals(r.arrets.length, 2);
  assertEquals(r.arrets[1].retard_min, 15);
  assertEquals(r.alertes[0], "Panne de signalisation");
  assertStringIncludes((await runTool(fakeRpc(), "train", { numero: "1" })).erreur, "introuvable");
});

Deno.test("outil inconnu ou base en panne : jamais d'exception", async () => {
  assertStringIncludes((await runTool(fakeRpc(), "pirater", {})).erreur, "inconnu");
  const broken: Rpc = () => Promise.reject(new Error("timeout"));
  assertStringIncludes((await runTool(broken, "perturbations", {})).erreur, "indisponibles");
});

Deno.test("systemPrompt : heure, trajet habituel nettoye", () => {
  const p = systemPrompt({ trajet: "Lyon → Grenoble\n<script>", at: new Date("2026-11-26T07:30:00Z") });
  assertStringIncludes(p, "8:30");
  assertStringIncludes(p, "Lyon → Grenoble  script");
  assert(!p.includes("<script>"));
});

// ---------------------------------------------------------------- boucle complete avec un modele simule
function deps(chat: Chat, allow = true): Deps {
  return { chat, rpc: fakeRpc(), hit: () => Promise.resolve(allow), origins: ["https://adrienboulay.github.io"], salt: "s" };
}
const post = (body: unknown, origin = "https://adrienboulay.github.io") =>
  new Request("http://x/assistant", { method: "POST", headers: { origin, "content-type": "application/json", "x-forwarded-for": "1.2.3.4" }, body: JSON.stringify(body) });

Deno.test("conversation : le modele appelle un outil puis repond", async () => {
  const seen: Msg[][] = [];
  const chat: Chat = (messages) => {
    seen.push([...messages]);
    if (seen.length === 1) {
      const tc = [{ id: "abc123XYZ", type: "function" as const, function: { name: "trajet", arguments: '{"depart":"Lyon","arrivee":"Grenoble"}' } }];
      return Promise.resolve({ text: "", toolCalls: tc, raw: { role: "assistant", content: null, tool_calls: tc } });
    }
    return Promise.resolve({ text: "Ton TER 881000 a 9 min de retard.", toolCalls: [], raw: { role: "assistant", content: "x" } });
  };
  const res = await handle(post({ messages: [{ role: "user", content: "Mon train Lyon Grenoble ?" }], trajet: "Lyon → Grenoble" }), deps(chat));
  assertEquals(res.status, 200);
  const j = await res.json();
  assertEquals(j.reply, "Ton TER 881000 a 9 min de retard.");
  assertEquals(j.tools, ["trajet"]);
  const second = seen[1];
  assertEquals(second[0].role, "system");
  const tool = second[second.length - 1] as Extract<Msg, { role: "tool" }>;
  assertEquals(tool.role, "tool");
  assertEquals(tool.tool_call_id, "abc123XYZ");
  assertStringIncludes(tool.content, "881000");
  assertEquals(res.headers.get("access-control-allow-origin"), "https://adrienboulay.github.io");
});

Deno.test("conversation : limite du jour -> 429 avec message lisible", async () => {
  const chat: Chat = () => { throw new Error("ne doit pas etre appele"); };
  const res = await handle(post({ messages: [{ role: "user", content: "salut" }] }), deps(chat, false));
  assertEquals(res.status, 429);
  assertStringIncludes((await res.json()).reply, "limite");
});

Deno.test("conversation : entree invalide refusee, historique tronque", async () => {
  const chat: Chat = (m) => Promise.resolve({ text: String(m.length), toolCalls: [], raw: { role: "assistant", content: "" } });
  assertEquals((await handle(post({ messages: [] }), deps(chat))).status, 400);
  assertEquals((await handle(post({ messages: [{ role: "assistant", content: "x" }] }), deps(chat))).status, 400);
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "q".repeat(5000) })).concat([{ role: "user", content: "fin" }]);
  const j = await (await handle(post({ messages: many }), deps(chat))).json();
  assertEquals(j.reply, "13"); // 1 consigne + 12 derniers messages
});

Deno.test("conversation : fournisseur sature -> 503 et message", async () => {
  const chat: Chat = () => Promise.reject(new LlmError(429, "rate"));
  const res = await handle(post({ messages: [{ role: "user", content: "q" }] }), deps(chat));
  assertEquals(res.status, 503);
  assertStringIncludes((await res.json()).reply, "réessaie");
});

Deno.test("conversation : le modele boucle sur les outils -> arret propre", async () => {
  let n = 0;
  const chat: Chat = (_m, tools) => {
    n++;
    if (!tools.length) return Promise.resolve({ text: "Voici ce que j'ai.", toolCalls: [], raw: { role: "assistant", content: "" } });
    const tc = [{ id: "id" + n, type: "function" as const, function: { name: "perturbations", arguments: "{}" } }];
    return Promise.resolve({ text: "", toolCalls: tc, raw: { role: "assistant", content: null, tool_calls: tc } });
  };
  const j = await (await handle(post({ messages: [{ role: "user", content: "q" }] }), deps(chat))).json();
  assertEquals(j.reply, "Voici ce que j'ai.");
  assertEquals(n, 5);
});

Deno.test("mistralChat : format de requete et lecture des appels d'outils", async () => {
  let sent: Record<string, unknown> = {};
  const fakeFetch = ((_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "",
      tool_calls: [{ id: "k1", function: { name: "train", arguments: { numero: "6611" } } }] } }] })));
  }) as unknown as typeof fetch;
  const r = await mistralChat("cle", "mistral-small-latest", fakeFetch)([{ role: "user", content: "q" }], [{ name: "train", description: "d", parameters: {} }]);
  assertEquals((sent.tools as unknown[]).length, 1);
  assertEquals(r.toolCalls[0].function.arguments, '{"numero":"6611"}');
  await mistralChat("cle", "m", fakeFetch)([{ role: "user", content: "q" }], []);
  assertEquals(sent.tools, undefined);
});

// ---------------------------------------------------------------- itineraire et voix
Deno.test("conversation : demande de trajet -> action d'ouverture de la carte", async () => {
  let n = 0;
  const chat: Chat = () => {
    if (n++ === 0) {
      const tc = [{ id: "itin12345", type: "function" as const, function: { name: "ouvrir_itineraire", arguments: '{"arrivee":"Grenoble"}' } }];
      return Promise.resolve({ text: "", toolCalls: tc, raw: { role: "assistant", content: null, tool_calls: tc } });
    }
    return Promise.resolve({ text: "Je t'ouvre l'itinéraire vers Grenoble.", toolCalls: [], raw: { role: "assistant", content: "x" } });
  };
  const res = await handle(post({ messages: [{ role: "user", content: "Je veux aller à Grenoble" }] }), deps(chat));
  const j = await res.json();
  assertEquals(j.action, { type: "itineraire", depart: "ma position", arrivee: "Grenoble" });
});

const audio = (bytes: number, type = "audio/webm;codecs=opus") =>
  new Request("http://x/assistant", { method: "POST", headers: { origin: "https://adrienboulay.github.io", "content-type": type, "x-forwarded-for": "1.2.3.4" }, body: new Uint8Array(bytes) });

Deno.test("voix : transcription renvoyee, sans appeler le modele", async () => {
  const chat: Chat = () => { throw new Error("ne doit pas etre appele"); };
  let got = "";
  const d = { ...deps(chat), stt: (a: Uint8Array, t: string) => { got = `${a.length} ${t}`; return Promise.resolve("de Lyon à Grenoble"); } };
  const res = await handle(audio(1000), d);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).text, "de Lyon à Grenoble");
  assertEquals(got, "1000 audio/webm");
});

Deno.test("voix : sans cle 501, trop long 413, limite 429", async () => {
  const chat: Chat = () => { throw new Error("ne doit pas etre appele"); };
  assertEquals((await handle(audio(10), deps(chat))).status, 501);
  const stt = () => Promise.resolve("x");
  assertEquals((await handle(audio(2_100_000), { ...deps(chat), stt })).status, 413);
  assertEquals((await handle(audio(10), { ...deps(chat, false), stt })).status, 429);
});

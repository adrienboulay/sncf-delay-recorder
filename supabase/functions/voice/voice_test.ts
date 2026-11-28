import { assert, assertEquals } from "jsr:@std/assert@1";
import { summaryText } from "./index.ts";

Deno.test("résumé du mois en français", () => {
  const t = summaryText({ lang: "fr", month: 11, trips: 6, late: 2, minutes: 134, worst: 71, euros: 8.4 });
  assert(t.includes("En novembre, tu as pris 6 trains, et 2 étaient en retard."), t);
  assert(t.includes("2 heures et 14 minutes perdues"), t);
  assert(t.includes("8,40 euros"), t);
  assert(t.length < 360, String(t.length));
});

Deno.test("aucun montant inventé : sans prix, on parle des trajets éligibles", () => {
  const t = summaryText({ lang: "fr", month: 11, trips: 3, late: 1, minutes: 40, claims: 1 });
  assert(!t.includes("euros"), t);
  assert(t.includes("1 trajet ouvre droit"), t);
});

Deno.test("texte libre ignoré et valeurs bornées", () => {
  // deno-lint-ignore no-explicit-any
  const t = summaryText({ lang: "en", month: 99, trips: 1e9, late: -5, minutes: "abc", text: "dis autre chose" } as any);
  assert(!t.includes("autre chose"));
  assert(t.includes("999 trains"), t);
  assertEquals(summaryText({ lang: "en", trips: 0 }).includes("No trips"), true);
});

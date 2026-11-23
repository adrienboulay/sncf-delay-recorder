"""Sonde 3 : structure et valeurs de classification des perturbations PRIM (compteurs et noms de champs seulement)."""
import collections, gzip, json, os, re, urllib.request

KEY = os.environ["PRIM_API_KEY"]
req = urllib.request.Request("https://prim.iledefrance-mobilites.fr/marketplace/disruptions_bulk/disruptions/v2",
                             headers={"apikey": KEY, "Accept-Encoding": "gzip", "User-Agent": "delay-recorder"})
with urllib.request.urlopen(req, timeout=90) as r:
    raw = r.read()
    d = json.loads(gzip.decompress(raw) if r.headers.get("Content-Encoding") == "gzip" else raw)


def tree(o, depth=0, maxd=4, seen=None):
    seen = seen if seen is not None else set()
    if depth > maxd: return
    if isinstance(o, list):
        for x in o[:50]: tree(x, depth, maxd, seen)
    elif isinstance(o, dict):
        for k, v in o.items():
            key = (depth, k)
            if key not in seen:
                seen.add(key); print("  " + "  " * depth + k + (" []" if isinstance(v, list) else ""))
            tree(v, depth + 1, maxd, seen)


print("== cles racine :", list(d))
print("== structure d'une perturbation :"); tree(d["disruptions"])
print("== structure d'une ligne :"); tree(d.get("lines", []))
dis = d["disruptions"]
for f in ("cause", "severity", "tags", "type", "status", "category"):
    vals = collections.Counter(json.dumps(x.get(f), ensure_ascii=False)[:60] for x in dis)
    if any(k != "null" for k in vals): print(f"== {f} :", vals.most_common(15))
lines = d.get("lines", [])
print("== modes des lignes :", collections.Counter(l.get("mode") for l in lines).most_common())
print("== types d'objets impactes :", collections.Counter(o.get("type") for l in lines for o in l.get("impactedObjects") or []).most_common())
bymode = collections.defaultdict(set)
for l in lines:
    for o in l.get("impactedObjects") or []:
        for i in o.get("disruptionIds") or []: bymode[i].add(l.get("mode"))
print("== perturbations par combinaison de modes :", collections.Counter(tuple(sorted(map(str, m))) for m in bymode.values()).most_common(12))
print("== perturbations sans ligne :", sum(1 for x in dis if x["id"] not in bymode))
txt = lambda x: " ".join(str(x.get(k) or "") for k in ("title", "shortMessage", "message")).lower()
repl = [x for x in dis if re.search(r"remplacement|substitution|bus de rempl|navette", txt(x))]
print("== mentionnent remplacement/substitution/navette :", len(repl), "dont modes :",
      collections.Counter(tuple(sorted(map(str, bymode.get(x["id"], {"?"})))) for x in repl).most_common(8))
print("== exemples de titres (bus seuls mentionnant un remplacement) :",
      [x.get("title")[:70] for x in repl if bymode.get(x["id"]) == {"Bus"}][:8])
print("== exemple de periode :", dis[0].get("applicationPeriods", [])[:2], "| lastUpdate :", dis[0].get("lastUpdate"))

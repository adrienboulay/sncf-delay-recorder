"""Construit les fichiers statiques de la carte a partir des donnees ouvertes officielles (a relancer si les lignes changent).

Sources :
  - Traces du reseau ferre d'Ile-de-France (Ile-de-France Mobilites, Licence Ouverte v2.0) : traces + couleur officielle + pictogramme
    https://data.iledefrance-mobilites.fr/explore/dataset/traces-du-reseau-ferre-idf/
  - Formes des lignes du Reseau Ferre National (SNCF Reseau, ODbL) : trace reel des voies en France
    https://ressources.data.sncf.com/explore/dataset/formes-des-lignes-du-rfn/
Sorties (dans le dossier du site) :
  data/lignes-idf.json   {lines: {C01742: {name, mode, color, picto}}, shapes: [[code, [[lat, lon], ...]], ...]}
  data/rfn.json          [[[lat, lon], ...], ...]   (voies simplifiees a ~150 m, pour la vue large)
  pictos/<code>.png      pictogrammes officiels reduits a 48 px de haut

Usage : python tools/build_geo.py <idf.geojson> <rfn.geojson> [arrets.json]
  arrets.json : export du jeu « Arrets et lignes associees » (IDFM) filtre sur metro, tram, RER, Transilien, funiculaire, cable
                -> ajoute stops: {C01742: [[lat, lon, nom], ...]} (une entree par nom d'arret et par ligne)
"""
import gzip, io, json, os, sys, urllib.request
from PIL import Image

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODES = {"METRO": "METRO", "RER": "RER", "TRAIN": "TRANSILIEN", "TRAMWAY": "TRAM", "NAVETTE": "NAVETTE", "CABLE": "CABLE"}


def rdp(pts, eps):
    """Simplification Douglas-Peucker (sans dependance)."""
    if len(pts) < 3: return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    n2 = dx * dx + dy * dy
    best, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        x, y = pts[i]
        if n2 == 0: d = (x - x1) ** 2 + (y - y1) ** 2
        else:
            t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / n2))
            d = (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2
        if d > best: best, idx = d, i
    if best <= eps * eps: return [pts[0], pts[-1]]
    return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)


def load(path):
    raw = open(path, "rb").read()
    if raw[:2] == bytes([0x1F, 0x8B]): raw = gzip.decompress(raw)   # les exports arrivent parfois compresses
    return json.loads(raw.decode("utf-8"))


def lines_of(geom):
    if not geom: return []
    if geom["type"] == "LineString": return [geom["coordinates"]]
    if geom["type"] == "MultiLineString": return geom["coordinates"]
    return []


def latlon(coords, eps, nd):
    pts = rdp([(c[1], c[0]) for c in coords], eps)
    return [[round(a, nd), round(b, nd)] for a, b in pts]


def main(idf_path, rfn_path, stops_path=None):
    os.makedirs(os.path.join(SITE, "data"), exist_ok=True)
    os.makedirs(os.path.join(SITE, "pictos"), exist_ok=True)
    # ---------------- Ile-de-France : traces, couleurs, pictogrammes
    feats = load(idf_path)["features"]
    lines, shapes, pictos = {}, [], {}
    for f in feats:
        p = f["properties"]
        code, mode = p.get("idrefligc"), MODES.get(p.get("mode"))
        if not code or not mode or not p.get("colourweb_hexa"): continue   # TER (traces SNCF) : non retenus ici
        name = p.get("indice_lig") or p.get("res_com")
        lines.setdefault(code, {"name": name, "mode": mode, "color": "#" + p["colourweb_hexa"].lower()})
        if p.get("picto_final") and "picto_intermediaire" not in p["picto_final"]: pictos[code] = p["picto_final"]
        for part in lines_of(f.get("geometry")):
            shapes.append([code, latlon(part, 0.00008, 5)])
    for code, url in sorted(pictos.items()):
        out = os.path.join(SITE, "pictos", code + ".png")
        try:
            raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "lateproof-map-build"}), timeout=60).read()
            im = Image.open(io.BytesIO(raw)).convert("RGBA")
            im = im.crop(im.getbbox() or (0, 0, im.width, im.height))
            im.thumbnail((96, 48), Image.LANCZOS)
            im.save(out, optimize=True)
            lines[code]["picto"] = f"pictos/{code}.png"
        except Exception as ex:
            print("picto introuvable", code, ex)
    stops = {}
    if stops_path:
        acc = {}
        for r in load(stops_path):
            code = (r.get("id") or "").replace("IDFM:", "")
            if code not in lines or not r.get("stop_lat"): continue
            a = acc.setdefault(code, {}).setdefault(r["stop_name"], [0.0, 0.0, 0])
            a[0] += float(r["stop_lat"]); a[1] += float(r["stop_lon"]); a[2] += 1
        stops = {c: [[round(a[0] / a[2], 5), round(a[1] / a[2], 5), n] for n, a in d.items()] for c, d in acc.items()}
    json.dump({"source": "Ile-de-France Mobilites, traces du reseau ferre (Licence Ouverte v2.0)", "lines": lines, "shapes": shapes, "stops": stops},
              open(os.path.join(SITE, "data", "lignes-idf.json"), "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    # ---------------- France : voies du reseau ferre national (vue large)
    rfn = []
    for f in load(rfn_path)["features"]:
        for part in lines_of(f.get("geometry")):
            pts = latlon(part, 0.0014, 3)
            if len(pts) >= 2: rfn.append(pts)
    json.dump(rfn, open(os.path.join(SITE, "data", "rfn.json"), "w", encoding="utf-8"), separators=(",", ":"))
    for n in ("data/lignes-idf.json", "data/rfn.json"):
        print(n, os.path.getsize(os.path.join(SITE, n)) // 1000, "ko")
    print(len(lines), "lignes IDF,", len(shapes), "traces,", sum(len(v) for v in stops.values()), "arrets,", sum(1 for l in lines.values() if l.get("picto")), "pictogrammes ;", len(rfn), "troncons RFN")


if __name__ == "__main__":
    main(*sys.argv[1:4])

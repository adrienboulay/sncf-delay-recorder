"""Previsions de greves : lit l'agenda public cestlagreve.fr (via le cache Firecrawl), garde les greves qui touchent
les transports (ou les greves nationales), et les enregistre dans strike_forecasts.

Economie : la page n'est lue qu'une fois toutes les 12 h (cache partage), soit au plus 2 credits Firecrawl par jour.
Variables : DATABASE_URL, FIRECRAWL_API_KEY.
"""
import datetime, hashlib, os, re, time
import psycopg
from sncf_common import apply_schema, bulk_upsert
from firecrawl_cache import get_facts

SOURCE = "https://www.cestlagreve.fr/"
TRANSPORT = re.compile(r"transport|sncf|ratp|ter\b|tgv|train|rer\b|m[ée]tro|tram|bus|cheminot|aiguilleur|contr[ôo]leur|"
                       r"r[ée]seau|ouigo|intercit|transilien|keolis|transdev|tcl|tag|star|tisséo|rtm", re.I)
NATIONAL = re.compile(r"toute la france|nationale|interprofessionnel", re.I)
DATE = r"(\d{2}/\d{2}/\d{4})"


def clean(md):
    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", md)                # images
    md = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", md)              # liens -> texte
    md = re.sub(r"[#*_>`|]+", " ", md)
    return [re.sub(r"\s+", " ", l).strip() for l in md.splitlines() if l.strip()]


def extract(markdown):
    """Strict minimum : titre, debut, fin, lieu, transport oui/non, national oui/non."""
    lines, out = clean(markdown), []
    for i, l in enumerate(lines):
        if not l.lower().startswith("grève") or len(l) > 140:
            continue
        window = " ".join(lines[i + 1:i + 4])
        m = re.search(rf"Du {DATE} au {DATE}", window) or re.search(rf"Le {DATE}", window)
        if not m:
            continue
        start = m.group(1); end = m.group(2) if m.lastindex == 2 else m.group(1)
        place = next((x for x in lines[i + 1:i + 4] if not re.search(DATE, x)), "")[:80]
        text = f"{l} {place}"
        transport, national = bool(TRANSPORT.search(text)), bool(NATIONAL.search(text))
        if transport or national:
            out.append({"title": l[:120], "start": start, "end": end, "place": place,
                        "transport": transport, "national": national})
    return {"strikes": out[:60]}


def iso(d):  # 01/12/2026 -> 20261201
    return datetime.datetime.strptime(d, "%d/%m/%Y").strftime("%Y%m%d")


def main():
    with psycopg.connect(os.environ["DATABASE_URL"]) as con:
        apply_schema(con)
        facts = get_facts(con, "strike_calendar", SOURCE, extract, ttl_s=12 * 3600)
        strikes = (facts or {}).get("strikes", [])
        now = int(time.time())
        rows = [(hashlib.md5(f"{s['title']}|{s['start']}".encode()).hexdigest(), s["title"], iso(s["start"]), iso(s["end"]),
                 s["place"], "national" if s["national"] else "local", s["transport"], "cestlagreve.fr", now, now)
                for s in strikes]
        bulk_upsert(con.cursor(), "strike_forecasts",
                    ["strike_id", "title", "start_date", "end_date", "place", "scope", "transport", "source", "first_seen", "last_seen"],
                    rows, ["strike_id"], {c: None for c in ["title", "start_date", "end_date", "place", "scope", "transport", "last_seen"]})
        con.commit()
        print(f"greves retenues (transport ou nationales) : {len(rows)} ; "
              f"credits Firecrawl aujourd'hui : {con.execute('SELECT credits FROM firecrawl_usage ORDER BY day DESC LIMIT 1').fetchone()}")


if __name__ == "__main__":
    main()

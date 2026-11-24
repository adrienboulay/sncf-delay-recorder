"""Acces a Firecrawl TOUJOURS via un cache partage en base (table firecrawl_cache).

Regles pour economiser les credits :
1. On regarde d'abord le cache : si l'info est encore valide, aucun appel a Firecrawl.
2. Si plusieurs taches ou utilisateurs demandent la meme page en meme temps, un verrou Postgres par URL fait qu'UN
   seul appel part ; les autres attendent puis relisent le cache.
3. On ne stocke que le strict minimum (les champs renvoyes par `extract`), jamais la page complete.
4. Plafond quotidien de credits (FIRECRAWL_DAILY_CAP, 50 par defaut) : au-dela, on renvoie l'ancienne info ou None.
Les utilisateurs de l'app ne declenchent jamais Firecrawl : ils lisent la base. Seules les taches serveur l'appellent.

Usage :
    facts = get_facts(con, "strike_notice", url, extract=lambda markdown: {...}, ttl_s=6 * 3600)
"""
import datetime, hashlib, json, os, time, urllib.request
from zoneinfo import ZoneInfo

API = "https://api.firecrawl.dev/v1/scrape"
FAILED_RETRY_S = 1800  # apres un echec, on attend 30 min avant de reessayer cette page


def _key(url):
    return hashlib.md5(url.strip().lower().rstrip("/").encode()).hexdigest()


def _today():
    return datetime.datetime.now(ZoneInfo("Europe/Paris")).strftime("%Y%m%d")


def _scrape(url):
    req = urllib.request.Request(API, method="POST",
                                 data=json.dumps({"url": url, "formats": ["markdown"], "onlyMainContent": True}).encode(),
                                 headers={"Authorization": f"Bearer {os.environ['FIRECRAWL_API_KEY']}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return (json.loads(r.read()).get("data") or {}).get("markdown") or ""


def get_facts(con, kind, url, extract, ttl_s):
    """Renvoie le dict minimal extrait de la page (depuis le cache si possible), ou None si indisponible."""
    k, now = _key(url), int(time.time())

    def cached():
        row = con.execute("SELECT facts, expires_at, ok FROM firecrawl_cache WHERE url_key = %s", (k,)).fetchone()
        return row

    row = cached()
    if row and row[1] > now:
        con.commit()
        return row[0] if row[2] else None

    # Verrou par URL, le temps de la transaction : un seul appel Firecrawl a la fois pour cette page.
    con.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (k,))
    row = cached()
    if row and row[1] > now:  # quelqu'un vient de la lire pendant qu'on attendait le verrou
        con.commit()
        return row[0] if row[2] else None

    cap = int(os.environ.get("FIRECRAWL_DAILY_CAP", "50"))
    used = con.execute("SELECT credits FROM firecrawl_usage WHERE day = %s", (_today(),)).fetchone()
    if not os.environ.get("FIRECRAWL_API_KEY") or (used and used[0] >= cap):
        con.commit()
        return row[0] if row and row[2] else None  # ancienne info (meme perimee) plutot que rien

    try:
        facts, ok, ttl = extract(_scrape(url)), True, ttl_s
    except Exception:
        facts, ok, ttl = {}, False, FAILED_RETRY_S
    con.execute("""INSERT INTO firecrawl_cache (url_key, kind, url, facts, fetched_at, expires_at, ok)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (url_key) DO UPDATE SET facts = EXCLUDED.facts, fetched_at = EXCLUDED.fetched_at,
                     expires_at = EXCLUDED.expires_at, ok = EXCLUDED.ok""",
                (k, kind, url, json.dumps(facts, ensure_ascii=False), now, now + ttl, ok))
    con.execute("""INSERT INTO firecrawl_usage (day, credits) VALUES (%s, 1)
                   ON CONFLICT (day) DO UPDATE SET credits = firecrawl_usage.credits + 1""", (_today(),))
    con.commit()
    return facts if ok else None

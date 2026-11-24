-- ============ CACHE FIRECRAWL (economie de credits) ============
-- Toute lecture de page par Firecrawl passe par ce cache : une page n'est lue qu'UNE fois par periode de validite,
-- quel que soit le nombre d'utilisateurs ou de taches qui la demandent en meme temps.
-- On ne garde que le STRICT MINIMUM extrait (quelques champs), jamais le texte complet de la page.
CREATE TABLE IF NOT EXISTS firecrawl_cache (
  url_key TEXT PRIMARY KEY,          -- md5 de l'URL normalisee
  kind TEXT NOT NULL,                -- ex. strike_notice, traffic_line, train_check
  url TEXT NOT NULL,
  facts JSONB NOT NULL,              -- le minimum utile, ex. {"strike": true, "start": "...", "end": "...", "lines": ["TER HdF"]}
  fetched_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  ok BOOLEAN NOT NULL DEFAULT true); -- false = la lecture a echoue (on ne reessaie pas avant expiration courte)
CREATE INDEX IF NOT EXISTS firecrawl_cache_kind ON firecrawl_cache(kind, expires_at);
-- Journal de consommation : pour respecter un plafond quotidien de credits.
CREATE TABLE IF NOT EXISTS firecrawl_usage (day TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0);
ALTER TABLE firecrawl_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE firecrawl_usage ENABLE ROW LEVEL SECURITY;

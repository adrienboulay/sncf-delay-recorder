-- ============ EMPREINTES PUBLIEES SUR SOLANA (registre des preuves) ============
-- Une ligne par journee : la racine de Merkle des retards de la journee, l'endroit ou la liste exacte est
-- archivee (pour recalculer les preuves plus tard), et la transaction Solana quand elle est publiee.
CREATE TABLE IF NOT EXISTS delay_roots (
  day TEXT PRIMARY KEY,              -- AAAAMMJJ (heure de Paris)
  root TEXT NOT NULL,                -- racine en hexadecimal (64 caracteres)
  n_records INTEGER NOT NULL,
  format TEXT NOT NULL,              -- version du format des enregistrements (v1)
  leaves_path TEXT,                  -- archive/proofs/AAAA/MM/JJ/delays-v1.txt.gz (liste triee des enregistrements)
  built_at BIGINT NOT NULL,
  tx_signature TEXT,                 -- signature de la transaction post_delay_root (NULL tant que non publiee)
  posted_at BIGINT);
ALTER TABLE delay_roots ENABLE ROW LEVEL SECURITY;

-- Preuve verifiable par tous : adresse du compte Solana de l'empreinte (PDA) et chemin PUBLIC de la liste exacte
-- des enregistrements (bucket « proofs »). La page de verification recalcule la racine dans le navigateur.
ALTER TABLE delay_roots ADD COLUMN IF NOT EXISTS pda TEXT;
ALTER TABLE delay_roots ADD COLUMN IF NOT EXISTS public_path TEXT;
CREATE OR REPLACE FUNCTION public.public_delay_root(p_day TEXT) RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object('day', day, 'root', root, 'n', n_records, 'format', format, 'tx', tx_signature,
                           'posted_at', posted_at, 'pda', pda, 'list', public_path)
  FROM delay_roots WHERE day = p_day $$;
REVOKE ALL ON FUNCTION public.public_delay_root(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_delay_root(TEXT) TO anon;

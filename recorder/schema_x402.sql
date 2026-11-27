-- ============ PAIEMENTS x402 (API payante « advice ») ============
-- Chaque appel payé et réglé sur Solana : la transaction (publique sur la chaîne), le payeur, le montant.
-- Écrit uniquement par la fonction serveur (clé de service) ; la page « API » lit les derniers via public_x402_payments().
CREATE TABLE IF NOT EXISTS x402_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tx TEXT NOT NULL,
  payer TEXT,
  amount TEXT NOT NULL,          -- unités atomiques (USDC : 6 décimales)
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  route TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE x402_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON x402_payments FROM anon, authenticated;
CREATE OR REPLACE FUNCTION public.public_x402_payments() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
    SELECT tx, payer, amount, route, network, EXTRACT(EPOCH FROM created_at)::bigint AS at
    FROM x402_payments ORDER BY created_at DESC LIMIT 20) x $$;
REVOKE ALL ON FUNCTION public.public_x402_payments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_x402_payments() TO anon;

-- Écriture du journal par la fonction serveur, avec la clé de service uniquement
CREATE OR REPLACE FUNCTION public.x402_log(p_tx TEXT, p_payer TEXT, p_amount TEXT, p_asset TEXT, p_network TEXT, p_route TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO x402_payments (tx, payer, amount, asset, network, route) VALUES (p_tx, p_payer, p_amount, p_asset, p_network, p_route) $$;
REVOKE ALL ON FUNCTION public.x402_log(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.x402_log(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

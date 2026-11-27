-- ============ TABLEAU DE BORD (gestion du site et statistiques) ============
-- Ces fonctions ne sont appelables QU'AVEC la clé de service, c'est-à-dire par la fonction serveur « admin »,
-- elle-même protégée par le mot de passe ADMIN_TOKEN. Le navigateur n'y a jamais accès directement.

CREATE OR REPLACE FUNCTION public.admin_stats() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS today, EXTRACT(EPOCH FROM now())::bigint AS t0)
  SELECT json_build_object(
    'now', (SELECT t0 FROM d),
    'today', public.public_today_stats(),
    'waitlist', json_build_object(
      'total', (SELECT COUNT(*) FROM waitlist),
      'last7', (SELECT COUNT(*) FROM waitlist WHERE created_at > now() - interval '7 days'),
      'by_profile', (SELECT COALESCE(json_object_agg(COALESCE(profile, '?'), n), '{}'::json) FROM (SELECT profile, COUNT(*) n FROM waitlist GROUP BY profile) x),
      'by_day', (SELECT COALESCE(json_agg(x ORDER BY x.day), '[]'::json) FROM (
          SELECT to_char(created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS day, COUNT(*) AS n FROM waitlist
          WHERE created_at > now() - interval '14 days' GROUP BY 1) x)),
    'reviews', json_build_object('pending', (SELECT COUNT(*) FROM reviews WHERE NOT approved), 'approved', (SELECT COUNT(*) FROM reviews WHERE approved)),
    'gus', json_build_object(
      'today', (SELECT COALESCE(SUM(n), 0) FROM assistant_usage, d WHERE day = d.today),
      'users_today', (SELECT COUNT(DISTINCT who) FROM assistant_usage, d WHERE day = d.today),
      'by_day', (SELECT COALESCE(json_agg(x ORDER BY x.day), '[]'::json) FROM (SELECT day, SUM(n) AS n, COUNT(DISTINCT who) AS users FROM assistant_usage GROUP BY day) x)),
    'x402', json_build_object(
      'count', (SELECT COUNT(*) FROM x402_payments),
      'usdc', (SELECT COALESCE(SUM(amount::numeric), 0) / 1e6 FROM x402_payments),
      'by_route', (SELECT COALESCE(json_object_agg(route, n), '{}'::json) FROM (SELECT route, COUNT(*) n FROM x402_payments GROUP BY route) x),
      'last', (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
          SELECT tx, route, amount, payer, EXTRACT(EPOCH FROM created_at)::bigint AS at FROM x402_payments ORDER BY created_at DESC LIMIT 10) x)),
    'solana', (SELECT COALESCE(json_agg(x ORDER BY x.day DESC), '[]'::json) FROM (
        SELECT day, n_records, tx_signature AS tx, posted_at, public_path IS NOT NULL AS public_list FROM delay_roots ORDER BY day DESC LIMIT 7) x),
    'recorder', json_build_object(
      'sncf_last', (SELECT MAX(polled_at) FROM polls),
      'sncf_hour', (SELECT COUNT(*) FROM polls, d WHERE polled_at > d.t0 - 3600),
      'sncf_errors_hour', (SELECT COUNT(*) FROM polls, d WHERE polled_at > d.t0 - 3600 AND error IS NOT NULL AND error <> ''),
      'idf_last', (SELECT MAX(polled_at) FROM idfm_polls),
      'idf_hour', (SELECT COUNT(*) FROM idfm_polls, d WHERE polled_at > d.t0 - 3600)),
    'database', json_build_object(
      'size', pg_size_pretty(pg_database_size(current_database())),
      'bytes', pg_database_size(current_database()),
      'tables', (SELECT json_agg(x) FROM (
          SELECT c.relname AS name, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, pg_total_relation_size(c.oid) AS bytes
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8) x))
  ) $$;

CREATE OR REPLACE FUNCTION public.admin_reviews() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(json_agg(x ORDER BY x.approved, x.at DESC), '[]'::json) FROM (
    SELECT id, name, trip, body, lang, approved, EXTRACT(EPOCH FROM created_at)::bigint AS at FROM reviews ORDER BY created_at DESC LIMIT 200) x $$;

CREATE OR REPLACE FUNCTION public.admin_review_set(p_id BIGINT, p_approved BOOLEAN) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ UPDATE reviews SET approved = p_approved WHERE id = p_id $$;

CREATE OR REPLACE FUNCTION public.admin_review_delete(p_id BIGINT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ DELETE FROM reviews WHERE id = p_id $$;

-- Liste des inscrits (e-mails) : uniquement pour l'export depuis le tableau de bord
CREATE OR REPLACE FUNCTION public.admin_waitlist() RETURNS JSON
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(json_agg(x ORDER BY x.created_at DESC), '[]'::json) FROM (
    SELECT email, lang, profile, line, source, created_at FROM waitlist ORDER BY created_at DESC) x $$;

DO $$ DECLARE f TEXT; BEGIN
  FOREACH f IN ARRAY ARRAY['admin_stats()', 'admin_reviews()', 'admin_review_set(BIGINT, BOOLEAN)', 'admin_review_delete(BIGINT)', 'admin_waitlist()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

"""Diagnostic de la base (lecture seule, chiffres agrégés uniquement : les logs GitHub sont publics).
Tailles, écritures par table, lectures disque, requêtes les plus coûteuses. Lancer : python recorder/db_health.py"""
import os
import psycopg

con = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)


def show(title, sql, args=()):
    print(f"\n== {title}")
    try:
        cur = con.execute(sql, args)
        cols = [d.name for d in cur.description]
        rows = cur.fetchall()
        print(" | ".join(cols))
        for r in rows:
            print(" | ".join("" if v is None else str(v)[:95] for v in r))
    except Exception as e:
        print("indisponible :", str(e).splitlines()[0][:150])


show("Taille totale", "SELECT pg_size_pretty(pg_database_size(current_database())) AS taille")
show("Depuis la remise a zero des compteurs", "SELECT stats_reset, now() - stats_reset AS duree FROM pg_stat_database WHERE datname = current_database()")
show("Tables : taille, lignes, ecritures depuis la remise a zero", """
SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS total, pg_size_pretty(pg_indexes_size(relid)) AS index,
       n_live_tup AS lignes, n_dead_tup AS mortes, n_tup_ins AS insert, n_tup_upd AS update, n_tup_hot_upd AS hot, n_tup_del AS delete,
       seq_scan, idx_scan, last_autovacuum::timestamp(0) AS autovacuum
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 25""")
show("Lectures disque par table (blocs lus sur disque / en cache)", """
SELECT relname AS table, heap_blks_read AS disque, heap_blks_hit AS cache, idx_blks_read AS index_disque, idx_blks_hit AS index_cache,
       round(100.0 * heap_blks_hit / NULLIF(heap_blks_hit + heap_blks_read, 0), 1) AS pct_cache
FROM pg_statio_user_tables ORDER BY heap_blks_read + idx_blks_read DESC LIMIT 15""")
show("Index jamais utilises (cout d'ecriture pour rien)", """
SELECT s.relname AS table, s.indexrelname AS index, pg_size_pretty(pg_relation_size(s.indexrelid)) AS taille, s.idx_scan
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 15""")
show("Cache global", """
SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS pct_cache, blks_read AS blocs_disque, blks_hit,
       tup_inserted, tup_updated, tup_deleted, temp_files, pg_size_pretty(temp_bytes) AS temp
FROM pg_stat_database WHERE datname = current_database()""")
show("WAL ecrit (volume d'ecriture)", "SELECT pg_size_pretty(wal_bytes) AS wal, wal_records, stats_reset FROM pg_stat_wal")
show("Requetes : plus de blocs lus sur disque", """
SELECT calls, round(total_exec_time::numeric / 1000, 1) AS sec_total, round(mean_exec_time::numeric, 1) AS ms_moy,
       shared_blks_read AS lus_disque, shared_blks_written + shared_blks_dirtied AS ecrits, temp_blks_written AS temp,
       regexp_replace(left(query, 90), '\\s+', ' ', 'g') AS requete
FROM extensions.pg_stat_statements ORDER BY shared_blks_read DESC LIMIT 15""")
show("Requetes : plus d'ecritures", """
SELECT calls, round(total_exec_time::numeric / 1000, 1) AS sec_total, shared_blks_dirtied AS salis, shared_blks_written AS ecrits,
       pg_size_pretty(wal_bytes) AS wal, regexp_replace(left(query, 90), '\\s+', ' ', 'g') AS requete
FROM extensions.pg_stat_statements ORDER BY wal_bytes DESC LIMIT 15""")
show("Requetes : plus de temps total", """
SELECT calls, round(total_exec_time::numeric / 1000, 1) AS sec_total, round(mean_exec_time::numeric, 1) AS ms_moy,
       regexp_replace(left(query, 90), '\\s+', ' ', 'g') AS requete
FROM extensions.pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15""")
show("Requetes : plus de fichiers temporaires (tris / hachages qui debordent sur disque)", """
SELECT calls, temp_blks_written AS temp_blocs, pg_size_pretty(temp_blks_written * 8192) AS temp,
       round(mean_exec_time::numeric, 1) AS ms_moy, regexp_replace(left(query, 90), '\\s+', ' ', 'g') AS requete
FROM extensions.pg_stat_statements WHERE temp_blks_written > 0 ORDER BY temp_blks_written DESC LIMIT 15""")
show("Fenetre de pg_stat_statements", "SELECT stats_reset FROM extensions.pg_stat_statements_info")
show("COMPTEURS (a comparer entre deux rapports)", """
SELECT now()::timestamp(0) AS a, w.wal_bytes, d.temp_bytes, d.temp_files,
       (SELECT COUNT(*) FROM polls) AS polls,
       (SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'stop_updates') AS upd_stop_updates,
       (SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'idfm_stop_updates') AS upd_idfm_stop_updates,
       (SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'trains') AS upd_trains,
       (SELECT n_tup_upd FROM pg_stat_user_tables WHERE relname = 'idfm_trains') AS upd_idfm_trains
FROM pg_stat_wal w, pg_stat_database d WHERE d.datname = current_database()""")
show("Lignes presentes dans le flux (vues depuis 12 min)", """
SELECT (SELECT COUNT(*) FROM stop_updates WHERE last_seen > EXTRACT(EPOCH FROM now())::bigint - 720) AS stop_updates,
       (SELECT COUNT(*) FROM idfm_stop_updates WHERE last_seen > EXTRACT(EPOCH FROM now())::bigint - 720) AS idfm_stop_updates""")
show("Table des prochains metros : journalisee ? (u = non)", "SELECT relpersistence FROM pg_class WHERE oid = 'public.idfm_metro_next'::regclass")
con.close()

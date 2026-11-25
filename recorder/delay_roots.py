"""Chaque nuit : l'empreinte (racine de Merkle) de tous les retards de la veille, publiee sur Solana.

1. Lit les retards de la journee (heure de Paris) : chaque passage en gare avec au moins 1 min de retard,
   chaque arret supprime et chaque train supprime, SNCF et Ile-de-France.
2. Les ecrit au format canonique v1, une ligne par enregistrement, TRIEES (le resultat est reproductible) :
       v1|<reseau>|<AAAAMMJJ>|<train>|<arret>|<retard en s>|<statut>
   ex. v1|sncf|20261126|860123|87723197|1620|LATE
3. Calcule la racine (memes regles que le programme Solana, voir merkle.py) et archive la liste exacte
   dans Supabase Storage : sans elle, on ne pourrait plus fabriquer les preuves une fois le detail purge.
4. Publie la racine avec l'instruction `post_delay_root` du programme LateProof, si la cle de l'oracle est
   configuree. Sinon (pas encore de SOL devnet) : mode « a blanc », tout est fait sauf la transaction.

Variables : DATABASE_URL ; SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (archive) ;
SOLANA_RPC_URL + ORACLE_KEYPAIR (tableau JSON de la cle secrete) + LATEPROOF_PROGRAM_ID (publication) ;
DAY (AAAAMMJJ, defaut : la veille). Les journaux ne montrent que des compteurs et la racine (rien de secret).
"""
import base64, datetime, gzip, hashlib, json, os, struct, time, urllib.request
from zoneinfo import ZoneInfo
import psycopg
from sncf_common import apply_schema
import merkle

PARIS = ZoneInfo("Europe/Paris")
FORMAT = "v1"

SQL_RECORDS = """
SELECT 'sncf', u.train_num, COALESCE(u.uic, u.stop_id),
       GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0),
       CASE WHEN u.skipped THEN 'SKIPPED' ELSE 'LATE' END
FROM stop_updates u
WHERE u.service_date = %(d)s AND (u.skipped OR COALESCE(u.arrival_delay_s, u.departure_delay_s, 0) >= 60)
UNION ALL
SELECT 'sncf', t.train_num, '*', 0, 'CANCELED' FROM trains t WHERE t.service_date = %(d)s AND t.status = 'CANCELED'
UNION ALL
SELECT 'idf', COALESCE(NULLIF(t.train_num, ''), 'J' || t.journey_key::text), u.stop_ref,
       GREATEST(COALESCE(u.arrival_delay_s, u.departure_delay_s, 0), 0),
       CASE WHEN u.status = 'CANCELLED' THEN 'SKIPPED' ELSE 'LATE' END
FROM idfm_stop_updates u JOIN idfm_trains t USING (journey_key)
WHERE t.service_date = %(d)s AND (u.status = 'CANCELLED' OR COALESCE(u.arrival_delay_s, u.departure_delay_s, 0) >= 60)
"""


def records_for(con, day):
    rows = con.execute(SQL_RECORDS, {"d": day}).fetchall()
    recs = {f"{FORMAT}|{net}|{day}|{train}|{stop}|{int(delay)}|{status}".encode() for net, train, stop, delay, status in rows}
    return sorted(r for r in recs if len(r) <= 200)


# ----------------------------------------------------------------- Publication sur Solana (sans dependance lourde)
def rpc(url, method, params):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if "error" in d: raise RuntimeError(f"RPC {method}: {d['error']}")
    return d["result"]


def build_tx(oracle, program, day, root, n, blockhash):
    """Construit (sans l'envoyer) la transaction post_delay_root. Testable sans programme deploye."""
    from solders.instruction import AccountMeta, Instruction
    from solders.message import Message
    from solders.pubkey import Pubkey
    from solders.transaction import Transaction
    day_i = int(day)
    config, _ = Pubkey.find_program_address([b"config"], program)
    delay_root, _ = Pubkey.find_program_address([b"delay", struct.pack("<I", day_i)], program)
    # Donnees Anchor : 8 octets d'identifiant d'instruction + arguments encodes (Borsh, petit-boutiste)
    disc = hashlib.sha256(b"global:post_delay_root").digest()[:8]
    data = disc + struct.pack("<I", day_i) + root + struct.pack("<I", n)
    ix = Instruction(program, data, [
        AccountMeta(oracle.pubkey(), is_signer=True, is_writable=True),
        AccountMeta(config, is_signer=False, is_writable=False),
        AccountMeta(delay_root, is_signer=False, is_writable=True),
        AccountMeta(Pubkey.from_string("11111111111111111111111111111111"), is_signer=False, is_writable=False)])
    return Transaction([oracle], Message.new_with_blockhash([ix], oracle.pubkey(), blockhash), blockhash), delay_root


def publish(day, root, n):
    """Envoie post_delay_root sur Solana et attend la confirmation. Renvoie la signature (ou None si deja publiee)."""
    from solders.hash import Hash
    from solders.keypair import Keypair
    from solders.pubkey import Pubkey
    url = os.environ["SOLANA_RPC_URL"]
    oracle = Keypair.from_bytes(bytes(json.loads(os.environ["ORACLE_KEYPAIR"])))
    program = Pubkey.from_string(os.environ["LATEPROOF_PROGRAM_ID"])
    bh = Hash.from_string(rpc(url, "getLatestBlockhash", [{"commitment": "finalized"}])["value"]["blockhash"])
    tx, delay_root = build_tx(oracle, program, day, root, n, bh)
    if rpc(url, "getAccountInfo", [str(delay_root), {"encoding": "base64"}])["value"] is not None:
        print(f"empreinte du {day} deja publiee sur Solana ({delay_root})", flush=True)
        return None
    sig = rpc(url, "sendTransaction", [base64.b64encode(bytes(tx)).decode(), {"encoding": "base64", "preflightCommitment": "confirmed"}])
    for _ in range(30):  # attendre la confirmation
        st = rpc(url, "getSignatureStatuses", [[sig]])["value"][0]
        if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
            if st.get("err"): raise RuntimeError(f"transaction refusee : {st['err']}")
            return sig
        time.sleep(2)
    raise RuntimeError("transaction non confirmee apres 60 s")


def selftest_tx():
    """Construit une transaction avec une cle jetable : verifie le format sans rien envoyer."""
    from solders.hash import Hash
    from solders.keypair import Keypair
    from solders.pubkey import Pubkey
    tx, pda = build_tx(Keypair(), Pubkey.from_string("8RKxwUR3X1vUG2HD2ruHYaPFa9ahExbMsCzg1L44aJeu"), "20261126",
                       bytes(32), 5, Hash.default())
    raw = bytes(tx)
    assert len(raw) < 1232, "transaction trop grosse"
    print(f"transaction de test OK : {len(raw)} octets, compte de l'empreinte {pda}")


def main():
    day = os.environ.get("DAY") or (datetime.datetime.now(PARIS).date() - datetime.timedelta(days=1)).strftime("%Y%m%d")
    assert day.isdigit() and len(day) == 8
    with psycopg.connect(os.environ["DATABASE_URL"]) as con:
        apply_schema(con)
        t0 = time.time()
        recs = records_for(con, day)
        if not recs:
            print(f"{day} : aucun enregistrement, rien a publier"); return
        leaves = [merkle.leaf(merkle.TAG_DELAY, r) for r in recs]
        root = merkle.root_of(leaves)
        # Auto-controle : une preuve prise au hasard se verifie
        i = len(leaves) // 2
        assert merkle.verify(leaves[i], merkle.proof_for(leaves, i), root)
        print(f"{day} : {len(recs)} enregistrements, racine {root.hex()} ({time.time() - t0:.1f} s)", flush=True)

        path = None
        if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
            from archive_prune import storage, ensure_bucket, BUCKET
            ensure_bucket()
            body = gzip.compress(b"\n".join(recs) + b"\n", compresslevel=9, mtime=0)
            path = f"proofs/{day[:4]}/{day[4:6]}/{day[6:]}/delays-{FORMAT}.txt.gz"
            st, _ = storage("POST", f"object/{BUCKET}/{path}", body, "application/gzip")
            if st not in (200, 201): raise RuntimeError(f"archive de la liste impossible ({st})")
            print(f"liste archivee : {BUCKET}/{path} ({len(body) // 1000} ko)", flush=True)

        con.execute("""INSERT INTO delay_roots (day, root, n_records, format, leaves_path, built_at)
                       VALUES (%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (day) DO UPDATE SET root = EXCLUDED.root, n_records = EXCLUDED.n_records,
                         leaves_path = EXCLUDED.leaves_path, built_at = EXCLUDED.built_at
                       WHERE delay_roots.tx_signature IS NULL""",
                    (day, root.hex(), len(recs), FORMAT, path, int(time.time())))
        con.commit()
        posted = con.execute("SELECT tx_signature, root FROM delay_roots WHERE day = %s", (day,)).fetchone()
        if posted[0]:
            print(f"deja publiee sur Solana (transaction {posted[0][:12]}...) : racine conservee {posted[1][:16]}...")
            return

        if all(os.environ.get(k) for k in ("SOLANA_RPC_URL", "ORACLE_KEYPAIR", "LATEPROOF_PROGRAM_ID")):
            sig = publish(day, root, len(recs))
            if sig:
                con.execute("UPDATE delay_roots SET tx_signature = %s, posted_at = %s WHERE day = %s", (sig, int(time.time()), day))
                con.commit()
                print(f"publiee sur Solana : transaction {sig}", flush=True)
        else:
            print("MODE A BLANC : cle de l'oracle ou programme non configures, racine calculee et archivee mais non publiee")


if __name__ == "__main__":
    selftest_tx() if os.environ.get("SELFTEST_TX") == "1" else main()

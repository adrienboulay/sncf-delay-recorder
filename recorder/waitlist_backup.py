"""Sauvegarde chiffree de la liste de preinscription (table waitlist).

Chaque nuit (appele par archive_prune.py) : export CSV -> gzip -> chiffrement AES-256-GCM avec une cle derivee
(scrypt) de la phrase secrete WAITLIST_BACKUP_KEY -> Supabase Storage, bucket prive « archive » :
    archive/backups/waitlist/AAAAMMJJ.csv.gz.enc     (30 copies gardees, la plus ancienne est supprimee)
Meme si le bucket fuitait, les emails restent illisibles sans la phrase secrete (gardee dans ton gestionnaire
de mots de passe + secret GitHub, jamais dans le code).

Restaurer une copie (sur ton PC, apres l'avoir telechargee depuis Supabase -> Storage -> archive) :
    pip install cryptography
    set WAITLIST_BACKUP_KEY=...   (PowerShell : $env:WAITLIST_BACKUP_KEY = "...")
    python recorder/waitlist_backup.py restore 20261125.csv.gz.enc waitlist.csv
"""
import gzip, hashlib, io, os, sys

MAGIC = b"LPWB1"          # format : MAGIC + sel (16) + nonce (12) + donnees chiffrees (avec etiquette GCM)
KEEP = 30
PREFIX = "backups/waitlist"


def _key(passphrase, salt):
    return hashlib.scrypt(passphrase.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=2**26, dklen=32)


def encrypt(data, passphrase):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, nonce = os.urandom(16), os.urandom(12)
    return MAGIC + salt + nonce + AESGCM(_key(passphrase, salt)).encrypt(nonce, data, MAGIC)


def decrypt(blob, passphrase):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not blob.startswith(MAGIC): raise ValueError("ce fichier n'est pas une sauvegarde LateProof")
    salt, nonce, ct = blob[5:21], blob[21:33], blob[33:]
    return AESGCM(_key(passphrase, salt)).decrypt(nonce, ct, MAGIC)  # erreur si mauvaise phrase ou fichier altere


def export(con):
    """-> (csv gzip en octets, nombre d'inscrits)."""
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
        with con.cursor().copy("COPY (SELECT * FROM waitlist ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER)") as cp:
            for chunk in cp: gz.write(chunk)
    return buf.getvalue(), con.execute("SELECT COUNT(*) FROM waitlist").fetchone()[0]


def backup(con, storage, bucket, day, old_day, passphrase, selftest=False):
    """Envoie la copie du jour, verifie qu'elle se relit et se dechiffre a l'identique, supprime celle d'il y a KEEP jours."""
    data, n = export(con)
    blob = encrypt(data, passphrase)
    path = f"{PREFIX}/{'selftest_' if selftest else ''}{day}.csv.gz.enc"
    st, _ = storage("POST", f"object/{bucket}/{path}", blob, "application/octet-stream")
    st2, back = storage("GET", f"object/{bucket}/{path}")
    ok = st in (200, 201) and st2 == 200 and decrypt(back, passphrase) == data
    if selftest or not ok:
        storage("DELETE", f"object/{bucket}", f'{{"prefixes": ["{path}"]}}'.encode())
    elif old_day:
        storage("DELETE", f"object/{bucket}", f'{{"prefixes": ["{PREFIX}/{old_day}.csv.gz.enc"]}}'.encode())
    print(f"SAUVEGARDE WAITLIST{' (auto-test)' if selftest else ''} : {n} inscrits, {len(blob)} octets chiffres ; "
          f"envoi {st}, relecture et dechiffrement {'identiques' if ok else 'ECHEC'}", flush=True)
    return ok


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "restore":
    with open(sys.argv[2], "rb") as f:
        csv = gzip.decompress(decrypt(f.read(), os.environ["WAITLIST_BACKUP_KEY"]))
    with open(sys.argv[3], "wb") as f:
        f.write(csv)
    print(f"restaure : {csv.count(b'\n') - 1} inscrits -> {sys.argv[3]}")

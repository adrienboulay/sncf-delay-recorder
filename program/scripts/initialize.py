"""Appelle `initialize` une seule fois apres le deploiement : cree la configuration et designe la cle de l'oracle.
Usage (dans le Codespace) : python3 scripts/initialize.py ~/keys/admin.json <cle publique de l'oracle>
Le reseau vient de SOLANA_RPC_URL (devnet par defaut). Aucune cle secrete n'est affichee."""
import hashlib
import json
import os
import sys
import time
import urllib.request

from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

PROGRAM = Pubkey.from_string("8RKxwUR3X1vUG2HD2ruHYaPFa9ahExbMsCzg1L44aJeu")
SYSTEM = Pubkey.from_string("11111111111111111111111111111111")
URL = os.environ.get("SOLANA_RPC_URL", "https://api.devnet.solana.com")


def rpc(method, params):
    req = urllib.request.Request(URL, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 {"Content-Type": "application/json"})
    out = json.load(urllib.request.urlopen(req, timeout=30))
    if "error" in out:
        raise SystemExit(f"{method} : {out['error']}")
    return out["result"]


def main():
    admin = Keypair.from_bytes(bytes(json.load(open(os.path.expanduser(sys.argv[1])))))
    oracle = Pubkey.from_string(sys.argv[2])
    config, _ = Pubkey.find_program_address([b"config"], PROGRAM)
    if rpc("getAccountInfo", [str(config), {"encoding": "base64"}])["value"]:
        print(f"Deja initialise : configuration {config}"); return
    data = hashlib.sha256(b"global:initialize").digest()[:8] + bytes(oracle)
    ix = Instruction(PROGRAM, data, [
        AccountMeta(admin.pubkey(), is_signer=True, is_writable=True),
        AccountMeta(config, is_signer=False, is_writable=True),
        AccountMeta(SYSTEM, is_signer=False, is_writable=False)])
    blockhash = Hash.from_string(rpc("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"])
    tx = Transaction([admin], Message([ix], admin.pubkey()), blockhash)
    import base64
    sig = rpc("sendTransaction", [base64.b64encode(bytes(tx)).decode(), {"encoding": "base64", "preflightCommitment": "confirmed"}])
    for _ in range(30):
        st = rpc("getSignatureStatuses", [[sig]])["value"][0]
        if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
            if st.get("err"):
                raise SystemExit(f"Echec : {st['err']}")
            break
        time.sleep(1)
    print(f"Initialise. Configuration : {config}\nOracle : {oracle}\nTransaction : https://explorer.solana.com/tx/{sig}?cluster=devnet")


if __name__ == "__main__":
    main()

"""Prépare la démo x402 sur Solana devnet, sans rien afficher de secret :
- applique le schéma (table des paiements) ;
- crée, si besoin, le compte USDC (ATA) de l'adresse qui reçoit les paiements, payé par la clé de l'oracle ;
- affiche les soldes SOL / USDC de l'agent (ici l'oracle) pour savoir s'il peut payer.
Variables : DATABASE_URL, SOLANA_RPC_URL, ORACLE_KEYPAIR, X402_PAY_TO (défaut : adresse admin)."""
import base64, json, os, sys, time, urllib.request
sys.path.insert(0, "recorder")
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

USDC = Pubkey.from_string("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
TOKEN = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ATA_PROG = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
SYS = Pubkey.from_string("11111111111111111111111111111111")


def rpc(method, params):
    req = urllib.request.Request(os.environ["SOLANA_RPC_URL"], data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if "error" in d:
        raise RuntimeError(f"{method}: {d['error']}")
    return d["result"]


def ata(owner):
    return Pubkey.find_program_address([bytes(owner), bytes(TOKEN), bytes(USDC)], ATA_PROG)[0]


def usdc(owner):
    v = rpc("getTokenAccountsByOwner", [str(owner), {"mint": str(USDC)}, {"encoding": "jsonParsed"}])["value"]
    return sum(float(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmount"] or 0) for a in v), len(v)


def main():
    if os.environ.get("DATABASE_URL"):
        import psycopg
        from sncf_common import apply_schema
        with psycopg.connect(os.environ["DATABASE_URL"]) as con:
            apply_schema(con)
        print("schéma appliqué (table x402_payments)")
    agent = Keypair.from_bytes(bytes(json.loads(os.environ["ORACLE_KEYPAIR"])))
    pay_to = Pubkey.from_string(os.environ.get("X402_PAY_TO") or "3pEkrEjgH5wYKZitvNtLWSmx9ELPmJPiwywJtWaP5s83")
    sol = rpc("getBalance", [str(agent.pubkey())])["value"] / 1e9
    bal, n = usdc(agent.pubkey())
    print(f"AGENT {agent.pubkey()} : {sol:.4f} SOL, {bal} USDC devnet ({n} compte(s))")
    dest = ata(pay_to)
    if rpc("getAccountInfo", [str(dest), {"encoding": "base64"}])["value"] is None:
        ix = Instruction(ATA_PROG, bytes([1]), [   # CreateIdempotent
            AccountMeta(agent.pubkey(), True, True), AccountMeta(dest, False, True), AccountMeta(pay_to, False, False),
            AccountMeta(USDC, False, False), AccountMeta(SYS, False, False), AccountMeta(TOKEN, False, False)])
        bh = Hash.from_string(rpc("getLatestBlockhash", [{"commitment": "finalized"}])["value"]["blockhash"])
        tx = Transaction([agent], Message.new_with_blockhash([ix], agent.pubkey(), bh), bh)
        sig = rpc("sendTransaction", [base64.b64encode(bytes(tx)).decode(), {"encoding": "base64", "preflightCommitment": "confirmed"}])
        for _ in range(30):
            st = rpc("getSignatureStatuses", [[sig]])["value"][0]
            if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
                break
            time.sleep(2)
        print(f"compte USDC créé pour {pay_to} : {dest} (transaction {sig})")
    else:
        print(f"compte USDC de {pay_to} déjà en place : {dest}")
    if bal < 0.01:
        print(f"::warning::L'agent {agent.pubkey()} n'a pas d'USDC devnet : demande-en sur https://faucet.circle.com (réseau Solana Devnet)")


if __name__ == "__main__":
    main()

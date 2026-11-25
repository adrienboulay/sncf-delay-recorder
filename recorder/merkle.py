"""Arbre de Merkle de LateProof : EXACTEMENT les memes regles que le programme Solana (programs/lateproof/src/merkle.rs).

  feuille = SHA256( 0x00 || etiquette || contenu )   etiquette = b"DLY" (retard) ou b"CRT" (justificatif)
  noeud   = SHA256( 0x01 || min(a, b) || max(a, b) ) (enfants tries)
  nombre impair a un niveau : le dernier remonte tel quel.

Un test croise (test_vectors) garantit que Python et Rust donnent la meme racine, a l'octet pres.
"""
import hashlib

TAG_DELAY = b"DLY"
TAG_CERT = b"CRT"


def leaf(tag, content):
    return hashlib.sha256(b"\x00" + tag + content).digest()


def node(a, b):
    lo, hi = (a, b) if a <= b else (b, a)
    return hashlib.sha256(b"\x01" + lo + hi).digest()


def root_of(leaves):
    """Racine seule (rapide, sans garder les preuves)."""
    assert leaves, "arbre vide"
    level = list(leaves)
    while len(level) > 1:
        level = [node(level[i], level[i + 1]) if i + 1 < len(level) else level[i] for i in range(0, len(level), 2)]
    return level[0]


def proof_for(leaves, index):
    """Preuve (liste des voisins) de la feuille `index`."""
    proof, level, pos = [], list(leaves), index
    while len(level) > 1:
        sib = pos ^ 1
        if sib < len(level):
            proof.append(level[sib])
        level = [node(level[i], level[i + 1]) if i + 1 < len(level) else level[i] for i in range(0, len(level), 2)]
        pos //= 2
    return proof


def verify(leaf_hash, proof, root):
    h = leaf_hash
    for s in proof:
        h = node(h, s)
    return h == root


SAMPLE_RECORDS = [  # memes valeurs que le test Rust `cross_language_vectors`
    b"v1|20261126|860123|87723197|1620|ARRIVED",
    b"v1|20261126|6641|87686006|0|ARRIVED",
    b"v1|20261126|17769|87751008|2700|ARRIVED",
    b"v1|20261126|860151|87723197|0|CANCELED",
    b"v1|20261126|6603|87723197|900|ARRIVED",
]


def test_vectors():
    """Racines de reference, a recopier dans le test Rust."""
    leaves = [leaf(TAG_DELAY, r) for r in SAMPLE_RECORDS]
    one = root_of([leaf(TAG_DELAY, SAMPLE_RECORDS[0])])
    five = root_of(leaves)
    cert = root_of([leaf(TAG_CERT, bytes([i + 1]) * 32) for i in range(3)])
    for i, l in enumerate(leaves):
        assert verify(l, proof_for(leaves, i), five)
    return {"one": one.hex(), "five": five.hex(), "cert3": cert.hex()}


if __name__ == "__main__":
    for k, v in test_vectors().items():
        print(k, v)

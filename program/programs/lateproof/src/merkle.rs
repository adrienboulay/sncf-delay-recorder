// =====================================================================================
// ARBRE DE MERKLE : comment une seule empreinte de 32 octets "contient" des milliers d'elements.
//
// On calcule l'empreinte (hash SHA-256) de chaque element : ce sont les FEUILLES. Puis on les
// assemble deux par deux, et on recommence, jusqu'a n'avoir plus qu'une empreinte : la RACINE.
// Pour prouver qu'un element en fait partie, il suffit de donner les empreintes "voisines" sur le
// chemin vers la racine (la PREUVE) : environ 14 empreintes pour 10 000 elements.
//
// REGLES EXACTES (le serveur qui construit l'arbre doit faire EXACTEMENT pareil) :
//   feuille = SHA256( 0x00 || etiquette || contenu )   etiquette = "DLY" (retard) ou "CRT" (justificatif)
//   noeud   = SHA256( 0x01 || min(a, b) || max(a, b) ) les deux enfants tries : pas besoin de savoir
//                                                     s'ils sont a gauche ou a droite
//   nombre impair d'elements a un niveau : le dernier remonte tel quel au niveau suivant.
// Le 0x00 / 0x01 empeche de faire passer un noeud pour une feuille (attaque classique).
// L'etiquette empeche de faire passer un justificatif pour un retard, et inversement.
// =====================================================================================
use solana_sha256_hasher::hashv;

pub const TAG_DELAY: &[u8] = b"DLY";
pub const TAG_CERT: &[u8] = b"CRT";

/// Empreinte d'une feuille.
pub fn leaf(tag: &[u8], content: &[u8]) -> [u8; 32] {
    hashv(&[&[0x00], tag, content]).to_bytes()
}

/// Empreinte d'un noeud a partir de ses deux enfants (ordre indifferent).
pub fn node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&[0x01], lo, hi]).to_bytes()
}

/// Remonte de la feuille a la racine avec la preuve, et compare a la racine attendue.
pub fn verify(leaf_hash: [u8; 32], proof: &[[u8; 32]], root: &[u8; 32]) -> bool {
    let mut h = leaf_hash;
    for sibling in proof {
        h = node(&h, sibling);
    }
    &h == root
}

/// Construit la racine et la preuve de chaque feuille (utilise par les tests et par le serveur).
/// Hors blockchain uniquement : sur Solana on ne fait que `verify`.
#[cfg(not(target_os = "solana"))]
pub fn build(leaves: &[[u8; 32]]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    assert!(!leaves.is_empty());
    let mut proofs: Vec<Vec<[u8; 32]>> = vec![Vec::new(); leaves.len()];
    // pos[i] = position actuelle de la feuille i dans le niveau courant
    let mut pos: Vec<usize> = (0..leaves.len()).collect();
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        for (i, p) in pos.iter_mut().enumerate() {
            let sib = *p ^ 1;
            if sib < level.len() {
                proofs[i].push(level[sib]);
            }
            *p /= 2;
        }
        level = level
            .chunks(2)
            .map(|c| if c.len() == 2 { node(&c[0], &c[1]) } else { c[0] })
            .collect();
    }
    (level[0], proofs)
}

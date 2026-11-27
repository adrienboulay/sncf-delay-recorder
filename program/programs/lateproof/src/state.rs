use anchor_lang::prelude::*;

// Les COMPTES = les donnees stockees sur la blockchain. Aucun ne contient de donnee personnelle.

/// La configuration : qui est l'admin, quelle cle a le droit de publier (l'oracle).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub bump: u8,
}

/// L'empreinte des retards d'une journee. Une seule par jour, jamais modifiable une fois publiee.
#[account]
#[derive(InitSpace)]
pub struct DelayRoot {
    pub day: u32,         // AAAAMMJJ (heure de Paris)
    pub root: [u8; 32],   // racine de Merkle de tous les retards releves ce jour-la
    pub n_records: u32,   // nombre de retards dans l'arbre (information)
    pub posted_at: i64,   // horodatage de publication (horloge de la blockchain)
    pub bump: u8,
}

/// L'empreinte des justificatifs crees pendant une heure. Une seule par heure, jamais modifiable.
#[account]
#[derive(InitSpace)]
pub struct CertRoot {
    pub hour: u32,        // heure Unix (secondes / 3600)
    pub root: [u8; 32],   // racine de Merkle des empreintes des justificatifs de cette heure
    pub n_certs: u32,     // nombre de justificatifs (information ; ne revele personne)
    pub posted_at: i64,
    pub bump: u8,
}

// Les EVENEMENTS : des messages que les applications peuvent ecouter (page de verification, etc.).
#[event]
pub struct DelayVerified {
    pub day: u32,
    pub leaf: [u8; 32],
}

#[event]
pub struct CertificateVerified {
    pub hour: u32,
    pub commitment: [u8; 32],
}

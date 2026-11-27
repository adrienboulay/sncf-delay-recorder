use anchor_lang::prelude::*;

// Les erreurs que le programme peut renvoyer, avec un message clair.
#[error_code]
pub enum LateProofError {
    #[msg("Seule la cle de l'oracle enregistree peut publier des empreintes.")]
    NotOracle,
    #[msg("Seul l'admin peut faire cette operation.")]
    NotAdmin,
    #[msg("Date invalide : format AAAAMMJJ attendu, et une date qui existe.")]
    InvalidDay,
    #[msg("Impossible de publier l'empreinte d'une journee qui n'a pas encore commence.")]
    FutureDay,
    #[msg("Cette heure n'a pas encore commence.")]
    CertHourNotStarted,
    #[msg("Trop tard : l'empreinte des justificatifs doit etre publiee au plus 2 h apres la fin de l'heure.")]
    CertWindowClosed,
    #[msg("Une empreinte doit contenir au moins un element.")]
    EmptyTree,
    #[msg("Preuve invalide : cet element ne fait pas partie de l'empreinte publiee.")]
    InvalidProof,
    #[msg("Enregistrement trop long.")]
    RecordTooLong,
    #[msg("Preuve trop longue.")]
    ProofTooLong,
}

// Les "graines" des adresses calculees (PDA) : une adresse par usage, retrouvable par tout le monde.
pub const CONFIG_SEED: &[u8] = b"config";
pub const DELAY_ROOT_SEED: &[u8] = b"delay";
pub const CERT_ROOT_SEED: &[u8] = b"cert";

/// Delai maximum, apres la fin d'une heure, pour publier l'empreinte de ses justificatifs (2 h).
/// Au-dela, le programme refuse : un justificatif ne peut donc pas etre ancre bien apres coup.
pub const CERT_GRACE_SECONDS: i64 = 2 * 3600;

/// Limites de taille, pour garder des transactions petites et previsibles.
pub const MAX_RECORD_LEN: usize = 200;
/// 32 niveaux = jusqu'a 4 milliards de feuilles : largement assez.
pub const MAX_PROOF_LEN: usize = 32;

/// Dates acceptees pour `day` (AAAAMMJJ).
pub const MIN_DAY: u32 = 20200101;
pub const MAX_DAY: u32 = 20991231;

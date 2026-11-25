// =====================================================================================
// LATEPROOF : le registre des preuves de retard, sur Solana.
//
// Ce que fait ce programme (lis dans l'ordre : lib.rs -> merkle.rs -> state.rs -> instructions/) :
//   1. Chaque nuit, l'ORACLE (notre serveur) publie UNE empreinte (racine de Merkle) de tous les
//      retards de train releves dans la journee. Une transaction par jour, quelques centimes.
//   2. Chaque heure, l'oracle publie UNE empreinte de tous les justificatifs crees dans l'heure.
//      Le programme REFUSE une empreinte publiee trop tard : impossible d'antidater un justificatif.
//   3. N'importe qui peut verifier, sur la blockchain, qu'un retard ou un justificatif fait bien
//      partie d'une empreinte publiee. Rien ne relie une personne a un trajet : seules des
//      empreintes sont stockees, jamais de nom, d'e-mail ni de position.
// =====================================================================================
pub mod constants;
pub mod error;
pub mod instructions;
pub mod merkle;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

// L'adresse du programme. Remplacee par la vraie au premier `anchor keys sync`.
declare_id!("8RKxwUR3X1vUG2HD2ruHYaPFa9ahExbMsCzg1L44aJeu");

#[program]
pub mod lateproof {
    use super::*;

    /// L'admin cree la configuration et designe la cle de l'oracle autorise.
    pub fn initialize(ctx: Context<Initialize>, oracle: Pubkey) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, oracle)
    }

    /// L'admin remplace la cle de l'oracle (rotation, ou cle compromise).
    pub fn set_oracle(ctx: Context<SetOracle>, new_oracle: Pubkey) -> Result<()> {
        instructions::set_oracle::handle_set_oracle(ctx, new_oracle)
    }

    /// L'ORACLE publie l'empreinte des retards d'une journee (`day` = AAAAMMJJ, heure de Paris).
    pub fn post_delay_root(ctx: Context<PostDelayRoot>, day: u32, root: [u8; 32], n_records: u32) -> Result<()> {
        instructions::post_delay_root::handle_post_delay_root(ctx, day, root, n_records)
    }

    /// L'ORACLE publie l'empreinte des justificatifs crees pendant une heure (`hour` = heure Unix,
    /// c'est-a-dire secondes / 3600). Refuse si l'heure n'a pas commence ou si elle est trop ancienne.
    pub fn post_cert_root(ctx: Context<PostCertRoot>, hour: u32, root: [u8; 32], n_certs: u32) -> Result<()> {
        instructions::post_cert_root::handle_post_cert_root(ctx, hour, root, n_certs)
    }

    /// N'importe qui verifie qu'un retard (`record`, texte canonique) figure dans l'empreinte du jour.
    pub fn verify_delay(ctx: Context<VerifyDelay>, day: u32, record: Vec<u8>, proof: Vec<[u8; 32]>) -> Result<()> {
        instructions::verify::handle_verify_delay(ctx, day, record, proof)
    }

    /// N'importe qui verifie qu'un justificatif (son empreinte) etait ancre dans l'heure annoncee.
    pub fn verify_certificate(ctx: Context<VerifyCertificate>, hour: u32, commitment: [u8; 32], proof: Vec<[u8; 32]>) -> Result<()> {
        instructions::verify::handle_verify_certificate(ctx, hour, commitment, proof)
    }
}

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::LateProofError,
    merkle,
    state::{CertRoot, CertificateVerified, DelayRoot, DelayVerified},
};

// Les verifications ne modifient rien : elles lisent une empreinte publiee et refusent la
// transaction si la preuve ne correspond pas. Utile pour les autres programmes (via CPI) et pour
// laisser une trace publique « ce retard a ete verifie ». La page de verification, elle, refait le
// meme calcul directement dans le navigateur, sans transaction.

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct VerifyDelay<'info> {
    #[account(seeds = [DELAY_ROOT_SEED, &day.to_le_bytes()], bump = delay_root.bump)]
    pub delay_root: Account<'info, DelayRoot>,
}

pub fn handle_verify_delay(ctx: Context<VerifyDelay>, day: u32, record: Vec<u8>, proof: Vec<[u8; 32]>) -> Result<()> {
    require!(record.len() <= MAX_RECORD_LEN, LateProofError::RecordTooLong);
    require!(proof.len() <= MAX_PROOF_LEN, LateProofError::ProofTooLong);
    let leaf = merkle::leaf(merkle::TAG_DELAY, &record);
    require!(merkle::verify(leaf, &proof, &ctx.accounts.delay_root.root), LateProofError::InvalidProof);
    emit!(DelayVerified { day, leaf });
    Ok(())
}

#[derive(Accounts)]
#[instruction(hour: u32)]
pub struct VerifyCertificate<'info> {
    #[account(seeds = [CERT_ROOT_SEED, &hour.to_le_bytes()], bump = cert_root.bump)]
    pub cert_root: Account<'info, CertRoot>,
}

pub fn handle_verify_certificate(ctx: Context<VerifyCertificate>, hour: u32, commitment: [u8; 32], proof: Vec<[u8; 32]>) -> Result<()> {
    require!(proof.len() <= MAX_PROOF_LEN, LateProofError::ProofTooLong);
    let leaf = merkle::leaf(merkle::TAG_CERT, &commitment);
    require!(merkle::verify(leaf, &proof, &ctx.accounts.cert_root.root), LateProofError::InvalidProof);
    emit!(CertificateVerified { hour, commitment });
    Ok(())
}

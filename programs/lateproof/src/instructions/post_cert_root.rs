use anchor_lang::prelude::*;

use crate::{constants::*, error::LateProofError, state::{CertRoot, Config}};

#[derive(Accounts)]
#[instruction(hour: u32)]
pub struct PostCertRoot<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = oracle @ LateProofError::NotOracle)]
    pub config: Account<'info, Config>,

    // Une adresse par heure, jamais remplacable.
    #[account(init, payer = oracle, space = 8 + CertRoot::INIT_SPACE,
              seeds = [CERT_ROOT_SEED, &hour.to_le_bytes()], bump)]
    pub cert_root: Account<'info, CertRoot>,

    pub system_program: Program<'info, System>,
}

pub fn handle_post_cert_root(ctx: Context<PostCertRoot>, hour: u32, root: [u8; 32], n_certs: u32) -> Result<()> {
    require!(n_certs > 0, LateProofError::EmptyTree);
    let now = Clock::get()?.unix_timestamp;
    let start = hour as i64 * 3600;
    // LA GARANTIE ANTI-ANTIDATAGE, verifiee par la blockchain elle-meme (pas par notre serveur) :
    // l'empreinte d'une heure ne peut etre publiee qu'une fois l'heure commencee, et au plus tard
    // 2 h apres sa fin. Un justificatif « du 26/11 a 8h » n'a donc pas pu etre fabrique le 28.
    require!(now >= start, LateProofError::CertHourNotStarted);
    require!(now < start + 3600 + CERT_GRACE_SECONDS, LateProofError::CertWindowClosed);

    let r = &mut ctx.accounts.cert_root;
    r.hour = hour;
    r.root = root;
    r.n_certs = n_certs;
    r.posted_at = now;
    r.bump = ctx.bumps.cert_root;
    msg!("Empreinte des justificatifs de l'heure {} publiee ({} justificatifs)", hour, n_certs);
    Ok(())
}

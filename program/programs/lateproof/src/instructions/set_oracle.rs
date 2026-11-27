use anchor_lang::prelude::*;

use crate::{constants::*, error::LateProofError, state::Config};

#[derive(Accounts)]
pub struct SetOracle<'info> {
    pub admin: Signer<'info>,

    // `has_one = admin` : Anchor verifie que la cle qui signe est bien l'admin enregistre.
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ LateProofError::NotAdmin)]
    pub config: Account<'info, Config>,
}

pub fn handle_set_oracle(ctx: Context<SetOracle>, new_oracle: Pubkey) -> Result<()> {
    ctx.accounts.config.oracle = new_oracle;
    msg!("Nouvel oracle = {}", new_oracle);
    Ok(())
}

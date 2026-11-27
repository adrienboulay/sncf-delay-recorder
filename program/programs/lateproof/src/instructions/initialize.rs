use anchor_lang::prelude::*;

use crate::{constants::*, state::Config};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    // `init` cree le compte ; son adresse est calculee a partir de "config" : il n'en existe qu'un.
    // Rappeler `initialize` echoue donc (le compte existe deja).
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, oracle: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle = oracle;
    config.bump = ctx.bumps.config;
    msg!("LateProof initialise, oracle = {}", oracle);
    Ok(())
}

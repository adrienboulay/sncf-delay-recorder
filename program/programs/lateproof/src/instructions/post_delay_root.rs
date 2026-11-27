use anchor_lang::prelude::*;

use crate::{constants::*, error::LateProofError, state::{Config, DelayRoot}};

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct PostDelayRoot<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,

    // Seule la cle de l'oracle enregistree dans la config peut publier.
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = oracle @ LateProofError::NotOracle)]
    pub config: Account<'info, Config>,

    // Une adresse par jour : publier deux fois le meme jour echoue (le compte existe deja).
    // L'empreinte d'un jour ne peut donc jamais etre remplacee apres coup.
    #[account(init, payer = oracle, space = 8 + DelayRoot::INIT_SPACE,
              seeds = [DELAY_ROOT_SEED, &day.to_le_bytes()], bump)]
    pub delay_root: Account<'info, DelayRoot>,

    pub system_program: Program<'info, System>,
}

pub fn handle_post_delay_root(ctx: Context<PostDelayRoot>, day: u32, root: [u8; 32], n_records: u32) -> Result<()> {
    require!(n_records > 0, LateProofError::EmptyTree);
    let start = day_start_unix(day).ok_or(LateProofError::InvalidDay)?;
    // Une journee doit avoir commence (heure de Paris : au plus UTC+2) pour qu'on publie ses retards.
    let now = Clock::get()?.unix_timestamp;
    require!(now >= start - 2 * 3600, LateProofError::FutureDay);

    let r = &mut ctx.accounts.delay_root;
    r.day = day;
    r.root = root;
    r.n_records = n_records;
    r.posted_at = now;
    r.bump = ctx.bumps.delay_root;
    msg!("Empreinte des retards du {} publiee ({} releves)", day, n_records);
    Ok(())
}

/// AAAAMMJJ -> secondes Unix du debut de ce jour (UTC). `None` si la date n'existe pas.
/// Algorithme « days from civil » (H. Hinnant), sans dependance.
pub fn day_start_unix(day: u32) -> Option<i64> {
    if !(MIN_DAY..=MAX_DAY).contains(&day) {
        return None;
    }
    let (y, m, d) = ((day / 10000) as i64, ((day / 100) % 100) as i64, (day % 100) as i64);
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 => if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 },
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

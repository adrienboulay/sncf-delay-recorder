# LateProof

Train delay assistant on Solana: it warns you before your trip, proves your delay with a verifiable certificate, and pays you back automatically.

> Part of the LateProof project: see the [main README](../README.md) for the whole project and the before / during split.

## Solana program
Program id: `8RKxwUR3X1vUG2HD2ruHYaPFa9ahExbMsCzg1L44aJeu`, **deployed on devnet** on 2026-11-27 ([explorer](https://explorer.solana.com/address/8RKxwUR3X1vUG2HD2ruHYaPFa9ahExbMsCzg1L44aJeu?cluster=devnet)).
Config account: `8i5uNfUeytmbgExRg5Kw621L15MMRqEPuuhXkwYHQqCJ` ([initialize transaction](https://explorer.solana.com/tx/W7PJY6AD6JHNmJ74gqJox44Y6fKubv38aPwHfnePNC7YDdxoEGrgc53p97mpyfBZxg5TGixDua1LBVnndAmFwLR?cluster=devnet)), oracle `2f97V5ZQoatB2Yrowkh7ZLYh93cXxzf2mkr8m9Rab1P1`.

It stores **fingerprints only** (no names, e-mails or locations):
- `post_delay_root`: once a day, the oracle publishes the Merkle root of every train delay recorded that day. One root per day, immutable.
- `post_cert_root`: once an hour, the Merkle root of the delay certificates created in that hour. **The program itself rejects a root posted before the hour starts or more than 2 hours after it ends**, so a certificate cannot be backdated, not even by us.
- `verify_delay` / `verify_certificate`: anyone can check a delay record or a certificate commitment against the published root (sorted-pair SHA-256 Merkle proof, domain-separated leaves).

Tests run on LiteSVM: `anchor build && cargo test` (7 tests).

## Development
Open the repository in GitHub Codespaces, then `cd program`. `.devcontainer/setup.sh` installs Rust, the Solana CLI, Anchor, Node.js and pnpm, and sets the Solana CLI to devnet.

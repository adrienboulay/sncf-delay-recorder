# LateProof

Train delay assistant on Solana: it warns you before your trip, proves your delay with a verifiable certificate, and pays you back automatically.

> Work in progress for the Dev3pack Global Hackathon (27–29 November 2026).

## Built before / during the hackathon
- **Before (from 23 November 2026):** an SNCF and Île-de-France real-time delay recorder (separate repository `sncf-delay-recorder`), this repository's development environment (`.devcontainer/`), and feasibility tests.
- **During:** listed here as it is built.

## Solana program
Program id: `8RKxwUR3X1vUG2HD2ruHYaPFa9ahExbMsCzg1L44aJeu` (devnet deployment pending).

It stores **fingerprints only** (no names, e-mails or locations):
- `post_delay_root`: once a day, the oracle publishes the Merkle root of every train delay recorded that day. One root per day, immutable.
- `post_cert_root`: once an hour, the Merkle root of the delay certificates created in that hour. **The program itself rejects a root posted before the hour starts or more than 2 hours after it ends**, so a certificate cannot be backdated, not even by us.
- `verify_delay` / `verify_certificate`: anyone can check a delay record or a certificate commitment against the published root (sorted-pair SHA-256 Merkle proof, domain-separated leaves).

Tests run on LiteSVM: `anchor build && cargo test` (6 tests).

## Development
Open the repository in GitHub Codespaces. `.devcontainer/setup.sh` installs Rust, the Solana CLI, Anchor, Node.js and pnpm, and sets the Solana CLI to devnet.

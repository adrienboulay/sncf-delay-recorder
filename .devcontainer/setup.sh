#!/usr/bin/env bash
# Installs the Solana toolchain inside the Codespace (runs once, when the Codespace is created).
# Official one-line installer from https://solana.com/docs/intro/installation :
# Rust, Solana CLI (Agave), Anchor CLI (via AVM), Surfpool, Node.js, Yarn.
set -euxo pipefail

sudo apt-get update
sudo apt-get install -y build-essential pkg-config libudev-dev llvm libclang-dev protobuf-compiler libssl-dev

curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash

# Make the tools available in every new terminal.
cat >> ~/.bashrc <<'EOF'
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
EOF
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"

corepack enable pnpm || npm install -g pnpm

solana config set --url devnet
rustc --version; solana --version; anchor --version; node --version; pnpm --version || true
echo "LATEPROOF_SETUP_DONE"

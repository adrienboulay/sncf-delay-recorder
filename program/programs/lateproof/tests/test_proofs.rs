// Tests sur une blockchain Solana simulee en memoire (LiteSVM) : rapides, sans SOL reel.
// On verifie le cas normal ET les tentatives de triche.
use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    lateproof::{constants::*, instructions::post_delay_root::day_start_unix, merkle, state::*},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const SOL: u64 = 1_000_000_000;
const DAY: u32 = 20261126;
// 26/11/2026 a 08h00 UTC (09h00 a Paris)
const T_0800: i64 = 1_795_680_000;

fn pid() -> Pubkey {
    lateproof::id()
}
fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &pid()).0
}
fn delay_pda(day: u32) -> Pubkey {
    Pubkey::find_program_address(&[DELAY_ROOT_SEED, &day.to_le_bytes()], &pid()).0
}
fn cert_pda(hour: u32) -> Pubkey {
    Pubkey::find_program_address(&[CERT_ROOT_SEED, &hour.to_le_bytes()], &pid()).0
}

struct World {
    svm: LiteSVM,
    admin: Keypair,
    oracle: Keypair,
    stranger: Keypair,
}

impl World {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/lateproof.so"));
        svm.add_program(pid(), bytes).unwrap();
        let w = World { svm, admin: Keypair::new(), oracle: Keypair::new(), stranger: Keypair::new() };
        let mut w = w;
        for k in [w.admin.pubkey(), w.oracle.pubkey(), w.stranger.pubkey()] {
            w.svm.airdrop(&k, 10 * SOL).unwrap();
        }
        w.set_time(T_0800);
        w
    }

    /// Regle l'horloge de la blockchain simulee.
    fn set_time(&mut self, unix: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = unix;
        self.svm.set_sysvar(&c);
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &bh);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e))
    }

    fn read<T: AccountDeserialize>(&self, addr: &Pubkey) -> T {
        let acc = self.svm.get_account(addr).unwrap();
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn initialize(&mut self) {
        let ix = Instruction::new_with_bytes(
            pid(),
            &lateproof::instruction::Initialize { oracle: self.oracle.pubkey() }.data(),
            lateproof::accounts::Initialize { admin: self.admin.pubkey(), config: config_pda(), system_program: system_program::ID }
                .to_account_metas(None),
        );
        let admin = self.admin.insecure_clone();
        self.send(ix, &admin).unwrap();
    }

    fn post_delay_root(&mut self, signer: &Keypair, day: u32, root: [u8; 32], n: u32) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            pid(),
            &lateproof::instruction::PostDelayRoot { day, root, n_records: n }.data(),
            lateproof::accounts::PostDelayRoot {
                oracle: signer.pubkey(), config: config_pda(), delay_root: delay_pda(day), system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer)
    }

    fn post_cert_root(&mut self, signer: &Keypair, hour: u32, root: [u8; 32], n: u32) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            pid(),
            &lateproof::instruction::PostCertRoot { hour, root, n_certs: n }.data(),
            lateproof::accounts::PostCertRoot {
                oracle: signer.pubkey(), config: config_pda(), cert_root: cert_pda(hour), system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix, signer)
    }

    fn verify_delay(&mut self, day: u32, record: &[u8], proof: Vec<[u8; 32]>) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            pid(),
            &lateproof::instruction::VerifyDelay { day, record: record.to_vec(), proof }.data(),
            lateproof::accounts::VerifyDelay { delay_root: delay_pda(day) }.to_account_metas(None),
        );
        let payer = self.stranger.insecure_clone(); // n'importe qui peut verifier
        self.send(ix, &payer)
    }

    fn verify_cert(&mut self, hour: u32, commitment: [u8; 32], proof: Vec<[u8; 32]>) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            pid(),
            &lateproof::instruction::VerifyCertificate { hour, commitment, proof }.data(),
            lateproof::accounts::VerifyCertificate { cert_root: cert_pda(hour) }.to_account_metas(None),
        );
        let payer = self.stranger.insecure_clone();
        self.send(ix, &payer)
    }
}

/// 5 retards « canoniques » d'une journee (le serveur produira exactement ce format).
fn sample_records() -> Vec<Vec<u8>> {
    [
        "v1|20261126|860123|87723197|1620|ARRIVED",
        "v1|20261126|6641|87686006|0|ARRIVED",
        "v1|20261126|17769|87751008|2700|ARRIVED",
        "v1|20261126|860151|87723197|0|CANCELED",
        "v1|20261126|6603|87723197|900|ARRIVED",
    ]
    .iter()
    .map(|s| s.as_bytes().to_vec())
    .collect()
}

#[test]
fn merkle_build_and_verify_offchain() {
    // L'arbre construit hors chaine se verifie, pour toutes les tailles (y compris impaires).
    for n in 1..=17usize {
        let leaves: Vec<[u8; 32]> = (0..n).map(|i| merkle::leaf(merkle::TAG_DELAY, format!("r{i}").as_bytes())).collect();
        let (root, proofs) = merkle::build(&leaves);
        for (i, l) in leaves.iter().enumerate() {
            assert!(merkle::verify(*l, &proofs[i], &root), "n={n} i={i}");
        }
        // une feuille etrangere ne passe pas
        let alien = merkle::leaf(merkle::TAG_DELAY, b"alien");
        assert!(!merkle::verify(alien, &proofs[0], &root));
    }
}

#[test]
fn day_conversion() {
    assert_eq!(day_start_unix(19700101), None); // hors plage
    assert_eq!(day_start_unix(20261126), Some(1_795_651_200)); // 26/11/2026 00:00 UTC
    assert_eq!(day_start_unix(20240229).is_some(), true); // annee bissextile
    assert_eq!(day_start_unix(20260229), None); // n'existe pas
    assert_eq!(day_start_unix(20261331), None);
}

#[test]
fn delay_root_publish_and_verify() {
    let mut w = World::new();
    w.initialize();
    let records = sample_records();
    let leaves: Vec<[u8; 32]> = records.iter().map(|r| merkle::leaf(merkle::TAG_DELAY, r)).collect();
    let (root, proofs) = merkle::build(&leaves);

    // Un inconnu ne peut pas publier
    let stranger = w.stranger.insecure_clone();
    assert!(w.post_delay_root(&stranger, DAY, root, 5).is_err());

    // L'oracle publie
    let oracle = w.oracle.insecure_clone();
    w.post_delay_root(&oracle, DAY, root, 5).unwrap();
    let stored: DelayRoot = w.read(&delay_pda(DAY));
    assert_eq!(stored.root, root);
    assert_eq!(stored.n_records, 5);
    assert_eq!(stored.posted_at, T_0800);

    // Impossible de la remplacer
    assert!(w.post_delay_root(&oracle, DAY, [7u8; 32], 5).is_err());

    // Chaque retard se verifie on-chain
    for (i, r) in records.iter().enumerate() {
        w.verify_delay(DAY, r, proofs[i].clone()).unwrap();
    }
    // Un retard modifie (27 min -> 47 min) est refuse
    let forged = b"v1|20261126|860123|87723197|2820|ARRIVED";
    assert!(w.verify_delay(DAY, forged, proofs[0].clone()).is_err());
    // La bonne donnee avec la preuve d'un autre est refusee
    assert!(w.verify_delay(DAY, &records[0], proofs[2].clone()).is_err());
}

#[test]
fn delay_root_rejects_bad_days() {
    let mut w = World::new();
    w.initialize();
    let oracle = w.oracle.insecure_clone();
    assert!(w.post_delay_root(&oracle, 20261127, [1u8; 32], 3).is_err(), "jour futur");
    assert!(w.post_delay_root(&oracle, 20260230, [1u8; 32], 3).is_err(), "date inexistante");
    assert!(w.post_delay_root(&oracle, DAY, [1u8; 32], 0).is_err(), "arbre vide");
    w.post_delay_root(&oracle, 20261125, [1u8; 32], 3).unwrap(); // la veille : OK
}

#[test]
fn cert_root_anti_backdating() {
    let mut w = World::new();
    w.initialize();
    let oracle = w.oracle.insecure_clone();
    let hour = (T_0800 / 3600) as u32; // l'heure 08h-09h UTC

    // Trois justificatifs crees dans l'heure (leurs empreintes ; le contenu reste prive)
    let commitments: Vec<[u8; 32]> = (0..3u8).map(|i| [i + 1; 32]).collect();
    let leaves: Vec<[u8; 32]> = commitments.iter().map(|c| merkle::leaf(merkle::TAG_CERT, c)).collect();
    let (root, proofs) = merkle::build(&leaves);

    // Heure pas encore commencee : refuse
    assert!(w.post_cert_root(&oracle, hour + 1, root, 3).is_err());
    // Dans la fenetre (08h40) : accepte
    w.set_time(T_0800 + 40 * 60);
    w.post_cert_root(&oracle, hour, root, 3).unwrap();
    for (i, c) in commitments.iter().enumerate() {
        w.verify_cert(hour, *c, proofs[i].clone()).unwrap();
    }
    // Un justificatif qui n'etait pas dans l'heure est refuse
    assert!(w.verify_cert(hour, [9u8; 32], proofs[0].clone()).is_err());

    // Tentative d'antidatage : le 26 a 14h, publier pour l'heure 8h-9h -> refuse (fenetre fermee)
    let hour_b = hour - 2; // 06h-07h UTC, une autre heure jamais publiee
    w.set_time(T_0800 + 6 * 3600);
    assert!(w.post_cert_root(&oracle, hour_b, root, 3).is_err());
    // Limite exacte : fin de l'heure + 2 h - 1 s -> encore accepte ; + 2 h -> refuse
    let hour_c = hour + 3; // 11h-12h UTC
    let start_c = hour_c as i64 * 3600;
    w.set_time(start_c + 3600 + CERT_GRACE_SECONDS - 1);
    w.post_cert_root(&oracle, hour_c, root, 3).unwrap();
    let hour_d = hour + 4;
    w.set_time(hour_d as i64 * 3600 + 3600 + CERT_GRACE_SECONDS);
    assert!(w.post_cert_root(&oracle, hour_d, root, 3).is_err());
}

#[test]
fn only_admin_rotates_oracle() {
    let mut w = World::new();
    w.initialize();
    let new_oracle = Keypair::new();
    w.svm.airdrop(&new_oracle.pubkey(), SOL).unwrap();
    let set = |signer: &Keypair| {
        Instruction::new_with_bytes(
            pid(),
            &lateproof::instruction::SetOracle { new_oracle: new_oracle.pubkey() }.data(),
            lateproof::accounts::SetOracle { admin: signer.pubkey(), config: config_pda() }.to_account_metas(None),
        )
    };
    let stranger = w.stranger.insecure_clone();
    assert!(w.send(set(&stranger), &stranger).is_err());
    let admin = w.admin.insecure_clone();
    w.send(set(&admin), &admin).unwrap();
    let cfg: Config = w.read(&config_pda());
    assert_eq!(cfg.oracle, new_oracle.pubkey());
    // L'ancien oracle ne peut plus publier, le nouveau oui
    let old = w.oracle.insecure_clone();
    assert!(w.post_delay_root(&old, DAY, [1u8; 32], 1).is_err());
    w.post_delay_root(&new_oracle, DAY, [1u8; 32], 1).unwrap();
}

/// Test croise : le serveur Python (recorder/merkle.py) et le programme doivent calculer les MEMES
/// racines, a l'octet pres. Valeurs produites par `python recorder/merkle.py`.
#[test]
fn cross_language_vectors() {
    let hex = |b: [u8; 32]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let records = sample_records();
    let leaves: Vec<[u8; 32]> = records.iter().map(|r| merkle::leaf(merkle::TAG_DELAY, r)).collect();
    assert_eq!(hex(merkle::build(&leaves[..1]).0), "6920be9584b1be6c22c387328125d8a57bbf2d0c15e79526e0ecb2ecd93f32a7");
    assert_eq!(hex(merkle::build(&leaves).0), "bafe8d721670518e41dbe7ab3fc57f1eac1e97e1a8c6ac3dba737958e0697fb2");
    let certs: Vec<[u8; 32]> = (0..3u8).map(|i| merkle::leaf(merkle::TAG_CERT, &[i + 1; 32])).collect();
    assert_eq!(hex(merkle::build(&certs).0), "6352987e734de648f9ee80790aca1e7dc6398f6e9b7af99243606f7b37b8fe1c");
}

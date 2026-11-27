# Le programme LateProof, expliqué simplement

> Pour comprendre et pouvoir expliquer chaque ligne au jury. Le code est commenté en français, fichier par fichier.

## À quoi il sert
Il stocke sur Solana des **empreintes** : jamais de nom, d'e-mail ni de position. Grâce à elles, n'importe qui peut vérifier :
1. **qu'un retard de train a bien été relevé** ce jour-là, avec la bonne durée ;
2. **qu'un justificatif a bien été créé à l'heure annoncée**, et pas fabriqué après coup.

## Les fichiers, dans l'ordre de lecture
| Fichier | Rôle |
|---|---|
| `src/lib.rs` | La liste des 6 instructions (les « boutons » du programme) |
| `src/merkle.rs` | L'arbre de Merkle : comment une empreinte de 32 octets « contient » des milliers d'éléments |
| `src/state.rs` | Les comptes stockés : `Config`, `DelayRoot` (un par jour), `CertRoot` (un par heure), et les événements |
| `src/constants.rs` | Graines d'adresses, délai de grâce (2 h), limites de taille |
| `src/error.rs` | Les messages d'erreur |
| `src/instructions/*.rs` | Une instruction par fichier |
| `tests/test_proofs.rs` | Les tests, sur une blockchain simulée (LiteSVM) |

## Les 6 instructions
| Instruction | Qui | Ce qu'elle fait |
|---|---|---|
| `initialize` | L'admin, une seule fois | Crée la config et enregistre la clé de l'oracle (notre serveur) |
| `set_oracle` | L'admin | Change la clé de l'oracle (si elle fuit, par exemple) |
| `post_delay_root` | L'oracle | Publie l'empreinte des retards d'une journée. **Une seule par jour, jamais remplaçable**. Refusée pour une journée pas encore commencée ou une date qui n'existe pas |
| `post_cert_root` | L'oracle | Publie l'empreinte des justificatifs d'une heure. **Refusée si l'heure n'a pas commencé, ou plus de 2 h après sa fin** |
| `verify_delay` | N'importe qui | Vérifie qu'un retard fait partie de l'empreinte du jour ; refuse sinon |
| `verify_certificate` | N'importe qui | Vérifie qu'un justificatif faisait partie de l'empreinte de son heure ; refuse sinon |

## L'idée clé à expliquer au jury : la garantie anti-antidatage
- Notre serveur pourrait mentir… sauf que **c'est la blockchain qui vérifie l'heure**, avec sa propre horloge.
- L'empreinte des justificatifs de 8h-9h ne peut être publiée qu'entre 8h et 11h. Passé ce délai, `post_cert_root` échoue.
- Et une empreinte publiée ne peut plus être remplacée.
- Donc un justificatif « 26/11 à 8h » prouve qu'il existait **le 26/11 avant 11h**. Personne, pas même nous, ne peut en fabriquer un le 28 pour le 26.

## Pourquoi un arbre de Merkle
- Publier chaque retard un par un coûterait des dizaines de SOL par jour. Une seule empreinte par jour coûte quelques centimes.
- Pour prouver qu'un élément est dedans, il suffit d'environ 14 empreintes voisines, pour 10 000 éléments.
- Les règles exactes de calcul sont en tête de `merkle.rs`. Le serveur qui construit l'arbre doit les suivre à l'octet près. On les reprendra en Python dans l'enregistreur.

## Ce que testent les tests (6, tous verts le 25/11)
1. L'arbre se construit et se vérifie pour 1 à 17 éléments ; un élément étranger est refusé.
2. La conversion des dates (années bissextiles, 29 février inexistant…).
3. Publier puis vérifier 5 retards ; refus d'un inconnu ; refus de remplacer ; refus d'un retard modifié (27 → 47 min) ; refus d'une preuve qui n'est pas la bonne.
4. Refus d'un jour futur, d'une date inexistante, d'un arbre vide.
5. **Anti-antidatage** : refus avant l'heure, accepté dans la fenêtre, refusé à la seconde où la fenêtre se ferme.
6. Seul l'admin change l'oracle ; ensuite l'ancien oracle ne peut plus publier.

## Lancer les tests (dans le Codespace)
```bash
cd /workspaces/lateproof && anchor build && cargo test
```

## Prochaines étapes
- `buy_pass` (abonnement Pro en USDC) et `credit_contribution` (points des contributeurs).
- Le script de l'enregistreur qui construit l'arbre du jour et appelle `post_delay_root`.
- Le déploiement sur devnet (il faut des SOL devnet).

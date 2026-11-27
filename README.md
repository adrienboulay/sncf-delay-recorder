# LateProof

**When your train is late, LateProof tells you what to do, and proves your delay to your boss in 3 seconds.**

- **Live app:** https://adrienboulay.github.io/lateproof/
- **Solana program (devnet):** `8RKxwUR3X1vUG2HD2ruHYaPFa9ahExbMsCzg1L44aJeu` ([explorer](https://explorer.solana.com/address/8RKxwUR3X1vUG2HD2ruHYaPFa9ahExbMsCzg1L44aJeu?cluster=devnet))
- Built for the Dev3pack Global Hackathon (27–29 November 2026), solo.

## The problem
French trains run late often: about one TGV in seven arrives more than 15 minutes late. Commuters and business travellers then face three questions at once: what do I take instead, what am I entitled to, and how do I prove to my employer or school that I was really on that late train? Screenshots of an app are easy to fake, so a "late certificate" today is worth very little.

## What it does
1. **Before the trip:** live delays for every SNCF train in France (TGV, Intercités, TER) and, in Île-de-France, RER, Transilien, metro and tram, refreshed every 2 minutes. Strikes and planned works are flagged on your route.
2. **During the trip:** **Gus**, a small robot conductor, answers by text or voice (journey requests work today; free-form AI answers are enabled once the copilot server is deployed with its LLM key): "is the RER B on time?", "I want to go to Massy". It reads our live data through tools, and opens the journey planner (one connection, walking included) on the right trip.
3. **After the trip:** a **delay certificate** signed on your phone (passkey: Face ID or fingerprint), shared as a link. Your manager opens it and checks it in their own browser, with no account: the signature, the selective-disclosure proof (you choose which fields to reveal), and the train's real delay against our recorded data. Every day of records is sealed on Solana the following night.

## How Solana is used
Program: [`program/`](program/) (Rust, Anchor). It stores **fingerprints only**: no names, e-mails or locations.

**Live now (devnet):**
- the program is deployed and initialized ([initialize transaction](https://explorer.solana.com/tx/W7PJY6AD6JHNmJ74gqJox44Y6fKubv38aPwHfnePNC7YDdxoEGrgc53p97mpyfBZxg5TGixDua1LBVnndAmFwLR?cluster=devnet));
- **`post_delay_root` runs every night:** the oracle publishes the Merkle root of every train delay recorded that day, one immutable root per day, and the full list is archived. First root: 26 November 2026, 61,867 delay records ([transaction](https://explorer.solana.com/tx/4iCgbnZeUKDvdzxvtCEVYKD14WeM9Rk5ayBuBHFCTf6ssV8UADbZ9seE8LZUspQaypNVxjsw4H2AdBKyw8txWQ6B?cluster=devnet)).

**In the program, wiring next:**
- **`post_cert_root`:** an hourly root of the certificates created in that hour. The program rejects a root posted outside a 2-hour window, so a certificate cannot be backdated, not even by us. No job publishes it yet.
- **`verify_delay` / `verify_certificate`:** check a record against a published root on-chain (sorted-pair SHA-256 Merkle proof, domain-separated leaves). Next step: the verification page fetches the day's proof and checks it against the on-chain root, instead of our database. The Rust program and the Python publisher compute identical roots, checked by shared test vectors on every nightly run.

## Repository layout
| Folder | What | Runs on |
|---|---|---|
| [`program/`](program/) | Solana program (Anchor) and its tests (LiteSVM) | Solana devnet |
| [`recorder/`](recorder/) | Real-time delay recorder (SNCF GTFS-RT, Île-de-France PRIM), nightly archive, nightly Solana publication | GitHub Actions + Supabase Postgres |
| [`supabase/functions/assistant/`](supabase/functions/assistant/) | Copilot server: LLM with tools on our data, voice transcription | Supabase Edge Functions (Deno) |
| [`site/`](site/) | Web app: home, live map and journey planner, copilot, my trips and certificates, verification page | GitHub Pages |
| `.github/workflows/` | Recorder, nightly archive and roots, copilot tests and deploy, site deploy | GitHub Actions |

## APIs and services
- **Data:** SNCF open data (GTFS / GTFS-RT via transport.data.gouv.fr), Île-de-France Mobilités PRIM, Base Adresse Nationale (address search). Licence Mobilités / ODbL.
- **LLM:** any "chat completions" provider with tool calling. Groq (free tier, `openai/gpt-oss-120b`) when `GROQ_API_KEY` is set, Mistral otherwise.
- **Voice:**
  - Speech to text: the browser's own dictation (Web Speech API) first.
  - Server fallback for browsers without dictation, in this order: Groq Whisper, then the **ElevenLabs Speech-to-Text API (Scribe, `/v1/speech-to-text`)**, then Mistral Voxtral, depending on which key is set.
  - Text to speech: the browser's speech synthesis.
- **Storage:** Supabase (Postgres, Storage, Edge Functions).

## Built before / during the hackathon
The hackathon allows existing code; here is the honest split, which matches the git history.
- **Before the kickoff (23–26 November 2026):**
  - the delay recorder and its database;
  - the web app (map, journey planner, my trips, certificates, verification page);
  - the first version of the copilot;
  - the Solana program code and its tests (not deployed);
  - the development environment.
- **During the hackathon (from 27 November 2026):**
  - devnet deployment and initialization of the program;
  - first on-chain delay root published by the nightly job;
  - copilot on a free LLM provider, plus server voice transcription;
  - live voice dictation that opens the right journey;
  - database write reduction;
  - merge of the three repositories into this one.
  - The rest is listed in the commit history as it lands.

## Run it yourself
- **Program:** open the repository in GitHub Codespaces (`.devcontainer/` installs Rust, Solana CLI and Anchor), then `cd program && anchor build && cargo test`.
- **Recorder and copilot:** see [`recorder/README.md`](recorder/README.md) and the workflows. Secrets live only in GitHub Actions secrets, never in the code.
- **Site:** static files in `site/`. Any static server works; `config.js` (Supabase URL and *publishable* key) is generated at deploy time.

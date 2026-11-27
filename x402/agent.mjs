// Agent de démonstration x402 : appelle l'API payante de LateProof, reçoit 402, paie 0,01 USDC sur Solana devnet, obtient
// la réponse. Bibliothèques officielles x402 (@x402/fetch, @x402/core, @x402/svm) ; la clé reste dans les secrets GitHub.
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";

const base = process.env.SUPABASE_URL.match(/^https:\/\/[a-z0-9-]+\.supabase\.co/)[0];
const url = `${base}/functions/v1/advice?de=${encodeURIComponent(process.env.DE || "Paris Gare de Lyon")}&vers=${encodeURIComponent(process.env.VERS || "Lyon Part-Dieu")}`;
const decode = (h) => (h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null);

const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(process.env.AGENT_KEYPAIR)));
console.log(`Agent : ${signer.address}`);

// 1. Sans payer : le serveur répond 402 et annonce ses conditions
const r0 = await fetch(url);
console.log(`\n1) Appel sans paiement : HTTP ${r0.status}`);
console.log(JSON.stringify(decode(r0.headers.get("PAYMENT-REQUIRED")), null, 2));
if (process.env.PAY !== "true") process.exit(0);

// 2. Avec x402 : la bibliothèque signe le transfert USDC, rejoue l'appel, et le serveur fait régler sur Solana
const client = new x402Client();
client.register("solana:*", new ExactSvmScheme(signer));
const pay = wrapFetchWithPayment(fetch, client);
const r = await pay(url);
const body = await r.json().catch(() => ({}));
console.log(`\n2) Appel payé : HTTP ${r.status}`);
const pr = decode(r.headers.get("PAYMENT-RESPONSE"));
if (pr) console.log("PAYMENT-RESPONSE :", JSON.stringify(pr));
if (r.status !== 200) { console.log(JSON.stringify(decode(r.headers.get("PAYMENT-REQUIRED")) || body, null, 2)); process.exit(1); }
console.log(`Conseil : ${body.conseil}`);
console.log(`Transaction Solana : https://explorer.solana.com/tx/${pr?.transaction || body.paiement?.transaction}?cluster=devnet`);

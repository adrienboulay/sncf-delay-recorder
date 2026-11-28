// LateProof : coeur commun de l'application et de la page de verification.
// Donnees publiques (Supabase), stockage local, empreintes (Merkle, memes regles que le programme Solana),
// cle de signature du telephone (passkey WebAuthn) et justificatifs a divulgation selective.
(function () {
  "use strict";
  const CFG = window.LP_CONFIG || {};
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ---------------------------------------------------------------- donnees publiques
  async function rpc(fn, body = {}) {
    if (!CFG.url) throw new Error("hors ligne");
    const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: "POST", body: JSON.stringify(body), headers: {apikey: CFG.key, "Content-Type": "application/json"},
      signal: AbortSignal.timeout(20000),   // une base lente ne bloque jamais l'écran
    });
    if (!r.ok) throw new Error(`${fn} ${r.status}`);
    return r.json();
  }

  // ---------------------------------------------------------------- stockage local (tout reste sur l'appareil)
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // Petit coffre IndexedDB : garde la cle du navigateur NON exportable (localStorage ne sait pas la stocker).
  const idb = {
    open() { return new Promise((ok, ko) => { const r = indexedDB.open("lateproof", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }); },
    async put(k, v) { const db = await idb.open(); return new Promise((ok, ko) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = ok; t.onerror = () => ko(t.error); }); },
    async get(k) { const db = await idb.open(); return new Promise((ok, ko) => { const r = db.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }); },
    async del(k) { const db = await idb.open(); return new Promise(ok => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").delete(k); t.oncomplete = ok; }); },
  };

  // ---------------------------------------------------------------- outils
  const b64u = {
    enc(bytes) { let s = ""; new Uint8Array(bytes).forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
    dec(str) { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); },
  };
  const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");
  const unhex = h => Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
  const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; arrs.forEach(a => { out.set(a, o); o += a.length; }); return out; };
  const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const eq = (a, b) => a.length === b.length && cmp(a, b) === 0;

  // ---------------------------------------------------------------- Merkle (identique a recorder/merkle.py et au programme Rust)
  // feuille = SHA256(0x00 || etiquette || contenu) ; noeud = SHA256(0x01 || min || max) ; impair : remonte tel quel.
  const merkle = {
    leaf: (tag, content) => sha256(concat(Uint8Array.of(0), enc.encode(tag), typeof content === "string" ? enc.encode(content) : content)),
    node: (a, b) => cmp(a, b) <= 0 ? sha256(concat(Uint8Array.of(1), a, b)) : sha256(concat(Uint8Array.of(1), b, a)),
    async root(leaves) {
      if (!leaves.length) throw new Error("arbre vide");
      let level = leaves.slice();
      while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? await merkle.node(level[i], level[i + 1]) : level[i]);
        level = next;
      }
      return level[0];
    },
  };

  // ---------------------------------------------------------------- cle du telephone (passkey)
  // La cle privee ne quitte jamais l'appareil (Face ID, empreinte, code). On garde son identifiant et sa cle publique.
  const passkey = {
    get() { return store.get("lp-passkey"); },
    supported: () => !!(window.PublicKeyCredential && navigator.credentials),
    async create(label) {
      const cred = await navigator.credentials.create({publicKey: {
        challenge: rand(32), rp: {name: "LateProof"},
        user: {id: rand(16), name: label || "lateproof", displayName: label || "LateProof"},
        pubKeyCredParams: [{type: "public-key", alg: -7}],           // ES256 (P-256), verifiable dans tout navigateur
        authenticatorSelection: {userVerification: "preferred", residentKey: "preferred"},
        timeout: 60000, attestation: "none",
      }});
      const r = cred.response, spki = r.getPublicKey ? r.getPublicKey() : null;
      if (!spki || (r.getPublicKeyAlgorithm && r.getPublicKeyAlgorithm() !== -7)) throw new Error("Ce navigateur ne fournit pas une cle compatible.");
      const pk = {id: b64u.enc(cred.rawId), pub: b64u.enc(spki), alg: -7, created: Date.now(), origin: location.origin};
      store.set("lp-passkey", pk);
      return pk;
    },
    // Secours si l'appareil n'a pas de passkey : cle ECDSA du navigateur (non exportable, gardee dans IndexedDB).
    // Moins forte (pas de deverrouillage biometrique) : la page de verification l'indique clairement.
    async createBrowserKey() {
      const kp = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, false, ["sign", "verify"]);
      await idb.put("browser-key", kp);
      const pk = {id: "browser", kind: "browser", pub: b64u.enc(await crypto.subtle.exportKey("spki", kp.publicKey)), alg: -7, created: Date.now(), origin: location.origin};
      store.set("lp-passkey", pk);
      return pk;
    },
    // Signe des octets (la racine du justificatif) : le navigateur demande le visage / l'empreinte / le code.
    async sign(challenge) {
      const pk = passkey.get(); if (!pk) throw new Error("Pas de cle sur cet appareil");
      if (pk.kind === "browser") {   // meme format qu'une passkey (donnees client + donnees « authentificateur »), sans biometrie
        const kp = await idb.get("browser-key"); if (!kp) throw new Error("Cle du navigateur introuvable");
        const ad = concat(await sha256(enc.encode(location.hostname)), Uint8Array.of(1), new Uint8Array(4));
        const cd = enc.encode(JSON.stringify({type: "webauthn.get", challenge: b64u.enc(challenge), origin: location.origin}));
        const raw = new Uint8Array(await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, kp.privateKey, concat(ad, await sha256(cd))));
        return {pub: pk.pub, alg: -7, kind: "browser", ad: b64u.enc(ad), cd: b64u.enc(cd), sig: b64u.enc(raw)};
      }
      const a = await navigator.credentials.get({publicKey: {
        challenge, allowCredentials: [{type: "public-key", id: b64u.dec(pk.id)}], userVerification: "preferred", timeout: 60000,
      }});
      const r = a.response;
      return {pub: pk.pub, alg: -7, ad: b64u.enc(r.authenticatorData), cd: b64u.enc(r.clientDataJSON), sig: b64u.enc(r.signature)};
    },
  };

  // Signature ECDSA en DER -> forme brute r||s attendue par WebCrypto
  function derToRaw(der) {
    let i = 2; if (der[1] & 0x80) i += der[1] & 0x7f;
    const readInt = () => { i++; const len = der[i++]; let v = der.slice(i, i + len); i += len; while (v.length > 32 && v[0] === 0) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
    return concat(readInt(), readInt());
  }
  async function verifySignature(s, expectedChallenge) {
    const cd = b64u.dec(s.cd), client = JSON.parse(dec.decode(cd));
    if (client.type !== "webauthn.get") return {ok: false, why: "type"};
    if (!eq(b64u.dec(client.challenge), expectedChallenge)) return {ok: false, why: "challenge"};
    const key = await crypto.subtle.importKey("spki", b64u.dec(s.pub), {name: "ECDSA", namedCurve: "P-256"}, false, ["verify"]);
    const signed = concat(b64u.dec(s.ad), await sha256(cd));
    const sig = s.kind === "browser" ? b64u.dec(s.sig) : derToRaw(b64u.dec(s.sig));
    const ok = await crypto.subtle.verify({name: "ECDSA", hash: "SHA-256"}, key, sig, signed);
    const flags = b64u.dec(s.ad)[32];
    return {ok, origin: client.origin, userVerified: s.kind !== "browser" && !!(flags & 4), kind: s.kind || "passkey"};
  }

  // ---------------------------------------------------------------- justificatif a divulgation selective
  // Chaque champ : feuille = SHA256(0x00 || "FLD" || nom=valeur|sel). Racine des champs = engagement signe par le telephone.
  // Un champ cache n'est transmis que par son empreinte : on ne peut ni le lire ni le deviner (sel aleatoire).
  const fieldContent = f => `${f.n}=${typeof f.v === "string" ? f.v : JSON.stringify(f.v)}|${f.s}`;
  async function buildCert(fields, hiddenNames) {
    const full = fields.map(f => ({n: f.n, v: f.v, s: hex(rand(16))}));
    const leaves = await Promise.all(full.map(f => merkle.leaf("FLD", fieldContent(f))));
    const root = await merkle.root(leaves);
    const sig = await passkey.sign(root);
    const shown = full.map((f, i) => hiddenNames.includes(f.n) ? {n: f.n, h: hex(leaves[i])} : f);
    return {v: 1, f: shown, sig, root: hex(root), at: Math.floor(Date.now() / 1000)};
  }
  async function checkCert(c) {
    const leaves = await Promise.all(c.f.map(f => f.h ? unhex(f.h) : merkle.leaf("FLD", fieldContent(f))));
    const root = await merkle.root(leaves);
    const sameRoot = !c.root || hex(root) === c.root;
    const s = await verifySignature(c.sig, root).catch(() => ({ok: false, why: "crypto"}));
    return {ok: s.ok && sameRoot, signature: s, root: hex(root)};
  }
  // Le justificatif voyage dans le lien lui-meme (apres #) : rien n'est envoye a un serveur.
  const certToHash = c => b64u.enc(enc.encode(JSON.stringify(c)));
  const certFromHash = h => JSON.parse(dec.decode(b64u.dec(h)));
  // Code court lisible (8 caracteres) derive de la racine : sert de reference a l'oral ou sur papier
  const shortCode = rootHex => { const A = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; const b = unhex(rootHex); let s = ""; for (let i = 0; i < 8; i++) s += A[b[i] % 32]; return s.slice(0, 4) + "-" + s.slice(4); };

  // ---------------------------------------------------------------- dates et heures (Paris)
  const TZ = "Europe/Paris";
  const fmt = {
    // Langue de la page (lp-i18n.js) : « 12h40 » en français, « 12:40 » en anglais.
    time: t => { if (!t) return ""; const en = window.LPI && LPI.lang === "en";
      const s = new Date(t * 1000).toLocaleTimeString(en ? "en-GB" : "fr-FR", {hour: "2-digit", minute: "2-digit", timeZone: TZ}); return en ? s : s.replace(":", "h"); },
    day: t => new Date(t * 1000).toLocaleDateString(window.LPI ? LPI.locale : "fr-FR", {weekday: "long", day: "numeric", month: "long", timeZone: TZ}),
    dayShort: t => new Date(t * 1000).toLocaleDateString(window.LPI ? LPI.locale : "fr-FR", {day: "2-digit", month: "2-digit", timeZone: TZ}),
    ymd: t => new Date(t * 1000).toLocaleDateString("fr-CA", {timeZone: TZ}).replace(/-/g, ""),
    min: s => Math.round((s || 0) / 60),
  };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

  window.LP = {CFG, rpc, store, idb, b64u, hex, unhex, sha256, merkle, passkey, verifySignature, buildCert, checkCert, certToHash, certFromHash, shortCode, fmt, esc};
})();

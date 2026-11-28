// Images « story » 1080 × 1920 (Instagram, WhatsApp, TikTok) dessinées dans le navigateur, dans la DA du site.
// LPStory.draw({kicker, title, hero:{value, label}, rows:[{value, label, sub}], note, foot}) -> Promise<Blob PNG>
// LPStory.share(blob, nom, texte) : partage natif si le téléphone sait partager un fichier, sinon téléchargement.
(function () {
  "use strict";
  const W = 1080, H = 1920, LIME = "#FFBE98", ORANGE = "#FF8A5C", BG = "#121417", FG = "#E6E6E0", MUTED = "#9DA2AA", SURF = "#1A1D21";
  const HEAD = '"Bricolage Grotesque", "Manrope", sans-serif', BODY = '"Manrope", "Segoe UI", sans-serif';

  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/), lines = []; let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur); return lines;
  }
  // Texte sur une ligne : on réduit la police jusqu'à ce qu'il tienne, puis « … » en dernier recours
  function fit(ctx, text, maxW, big, small, weight, x, y) {
    let sz = big; text = String(text || "");
    for (; sz > small; sz -= 2) { ctx.font = `${weight} ${sz}px ${BODY}`; if (ctx.measureText(text).width <= maxW) break; }
    ctx.font = `${weight} ${sz}px ${BODY}`;
    while (text.length > 1 && ctx.measureText(text).width > maxW) text = text.slice(0, -2) + "…";
    ctx.fillText(text, x, y);
  }
  function round(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function logo(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 64, s / 64);
    ctx.fillStyle = LIME; round(ctx, 0, 0, 64, 64, 18); ctx.fill();
    ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.strokeStyle = "rgba(11,12,15,.18)"; ctx.beginPath(); ctx.arc(32, 32, 19, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#0B0C0F"; ctx.beginPath(); ctx.arc(32, 32, 19, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 / 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(32, 32); ctx.lineTo(41.5, 37.5); ctx.stroke();
    ctx.fillStyle = "#0B0C0F"; ctx.beginPath(); ctx.arc(32, 32, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }

  async function draw(o) {
    try { await Promise.all([`700 80px ${HEAD}`, `800 40px ${BODY}`, `600 40px ${BODY}`].map(f => document.fonts.load(f))); } catch (e) {}
    const c = document.createElement("canvas"); c.width = W; c.height = H; const ctx = c.getContext("2d");
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    // halos (l'« aurore » du site)
    [[160, 260, 620, "rgba(255,190,152,.16)"], [980, 900, 700, "rgba(255,138,92,.10)"], [200, 1700, 560, "rgba(255,190,152,.08)"]].forEach(([x, y, r, col]) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col); g.addColorStop(1, "rgba(18,20,23,0)"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    });
    // rails
    ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.lineWidth = 3; for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.moveTo(0, 1240 + i * 46); ctx.lineTo(W, 1100 + i * 46); ctx.stroke(); }
    const X = 84, CW = W - 2 * X;
    logo(ctx, X, 120, 76); ctx.fillStyle = FG; ctx.font = `700 50px ${HEAD}`; ctx.textBaseline = "middle"; ctx.fillText("lateproof", X + 98, 160); ctx.textBaseline = "alphabetic";
    // Contenu dessiné sur un calque, puis centré verticalement entre le logo et le pied de page
    const k = document.createElement("canvas"); k.width = W; k.height = H; const g = k.getContext("2d"); let y = 0;
    if (o.kicker) { g.fillStyle = LIME; g.font = `800 34px ${BODY}`; g.fillText(String(o.kicker).toUpperCase(), X, y + 34); y += 40; }
    g.fillStyle = FG; g.font = `700 96px ${HEAD}`;
    for (const l of wrap(g, o.title || "", CW).slice(0, 4)) { y += 104; g.fillText(l, X, y); }
    y += 60;
    if (o.hero) {
      g.fillStyle = o.hero.color || LIME; g.font = `700 280px ${HEAD}`; g.fillText(o.hero.value, X - 8, y + 236); y += 286;
      g.fillStyle = FG; g.font = `600 48px ${BODY}`; for (const l of wrap(g, o.hero.label || "", CW).slice(0, 2)) { y += 58; g.fillText(l, X, y); }
      y += 70;
    }
    // Lignes : {value, label, sub, color, badge: {img} | {text, color, fg}} ; intertitre : {section: "texte"}
    const all = (o.rows || []).slice(0, 9), rows = all.filter(r => !r.section), dense = rows.length > 4;
    const rh = dense ? 142 : 190, vf = `700 ${dense ? 60 : 78}px ${HEAD}`;
    g.font = vf; const vw = Math.max(0, ...rows.map(r => g.measureText(r.value).width));
    all.forEach((r, i) => {
      if (r.section) { g.fillStyle = LIME; g.font = `800 30px ${BODY}`; g.fillText(String(r.section).toUpperCase(), X, y + 44); y += 66; return; }
      g.fillStyle = SURF; round(g, X, y, CW, rh - 20, 36); g.fill();
      g.fillStyle = r.color || (i === 0 && o.rankColors ? ORANGE : LIME); g.font = vf; g.fillText(r.value, X + 40, y + (rh - 20) / 2 + (dense ? 22 : 26));
      let vx = X + 40 + vw + 36;
      if (r.badge) {
        const cy = y + (rh - 20) / 2, bs = dense ? 64 : 76;
        if (r.badge.img) { if (r.badge.light) { g.fillStyle = "#fff"; round(g, vx - 6, cy - bs / 2 - 6, bs + 12, bs + 12, 14); g.fill(); } g.drawImage(r.badge.img, vx, cy - bs / 2, bs, bs); vx += bs + 22 + (r.badge.light ? 6 : 0); }
        else {
          g.font = `800 ${dense ? 28 : 32}px ${BODY}`; const tw = g.measureText(r.badge.text).width, bw = Math.max(bs, tw + 32);
          g.fillStyle = r.badge.color || "#5B6470"; round(g, vx, cy - bs / 2, bw, bs, 14); g.fill();
          g.fillStyle = r.badge.fg || "#fff"; g.textAlign = "center"; g.fillText(r.badge.text, vx + bw / 2, cy + (dense ? 10 : 11)); g.textAlign = "left"; vx += bw + 22;
        }
      }
      const mw = CW - (vx - X) - 30;
      g.fillStyle = FG; fit(g, r.label, mw, 40, 26, "700", vx, y + (r.sub ? (rh - 20) / 2 - 6 : (rh - 20) / 2 + 14));
      if (r.sub) { g.fillStyle = MUTED; fit(g, r.sub, mw, 31, 24, "600", vx, y + (rh - 20) / 2 + 40); }
      y += rh;
    });
    if (o.note) { g.fillStyle = MUTED; g.font = `600 32px ${BODY}`; y += 16; for (const l of wrap(g, o.note, CW).slice(0, 3)) { y += 44; g.fillText(l, X, y); } }
    const top = 260, bottom = H - 190, h = Math.min(y + 20, bottom - top);
    ctx.drawImage(k, 0, 0, W, h, 0, top + Math.max(0, (bottom - top - h) / 2), W, h);
    ctx.fillStyle = MUTED; ctx.font = `600 32px ${BODY}`; ctx.fillText(o.foot || "adrienboulay.github.io/lateproof", X, H - 110);
    return new Promise(res => c.toBlob(res, "image/png"));
  }

  async function share(blob, name, text) {
    const file = new File([blob], name, {type: "image/png"});
    try { if (navigator.canShare && navigator.canShare({files: [file]})) { await navigator.share({files: [file], text}); return "shared"; } } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000); return "downloaded";
  }
  window.LPStory = {draw, share};
})();

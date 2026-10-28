// Sharing: a link that carries a whole ranking (plus hot takes), and a PNG image of the top of it.

// ---------- links ----------
// Deezer track ids are packed as varints (7 bits per byte), base64url encoded.

const toB64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export function encodeIds(ids) {
  const out = [];
  for (const id of ids) {
    let n = Number(id);
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n) b |= 128;
      out.push(b);
    } while (n);
  }
  return toB64(Uint8Array.from(out));
}

export function decodeIds(s) {
  const b = fromB64(s), ids = [];
  let n = 0, mul = 1;
  for (const byte of b) {
    n += (byte & 127) * mul;
    if (byte & 128) mul *= 128;
    else { ids.push(String(n)); n = 0; mul = 1; }
  }
  return ids;
}

const enc = obj => toB64(new TextEncoder().encode(JSON.stringify(obj)));
const dec = s => JSON.parse(new TextDecoder().decode(fromB64(s)));

// notes: { trackId: text } for tracks in ids. Stored by position to keep the link short.
export function shareUrl({ artist, ids, name, date, notes = {} }) {
  const q = new URLSearchParams();
  q.set('a', artist.id);
  q.set('an', artist.name);
  if (name) q.set('n', name);
  if (date) q.set('d', date);
  q.set('r', encodeIds(ids));
  const pos = ids.map((id, i) => (notes[id] ? [i, notes[id]] : null)).filter(Boolean);
  if (pos.length) q.set('t', enc(pos));
  return location.origin + location.pathname.replace(/index\.html$/, '') + '#' + q.toString();
}

export function readShared(hash = location.hash) {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  if (!q.has('r') || !q.has('a')) return null;
  try {
    const ids = decodeIds(q.get('r'));
    const notes = {};
    if (q.has('t')) for (const [i, text] of dec(q.get('t'))) if (ids[i]) notes[ids[i]] = String(text).slice(0, 280);
    return {
      artist: { id: q.get('a'), name: q.get('an') || '' },
      ids, notes, name: q.get('n') || '', date: q.get('d') || '',
    };
  } catch {
    return null;
  }
}

// ---------- image ----------

const W = 1080;
const LAYOUTS = { 10: { cols: 1, rowH: 104 }, 25: { cols: 2, rowH: 118 }, 50: { cols: 2, rowH: 66 } };

function loadImage(src) {
  return new Promise(res => {
    if (!src) return res(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
    setTimeout(() => res(null), 8000);
  });
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

// rows: [{ name, sub, image }] in ranked order. Returns a canvas.
export async function renderImage({ rows, n, title, subtitle, footer, accent = '#e8ff3c' }) {
  const L = LAYOUTS[n] || LAYOUTS[10];
  const shown = rows.slice(0, n);
  const perCol = Math.ceil(shown.length / L.cols);
  const head = 230, foot = 90, pad = 48;
  const H = head + perCol * L.rowH + foot;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  await document.fonts?.load?.('700 40px "Space Grotesk"').catch(() => {});
  const font = (w, s) => `${w} ${s}px "Space Grotesk", system-ui, sans-serif`;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#12121a'); g.addColorStop(1, '#08080b');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 10);

  ctx.fillStyle = accent; ctx.font = font(600, 26);
  ctx.fillText(fit(ctx, subtitle.toUpperCase(), W - 2 * pad), pad, 78);
  ctx.fillStyle = '#f2f2f5'; ctx.font = font(700, 58);
  ctx.fillText(fit(ctx, title, W - 2 * pad), pad, 150);

  const imgs = await Promise.all(shown.map(r => loadImage(r.image)));
  const colW = (W - 2 * pad - (L.cols - 1) * 28) / L.cols;
  const wide = L.cols === 1, tight = L.rowH < 90;
  shown.forEach((r, i) => {
    const col = Math.floor(i / perCol), row = i % perCol;
    const x = pad + col * (colW + 28), y = head + row * L.rowH;
    const h = L.rowH - 10;
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.06)';
    ctx.beginPath(); ctx.roundRect(x, y, colW, h, 14); ctx.fill();

    ctx.fillStyle = i < 3 ? accent : '#f2f2f5';
    ctx.font = font(700, wide ? 40 : tight ? 26 : 32);
    ctx.textAlign = 'right';
    const rankW = wide ? 70 : tight ? 48 : 56;
    ctx.fillText(String(i + 1), x + rankW, y + h / 2 + (wide ? 14 : tight ? 9 : 11));
    ctx.textAlign = 'left';

    const s = h - 12, ix = x + rankW + 14, iy = y + 6;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(ix, iy, s, s, 8); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(ix, iy, s, s);
    if (imgs[i]) ctx.drawImage(imgs[i], ix, iy, s, s);
    ctx.restore();

    const tx = ix + s + 16, maxW = x + colW - tx - 12;
    ctx.fillStyle = '#f2f2f5'; ctx.font = font(700, wide ? 34 : tight ? 22 : 27);
    if (tight) {
      ctx.fillText(fit(ctx, r.name, maxW), tx, y + h / 2 + 8);
    } else {
      ctx.fillText(fit(ctx, r.name, maxW), tx, y + h / 2 - 4);
      ctx.fillStyle = '#9a9aab'; ctx.font = font(500, wide ? 22 : 19);
      ctx.fillText(fit(ctx, r.sub, maxW), tx, y + h / 2 + (wide ? 30 : 26));
    }
  });

  ctx.fillStyle = '#9a9aab'; ctx.font = font(500, 24);
  ctx.fillText(fit(ctx, footer, W - 2 * pad), pad, H - 38);
  return c;
}

export function canvasBlob(c) {
  return new Promise(res => c.toBlob(res, 'image/png'));
}

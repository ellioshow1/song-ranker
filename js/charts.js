// Charts for the Share tab: the bump chart of how a ranking took shape, and the hover tooltip
// shared with the album strips.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Line colors for followed songs, assigned by slot so a song keeps its color while followed.
// Checked for colorblind separation and 3:1 contrast against the card background (#121218).
export const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const tipEl = () => document.getElementById('chart-tip');
export function showTip(x, y, html) {
  const t = tipEl();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const left = x + 16 + r.width > innerWidth - 8 ? x - 16 - r.width : x + 16;
  t.style.left = Math.max(8, left) + 'px';
  t.style.top = Math.min(innerHeight - r.height - 8, Math.max(8, y - r.height - 10)) + 'px';
}
export function hideTip() { tipEl().hidden = true; }

const fit = (text, chars) => (text.length > chars ? text.slice(0, Math.max(1, chars - 1)).trimEnd() + '…' : text);

// hist: one Map of id → place per checkpoint. labels: short checkpoint names for the x axis ("1", "2", …, "Now");
// long(i) names checkpoint i for the tooltip. K: the lowest place shown (lines below it run off the bottom).
// follow: [[id, color]], drawn on top and labelled. onPick(id) when a song is tapped.
export function bumpChart(el, { hist, labels, long, K, follow, name, onPick }) {
  const W = Math.max(280, el.clientWidth || 600), narrow = W < 520;
  const C = hist.length, last = hist[C - 1], N = last.size;
  const padL = 30, padR = narrow ? 112 : 196, padT = 10, padB = 30;
  const plotH = K <= 10 ? 270 : K <= 25 ? 390 : Math.min(460, Math.max(280, K * 3));
  const H = padT + plotH + padB, xEnd = W - padR;
  const x = i => padL + (i * (xEnd - padL)) / (C - 1);
  const y = r => padT + ((r - 1) * plotH) / Math.max(1, K - 1);
  const byPlace = hist.map(m => { const a = []; for (const [id, r] of m) a[r] = id; return a; });
  const line = id => hist.map((m, i) => `${x(i).toFixed(1)},${y(m.get(id)).toFixed(1)}`).join(' ');
  const followed = new Map(follow);

  const bg = [...last.keys()].filter(id => !followed.has(id) && hist.some(m => m.get(id) <= K))
    .map(id => `<polyline points="${line(id)}"/>`).join('');
  const dots = C <= 20;
  const fg = follow.filter(([id]) => last.has(id)).map(([id, col]) =>
    `<polyline points="${line(id)}" stroke="${col}"/>` +
    hist.map((m, i) => (dots || i === C - 1) && m.get(id) <= K ? `<circle cx="${x(i).toFixed(1)}" cy="${y(m.get(id)).toFixed(1)}" r="4" fill="${col}"/>` : '').join('')).join('');

  // End labels: every song that finishes in view when zoomed to a top 10/25, otherwise just the followed ones.
  // Labels that would overlap are spread out and joined to their line by a short leader.
  const gap = 15, maxChars = Math.floor((padR - 34) / 6.6);
  const lab = [...last.entries()].filter(([id, r]) => r <= K && (K <= 25 || followed.has(id)))
    .map(([id, r]) => ({ id, r, y: y(r), ly: y(r) })).sort((a, b) => a.r - b.r);
  let prev = -Infinity;
  for (const l of lab) { l.ly = Math.max(l.y, prev + gap); prev = l.ly; }
  let next = padT + plotH + gap;
  for (const l of [...lab].reverse()) { l.ly = Math.min(l.ly, next - gap); next = l.ly; }
  const ends = lab.map(l => {
    const col = followed.get(l.id), tx = xEnd + (col ? 30 : 16);
    return (Math.abs(l.ly - l.y) > 1 ? `<polyline class="leader" points="${xEnd + 5},${l.y.toFixed(1)} ${xEnd + 11},${l.ly.toFixed(1)} ${xEnd + 14},${l.ly.toFixed(1)}"/>` : '') +
      (col ? `<line x1="${xEnd + 15}" x2="${xEnd + 26}" y1="${l.ly.toFixed(1)}" y2="${l.ly.toFixed(1)}" stroke="${col}" class="key"/>` : '') +
      `<text x="${tx}" y="${(l.ly + 4).toFixed(1)}" class="${col ? 'f' : ''}">${l.r} ${esc(fit(name(l.id), maxChars - (col ? 2 : 0)))}</text>`;
  }).join('');

  const step = K <= 10 ? 1 : K <= 25 ? 5 : [10, 20, 25, 50, 100, 200, 250, 500].find(s => K / s <= 7) || 1000;
  const yTicks = [1, ...Array.from({ length: Math.floor(K / step) }, (_, i) => (i + 1) * step)].filter((v, i, a) => v <= K && a.indexOf(v) === i);
  const every = Math.ceil(C / Math.max(2, Math.floor((xEnd - padL) / 34)));
  const shownX = labels.map((_, i) => i).filter(i => i === C - 1 || (i % every === 0 && C - 1 - i >= every / 2));

  el.innerHTML = `<svg class="bump" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Each song's place after every round of matchups">
    <defs><clipPath id="bump-clip"><rect x="0" y="0" width="${xEnd + 6}" height="${padT + plotH + 8}"/></clipPath></defs>
    ${shownX.map(i => `<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${padT - 4}" y2="${padT + plotH + 4}"/>`).join('')}
    ${yTicks.map(r => `<text class="tick" x="${padL - 8}" y="${y(r) + 4}" text-anchor="end">${r}</text>`).join('')}
    ${shownX.map(i => `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(labels[i])}</text>`).join('')}
    <g clip-path="url(#bump-clip)"><g class="bg${N > 60 && K > 25 ? ' dense' : ''}">${bg}</g><g class="fg">${fg}</g></g>
    ${ends}
    <g class="hov"></g>
    <rect class="hit" x="0" y="0" width="${W}" height="${padT + plotH + 10}" fill="transparent"/>
  </svg>`;

  // Hover: snap to the nearest round, then the song at the nearest place in it (or the nearest end label).
  const svg = el.firstElementChild, hov = svg.querySelector('.hov');
  let cur = null;
  const at = e => {
    const b = svg.getBoundingClientRect(), px = e.clientX - b.left, py = e.clientY - b.top;
    if (px > xEnd + 8 && lab.length) {
      const l = lab.reduce((a, c) => (Math.abs(c.ly - py) < Math.abs(a.ly - py) ? c : a));
      return { id: l.id, i: C - 1 };
    }
    const i = Math.max(0, Math.min(C - 1, Math.round(((px - padL) / (xEnd - padL)) * (C - 1))));
    const r = Math.max(1, Math.min(K, N, Math.round(1 + ((py - padT) / plotH) * Math.max(1, K - 1))));
    return { id: byPlace[i][r], i };
  };
  const move = e => {
    const h = at(e);
    if (!h.id) return;
    cur = h.id;
    const r = hist[h.i].get(h.id), col = followed.get(h.id);
    hov.innerHTML = `<line class="cross" x1="${x(h.i)}" x2="${x(h.i)}" y1="${padT - 4}" y2="${padT + plotH + 4}"/>
      <g clip-path="url(#bump-clip)"><polyline points="${line(h.id)}" stroke="${col || '#f2f2f5'}" class="hl"/></g>
      ${r <= K ? `<circle cx="${x(h.i)}" cy="${y(r)}" r="5.5" fill="${col || '#f2f2f5'}"/>` : ''}`;
    showTip(e.clientX, e.clientY, `<b>#${r}</b> ${esc(name(h.id))}<span class="s">${esc(long(h.i))}${h.i < C - 1 ? ` · now #${last.get(h.id)}` : ''}</span>` +
      `<span class="s">${col ? 'Tap to stop following' : 'Tap to follow'}</span>`);
  };
  const leave = () => { cur = null; hov.innerHTML = ''; hideTip(); };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('click', () => { if (cur) { const id = cur; leave(); onPick(id); } });
}

// A song's rating after each of its matchups, starting from `start`: a dot per game (win, loss or tie)
// and a hairline at the starting rating.
export function sparkSvg(log, start, { w = 480, h = 84, pad = 8 } = {}) {
  const rs = [start, ...log.map(g => g.r)];
  const lo = Math.min(...rs), hi = Math.max(...rs), span = Math.max(1, hi - lo);
  const x = i => pad + (i * (w - 2 * pad)) / Math.max(1, rs.length - 1);
  const y = v => pad + ((hi - v) * (h - 2 * pad)) / span;
  const cls = res => (res === 1 ? 'w' : res === 0 ? 'l' : 't');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Rating after each matchup, from ${Math.round(start)} to ${Math.round(rs[rs.length - 1])}">
    <line class="base" x1="${pad}" x2="${w - pad}" y1="${y(start).toFixed(1)}" y2="${y(start).toFixed(1)}"/>
    <polyline points="${rs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>
    ${log.map((g, i) => `<circle class="${cls(g.res)}" cx="${x(i + 1).toFixed(1)}" cy="${y(g.r).toFixed(1)}" r="4"/>`).join('')}
  </svg>`;
}

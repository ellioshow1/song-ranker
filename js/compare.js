// Comparing rankings: you vs the crowd, you vs a friend, and a group consensus.

// Spearman rank correlation over the songs both lists contain.
export function agreement(orderA, orderB) {
  const inB = new Set(orderB);
  const common = orderA.filter(id => inB.has(id));
  const n = common.length;
  if (n < 3) return null;
  const ra = new Map(common.map((id, i) => [id, i + 1]));
  const rb = new Map(orderB.filter(id => ra.has(id)).map((id, i) => [id, i + 1]));
  let d2 = 0, gap = 0;
  for (const id of common) { const d = ra.get(id) - rb.get(id); d2 += d * d; gap += Math.abs(d); }
  const topA = common.slice(0, 10), topB = new Set(orderB.filter(id => ra.has(id)).slice(0, 10));
  return {
    rho: 1 - (6 * d2) / (n * (n * n - 1)),
    pct: Math.round(Math.max(0, 1 - (6 * d2) / (n * (n * n - 1))) * 100),
    gap: gap / n, n, ra, rb,
    top10: topA.filter(id => topB.has(id)).length,
  };
}

// Biggest disagreements, scaled so 5 places near the top counts more than 5 places at #200.
// Returns [aHigher, bHigher], each [{ id, a, b }].
export function disagreements(ag, limit = 10) {
  const rows = [...ag.ra.keys()].map(id => ({ id, a: ag.ra.get(id), b: ag.rb.get(id) }));
  const w = r => (r.b - r.a) / Math.sqrt((r.a + r.b) / 2);
  return [
    rows.filter(r => r.b > r.a).sort((x, y) => w(y) - w(x)).slice(0, limit),
    rows.filter(r => r.a > r.b).sort((x, y) => w(x) - w(y)).slice(0, limit),
  ];
}

// Group ranking from several lists. Each song's score is its average percentile across the lists
// that include it (0 = top), counting only songs at least half the group ranked.
// Returns { order: [{ id, score, spread, n }], divisive: [...] }.
export function consensus(lists) {
  const per = new Map();
  for (const order of lists) {
    const n = order.length;
    order.forEach((id, i) => {
      const p = n > 1 ? i / (n - 1) : 0;
      per.has(id) ? per.get(id).push(p) : per.set(id, [p]);
    });
  }
  const need = Math.max(1, Math.ceil(lists.length / 2));
  const rows = [...per.entries()].filter(([, ps]) => ps.length >= need).map(([id, ps]) => {
    const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
    const spread = Math.sqrt(ps.reduce((a, b) => a + (b - mean) ** 2, 0) / ps.length);
    return { id, score: mean, spread, n: ps.length, ps };
  });
  const order = [...rows].sort((a, b) => a.score - b.score || b.n - a.n);
  const divisive = rows.filter(r => r.n >= 2).sort((a, b) => b.spread - a.spread).slice(0, 10);
  return { order, divisive };
}

export function scatterSvg(ids, ra, rb, { xLabel, yLabel, name }) {
  const n = ids.length, S = 600, pad = 36;
  const sc = v => pad + ((v - 1) / Math.max(1, n - 1)) * (S - 2 * pad);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dots = ids.map(id => {
    const a = ra.get(id), b = rb.get(id), d = b - a;
    const col = Math.abs(d) <= n * 0.05 ? '#9a9aab' : d > 0 ? '#4ade80' : '#f87171';
    return `<circle data-song="${id}" cx="${sc(b).toFixed(1)}" cy="${sc(a).toFixed(1)}" r="${n > 200 ? 3.5 : 5}" fill="${col}" fill-opacity=".8"><title>${esc(name(id))}: ${esc(yLabel)} #${a}, ${esc(xLabel)} #${b}</title></circle>`;
  }).join('');
  return `<svg viewBox="0 0 ${S} ${S}" role="img" aria-label="${esc(yLabel)} rank against ${esc(xLabel)} rank for every song">
    <line x1="${pad}" y1="${pad}" x2="${S - pad}" y2="${S - pad}" stroke="#2a2a35" stroke-width="2"/>
    <text x="${S / 2}" y="${S - 8}" fill="#9a9aab" font-size="14" text-anchor="middle">${esc(xLabel)} (1 → ${n})</text>
    <text x="14" y="${S / 2}" fill="#9a9aab" font-size="14" text-anchor="middle" transform="rotate(-90 14 ${S / 2})">${esc(yLabel)} (1 → ${n})</text>
    ${dots}</svg>`;
}

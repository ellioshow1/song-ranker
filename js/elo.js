// Elo ratings from head-to-head picks. The only stored state is the list of picks;
// ratings are rebuilt by replaying them, which keeps undo and pool changes trivial.
//
// A pick is [a, b, result] where result is 1 (a wins), 0 (b wins) or 0.5 (can't split them).

export const START = 1500;

// New players move fast, settled players move slowly.
export function kFactor(games) {
  return games < 5 ? 40 : games < 12 ? 28 : 18;
}

export function expected(ra, rb) {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

export function ratings(pool, picks) {
  const R = new Map(pool.map(id => [id, { id, r: START, g: 0, w: 0, l: 0, t: 0, opp: new Set() }]));
  for (const [a, b, res] of picks) {
    const A = R.get(a), B = R.get(b);
    if (!A || !B || A === B) continue; // one has left the pool, or they've since been merged into one song
    const ea = expected(A.r, B.r);
    const ka = kFactor(A.g), kb = kFactor(B.g);
    A.r += ka * (res - ea);
    B.r += kb * ((1 - res) - (1 - ea));
    A.g++; B.g++;
    A.opp.add(b); B.opp.add(a);
    if (res === 1) { A.w++; B.l++; } else if (res === 0) { A.l++; B.w++; } else { A.t++; B.t++; }
  }
  return R;
}

// Everyone in the pool gets a place. Early on, rating-matched pairing leaves many exact ties
// (everyone who's 3-0 against similar opposition), so ties go to the better record, then the
// tougher schedule (average rating of opponents faced), and only then to the tiebreak order.
export function ranking(R, tiebreak = new Map()) {
  const sched = p => (p.opp.size ? [...p.opp].reduce((s, id) => s + (R.get(id)?.r ?? START), 0) / p.opp.size : START);
  const sos = new Map([...R.values()].map(p => [p.id, sched(p)]));
  return [...R.values()].sort((x, y) =>
    y.r - x.r || (y.w - y.l) - (x.w - x.l) || sos.get(y.id) - sos.get(x.id) ||
    (tiebreak.get(x.id) ?? 1e9) - (tiebreak.get(y.id) ?? 1e9));
}

// Next matchup: the player with the fewest games so far, against someone close in rating
// they haven't met yet. Early on everyone is 1500, so pairs are effectively random.
export function nextPair(R, { avoid = [], rand = Math.random } = {}) {
  const list = [...R.values()];
  if (list.length < 2) return null;
  const skip = new Set(avoid);
  const minG = Math.min(...list.map(p => p.g));
  const fresh = list.filter(p => p.g === minG && !skip.has(p.id));
  const pool = fresh.length ? fresh : list.filter(p => p.g === minG);
  const A = pool[Math.floor(rand() * pool.length)];
  let best = null, bestCost = Infinity;
  for (const B of list) {
    if (B === A) continue;
    const cost = Math.abs(A.r - B.r) + 12 * (B.g - minG) + (A.opp.has(B.id) ? 600 : 0) + (skip.has(B.id) ? 300 : 0) + rand() * 60;
    if (cost < bestCost) { bestCost = cost; best = B; }
  }
  return rand() < 0.5 ? [A.id, best.id] : [best.id, A.id];
}

// How settled the ranking is, as average games per player.
export const LEVELS = [
  { games: 4, label: 'Rough' },
  { games: 8, label: 'Solid' },
  { games: 14, label: 'Sharp' },
];

export function progress(R, picks) {
  const n = R.size || 1;
  const avg = (2 * picks) / n;
  const next = LEVELS.find(l => avg < l.games);
  const reached = [...LEVELS].reverse().find(l => avg >= l.games);
  return {
    avg,
    label: reached ? reached.label : 'Just started',
    next,
    picksToNext: next ? Math.ceil((next.games * n) / 2 - picks) : 0,
    frac: next ? avg / next.games : 1,
  };
}

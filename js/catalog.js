// Turns the raw track scan into songs: one entry per song, however many releases it's on.
//
// Two tracks are the same song when they share an ISRC (the same recording), or when their titles
// match once "noise" is stripped (feat. credits, remaster years, radio edit, single version, bonus
// track...) and their lengths are within 20 seconds. Real variations (live, remix, acoustic,
// sped up, re-recordings...) stay separate songs with a tag, so they can be filtered.
// Users can override both ways: split a track off its song, or merge two songs.

const FEAT = /\s*[\(\[]\s*(feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]/gi;
const DASH_FEAT = /\s+-\s+(feat\.?|ft\.?|featuring|with)\s.*$/i;

// A bracketed or " - " part of a title that doesn't make it a different song.
const SAME_SONG = new RegExp('^(' + [
  '(\\d{4} )?(digital(ly)? )?re-?master(ed)?( \\d{4})?( version| edition| mix)?',
  're-?master(ed)? (version|edition|\\d{4})',
  'radio (edit|version|mix)',
  '(single|album|lp|original|main|clean|explicit|dirty|censored|mono|stereo|short|edited|uncensored) (version|edit|mix)',
  'clean|explicit|dirty|mono|stereo|edit|edited|censored|uncensored|original|bonus|bonus track|hidden track',
  'deluxe( edition| version)?',
  'from .+',
  '\\d+(st|nd|rd|th) anniversary( edition| version)?',
].join('|') + ')$');

// Real variations: kept as their own songs, each type toggleable.
export const VERSION_TAGS = {
  live: { label: 'Live', re: /\blive\b|\bunplugged\b|\bin concert\b/ },
  remix: { label: 'Remixes', re: /\bre ?mix(ed)?\b|\brmx\b|\bbootleg\b|\b(club|dub|vip|extended) mix\b|\bflip\b/ },
  acoustic: { label: 'Acoustic & stripped', re: /\bacoustic\b|\bstripped\b|\bpiano\b|\borchestral\b|\bsymphonic\b/ },
  instrumental: { label: 'Instrumentals & a cappellas', re: /\binstrumental\b|\ba ?capp?ell?a\b/ },
  sped: { label: 'Sped up & slowed', re: /\bsped\b|\bspeed up\b|\bslowed\b|\breverb\b|\bnightcore\b|\b8d\b/ },
  demo: { label: 'Demos', re: /\bdemo\b|\bvoice ?memo\b|\bwork ?tape\b/ },
  rerecord: { label: "Re-recordings (e.g. Taylor's Version)", re: /\b\w+'s version\b|\bre ?record(ed|ing)?\b/ },
  extended: { label: 'Extended versions', re: /\bextended\b|\blong version\b/ },
  skit: { label: 'Skits, interviews & commentary', re: /\bskit\b|\binterview\b|\bcommentary\b|\bspoken word\b|\btrack by track\b|\bvoice note\b|\bbehind the song\b/ },
  // Anything else that names itself a version, mix, take or edit: "(Cabaret Version)", "(International Mix)".
  alt: { label: 'Other versions (alternate takes, special mixes)', re: /\bversion\b|\bmix\b|\btake\b|\brehearsal\b|\bedit\b|\bmixed\b|\bsession\b/ },
};

// Release kinds, from the album a track sits on.
export const KINDS = {
  album: 'Albums',
  single: 'Singles & EPs',
  feature: 'Features',
  compilation: 'Greatest hits & compilations',
  live: 'Live albums',
};
const LIVE_ALBUM = /\(live\)|\[live\]|\blive (at|from|in|on|session|sessions|recordings?|tour)\b|^live\b|(?<!long )\blive$|\bunplugged\b|\bin concert\b|\bmtv\b/i;
const COMPILATION = /\bgreatest hits\b|\bbest of\b|\bthe very best\b|\bthe essential\b|\bessentials\b|\banthology\b|\bretrospective\b|\bthe collection\b|\bdefinitive\b|\bhits (collection|vol)|\bplaylist:/i;
const DELUXE = /deluxe|expanded|anniversary|complete edition|special edition|platinum edition|tour edition|super edition|\bedition\b/i;

const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’`]/g, "'").replace(/&/g, ' and ').replace(/\$/g, 's').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Title -> { base, kept (variation parts), stripped (noise was removed), tag }
export function parseTitle(title) {
  let t = title.replace(FEAT, '').replace(DASH_FEAT, '');
  const parts = [];
  t = t.replace(/[\(\[]([^\)\]]*)[\)\]]/g, (_, inner) => { parts.push(inner); return ' '; });
  const dash = t.match(/\s[-–—]\s(.+)$/);
  if (dash) { parts.push(dash[1]); t = t.slice(0, dash.index); }
  const kept = [];
  let stripped = false;
  for (const p of parts.map(norm).filter(Boolean)) {
    if (SAME_SONG.test(p)) stripped = true;
    else kept.push(p);
  }
  const extra = kept.join(' ');
  let tag = null;
  for (const [k, v] of Object.entries(VERSION_TAGS)) if (v.re.test(extra)) { tag = k; break; }
  // Skits often say so in the title itself rather than in brackets.
  if (!tag && /\b(skit|interview)\b/.test(norm(t))) tag = 'skit';
  return { base: norm(t) || norm(title), kept, stripped, tag };
}

export function releaseKind(t, artistId) {
  const a = t.album;
  if (a.group === 'manual') return 'manual';
  if (a.group === 'appears_on') {
    if (t.artists[0]?.id !== artistId) return 'feature';
    return LIVE_ALBUM.test(a.name) ? 'live' : 'compilation';
  }
  if (LIVE_ALBUM.test(a.name)) return 'live';
  if (a.group === 'compilation' || COMPILATION.test(a.name)) return 'compilation';
  // Someone else's single the artist is on (Deezer lists collab singles under both artists).
  if (a.group === 'single' && t.artists[0]?.id !== artistId) return 'feature';
  if (a.group === 'single') return 'single';
  return 'album';
}

const KIND_ORDER = { album: 0, single: 1, feature: 1, manual: 1, compilation: 3, live: 4 };

// Which version stands for the song. allowed = kinds the user wants; others only as a fallback.
function pickRep(versions, prefer, allowed) {
  const score = v => (allowed && !allowed[v.kind] && v.kind !== 'manual' ? 100 : 0);
  return [...versions].sort((a, b) => {
    const s = score(a) - score(b);
    if (s) return s;
    if (prefer === 'popular') return b.rank - a.rank;
    if (prefer === 'latest') return (b.album.date || '').localeCompare(a.album.date || '') || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      || (DELUXE.test(a.album.name) - DELUXE.test(b.album.name))
      || (b.explicit - a.explicit)
      || (a.album.date || '9').localeCompare(b.album.date || '9');
  })[0];
}

// raw: scanned tracks. Options:
//   artistId, prefer ('original' | 'popular' | 'latest'), allowed (kinds map from the filters),
//   chosen (Set of track ids the user picked as their song's version),
//   splits (Set of track ids forced into their own song), merges ([[trackId, trackId], ...]).
export function buildSongs(raw, { artistId, prefer = 'original', allowed = null, chosen = new Set(), splits = new Set(), merges = [] } = {}) {
  const tracks = raw.map(t => {
    const p = parseTitle(t.name);
    let { tag } = p;
    const kind = releaseKind(t, artistId);
    if (!tag && kind === 'live') tag = 'live'; // live albums rarely say "(Live)" on every track
    const key = [p.base, ...p.kept, tag === 'live' ? '[live]' : ''].join(' ').trim() + (splits.has(t.id) ? ' #' + t.id : '');
    return { ...t, kind, tag, key, base: p.base, stripped: p.stripped };
  });

  // Union-find over track indexes.
  const parent = tracks.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  const byKey = new Map();
  tracks.forEach((t, i) => (byKey.has(t.key) ? byKey.get(t.key).push(i) : byKey.set(t.key, [i])));
  for (const idx of byKey.values()) {
    idx.sort((a, b) => tracks[a].duration - tracks[b].duration);
    const clusters = [];
    for (const i of idx) {
      const c = clusters.find(c => Math.abs(tracks[c[0]].duration - tracks[i].duration) <= 20000);
      c ? c.push(i) : clusters.push([i]);
    }
    for (const c of clusters) for (const i of c) union(c[0], i);
    // An edit ("radio edit", "single version") can be far shorter than the original: join it to the closest one.
    for (const c of clusters) {
      if (clusters.length < 2 || !c.every(i => tracks[i].stripped)) continue;
      const others = clusters.filter(o => o !== c);
      const near = others.sort((x, y) => Math.abs(tracks[x[0]].duration - tracks[c[0]].duration) - Math.abs(tracks[y[0]].duration - tracks[c[0]].duration))[0];
      union(near[0], c[0]);
    }
  }
  // The same recording on different releases always shares an ISRC.
  const byIsrc = new Map();
  tracks.forEach((t, i) => {
    if (!t.isrc || splits.has(t.id)) return;
    byIsrc.has(t.isrc) ? union(byIsrc.get(t.isrc), i) : byIsrc.set(t.isrc, i);
  });
  const idx = new Map(tracks.map((t, i) => [t.id, i]));
  for (const [a, b] of merges) if (idx.has(a) && idx.has(b)) union(idx.get(a), idx.get(b));

  const groups = new Map();
  tracks.forEach((t, i) => { const r = find(i); groups.has(r) ? groups.get(r).push(t) : groups.set(r, [t]); });

  // "Same title" = another song with exactly the same cleaned-up title but a different length
  // (two different "Intro"s, or an edit we couldn't tie to its original).
  const titleKey = t => t.key.replace(/ #\d+$/, '');
  const songs = [];
  const baseCount = new Map();
  for (const versions of groups.values()) {
    const rep = versions.find(v => chosen.has(v.id)) || pickRep(versions, prefer, allowed);
    baseCount.set(titleKey(rep), (baseCount.get(titleKey(rep)) || 0) + 1);
    songs.push({
      ...rep,
      versions: versions.sort((a, b) => (a.album.date || '').localeCompare(b.album.date || '')),
      kinds: [...new Set(versions.map(v => v.kind))],
      rank: Math.max(...versions.map(v => v.rank || 0)),
      primary: rep.artists[0]?.id,
    });
  }
  for (const s of songs) s.dupeTitle = baseCount.get(titleKey(s)) > 1;
  songs.sort((a, b) => (b.album.date || '').localeCompare(a.album.date || '') || a.name.localeCompare(b.name));
  return songs;
}

// Every track id -> the song it belongs to. Picks and pools store track ids, so they keep working
// when the representative version changes.
export function songIndex(songs) {
  const m = new Map();
  for (const s of songs) for (const v of s.versions) m.set(v.id, s);
  return m;
}

// The artist's own albums and EPs, for the album filter.
export function releases(raw) {
  const m = new Map();
  for (const t of raw) {
    const a = t.album;
    if (!['album', 'single', 'compilation'].includes(a.group) || (a.group === 'single' && a.type !== 'ep')) continue;
    if (!m.has(a.id)) m.set(a.id, { ...a, count: 0 });
    m.get(a.id).count++;
  }
  return [...m.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export const artistLine = s => s.artists.map(a => a.name).join(', ');
export const year = s => (s.album.date || '').slice(0, 4);
export const fmtTime = ms => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`;

// ---------- pool filters ----------

export function defaultFilters() {
  return {
    kinds: { album: true, single: true, feature: true, compilation: false, live: false },
    tags: Object.fromEntries(Object.keys(VERSION_TAGS).map(k => [k, false])),
    minLength: 45,       // seconds; hides intros and interludes
    yearFrom: 0, yearTo: 0,
    albums: [],          // release ids; empty = all
    crowdTop: 0,         // 0 = no cap
    prefer: 'original',
    include: [], exclude: [],   // track ids
  };
}

export const PRESETS = {
  hits: { label: 'The hits', hint: "The crowd's top 40", f: { crowdTop: 40, kinds: { album: true, single: true, feature: true, compilation: true, live: false } } },
  catalog: { label: 'Main catalog', hint: 'Albums, singles, features', f: {} },
  albums: { label: 'Album tracks', hint: 'Studio albums only', f: { kinds: { album: true, single: false, feature: false, compilation: false, live: false } } },
  everything: { label: 'Everything', hint: 'Every version of every song', f: { kinds: { album: true, single: true, feature: true, compilation: true, live: true }, tags: Object.fromEntries(Object.keys(VERSION_TAGS).map(k => [k, true])), minLength: 0 } },
};

// Song ids (representative track ids) that pass the filters.
export function poolFor(songs, f, index) {
  const has = (list, s) => list.some(id => index.get(id) === s);
  let out = songs.filter(s => {
    if (has(f.exclude, s)) return false;
    if (has(f.include, s)) return true;
    if (s.tag && !f.tags[s.tag]) return false;
    if (!s.kinds.some(k => k === 'manual' || f.kinds[k])) return false;
    if (s.duration && s.duration / 1000 < f.minLength) return false;
    const y = +year(s);
    if (f.yearFrom && y && y < f.yearFrom) return false;
    if (f.yearTo && y && y > f.yearTo) return false;
    if (f.albums.length && !s.versions.some(v => f.albums.includes(v.album.id))) return false;
    return true;
  });
  if (f.crowdTop > 0) {
    const forced = new Set(out.filter(s => has(f.include, s)));
    out = [...out].sort((a, b) => b.rank - a.rank).filter((s, i) => i < f.crowdTop || forced.has(s));
  }
  return out.map(s => s.id);
}

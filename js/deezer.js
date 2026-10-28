// Deezer public API access: artist search, catalog scan, track lookup, fresh preview links.
// No login needed. Deezer doesn't send CORS headers, so every call goes through JSONP.

const API = 'https://api.deezer.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Deezer allows 50 requests per 5 seconds per IP; stay under it.
const WINDOW_MS = 5000, WINDOW_MAX = 40;
const stamps = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > WINDOW_MS) stamps.shift();
    if (stamps.length < WINDOW_MAX) { stamps.push(now); return; }
    await sleep(WINDOW_MS - (now - stamps[0]) + 25);
  }
}

let cbSeq = 0;
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const name = '__deezer' + (++cbSeq);
    const s = document.createElement('script');
    const timer = setTimeout(() => finish(new Error('Deezer took too long to answer. Check your connection and try again.')), 20000);
    function finish(err, data) {
      clearTimeout(timer);
      window[name] = () => {}; // a late answer after a timeout lands here harmlessly
      s.remove();
      err ? reject(err) : resolve(data);
    }
    window[name] = data => finish(null, data);
    s.onerror = () => finish(new Error("Couldn't reach Deezer. Check your connection and try again."));
    s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + name;
    document.head.appendChild(s);
  });
}

export async function api(path) {
  const url = path.startsWith('http') ? path : API + path;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const data = await jsonp(url);
    const err = data?.error;
    if (!err) return data;
    // Code 4 is Deezer's "quota exceeded": wait out the window and retry.
    if (err.code === 4 && attempt < 5) { await sleep(WINDOW_MS + 500); continue; }
    const e = new Error(err.code === 800 ? 'Deezer has no data for that.' : `Deezer error: ${err.message || err.type || 'unknown'}`);
    e.code = err.code;
    throw e;
  }
}

async function pageAll(path) {
  const out = [];
  let next = path;
  while (next) {
    const page = await api(next);
    out.push(...(page.data || []));
    next = page.next;
  }
  return out;
}

async function pool(items, size, fn) {
  let i = 0, failed = false;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length && !failed) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch (e) { failed = true; throw e; }
    }
  }));
}

const GROUP = { album: 'album', single: 'single', ep: 'single', compile: 'compilation' };

function toTrack(t, album, group, artists = t.contributors?.length ? t.contributors : [t.artist]) {
  return {
    id: String(t.id),
    isrc: t.isrc || '',
    name: t.title,
    artists: artists.map(a => ({ id: String(a.id), name: a.name })),
    duration: (t.duration || 0) * 1000,
    explicit: !!t.explicit_lyrics,
    rank: t.rank || 0,        // Deezer popularity, driven by recent streams
    album: {
      id: String(album.id),
      name: album.title,
      type: album.record_type || '',
      group,
      date: album.release_date || '',
      image: album.cover_big || album.cover_medium || '',
      imageSmall: album.cover_small || album.cover_medium || '',
    },
  };
}

function artistInfo(a) {
  return {
    id: String(a.id),
    name: a.name,
    image: a.picture_medium || a.picture || '',
    albums: a.nb_album || 0,
    fans: a.nb_fan || 0,
  };
}

export async function searchArtists(q) {
  const r = await api(`/search/artist?limit=10&q=${encodeURIComponent(q)}`);
  return (r.data || []).map(artistInfo);
}

export async function getArtist(id) {
  return artistInfo(await api(`/artist/${id}`));
}

// Every track (raw, not yet deduped) the artist is on.
// 1. Their own releases (albums, singles, EPs, compilations) and every track on them.
// 2. Features and other people's releases: Deezer has no "appears on" list, so candidates come
//    from the artist's top tracks and a search for their name, kept only if Deezer credits them.
// 3. Any extra track ids (songs added by link).
export async function fetchCatalog(artist, onProgress = () => {}, extraIds = []) {
  const id = String(artist.id);
  onProgress({ phase: 'releases', text: 'Finding releases…' });
  const releases = await pageAll(`/artist/${id}/albums?limit=100`);

  const tracks = [];
  const seen = new Set();
  let done = 0;
  await pool(releases, 4, async album => {
    // Every track on the artist's own release counts, even when Deezer lists a collaborator first
    // (collab singles show up under both artists); credit the artist so the song says who's on it.
    for (const t of await pageAll(`/album/${album.id}/tracks?limit=100`)) {
      if (!t.id || t.readable === false || seen.has(String(t.id))) continue;
      seen.add(String(t.id));
      const artists = String(t.artist?.id) === id ? [t.artist] : [t.artist, { id, name: artist.name }];
      tracks.push(toTrack(t, album, GROUP[album.record_type] || 'album', artists));
    }
    onProgress({ phase: 'tracks', done: ++done, total: releases.length, found: tracks.length, text: album.title });
  });

  onProgress({ phase: 'features', text: 'Looking for features and other releases…' });
  const [top, found] = await Promise.all([
    api(`/artist/${id}/top?limit=100`).then(r => r.data || []),
    pageAll(`/search/track?limit=100&q=${encodeURIComponent(artist.name)}`),
  ]);
  const candidates = [...new Map([...top, ...found, ...extraIds.map(x => ({ id: x, title: '' }))]
    .filter(t => t.id && !seen.has(String(t.id)))
    .map(t => [String(t.id), t])).values()];
  const extra = new Set(extraIds.map(String));

  let checked = 0, feats = 0;
  await pool(candidates, 4, async c => {
    const t = await api(`/track/${c.id}`).catch(e => (e.code === 800 ? null : Promise.reject(e)));
    const credited = t?.contributors?.some(a => String(a.id) === id);
    if (t && t.readable !== false && (credited || extra.has(String(t.id))) && !seen.has(String(t.id))) {
      seen.add(String(t.id));
      tracks.push(toTrack(t, t.album, extra.has(String(t.id)) && !credited ? 'manual' : 'appears_on'));
      feats++;
    }
    onProgress({ phase: 'features', done: ++checked, total: candidates.length, found: tracks.length, feats, text: c.title });
  });
  return tracks;
}

export async function fetchTrack(trackId) {
  const t = await api(`/track/${trackId}`);
  return toTrack(t, t.album, 'manual');
}

// Preview links are signed and expire after about 15 minutes, so fetch them right before playing.
const previews = new Map();
export async function previewUrl(trackId, fresh = false) {
  const hit = previews.get(trackId);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60e3) return hit.url;
  const t = await api(`/track/${trackId}`);
  previews.set(trackId, { url: t.preview || '', at: Date.now() });
  return t.preview || '';
}

export const trackLink = id => `https://www.deezer.com/track/${id}`;

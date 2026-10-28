import * as dz from './deezer.js';
import * as sp from './spotify.js';
import * as Elo from './elo.js';
import * as C from './catalog.js';
import * as store from './store.js';
import { agreement, disagreements, consensus, scatterSvg } from './compare.js';
import { shareUrl, readShared, renderImage, canvasBlob } from './share.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt1 = n => (Math.round(n * 10) / 10).toFixed(1);
const today = () => new Date().toISOString().slice(0, 10);
const cover = (url, cls = 'cv') => `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;

// ---------- state ----------
// S: the open artist's saved state. CAT: its scanned catalog. Everything else is derived by rebuild().

let S = null, CAT = null;
let songs = [], idx = new Map(), byId = new Map(), poolIds = [], R = new Map();
let me = store.read('me', { name: '' });
let friends = store.read('friends', []);

function freshState(artist) {
  return {
    artist, filters: C.defaultFilters(), preset: 'catalog', pool: null, picks: [], current: null,
    notes: {}, chosen: [], splits: [], merges: [], manual: [], spotify: {}, playlist: null, imgN: 10,
  };
}
function loadState(artist) {
  const saved = store.read('r.' + artist.id, null);
  if (!saved) return freshState(artist);
  const f = { ...C.defaultFilters(), ...saved.filters };
  return { ...freshState(artist), ...saved, filters: f };
}
function indexList() { return store.read('index', []); }
let warned = false;
function save() {
  if (!S) return;
  const ok = store.write('r.' + S.artist.id, S);
  const list = indexList().filter(x => x.id !== S.artist.id);
  list.unshift({ id: S.artist.id, name: S.artist.name, image: S.artist.image, updated: Date.now(), picks: S.picks.length, songs: S.pool ? S.pool.length : null });
  store.write('index', list);
  store.write('current', S.artist.id);
  if (!ok && !warned) { toast('Browser storage is full. Download a backup from the Share tab.', true); warned = true; }
}

const sid = trackId => idx.get(trackId)?.id;
const song = id => byId.get(id);
function resolve(trackIds) {
  const out = [], seen = new Set();
  for (const t of trackIds) { const s = sid(t); if (s && !seen.has(s)) { seen.add(s); out.push(s); } }
  return out;
}

function rebuild() {
  const f = S.filters;
  songs = C.buildSongs(CAT.raw, {
    artistId: S.artist.id, prefer: f.prefer, allowed: f.kinds,
    chosen: new Set(S.chosen), splits: new Set(S.splits), merges: S.merges,
  });
  idx = C.songIndex(songs);
  byId = new Map(songs.map(s => [s.id, s]));
  poolIds = S.pool ? resolve(S.pool) : [];
  R = Elo.ratings(poolIds, S.picks.map(([a, b, r]) => [sid(a), sid(b), r]));
}

const catalogOrder = () => new Map(songs.map((s, i) => [s.id, i]));
const myOrder = () => Elo.ranking(R, catalogOrder()).map(r => r.id);
const crowdOrder = ids => [...ids].sort((a, b) => song(b).rank - song(a).rank);
const ranksOf = order => new Map(order.map((id, i) => [id, i + 1]));
const noteFor = s => s.versions.map(v => S.notes[v.id]).find(Boolean) || '';
const artistName = () => S?.artist.name || 'this artist';

// ---------- ui helpers ----------

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 7000 : 3000);
}
async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { toast('Clipboard blocked by the browser', true); }
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = s => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artist';

let view = null;
const ARTIST_VIEWS = ['songs', 'play', 'rank', 'compare', 'share'];
function show(v) {
  view = v;
  if (v !== 'play') players.pauseAll();
  for (const s of $$('.view')) s.hidden = s.id !== 'view-' + v;
  const open = !!S && ARTIST_VIEWS.includes(v);
  document.body.classList.toggle('open', open);
  $('#tabs').hidden = !open;
  $('#brand-artist').textContent = open ? S.artist.name : '';
  document.title = open ? `${S.artist.name} · Song Ranker` : 'Song Ranker';
  for (const b of $$('#tabs button')) {
    b.classList.toggle('on', b.dataset.view === v);
    if (b.dataset.view !== 'songs') b.hidden = !S?.pool;
  }
  refresh();
  window.scrollTo(0, 0);
}
// Re-render the current view in place (no scroll jump).
function refresh() {
  ({ home: renderHome, songs: renderSongs, play: renderPlay, rank: renderRank, compare: renderCompare, share: renderShare, connect: renderConnect, shared: renderShared }[view] || (() => {}))();
}
for (const b of $$('#tabs button')) b.onclick = () => show(b.dataset.view);
$('#brand').onclick = () => { clearHash(); show('home'); };
function clearHash() { if (location.hash) history.replaceState(null, '', location.pathname); }

function deltaHtml(mine, other, who = 'crowd') {
  if (!other) return '';
  const d = other - mine;
  if (!d) return `<span class="delta same" title="The ${who} agrees">=</span>`;
  return `<span class="delta ${d > 0 ? 'up' : 'down'}" title="The ${who} has it #${other}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
}
function badges(s) {
  const kinds = s.kinds.filter(k => k !== 'manual');
  return [
    s.tag ? `<span class="badge">${esc(C.VERSION_TAGS[s.tag].label.split(/ [(&]/)[0])}</span>` : '',
    s.versions.length > 1 ? `<span class="badge" title="On ${s.versions.length} releases, merged">${s.versions.length} versions</span>` : '',
    s.dupeTitle ? '<span class="badge warn" title="Another song has the same title but a different length">same title</span>' : '',
    s.primary !== S.artist.id && kinds.includes('feature') ? '<span class="badge">feature</span>' : '',
    kinds.length === 1 && kinds[0] === 'compilation' ? '<span class="badge">compilation only</span>' : '',
  ].join('');
}
const songSub = s => [C.artistLine(s), s.album.name, C.year(s)].filter(Boolean).join(' · ');

// ---------- home ----------

function renderHome() {
  const mine = indexList();
  $('#mine-wrap').hidden = !mine.length;
  $('#mine-list').innerHTML = mine.map(a => `<li class="clickable" data-open="${esc(a.id)}">${cover(a.image, 'cv round')}
    <div class="t-main"><div class="t-name">${esc(a.name)}</div><div class="t-sub">${a.songs ? `${a.songs} songs · ${a.picks.toLocaleString()} picks` : 'Not started'} · ${new Date(a.updated).toLocaleDateString()}</div></div>
    <button class="link" data-del="${esc(a.id)}">Delete</button></li>`).join('');
  $('#friends-wrap').hidden = !friends.length;
  $('#friends-list').innerHTML = friends.map((f, i) => `<li class="clickable" data-friend="${i}"><span></span>
    <div class="t-main"><div class="t-name">${esc(f.name || 'Someone')}'s ${esc(f.artist.name)} ranking</div><div class="t-sub">${f.ids.length} songs · ranked ${esc(f.date || '?')}</div></div>
    <button class="link" data-unfriend="${i}">Remove</button></li>`).join('');
  const have = new Set(mine.map(a => a.id));
  const old = store.oldRankings().filter(o => !have.has(String(o.artist.id)));
  $('#import-card').hidden = !old.length;
  if (old.length) {
    $('#import-card').innerHTML = `<h2>Bring over your rankings from the old Artist Ranker</h2>
      <p class="hint">Found in this browser: ${old.map(o => `<b>${esc(o.artist.name)}</b> (${(o.data.t?.matches.length || 0).toLocaleString()} picks)`).join(', ')}.
      Your picks are copied across and replayed as Elo ratings. The old app and its rankings stay exactly as they are.</p>
      <button class="primary" id="import-old">Bring them over</button>`;
    $('#import-old').onclick = () => {
      for (const o of old) importOld(o.artist, o.data);
      toast(`Brought over ${old.length} ranking${old.length > 1 ? 's' : ''}. Open one to load its songs.`);
      renderHome();
    };
  }
}

function importOld(artist, d) {
  const a = { id: String(artist.id), name: artist.name, image: artist.image || '' };
  const st = freshState(a);
  if (d.t) {
    st.pool = [...d.t.active];
    st.picks = d.t.matches.map(m => [m.a, m.b, m.w === 'a' ? 1 : m.w === 'b' ? 0 : 0.5]);
  }
  st.manual = (d.manual || []).map(t => t.id);
  st.preset = null;
  st.importedFrom = 'deezer-edition';
  store.write('r.' + a.id, st);
  const list = indexList().filter(x => x.id !== a.id);
  list.unshift({ id: a.id, name: a.name, image: a.image, updated: Date.now(), picks: st.picks.length, songs: st.pool ? st.pool.length : null });
  store.write('index', list);
}

let searchTimer, searchSeq = 0;
$('#artist-search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#artist-results').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const res = await dz.searchArtists(q);
      if (seq !== searchSeq) return;
      $('#artist-results').innerHTML = res.map(a => `<li>${cover(a.image, 'cv round')}
        <div class="t-main"><div class="t-name">${esc(a.name)}</div><div class="t-sub">${a.albums.toLocaleString()} releases · ${a.fans.toLocaleString()} fans</div></div>
        <button class="primary small" data-pick-artist='${esc(JSON.stringify(a))}'>Rank</button></li>`).join('')
        || '<li><span></span><span class="hint">No artists found.</span></li>';
    } catch (err) { toast(err.message, true); }
  }, 300);
});
$('#artist-results').addEventListener('click', e => {
  const raw = e.target.closest('[data-pick-artist]')?.dataset.pickArtist;
  if (raw) openArtist(JSON.parse(raw));
});
$('#mine-list').addEventListener('click', e => {
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (del) {
    e.stopPropagation();
    const a = indexList().find(x => x.id === del);
    if (!confirm(`Delete your ${a.name} ranking and every pick in it? This can't be undone.`)) return;
    store.remove('r.' + del);
    store.write('index', indexList().filter(x => x.id !== del));
    store.deleteCatalog(del);
    if (S?.artist.id === del) S = null;
    renderHome();
    return;
  }
  const id = e.target.closest('[data-open]')?.dataset.open;
  if (id) { const a = indexList().find(x => x.id === id); openArtist({ id: a.id, name: a.name, image: a.image }); }
});
$('#friends-list').addEventListener('click', e => {
  const un = e.target.closest('[data-unfriend]')?.dataset.unfriend;
  if (un != null) {
    e.stopPropagation();
    friends.splice(+un, 1);
    store.write('friends', friends);
    renderHome();
    return;
  }
  const i = e.target.closest('[data-friend]')?.dataset.friend;
  if (i != null) { const f = friends[+i]; location.hash = shareUrl({ artist: f.artist, ids: f.ids, name: f.name, date: f.date, notes: f.notes }).split('#')[1]; }
});
$('#copy-app').onclick = () => copy(sp.redirectUri(), 'App link copied');

// ---------- opening an artist & scanning ----------

async function openArtist(artist, then) {
  clearHash();
  S = loadState(artist);
  if (artist.image) S.artist.image = artist.image;
  CAT = await store.getCatalog(S.artist.id);
  if (!CAT) return scan(then);
  rebuild();
  show(then || (S.pool ? 'play' : 'songs'));
}

async function scan(then) {
  show('scan');
  $('#scan-title').textContent = `Digging through ${artistName()}'s catalog…`;
  $('#scan-bar').style.width = '2%';
  try {
    const raw = await dz.fetchCatalog(S.artist, p => {
      const frac = p.total ? p.done / p.total : 0;
      if (p.phase === 'tracks') {
        $('#scan-text').textContent = `Scanning releases: ${p.done} of ${p.total}`;
        $('#scan-sub').textContent = `${p.found} tracks so far · ${p.text}`;
        $('#scan-bar').style.width = (2 + 68 * frac) + '%';
      } else if (p.phase === 'features' && p.total) {
        $('#scan-text').textContent = `Checking features and other releases: ${p.done} of ${p.total}`;
        $('#scan-sub').textContent = `${p.feats} extra songs found · ${p.text}`;
        $('#scan-bar').style.width = (70 + 30 * frac) + '%';
      } else {
        $('#scan-text').textContent = p.text;
        $('#scan-sub').textContent = '';
      }
    }, S.manual);
    CAT = { scannedAt: new Date().toISOString(), raw };
    await store.putCatalog(S.artist.id, CAT);
    if (!S.artist.image) S.artist.image = (await dz.getArtist(S.artist.id).catch(() => ({}))).image || '';
    rebuild();
    if (typeof then === 'function') return then();
    save();
    show(then || (S.pool ? 'play' : 'songs'));
  } catch (e) {
    console.error(e);
    $('#scan-text').textContent = 'The scan failed.';
    $('#scan-sub').innerHTML = esc(e.message) + ' <button class="ghost small" id="retry-scan">Try again</button>';
    $('#retry-scan').onclick = () => scan(then);
  }
}

// ---------- songs: who's in ----------

function preview() { return C.poolFor(songs, S.filters, idx); }
function changed() { S.preset = null; save(); renderSongs(); }
function refilter() { rebuild(); changed(); }

$('#presets').addEventListener('click', e => {
  const k = e.target.closest('[data-preset]')?.dataset.preset;
  if (!k) return;
  const f = S.filters;
  S.filters = { ...C.defaultFilters(), ...C.PRESETS[k].f, include: f.include, exclude: f.exclude, prefer: f.prefer };
  S.preset = k;
  rebuild();
  save();
  renderSongs();
});
$('#f-kinds').onclick = e => { const k = e.target.closest('[data-kind]')?.dataset.kind; if (k) { S.filters.kinds[k] = !S.filters.kinds[k]; refilter(); } };
$('#f-tags').onclick = e => { const k = e.target.closest('[data-tag]')?.dataset.tag; if (k) { S.filters.tags[k] = !S.filters.tags[k]; changed(); } };
$('#f-len').oninput = () => { S.filters.minLength = +$('#f-len').value; changed(); };
$('#f-top').oninput = () => { S.filters.crowdTop = +$('#f-top').value; changed(); };
$('#f-from').onchange = () => { S.filters.yearFrom = +$('#f-from').value; changed(); };
$('#f-to').onchange = () => { S.filters.yearTo = +$('#f-to').value; changed(); };
$('#f-prefer').onchange = () => { S.filters.prefer = $('#f-prefer').value; save(); rebuild(); renderSongs(); };
$('#f-albums').onclick = e => {
  const id = e.target.closest('[data-album]')?.dataset.album;
  if (!id) return;
  const set = new Set(S.filters.albums);
  set.has(id) ? set.delete(id) : set.add(id);
  S.filters.albums = [...set];
  changed();
};

function renderSongs() {
  const f = S.filters, started = !!S.pool;
  $('#songs-title').textContent = started ? 'Songs in your ranking' : `${artistName()}: choose the songs`;
  $('#songs-lede').innerHTML = `${songs.length} songs from ${CAT.raw.length} tracks on Deezer (duplicates across albums, deluxes, singles and greatest hits merged), scanned ${new Date(CAT.scannedAt).toLocaleDateString()}. <button class="link" id="rescan">Rescan</button>`;
  $('#rescan').onclick = () => scan('songs');
  $('#presets').innerHTML = Object.entries(C.PRESETS).map(([k, p]) =>
    `<button class="preset ghost ${S.preset === k ? 'on' : ''}" data-preset="${k}"><b>${esc(p.label)}</b><span>${esc(p.hint)}</span></button>`).join('');

  const kindCount = k => songs.filter(s => s.kinds.includes(k)).length;
  $('#f-kinds').innerHTML = Object.entries(C.KINDS).map(([k, l]) =>
    `<button class="${f.kinds[k] ? 'on' : ''}" data-kind="${k}">${esc(l)} <span class="hint">${kindCount(k)}</span></button>`).join('');
  $('#f-tags').innerHTML = Object.entries(C.VERSION_TAGS).map(([k, v]) => {
    const n = songs.filter(s => s.tag === k).length;
    return n ? `<button class="${f.tags[k] ? 'on' : ''}" data-tag="${k}">${esc(v.label)} <span class="hint">${n}</span></button>` : '';
  }).join('') || '<span class="hint">No remixes, live or other versions found.</span>';
  $('#f-len').value = f.minLength;
  $('#f-len-val').textContent = f.minLength ? C.fmtTime(f.minLength * 1000) : 'any';
  $('#f-top').value = f.crowdTop;
  $('#f-top-val').textContent = f.crowdTop || 'no limit';
  const years = [...new Set(songs.map(s => +C.year(s)).filter(Boolean))].sort();
  const opts = (sel, label) => `<option value="0">${label}</option>` + years.map(y => `<option value="${y}" ${sel === y ? 'selected' : ''}>${y}</option>`).join('');
  $('#f-from').innerHTML = opts(f.yearFrom, 'Any');
  $('#f-to').innerHTML = opts(f.yearTo, 'Any');
  $('#f-prefer').value = f.prefer;
  const rel = C.releases(CAT.raw);
  $('#f-albums').innerHTML = rel.map(a => `<button class="ghost ${f.albums.includes(a.id) ? 'on' : ''}" data-album="${esc(a.id)}">${cover(a.imageSmall, '')}<span>${esc(a.name)}<span class="hint">${esc((a.date || '').slice(0, 4))} · ${a.type === 'ep' ? 'EP' : a.group === 'compilation' ? 'compilation' : 'album'}</span></span></button>`).join('');
  $('#f-albums-sum').textContent = f.albums.length ? `${f.albums.length} selected` : 'All';

  const ids = preview(), inPool = new Set(ids), n = ids.length;
  $('#pool-count').textContent = n;
  const est = l => Math.ceil((l * n) / 2).toLocaleString();
  $('#pool-est').textContent = n < 2 ? 'Pick at least 2 songs.' : `About ${est(4)} picks for a rough ranking, ${est(8)} for a solid one. Stop whenever you like.`;
  if (started) {
    const cur = new Set(poolIds);
    const add = ids.filter(id => !cur.has(id)).length, rm = poolIds.filter(id => !inPool.has(id)).length;
    $('#start-btn').textContent = add || rm ? `Apply changes (+${add} / −${rm})` : 'Back to matchups';
  } else {
    $('#start-btn').textContent = 'Start ranking';
  }
  $('#start-btn').disabled = n < 2;
  $('#restart-card').hidden = !started;

  const q = $('#song-search').value.trim().toLowerCase();
  const dupes = songs.filter(s => s.dupeTitle && inPool.has(s.id));
  $('#only-dupes-label').textContent = `Only possible duplicates (${dupes.length} in your pool)`;
  let list = $('#only-dupes').checked
    ? songs.filter(s => s.dupeTitle).sort((a, b) => a.base.localeCompare(b.base) || a.duration - b.duration)
    : songs;
  if (q) list = list.filter(s => (s.name + ' ' + s.versions.map(v => v.album.name).join(' ')).toLowerCase().includes(q));
  $('#song-list').innerHTML = list.map(s => `<li class="clickable ${inPool.has(s.id) ? '' : 'off'}" data-song="${s.id}">${cover(s.album.imageSmall || s.album.image)}
    <div class="t-main"><div class="t-name">${esc(s.name)}${badges(s)}</div><div class="t-sub">${esc(songSub(s))} · ${C.fmtTime(s.duration)}</div></div>
    <input type="checkbox" data-toggle="${s.id}" ${inPool.has(s.id) ? 'checked' : ''} aria-label="Include ${esc(s.name)}"></li>`).join('')
    || '<li><span></span><span class="hint">No songs match.</span></li>';
}
$('#song-search').addEventListener('input', () => renderSongs());
$('#only-dupes').onchange = () => renderSongs();

function togglePool(id, on) {
  const s = song(id), f = S.filters;
  const ids = s.versions.map(v => v.id);
  f.include = f.include.filter(x => !ids.includes(x));
  f.exclude = f.exclude.filter(x => !ids.includes(x));
  // Only record an override when it differs from what the filters would do on their own.
  const byFilter = C.poolFor(songs, { ...f }, idx).includes(id);
  if (on !== byFilter) (on ? f.include : f.exclude).push(id);
}
$('#song-list').addEventListener('click', e => {
  const t = e.target.closest('[data-toggle]');
  if (t) { e.stopPropagation(); togglePool(t.dataset.toggle, t.checked); save(); renderSongs(); return; }
  const id = e.target.closest('[data-song]')?.dataset.song;
  if (id) showSong(id);
});

$('#start-btn').onclick = () => {
  const ids = preview();
  if (ids.length < 2) return;
  if (!S.pool) {
    S.pool = ids;
    S.picks = [];
    S.current = null;
  } else {
    const before = new Set(poolIds);
    const add = ids.filter(id => !before.has(id)).length;
    S.pool = ids;
    if (add) toast(`${add} new song${add > 1 ? 's' : ''} start at ${Elo.START} and get matched up first.`);
  }
  rebuild();
  save();
  show('play');
};
$('#restart').onclick = () => {
  if (!confirm(`Throw away all ${S.picks.length.toLocaleString()} picks for ${artistName()} and start a new ranking?`)) return;
  S.pool = null; S.picks = []; S.current = null;
  rebuild();
  save();
  show('songs');
  toast('Fresh start. Choose your songs and hit Start ranking.');
};
$('#backup-first').onclick = e => { e.preventDefault(); downloadBackup(); };

$('#add-link-btn').onclick = async () => {
  const m = $('#add-link').value.match(/deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?track\/(\d+)/i);
  if (!m) return toast('Paste a link like https://www.deezer.com/track/… (open short links in your browser first to get the full one)', true);
  try {
    const t = await dz.fetchTrack(m[1]);
    if (!t.artists.some(a => a.id === S.artist.id)) toast(`Heads up: Deezer doesn't credit ${artistName()} on "${t.name}". Added anyway.`);
    if (!CAT.raw.some(x => x.id === t.id)) { CAT.raw.push(t); await store.putCatalog(S.artist.id, CAT); }
    if (!S.manual.includes(t.id)) S.manual.push(t.id);
    rebuild();
    togglePool(sid(t.id), true);
    if (S.pool && !poolIds.includes(sid(t.id))) S.pool.push(t.id);
    rebuild();
    save();
    $('#add-link').value = '';
    renderSongs();
    toast(`Added "${t.name}"`);
  } catch (e) { toast(e.message, true); }
};

// ---------- players (30-second Deezer previews) ----------

const players = (() => {
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const P = {};
  for (const side of ['a', 'b']) {
    const audio = new Audio();
    audio.preload = 'auto';
    const p = P[side] = { audio, id: null, retried: false };
    const el = () => $(`.side[data-side=${side}] .player`);
    p.el = el;
    const tick = () => {
      const e = el(); if (!e) return;
      const d = audio.duration || 30;
      e.querySelector('.pbar > div').style.width = (100 * audio.currentTime / d) + '%';
      e.querySelector('.pclock').textContent = `${fmt(audio.currentTime)} / ${fmt(d)}`;
    };
    audio.addEventListener('timeupdate', tick);
    audio.addEventListener('loadedmetadata', tick);
    audio.addEventListener('play', () => { el()?.classList.add('playing'); P[side === 'a' ? 'b' : 'a'].audio.pause(); });
    audio.addEventListener('pause', () => el()?.classList.remove('playing'));
    audio.addEventListener('ended', () => { audio.currentTime = 0; tick(); });
    // Preview links are signed and expire; if one has, swap in a fresh link once.
    audio.addEventListener('error', async () => {
      const id = p.id;
      if (!id || p.retried || !audio.getAttribute('src')) return;
      p.retried = true;
      const url = await dz.previewUrl(id, true).catch(() => '');
      if (p.id !== id) return;
      if (url) { audio.src = url; status(side, 'Preview refreshed, press play again'); }
      else empty(side, 'Preview unavailable');
    });
  }
  function status(side, text) { const e = P[side].el(); if (e) e.querySelector('.pstatus').textContent = text; }
  function empty(side, text) { P[side].el()?.classList.add('empty'); status(side, text); }

  async function set(side, s) {
    const p = P[side];
    p.id = s.id;
    p.retried = false;
    p.audio.pause();
    p.audio.removeAttribute('src');
    p.audio.load();
    empty(side, 'Loading preview…');
    const url = await dz.previewUrl(s.id).catch(() => '');
    if (p.id !== s.id) return;
    if (!url) return empty(side, 'No preview on Deezer');
    // Set the source ahead of time so a tap can start playback straight away (mobile needs that).
    p.audio.src = url;
    p.el()?.classList.remove('empty');
    status(side, '');
  }
  return {
    set,
    toggle(side) {
      const a = P[side].audio;
      if (!a.getAttribute('src')) return;
      if (a.paused) a.play().catch(() => status(side, "Couldn't play, try again")); else a.pause();
    },
    seek(side, frac) { const a = P[side].audio; if (a.getAttribute('src') && a.duration) a.currentTime = frac * a.duration; },
    pauseAll() { P.a.audio.pause(); P.b.audio.pause(); },
  };
})();

// ---------- matchups ----------

function playerHtml(s, side) {
  const spotify = 'https://open.spotify.com/search/' + encodeURIComponent(`${s.name.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '')} ${s.artists[0]?.name || ''}`.trim());
  return `<div class="player empty">
    <button class="play" data-play="${side}" aria-label="Play preview"></button>
    <div class="ptrack"><div class="pbar" data-seek="${side}"><div></div></div><div class="ptime"><span class="pstatus">Loading preview…</span><span class="pclock">0:00 / 0:30</span></div></div>
    <div class="plinks"><a href="${esc(dz.trackLink(s.id))}" target="_blank" rel="noopener">Deezer</a><a href="${esc(spotify)}" target="_blank" rel="noopener">Spotify</a></div>
  </div>`;
}
function sideHtml(s, side) {
  const r = R.get(s.id);
  return `<div class="art"><img src="${esc(s.album.image)}" alt=""></div>
    <div class="meta">
      <h2>${esc(s.name)}</h2>
      <p>${esc(C.artistLine(s))}</p>
      <p>${esc([s.album.name, C.year(s)].filter(Boolean).join(' · '))}</p>
      <p class="record">${r && r.g ? `${r.w}–${r.l}${r.t ? '–' + r.t : ''} so far` : 'First matchup'}</p>
    </div>
    ${playerHtml(s, side)}
    <button class="pick primary big" data-pick="${side}">This one <kbd>${side === 'a' ? '←' : '→'}</kbd></button>`;
}

const undoStack = [];
let shownPair = '';
function ensurePair() {
  const cur = S.current && S.current.map(sid);
  const valid = cur && cur.every(id => R.has(id)) && cur[0] !== cur[1];
  if (!valid) {
    const last = S.picks[S.picks.length - 1];
    S.current = Elo.nextPair(R, { avoid: last ? [sid(last[0]), sid(last[1])] : [] });
    save();
    return S.current;
  }
  return cur;
}

function renderPlay() {
  if (!S?.pool) return show('songs');
  const pr = Elo.progress(R, S.picks.length);
  $('#lvl-label').textContent = pr.label;
  $('#lvl-detail').textContent = `${S.picks.length.toLocaleString()} picks · ${R.size} songs · ${fmt1(pr.avg)} matchups each` +
    (pr.next ? ` · ${pr.picksToNext.toLocaleString()} more to "${pr.next.label}"` : '');
  $('#lvl-bar').style.width = Math.min(100, pr.frac * 100) + '%';
  $('#undo-btn').disabled = !S.picks.length;
  const pair = ensurePair();
  if (!pair) return;
  const key = pair.join();
  pair.forEach((id, i) => {
    const side = i ? 'b' : 'a';
    const el = $(`.side[data-side=${side}]`);
    el.classList.remove('chosen');
    el.innerHTML = sideHtml(song(id), side);
  });
  shownPair = key;
  players.set('a', song(pair[0]));
  players.set('b', song(pair[1]));
}

function choose(w) {
  if (view !== 'play' || !S.current) return;
  const [a, b] = S.current.map(sid);
  undoStack.push(S.current);
  S.picks.push([a, b, w === 'a' ? 1 : w === 'b' ? 0 : 0.5]);
  if (w !== 't') $(`.side[data-side=${w}]`).classList.add('chosen');
  S.current = null;
  rebuild();
  save();
  setTimeout(renderPlay, w === 't' ? 0 : 140);
}
function skip() {
  if (!S.current) return;
  S.current = Elo.nextPair(R, { avoid: S.current.map(sid) });
  save();
  renderPlay();
}
function undo() {
  if (!S.picks.length) return toast('Nothing to undo');
  const [a, b] = S.picks.pop();
  S.current = undoStack.pop() || [a, b];
  rebuild();
  save();
  renderPlay();
  toast('Undone');
}
$('#matchup').addEventListener('click', e => {
  const play = e.target.closest('[data-play]')?.dataset.play;
  if (play) return players.toggle(play);
  const bar = e.target.closest('[data-seek]');
  if (bar) { const r = bar.getBoundingClientRect(); return players.seek(bar.dataset.seek, Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))); }
  const p = e.target.closest('[data-pick]')?.dataset.pick;
  if (p) choose(p);
});
$('#tie-btn').onclick = () => choose('t');
$('#skip-btn').onclick = skip;
$('#undo-btn').onclick = undo;
document.addEventListener('keydown', e => {
  if (view !== 'play' || e.target.matches?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey || $('#song-dlg').open) return;
  const act = {
    arrowleft: () => choose('a'), 1: () => choose('a'),
    arrowright: () => choose('b'), 2: () => choose('b'),
    arrowdown: () => choose('t'), t: () => choose('t'),
    s: skip, z: undo, backspace: undo,
    a: () => players.toggle('a'), d: () => players.toggle('b'),
  }[e.key.toLowerCase()];
  if (act) { e.preventDefault(); act(); }
});

// ---------- ranking ----------

let rankMode = 'songs';
$('#rank-mode').onclick = e => { const v = e.target.dataset.v; if (v) { rankMode = v; renderRank(); } };
$('#rank-search').addEventListener('input', () => renderRank());

function albumRanking(order) {
  const groups = new Map();
  order.forEach((id, i) => {
    const s = song(id), k = s.album.id;
    if (!groups.has(k)) groups.set(k, { album: s.album, ids: [], ranks: [] });
    groups.get(k).ids.push(id);
    groups.get(k).ranks.push(i + 1);
  });
  const rows = [...groups.values()].filter(g => g.ids.length >= 3).map(g => ({
    ...g, avg: g.ids.reduce((a, id) => a + R.get(id).r, 0) / g.ids.length,
  }));
  const loose = [...groups.values()].filter(g => g.ids.length < 3).reduce((a, g) => a + g.ids.length, 0);
  return { rows: rows.sort((a, b) => b.avg - a.avg), loose };
}

function renderRank() {
  if (!S?.pool) return show('songs');
  const order = myOrder();
  const crowd = ranksOf(crowdOrder(poolIds));
  const pr = Elo.progress(R, S.picks.length);
  for (const b of $$('#rank-mode button')) b.classList.toggle('on', b.dataset.v === rankMode);
  $('#rank-search').hidden = rankMode !== 'songs';
  if (rankMode === 'albums') {
    const { rows, loose } = albumRanking(order);
    $('#rank-summary').textContent = `Albums and EPs ranked by the average rating of their songs in your ranking (3 or more songs).${loose ? ` ${loose} songs on singles and smaller releases aren't counted.` : ''}`;
    $('#rank-list').innerHTML = rows.map((g, i) => {
      const best = song(g.ids[0]);
      return `<li><span class="pos">${i + 1}</span>${cover(g.album.imageSmall || g.album.image)}
        <div class="t-main"><div class="t-name">${esc(g.album.name)}</div><div class="t-sub">${esc((g.album.date || '').slice(0, 4))} · ${g.ids.length} songs · best: ${esc(best.name)} (#${g.ranks[0]})</div></div>
        <div class="t-right"><b>${Math.round(g.avg)}</b></div></li>`;
    }).join('') || '<li><span></span><span></span><span class="hint">No album has 3 songs in your ranking yet.</span></li>';
    return;
  }
  $('#rank-summary').textContent = `${order.length} songs · ${S.picks.length.toLocaleString()} picks · ${pr.label.toLowerCase()} (${fmt1(pr.avg)} matchups each). Arrows show where the crowd has them. Tap a song to add a hot take.`;
  const q = $('#rank-search').value.trim().toLowerCase();
  $('#rank-list').innerHTML = order.map((id, i) => {
    const s = song(id), r = R.get(id), note = noteFor(s);
    if (q && !(s.name + ' ' + s.album.name).toLowerCase().includes(q)) return '';
    return `<li class="clickable" data-song="${id}"><span class="pos">${i + 1}</span>${cover(s.album.imageSmall || s.album.image)}
      <div class="t-main"><div class="t-name">${esc(s.name)}</div><div class="t-sub">${esc([s.album.name, C.year(s)].filter(Boolean).join(' · '))} · ${r.w}–${r.l}${r.t ? '–' + r.t : ''}</div>${note ? `<div class="t-take">“${esc(note)}”</div>` : ''}</div>
      <div class="t-right"><b>${Math.round(r.r)}</b> ${deltaHtml(i + 1, crowd.get(id))}</div></li>`;
  }).join('');
}
$('#rank-list').addEventListener('click', e => { const id = e.target.closest('[data-song]')?.dataset.song; if (id) showSong(id); });

// ---------- compare ----------

let cmpWith = 'crowd';
const artistFriends = () => friends.filter(f => f.artist.id === S.artist.id);
const friendOrder = f => resolve(f.ids);
const friendLabel = f => f.name || 'Someone';

function tilesHtml(tiles) {
  return `<div class="stat-tiles">${tiles.map(([n, l]) => `<div class="tile"><div class="num">${n}</div><div class="lbl">${esc(l)}</div></div>`).join('')}</div>`;
}
function diffRows(rows, labelA, labelB, who) {
  return rows.map(({ id, a, b }) => {
    const s = song(id);
    return `<li class="clickable" data-song="${id}">${cover(s.album.imageSmall || s.album.image)}
      <div class="t-main"><div class="t-name">${esc(s.name)}</div><div class="t-sub">${esc(labelA)} #${a} · ${esc(labelB)} #${b}</div></div>
      <div class="t-right">${deltaHtml(a, b, who)}</div></li>`;
  }).join('') || '<li><span></span><span class="hint">None.</span></li>';
}
function versusHtml(mine, other, otherLabel, intro) {
  const ag = agreement(mine, other);
  if (!ag) return '<p class="hint">Not enough songs in common to compare.</p>';
  const [youHigher, themHigher] = disagreements(ag);
  const top = 25, inBoth = new Set(mine.filter(id => ag.ra.has(id)).slice(0, top).filter(id => other.filter(x => ag.ra.has(x)).slice(0, top).includes(id)));
  const col = (title, order) => `<div><h3>${esc(title)}</h3>${order.filter(id => ag.ra.has(id)).slice(0, top).map((id, i) =>
    `<div class="sbs-row ${inBoth.has(id) ? 'match' : ''}"><span class="n">${i + 1}</span><span class="name">${esc(song(id).name)}</span></div>`).join('')}</div>`;
  const theirOne = other.find(id => ag.ra.has(id));
  return `${intro ? `<p class="hint">${intro}</p>` : ''}
    ${tilesHtml([[ag.pct + '%', 'rank agreement'], [fmt1(ag.gap), 'places apart on average'], [`${ag.top10}/10`, 'of your top 10 are in theirs'], [esc(song(theirOne).name), `is ${otherLabel === 'The crowd' ? "the crowd's" : otherLabel + "'s"} #1`]])}
    ${S.picks.length < R.size ? `<p class="hint">Heads up: with ${S.picks.length} picks for ${R.size} songs your ranking is still rough, so this will move as you pick.</p>` : ''}
    <div class="cols">
      <div class="card"><h2>You rate higher</h2><ul class="plist">${diffRows(youHigher, 'You', otherLabel === 'The crowd' ? 'Crowd' : otherLabel, otherLabel === 'The crowd' ? 'crowd' : otherLabel)}</ul></div>
      <div class="card"><h2>${esc(otherLabel)} rates higher</h2><ul class="plist">${diffRows(themHigher, 'You', otherLabel === 'The crowd' ? 'Crowd' : otherLabel, otherLabel === 'The crowd' ? 'crowd' : otherLabel)}</ul></div>
    </div>
    <div class="card scatter"><h2>Every song, your rank vs ${otherLabel === 'The crowd' ? "the crowd's" : esc(otherLabel) + "'s"}</h2>
      <p class="hint">On the diagonal you agree. Above it, you rank the song higher. Tap a dot for the song.</p>
      ${scatterSvg(mine.filter(id => ag.ra.has(id)), ag.ra, ag.rb, { xLabel: otherLabel === 'The crowd' ? 'Crowd' : otherLabel, yLabel: 'You', name: id => song(id).name })}</div>
    <div class="card"><h2>Top 25 side by side</h2><p class="hint">Green: in both top 25s.</p><div class="side-by-side">${col('You', mine)}${col(otherLabel, other)}</div></div>`;
}

function groupHtml() {
  const fr = artistFriends();
  const sel = S.groupSel || (S.groupSel = { me: true, ...Object.fromEntries(fr.map(f => [f.key, true])) });
  const members = [...(S.picks.length ? [{ key: 'me', label: 'You', order: myOrder() }] : []), ...fr.map(f => ({ key: f.key, label: friendLabel(f), order: friendOrder(f) }))];
  const on = members.filter(m => sel[m.key] !== false);
  const boxes = `<div class="members">${members.map(m => `<label><input type="checkbox" data-member="${esc(m.key)}" ${sel[m.key] !== false ? 'checked' : ''}> ${esc(m.label)}</label>`).join('')}</div>`;
  if (on.length < 2) return boxes + '<p class="hint">Pick at least two people to blend.</p>';
  const { order, divisive } = consensus(on.map(m => m.order));
  const rankIn = on.map(m => ranksOf(m.order));
  const list = order.slice(0, 50).map((r, i) => {
    const s = song(r.id);
    return `<li class="clickable" data-song="${r.id}"><span class="pos">${i + 1}</span>${cover(s.album.imageSmall || s.album.image)}
      <div class="t-main"><div class="t-name">${esc(s.name)}</div><div class="t-sub">${on.map((m, k) => `${esc(m.label)} #${rankIn[k].get(r.id) ?? '–'}`).join(' · ')}</div></div><div></div></li>`;
  }).join('');
  const div = divisive.map(r => {
    const s = song(r.id);
    return `<li class="clickable" data-song="${r.id}">${cover(s.album.imageSmall || s.album.image)}
      <div class="t-main"><div class="t-name">${esc(s.name)}</div><div class="t-sub">${on.map((m, k) => `${esc(m.label)} #${rankIn[k].get(r.id) ?? '–'}`).join(' · ')}</div></div><div></div></li>`;
  }).join('');
  const matrix = `<table class="matrix"><tr><th></th>${on.map(m => `<th>${esc(m.label)}</th>`).join('')}</tr>${on.map(a => `<tr><th>${esc(a.label)}</th>${on.map(b => {
    if (a === b) return '<td>–</td>';
    const ag = agreement(a.order, b.order);
    return `<td>${ag ? ag.pct + '%' : '?'}</td>`;
  }).join('')}</tr>`).join('')}</table>`;
  return `${boxes}
    <div class="cols">
      <div class="card"><h2>Group ranking</h2><p class="hint">Each song's average position across everyone who ranked it (songs at least half the group ranked).</p><ol class="plist ranked">${list}</ol></div>
      <div>
        <div class="card"><h2>Most divisive</h2><p class="hint">Where you disagree the most.</p><ul class="plist">${div || '<li><span></span><span class="hint">Nothing yet.</span></li>'}</ul></div>
        <div class="card"><h2>Who agrees with whom</h2>${matrix}</div>
      </div>
    </div>`;
}

function renderCompare() {
  if (!S?.pool) return show('songs');
  const fr = artistFriends();
  const opts = [['crowd', 'The crowd'], ...fr.map(f => [f.key, friendLabel(f)]), ...(fr.length ? [['group', 'Group ranking']] : [])];
  if (!opts.some(([k]) => k === cmpWith)) cmpWith = 'crowd';
  $('#cmp-pick').innerHTML = opts.map(([k, l]) => `<button class="${k === cmpWith ? 'on' : ''}" data-cmp="${esc(k)}">${esc(l)}</button>`).join('') +
    (fr.length ? '' : '<span class="hint">&nbsp;Open a friend\'s shared link and save it to compare with them here.</span>');
  const mine = myOrder();
  if (cmpWith === 'group') { $('#cmp-body').innerHTML = groupHtml(); return; }
  if (cmpWith === 'crowd') {
    $('#cmp-body').innerHTML = versusHtml(mine, crowdOrder(poolIds), 'The crowd',
      'The crowd is Deezer popularity: what people stream most right now. Songs you rate higher are your hidden gems; songs the crowd rates higher are the ones you think are overplayed.');
    return;
  }
  const f = fr.find(x => x.key === cmpWith);
  const takes = Object.entries(f.notes || {}).map(([tid, text]) => ({ s: song(sid(tid)), text })).filter(x => x.s);
  $('#cmp-body').innerHTML = versusHtml(mine, friendOrder(f), friendLabel(f), `${esc(friendLabel(f))} ranked ${f.ids.length} songs on ${esc(f.date || '?')}.`) +
    (takes.length ? `<div class="card"><h2>${esc(friendLabel(f))}'s hot takes</h2><ul class="takes">${takes.map(x => `<li><b>${esc(x.s.name)}</b>: <q>${esc(x.text)}</q></li>`).join('')}</ul></div>` : '');
}
$('#cmp-pick').onclick = e => { const k = e.target.closest('[data-cmp]')?.dataset.cmp; if (k) { cmpWith = k; renderCompare(); } };
$('#cmp-body').addEventListener('click', e => {
  const m = e.target.closest('[data-member]');
  if (m) { S.groupSel[m.dataset.member] = m.checked; save(); renderCompare(); return; }
  const id = e.target.closest('[data-song]')?.getAttribute('data-song');
  if (id) showSong(id);
});

// ---------- share ----------

function myLink() {
  const order = myOrder();
  const notes = {};
  for (const id of order) { const n = noteFor(song(id)); if (n) notes[id] = n; }
  return shareUrl({ artist: S.artist, ids: order, name: me.name, date: today(), notes });
}
const shareTitle = n => `${me.name ? me.name + "'s" : 'My'} top ${n} ${artistName()} songs`;

let imgCanvas = null, imgSeq = 0;
async function renderImg() {
  const seq = ++imgSeq, n = S.imgN, order = myOrder();
  for (const b of $$('#img-n button')) b.classList.toggle('on', +b.dataset.v === n);
  $('#img-preview').style.opacity = 0.4;
  const ag = agreement(order, crowdOrder(poolIds));
  const c = await renderImage({
    rows: order.map(id => { const s = song(id); return { name: s.name, sub: [s.album.name, C.year(s)].filter(Boolean).join(' · '), image: s.album.image }; }),
    n, title: shareTitle(Math.min(n, order.length)),
    subtitle: `Ranked head to head · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    footer: `ellioshow1.github.io/song-ranker${ag ? ` · ${ag.pct}% agreement with the crowd` : ''}`,
  });
  if (seq !== imgSeq) return;
  imgCanvas = c;
  $('#img-preview').src = c.toDataURL('image/png');
  $('#img-preview').style.opacity = 1;
}

function renderShare() {
  if (!S?.pool) return show('songs');
  $('#share-name').value = me.name;
  $('#link-len').textContent = `(${myLink().length.toLocaleString()} characters.)`;
  renderImg();
  $('#sp-connect').hidden = sp.isLoggedIn();
  $('#sp-save').hidden = !sp.isLoggedIn();
  if (!$('#pl-name').value || $('#pl-name').dataset.artist !== S.artist.id) {
    $('#pl-name').value = `${artistName()}: Every Song Ranked`;
    $('#pl-name').dataset.artist = S.artist.id;
    $('#pl-count').value = Math.min(poolIds.length, 50);
  }
  $('#pl-count').max = poolIds.length;
  $('#pl-status').innerHTML = S.playlist ? `Last saved: <a href="${esc(S.playlist.url)}" target="_blank" rel="noopener">open playlist</a>. Saving again overwrites it.` : '';
}
$('#share-name').addEventListener('change', () => { me.name = $('#share-name').value.trim(); store.write('me', me); renderShare(); });
$('#img-n').onclick = e => { const v = +e.target.dataset.v; if (v) { S.imgN = v; save(); renderImg(); } };
$('#copy-link').onclick = () => copy(myLink(), 'Link copied');
$('#share-link').onclick = async () => {
  const url = myLink();
  if (navigator.share) {
    try { await navigator.share({ title: shareTitle(10), text: `My ${artistName()} ranking. Make yours and compare:`, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url, 'Link copied');
};
$('#copy-text').onclick = () => copy(
  [shareTitle(25)].concat(myOrder().slice(0, 25).map((id, i) => { const s = song(id), n = noteFor(s); return `${i + 1}. ${s.name}${n ? ` (“${n}”)` : ''}`; })).concat(['', myLink()]).join('\n'),
  'Copied your top 25');
async function imageFile() {
  if (!imgCanvas) await renderImg();
  const blob = await canvasBlob(imgCanvas);
  return new File([blob], `${slug(artistName())}-top-${S.imgN}.png`, { type: 'image/png' });
}
$('#dl-img').onclick = async () => {
  const f = await imageFile();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f);
  a.download = f.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#share-img').onclick = async () => {
  const f = await imageFile();
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: shareTitle(S.imgN), text: myLink() }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  $('#dl-img').click();
  toast("This browser can't share images directly, so it was downloaded instead.");
};

// Spotify export: each song is matched once (by ISRC) and remembered.
const sentence = m => (/[.!?]$/.test(m) ? m : m + '.');
$('#sp-connect-btn').onclick = () => show('connect');
$('#sp-logout').onclick = () => { sp.logout(); renderShare(); };
$('#save-pl').onclick = async () => {
  const btn = $('#save-pl'), status = $('#pl-status');
  btn.disabled = true;
  try {
    const order = myOrder();
    const n = Math.max(1, Math.min(order.length, Math.floor(+$('#pl-count').value) || order.length));
    const picked = order.slice(0, n).map(song);
    const todo = picked.filter(s => !(s.id in S.spotify));
    for (const [i, s] of todo.entries()) {
      status.textContent = `Finding songs on Spotify: ${i + 1} of ${todo.length}…`;
      S.spotify[s.id] = await sp.matchTrack(s);
      if (i % 10 === 9) save();
    }
    save();
    const uris = picked.map(s => S.spotify[s.id]).filter(Boolean);
    const missing = picked.filter(s => !S.spotify[s.id]);
    if (!uris.length) throw new Error('None of those songs could be found on Spotify');
    status.textContent = 'Saving to Spotify…';
    S.playlist = await sp.savePlaylist({
      playlistId: S.playlist?.id,
      name: $('#pl-name').value.trim() || `${artistName()}: Every Song Ranked`,
      description: `${artistName()} songs, ranked head to head: top ${n} of ${order.length}, ${S.picks.length} picks. Updated ${new Date().toLocaleDateString()}.`,
      uris,
    });
    save();
    status.innerHTML = `Saved ${uris.length} songs in order. <a href="${esc(S.playlist.url)}" target="_blank" rel="noopener">Open in Spotify</a>` +
      (missing.length ? ` Not found on Spotify (${missing.length}): ${esc(missing.slice(0, 5).map(s => s.name).join(', '))}${missing.length > 5 ? '…' : ''}.` : '');
  } catch (e) {
    console.error(e);
    save();
    status.textContent = sentence(e.message) + ' Songs already found are remembered, so trying again carries on from there.';
  } finally { btn.disabled = false; }
};

function renderConnect() {
  $('#redirect-uri').textContent = sp.redirectUri();
  $('#client-id').value = sp.getClientId();
  $('#shared-login').hidden = !sp.sharedClientId;
  $('#own-app').open = !sp.sharedClientId;
}
$('#copy-redirect').onclick = () => copy(sp.redirectUri(), 'Copied');
$('#connect-btn').onclick = () => {
  const id = $('#client-id').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) return toast("That doesn't look like a Client ID (32 letters and numbers).", true);
  store.write('returnTo', S?.artist.id || '');
  sp.startLogin(id);
};
$('#shared-login-btn').onclick = () => { store.write('returnTo', S?.artist.id || ''); sp.startLogin(sp.sharedClientId); };
$('#connect-back').onclick = () => show(S?.pool ? 'share' : 'home');

// Backups: the state for one artist (the catalog is rescanned on restore).
function downloadBackup() {
  download(`${slug(artistName())}-song-ranker-${today()}.json`, JSON.stringify({ app: 'song-ranker', v: 1, state: S }), 'application/json');
}
$('#export-json').onclick = downloadBackup;
$('#import-json').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    let artist;
    if (data.app === 'song-ranker' && data.state?.artist) {
      artist = data.state.artist;
      store.write('r.' + artist.id, data.state);
    } else if (data.source === 'deezer' && data.artist) {
      artist = data.artist;          // a backup from the old Deezer edition
      importOld(artist, data);
    } else throw new Error("that isn't a Song Ranker backup");
    toast(`Restored your ${artist.name} ranking`);
    await openArtist({ id: String(artist.id), name: artist.name, image: artist.image });
  } catch (err) { toast("Couldn't read that file: " + err.message, true); }
};

// ---------- someone else's ranking ----------

let shared = null;
async function openShared(sh) {
  shared = sh;
  const artist = { id: sh.artist.id, name: sh.artist.name };
  if (S?.artist.id !== artist.id) {
    S = loadState(artist);
    CAT = await store.getCatalog(artist.id);
  }
  if (!CAT) return scan(() => renderShared());
  rebuild();
  renderShared();
}

function renderShared() {
  const sh = shared;
  if (view !== 'shared') return show('shared');
  const ids = resolve(sh.ids);
  const missing = sh.ids.length - ids.length;
  const who = sh.name || 'Someone';
  $('#shared-title').textContent = `${who}'s ${sh.artist.name} ranking`;
  $('#shared-lede').textContent = `${ids.length} songs${sh.date ? ` · ranked ${new Date(sh.date + 'T12:00').toLocaleDateString()}` : ''}${missing ? ` · ${missing} not found in Deezer's current catalog` : ''}. Arrows show where the crowd has them.`;
  const key = (sh.artist.id + '|' + who).toLowerCase();
  const saved = friends.some(f => f.key === key && f.ids.join() === sh.ids.join());
  const mineStarted = !!S.pool && S.picks.length > 0;
  $('#shared-actions').innerHTML = `
    <button class="${saved ? 'ghost' : 'primary'}" id="sh-save" ${saved ? 'disabled' : ''}>${saved ? 'Saved to friends ✓' : 'Save to my friends'}</button>
    <button class="${saved ? 'primary' : 'ghost'}" id="sh-mine">${mineStarted ? 'Compare with mine' : `Rank ${esc(sh.artist.name)} myself`}</button>`;
  const crowd = crowdOrder(ids);
  const vsCrowd = agreement(ids, crowd);
  const tiles = [];
  if (ids.length) tiles.push([esc(song(ids[0]).name), 'is their #1']);
  if (vsCrowd) tiles.push([vsCrowd.pct + '%', 'agreement with the crowd']);
  let mineRanks = null;
  if (mineStarted) {
    const ag = agreement(ids, myOrder());
    if (ag && ag.n >= 5) { tiles.push([ag.pct + '%', `agreement with you (${ag.n} songs in common)`]); mineRanks = ag.rb; }
  }
  $('#shared-tiles').innerHTML = tiles.map(([n, l]) => `<div class="tile"><div class="num">${n}</div><div class="lbl">${esc(l)}</div></div>`).join('');
  const takes = Object.entries(sh.notes).map(([tid, text]) => ({ id: sid(tid), text })).filter(x => x.id);
  $('#shared-takes-card').hidden = !takes.length;
  $('#shared-takes').innerHTML = takes.map(x => `<li><b>#${ids.indexOf(x.id) + 1} ${esc(song(x.id).name)}</b>: <q>${esc(x.text)}</q></li>`).join('');
  const cr = ranksOf(crowd);
  const noteBy = new Map(Object.entries(sh.notes).map(([tid, text]) => [sid(tid), text]));
  $('#shared-list').innerHTML = ids.map((id, i) => {
    const s = song(id), note = noteBy.get(id);
    return `<li class="clickable" data-song="${id}"><span class="pos">${i + 1}</span>${cover(s.album.imageSmall || s.album.image)}
      <div class="t-main"><div class="t-name">${esc(s.name)}</div><div class="t-sub">${esc([s.album.name, C.year(s)].filter(Boolean).join(' · '))}${mineRanks?.get(id) ? ` · you #${mineRanks.get(id)}` : ''}</div>${note ? `<div class="t-take">“${esc(note)}”</div>` : ''}</div>
      <div class="t-right">${deltaHtml(i + 1, cr.get(id))}</div></li>`;
  }).join('');
  const saveFriend = () => {
    friends = friends.filter(f => f.key !== key);
    friends.unshift({ key, artist: { id: sh.artist.id, name: sh.artist.name }, name: who === 'Someone' ? '' : who, date: sh.date, ids: sh.ids, notes: sh.notes, savedAt: Date.now() });
    store.write('friends', friends);
    if (S.groupSel) S.groupSel[key] = true;
  };
  $('#sh-save').onclick = () => {
    saveFriend();
    toast(`Saved. Compare with ${who} any time from your ${sh.artist.name} ranking.`);
    renderShared();
  };
  $('#sh-mine').onclick = () => {
    clearHash();
    if (mineStarted) { if (!saved) saveFriend(); cmpWith = key; show('compare'); }
    else { save(); show(S.pool ? 'play' : 'songs'); }
  };
}
$('#shared-list').addEventListener('click', e => { const id = e.target.closest('[data-song]')?.dataset.song; if (id) showSong(id); });

// ---------- song card: versions, split/merge, hot take ----------

function showSong(id) {
  const s = song(id);
  if (!s) return;
  const dlg = $('#song-dlg');
  const inPool = poolIds.includes(id);
  const r = R.get(id);
  const crowdRank = inPool ? ranksOf(crowdOrder(poolIds)).get(id) : null;
  const myRank = inPool && S.picks.length ? myOrder().indexOf(id) + 1 : null;
  const touched = s.versions.some(v => S.splits.includes(v.id) || S.chosen.includes(v.id) || S.merges.some(m => m.includes(v.id)));
  dlg.innerHTML = `
    <div class="dlg-head">${cover(s.album.image, '')}
      <div><h2>${esc(s.name)}</h2><p class="hint">${esc(songSub(s))} · ${C.fmtTime(s.duration)}</p><div>${badges(s)}</div></div>
    </div>
    <div class="dlg-body">
      <audio controls preload="none" id="dlg-audio"></audio>
      <table class="dlg-stats">
        ${myRank ? `<tr><td>Your rank</td><td>#${myRank} of ${poolIds.length} · Elo ${Math.round(r.r)} · ${r.w}–${r.l}${r.t ? '–' + r.t : ''}</td></tr>` : ''}
        <tr><td>Crowd</td><td>${crowdRank ? `#${crowdRank} in your pool · ` : ''}popularity ${s.rank.toLocaleString()}</td></tr>
        <tr><td>In your ranking</td><td>${inPool ? 'Yes' : 'No'} <button class="link" id="dlg-toggle">${inPool ? 'Remove' : 'Add'}</button></td></tr>
      </table>
      ${S.pool ? `<h3>Your hot take <span class="hint">(shared with your link)</span></h3>
      <textarea id="dlg-note" maxlength="280" placeholder="Criminally underrated. Best bridge on the album…">${esc(noteFor(s))}</textarea>` : ''}
      <h3>Versions (${s.versions.length})</h3>
      <ul class="versions">${s.versions.map(v => `<li class="${v.id === s.id ? 'rep' : ''}">${cover(v.album.imageSmall, '')}
        <div class="t-main"><div class="t-name">${esc(v.album.name)}</div><div class="t-sub">${esc(C.KINDS[v.kind] || 'Added by you')} · ${esc((v.album.date || '').slice(0, 4))} · ${C.fmtTime(v.duration)} · ${esc(v.name)}</div></div>
        <span class="row">${v.id !== s.id ? `<button class="ghost small" data-use="${v.id}">Use this</button>` : ''}${s.versions.length > 1 ? `<button class="link" data-split="${v.id}" title="This isn't the same song">Split off</button>` : ''}</span></li>`).join('')}</ul>
      <h3>Is this the same song as another one in the list?</h3>
      <input type="search" id="dlg-merge" placeholder="Search for the duplicate to merge…" autocomplete="off">
      <ul class="plist" id="dlg-merge-list"></ul>
      <div class="dlg-foot">
        ${touched ? '<button class="link" id="dlg-reset">Undo my version changes for this song</button>' : '<span></span>'}
        <button class="ghost" id="dlg-close">Close</button>
      </div>
    </div>`;
  const after = () => { rebuild(); if (view !== 'shared') save(); refresh(); const again = sid(id) || id; if (dlg.open) showSong(again); };
  $('#dlg-close').onclick = () => dlg.close();
  dz.previewUrl(id).then(u => { if (u) $('#dlg-audio').src = u; }).catch(() => {});
  $('#dlg-toggle').onclick = () => {
    togglePool(id, !inPool);
    if (S.pool) { if (inPool) S.pool = S.pool.filter(t => sid(t) !== id); else S.pool.push(id); }
    after();
  };
  const note = $('#dlg-note');
  if (note) note.onchange = () => {
    for (const v of s.versions) delete S.notes[v.id];
    if (note.value.trim()) S.notes[id] = note.value.trim().slice(0, 280);
    save();
    if (view === 'rank') renderRank();
    toast(note.value.trim() ? 'Hot take saved' : 'Hot take removed');
  };
  dlg.querySelectorAll('[data-use]').forEach(b => b.onclick = () => {
    const ids = s.versions.map(v => v.id);
    S.chosen = S.chosen.filter(x => !ids.includes(x)).concat(b.dataset.use);
    after();
  });
  dlg.querySelectorAll('[data-split]').forEach(b => b.onclick = () => {
    const v = b.dataset.split;
    S.splits.push(v);
    S.chosen = S.chosen.filter(x => x !== v);
    S.merges = S.merges.filter(m => !m.includes(v));
    toast('Split off. It now appears as its own song.');
    after();
  });
  // Songs with the same cleaned-up title are the likely duplicates, so suggest them before any typing.
  const mergeRows = list => list.slice(0, 6).map(o =>
    `<li class="clickable" data-merge="${o.id}">${cover(o.album.imageSmall)}<div class="t-main"><div class="t-name">${esc(o.name)}${badges(o)}</div><div class="t-sub">${esc(songSub(o))} · ${C.fmtTime(o.duration)}</div></div><button class="ghost small">Merge</button></li>`).join('');
  const sameTitle = songs.filter(o => o.id !== id && o.base === s.base);
  $('#dlg-merge-list').innerHTML = mergeRows(sameTitle);
  $('#dlg-merge').oninput = () => {
    const q = $('#dlg-merge').value.trim().toLowerCase();
    $('#dlg-merge-list').innerHTML = mergeRows(q.length < 2 ? sameTitle : songs.filter(o => o.id !== id && o.name.toLowerCase().includes(q)));
  };
  $('#dlg-merge-list').onclick = e => {
    const o = e.target.closest('[data-merge]')?.dataset.merge;
    if (!o) return;
    const other = song(o);
    S.merges.push([id, o]);
    const ids = [...s.versions, ...other.versions].map(v => v.id);
    S.splits = S.splits.filter(x => !ids.includes(x));
    toast(`Merged with "${other.name}". Picks for both now count for one song.`);
    after();
  };
  const reset = $('#dlg-reset');
  if (reset) reset.onclick = () => {
    const ids = s.versions.map(v => v.id);
    S.splits = S.splits.filter(x => !ids.includes(x));
    S.chosen = S.chosen.filter(x => !ids.includes(x));
    S.merges = S.merges.filter(m => !m.some(x => ids.includes(x)));
    after();
  };
  if (!dlg.open) dlg.showModal();
}
$('#song-dlg').addEventListener('click', e => { if (e.target.id === 'song-dlg') e.target.close(); });
$('#song-dlg').addEventListener('close', () => { const a = $('#dlg-audio'); if (a) a.pause(); });

// ---------- boot ----------

async function route() {
  const sh = readShared();
  if (sh) return openShared(sh);
  if (view === 'shared') show(S?.pool ? 'play' : 'home');
}
window.addEventListener('hashchange', route);

async function boot() {
  // Spotify only accepts loopback redirects as an IP, so keep everyone on 127.0.0.1.
  if (location.hostname === 'localhost') return location.replace(location.href.replace('//localhost', '//127.0.0.1'));
  let connected = false;
  try { connected = await sp.handleRedirect(); }
  catch (e) { toast(e.message, true); }
  if (readShared()) return route();
  const back = connected ? store.read('returnTo', '') : '';
  store.remove('returnTo');
  const cur = back || store.read('current', '');
  const known = cur && indexList().find(a => a.id === cur);
  if (known) {
    await openArtist({ id: known.id, name: known.name, image: known.image }, connected ? 'share' : undefined);
    if (connected) toast('Spotify connected. You can save your playlist now.');
    return;
  }
  show('home');
}
boot();

// Exposed for debugging in the console.
window.songRanker = { get state() { return S; }, get songs() { return songs; }, get ratings() { return R; }, get pool() { return poolIds; }, Elo, C };

// Storage. Small state (picks, filters, friends) in localStorage under songRanker.*; scanned
// catalogs, which can be hundreds of KB per artist, in IndexedDB. The older Artist Ranker apps share
// this github.io origin, so their keys (artistRanker.*, deezerRanker.*) are only ever read, never written.

const P = 'songRanker.';

export function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(P + key)) ?? fallback; } catch { return fallback; }
}
export function write(key, value) {
  try { localStorage.setItem(P + key, JSON.stringify(value)); return true; } catch { return false; }
}
export function remove(key) {
  try { localStorage.removeItem(P + key); } catch {}
}

// ---------- catalogs in IndexedDB (falls back to memory if unavailable) ----------

const mem = new Map();
let dbp = null;
function db() {
  dbp ||= new Promise(res => {
    try {
      const req = indexedDB.open('songRanker', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('catalogs');
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
// Resolves with the request's result (undefined for a missing key), or null if storage failed.
async function tx(mode, fn) {
  const d = await db();
  if (!d) return null;
  return new Promise(res => {
    try {
      const t = d.transaction('catalogs', mode);
      const r = fn(t.objectStore('catalogs'));
      t.oncomplete = () => res(r.result);
      t.onerror = t.onabort = () => res(null);
    } catch { res(null); }
  });
}
export async function getCatalog(artistId) {
  return (await tx('readonly', s => s.get(artistId))) || mem.get(artistId) || null;
}
export async function putCatalog(artistId, catalog) {
  mem.set(artistId, catalog);
  await tx('readwrite', s => s.put(catalog, artistId));
}
export async function deleteCatalog(artistId) {
  mem.delete(artistId);
  await tx('readwrite', s => s.delete(artistId));
}

// ---------- the old Deezer edition, read-only ----------

export function oldRankings() {
  try {
    const idx = JSON.parse(localStorage.getItem('deezerRanker.artists')) || [];
    return idx.map(a => {
      const d = JSON.parse(localStorage.getItem('deezerRanker.data.' + a.id)) || {};
      return { artist: d.artist || { id: a.id, name: a.name, image: a.image }, data: d };
    }).filter(x => x.data.t?.matches?.length || x.data.raw?.length);
  } catch {
    return [];
  }
}

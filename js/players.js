/**
 * Player dictionary: /players/nfl is ~5MB, so it is fetched at most once a
 * day, slimmed down to the four fields the board needs, and cached in
 * IndexedDB (localStorage as a fallback). Polling never touches it.
 *
 * Load order:
 *   1. cached copy in this browser (if fresh)
 *   2. data/players.json served locally, if you pre-fetched one
 *   3. the Sleeper API
 */
import { api } from './sleeper.js';
import { store } from './util.js';

const DB_NAME = 'draftroom';
const STORE_NAME = 'cache';
const KEY = 'players-nfl-v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/* ----------------------------------------------------- IndexedDB (tiny) */

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    return undefined;
  });
}

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key) {
  try {
    const db = await openDb();
    try {
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } finally {
      db.close();
    }
  } catch { /* ignore */ }
}

/* ----------------------------------------------------------- slimming */

/** Keep only what the board and reveal card render. */
export function slimPlayers(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;

  for (const [id, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    const pos = typeof p.position === 'string' ? p.position : '';
    const name = typeof p.full_name === 'string' && p.full_name
      ? p.full_name
      : [p.first_name, p.last_name].filter((s) => typeof s === 'string' && s).join(' ');
    if (!name && !pos) continue;
    out[id] = {
      n: name || id,
      p: pos,
      t: typeof p.team === 'string' ? p.team : '',
      j: p.number == null ? '' : String(p.number),
      y: Number.isFinite(p.years_exp) ? p.years_exp : null,
    };
  }
  return out;
}

/* -------------------------------------------------------------- public */

let memo = null;

export const players = {
  /** Look a player up; always returns a renderable record. */
  get(playerId) {
    const rec = memo?.[playerId];
    if (rec) return rec;
    // Team defenses use the team code as the player id (e.g. "SF").
    if (typeof playerId === 'string' && /^[A-Z]{2,4}$/.test(playerId)) {
      return { n: `${playerId} Defense`, p: 'DEF', t: playerId, j: '', y: null };
    }
    return { n: playerId ? `Player ${playerId}` : 'Unknown player', p: '', t: '', j: '', y: null };
  },

  get size() {
    return memo ? Object.keys(memo).length : 0;
  },

  /** Random sample — used by mock mode only. */
  sample(count, positions) {
    const ids = Object.keys(memo ?? {}).filter((id) => {
      const rec = memo[id];
      return rec.t && (!positions || positions.includes(rec.p));
    });
    const picked = [];
    for (let i = 0; i < count && ids.length; i += 1) {
      const idx = Math.floor(Math.random() * ids.length);
      picked.push(ids.splice(idx, 1)[0]);
    }
    return picked;
  },

  /**
   * Ensure the dictionary is loaded. `onStage` reports progress so the UI can
   * explain the one slow fetch. Never throws — a failed load just means the
   * board falls back to the pick metadata Sleeper sends with each pick.
   */
  async ensure({ onStage = () => {} } = {}) {
    if (memo) return memo;

    const meta = store.get('players-meta', null);
    if (meta && Date.now() - meta.at < MAX_AGE_MS) {
      onStage('cache');
      try {
        const cached = await idbGet(KEY);
        if (cached && typeof cached === 'object') {
          memo = cached;
          return memo;
        }
      } catch { /* fall through to network */ }
      const inline = store.get('players-inline', null);
      if (inline) {
        memo = inline;
        return memo;
      }
    }

    onStage('local-file');
    try {
      const res = await fetch('data/players.json', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        // A pre-fetched file may be raw Sleeper output or already slimmed.
        const looksSlim = Object.values(json).some((v) => v && typeof v === 'object' && 'n' in v);
        memo = looksSlim ? json : slimPlayers(json);
        await persist(memo);
        return memo;
      }
    } catch { /* no local file — normal */ }

    onStage('download');
    const raw = await api.getAllPlayers();
    memo = slimPlayers(raw);
    onStage('saving');
    await persist(memo);
    return memo;
  },

  /** Test/mock seam: inject a dictionary without any network access. */
  seed(dict) {
    memo = dict ?? Object.create(null);
    return memo;
  },

  async clearCache() {
    memo = null;
    store.remove('players-meta');
    store.remove('players-inline');
    await idbDelete(KEY);
  },
};

async function persist(dict) {
  const stamp = { at: Date.now(), count: Object.keys(dict).length };
  try {
    await idbSet(KEY, dict);
    store.set('players-meta', stamp);
    return;
  } catch { /* IndexedDB unavailable (private mode, etc.) */ }
  if (store.set('players-inline', dict)) store.set('players-meta', stamp);
}

/**
 * Sleeper read-only API client.
 *
 * The v1 API is public and unauthenticated — no keys, no tokens, nothing
 * secret ever leaves this machine. Every path segment is validated against a
 * strict pattern before it is encoded into a URL, so a malformed id can't be
 * used to reshape the request.
 */
import { isId, isUsername, isSeason } from './util.js';

const BASE = 'https://api.sleeper.app/v1';
const TIMEOUT_MS = 12000;

export class ApiError extends Error {
  constructor(message, { status = 0, retryable = true } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Sleeper serves this API through Cloudflare with `s-maxage` in the hundreds
 * of seconds, so a plain poll can be answered from the edge cache with a
 * response that is already seconds stale — `cache: 'no-store'` only governs
 * *this browser's* cache, never a shared one. Live endpoints therefore get a
 * unique query string per request, which makes the edge treat each poll as its
 * own key and go to origin. Digits and letters only; nothing here is derived
 * from user input.
 */
let bustSeq = 0;
const cacheBuster = () => {
  bustSeq = (bustSeq + 1) % 1e6;
  return `${Date.now().toString(36)}${bustSeq.toString(36)}`;
};

async function getJson(path, { timeout = TIMEOUT_MS, signal, fresh = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const url = `${BASE}${path}${fresh ? `?_=${cacheBuster()}` : ''}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) return null;             // Sleeper's "nothing here"
    if (!res.ok) {
      throw new ApiError(`Sleeper returned ${res.status}`, {
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const text = await res.text();
    if (!text || text === 'null') return null;
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError') throw new ApiError('Request timed out', { status: 0 });
    throw new ApiError('Network error reaching Sleeper', { status: 0 });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const requireId = (value, label) => {
  if (!isId(value)) throw new ApiError(`Invalid ${label}`, { retryable: false });
  return encodeURIComponent(value);
};

export const api = {
  getLeague: (leagueId, opts) => getJson(`/league/${requireId(leagueId, 'league id')}`, opts),
  getUsers: (leagueId, opts) => getJson(`/league/${requireId(leagueId, 'league id')}/users`, opts),
  getRosters: (leagueId, opts) => getJson(`/league/${requireId(leagueId, 'league id')}/rosters`, opts),
  getDrafts: (leagueId, opts) => getJson(`/league/${requireId(leagueId, 'league id')}/drafts`, opts),
  // Polled live during a draft — always bypass the shared edge cache.
  getDraft: (draftId, opts) => getJson(`/draft/${requireId(draftId, 'draft id')}`, { fresh: true, ...opts }),
  getPicks: (draftId, opts) => getJson(`/draft/${requireId(draftId, 'draft id')}/picks`, { fresh: true, ...opts }),
  getState: (opts) => getJson('/state/nfl', opts),

  getUser(username, opts) {
    if (!isUsername(username)) throw new ApiError('Invalid username', { retryable: false });
    return getJson(`/user/${encodeURIComponent(username)}`, opts);
  },

  getUserLeagues(userId, season, opts) {
    if (!isId(userId)) throw new ApiError('Invalid user id', { retryable: false });
    if (!isSeason(season)) throw new ApiError('Invalid season', { retryable: false });
    return getJson(`/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`, opts);
  },

  /** ~5MB payload — fetched at most once a day via players.js. */
  getAllPlayers(opts) {
    return getJson('/players/nfl', { timeout: 90000, ...opts });
  },
};

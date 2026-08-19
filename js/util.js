/** Small shared helpers: DOM, validation, storage. No third-party code. */

export const $ = (sel, root = document) => root.querySelector(sel);

/** Clone a <template> and return its first element child. */
export function fromTemplate(id) {
  const tpl = document.getElementById(id);
  if (!(tpl instanceof HTMLTemplateElement)) throw new Error(`missing template: ${id}`);
  const node = tpl.content.firstElementChild.cloneNode(true);
  return node;
}

/**
 * Set text content safely. Everything user- or API-provided goes through here
 * (or textContent directly) — the app never assigns innerHTML, so remote
 * strings can't become markup.
 */
export function setText(el, value) {
  if (!el) return;
  el.textContent = value == null ? '' : String(value);
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Input validation. Every value that ends up in a URL path is checked
 * against a strict allowlist pattern first, then percent-encoded.
 * ------------------------------------------------------------------ */

const RE_ID = /^[0-9]{6,32}$/;                 // Sleeper league/draft/user ids
const RE_USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;  // Sleeper handles
const RE_PLAYER_ID = /^[A-Za-z0-9]{1,16}$/;    // numeric ids, or team codes for DEF
const RE_TEAM = /^[A-Za-z]{2,4}$/;             // NFL team abbreviation
const RE_AVATAR = /^[A-Za-z0-9]{8,64}$/;       // Sleeper avatar hash
const RE_SEASON = /^(19|20)[0-9]{2}$/;

export const isId = (v) => typeof v === 'string' && RE_ID.test(v);
export const isUsername = (v) => typeof v === 'string' && RE_USERNAME.test(v);
export const isPlayerId = (v) => typeof v === 'string' && RE_PLAYER_ID.test(v);
export const isTeam = (v) => typeof v === 'string' && RE_TEAM.test(v);
export const isAvatar = (v) => typeof v === 'string' && RE_AVATAR.test(v);
export const isSeason = (v) => typeof v === 'string' && RE_SEASON.test(v);

/** Sleeper CDN image URLs, built only from validated tokens. */
export const playerPhotoUrl = (playerId) =>
  isPlayerId(playerId) ? `https://sleepercdn.com/content/nfl/players/${encodeURIComponent(playerId)}.jpg` : '';

export const teamLogoUrl = (team) =>
  isTeam(team) ? `https://sleepercdn.com/images/team_logos/nfl/${encodeURIComponent(team.toLowerCase())}.png` : '';

export const avatarUrl = (avatarId) =>
  isAvatar(avatarId) ? `https://sleepercdn.com/avatars/thumbs/${encodeURIComponent(avatarId)}` : '';

/**
 * Point an <img> at a URL, hiding it if the URL is unusable or the fetch
 * fails, so a broken CDN never leaves a broken-image glyph on the board.
 */
export function setImage(img, url, { onFail } = {}) {
  if (!img) return;
  img.onerror = null;
  if (!url) {
    img.removeAttribute('src');
    img.hidden = true;
    onFail?.();
    return;
  }
  img.hidden = false;
  img.onerror = () => {
    img.hidden = true;
    img.onerror = null;
    onFail?.();
  };
  img.src = url;
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/* ------------------------------------------------------------------ *
 * localStorage wrapper — namespaced, quota-safe, never throws.
 * ------------------------------------------------------------------ */

const NS = 'draftroom:';

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
      return true;
    } catch {
      return false; // quota exceeded or storage disabled — degrade quietly
    }
  },
  remove(key) {
    try { localStorage.removeItem(NS + key); } catch { /* ignore */ }
  },
  clearAll() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith(NS)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

/** Ordinal formatting for round/pick labels. */
export function ordinal(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
  switch (num % 10) {
    case 1: return `${num}st`;
    case 2: return `${num}nd`;
    case 3: return `${num}rd`;
    default: return `${num}th`;
  }
}

export function timeAgo(ms) {
  if (!ms) return '';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

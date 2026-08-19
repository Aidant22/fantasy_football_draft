/**
 * Tiered pick reveals.
 *
 *   tier "full"    — round 1: screen takeover, flash, rays, held ~5s
 *   tier "compact" — round 2+: quick flash + corner banner, gone in ~1.7s
 *   tier "subtle"  — board highlight only (the cell animation still fires)
 *   tier "off"     — nothing but the board update
 *
 * Reveals are queued and played one at a time so a burst of picks (autodraft,
 * or a reconnect after a lull) can never stack overlapping animations. If the
 * queue backs up, tiers are automatically compressed to catch up — the board
 * stays truthful and the recording stays smooth.
 */
import { fromTemplate, setText, setImage, initials, playerPhotoUrl, teamLogoUrl, ordinal, sleep } from './util.js';
import { audio } from './audio.js';

const DUR = {
  full: { in: 900, hold: 3600, out: 380 },
  compact: { in: 430, hold: 1050, out: 300 },
};

export class RevealDirector {
  constructor({ stage, stageBody, toasts, board, getSettings }) {
    this.stage = stage;
    this.stageBody = stageBody;
    this.toasts = toasts;
    this.board = board;
    this.getSettings = getSettings;
    this.queue = [];
    this.running = false;
    this.skipRequested = false;
  }

  /** Which tier a pick gets, given the round and the live intensity setting. */
  tierFor(round, queueDepth = 0) {
    const { intensity } = this.getSettings();
    if (intensity === 'off') return 'off';
    if (intensity === 'subtle') return 'subtle';
    if (queueDepth >= 6) return 'subtle';        // deep backlog: catch up fast
    if (intensity === 'compact') return 'compact';
    if (queueDepth >= 2) return 'compact';       // 2+ waiting: skip the takeover
    return round === 1 ? 'full' : 'compact';
  }

  enqueue(item) {
    this.queue.push(item);
    if (!this.running) this.#drain();
  }

  clear() {
    this.queue.length = 0;
  }

  skip() {
    this.skipRequested = true;
  }

  async #drain() {
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        await this.play(item, this.tierFor(item.view.round, this.queue.length));
      }
    } finally {
      this.running = false;
    }
  }

  /** Play one reveal at an explicit tier (also used by the Preview button). */
  async play(item, tier) {
    const { view } = item;

    if (tier === 'off') {
      this.#land(view, false);   // board still updates, just silently
      return;
    }

    if (tier === 'subtle') {
      audio.tick();
      this.#land(view);
      await this.#wait(120);
      return;
    }

    if (tier === 'compact') {
      audio.sting();
      this.#flash();
      this.#land(view);
      await this.#toast(item);
      return;
    }

    audio.fanfare();
    await this.#takeover(item);
    this.#land(view);
  }

  /* ------------------------------------------------------------ pieces */

  #land(view, animate = true) {
    const cell = this.board?.applyPick(view, { animate });
    if (cell && this.getSettings().autoScroll !== false) {
      this.board.scrollTo(view.round, view.slot);
    }
  }

  #flash() {
    if (this.getSettings().reduceMotion) return;
    const el = document.createElement('div');
    el.className = 'mini-flash';
    document.body.append(el);
    setTimeout(() => el.remove(), 420);
  }

  async #takeover(item) {
    const card = buildCard(item, this.getSettings());
    this.stageBody.replaceChildren(card);
    this.stage.hidden = false;
    this.stage.classList.remove('out');
    void this.stage.offsetWidth;
    this.stage.classList.add('in');
    card.classList.add('sweep');

    const bar = card.querySelector('.reveal-bar-fill');
    this.#runBar(bar, DUR.full.hold + DUR.full.in);

    await this.#wait(DUR.full.in + DUR.full.hold);

    this.stage.classList.remove('in');
    this.stage.classList.add('out');
    await this.#wait(DUR.full.out);
    this.stage.classList.remove('out');
    this.stage.hidden = true;
    this.stageBody.replaceChildren();
  }

  async #toast(item) {
    const card = buildCard(item, this.getSettings());
    card.classList.add('toast-item', 'in');
    this.toasts.append(card);

    const bar = card.querySelector('.reveal-bar-fill');
    this.#runBar(bar, DUR.compact.hold + DUR.compact.in);

    await this.#wait(DUR.compact.in + DUR.compact.hold);
    card.classList.remove('in');
    card.classList.add('out');
    await this.#wait(DUR.compact.out);
    card.remove();
  }

  #runBar(bar, ms) {
    if (!bar) return;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    bar.style.transition = `transform ${ms}ms linear`;
    bar.style.transform = 'scaleX(0)';
  }

  /** Sleep that can be cut short by skip() (Esc during a takeover). */
  async #wait(ms) {
    const step = 60;
    let left = ms;
    while (left > 0) {
      if (this.skipRequested) { this.skipRequested = false; return; }
      const chunk = Math.min(step, left);
      // eslint-disable-next-line no-await-in-loop
      await sleep(chunk);
      left -= chunk;
    }
  }
}

/** Build a reveal card element from a pick view. Shared by both tiers. */
export function buildCard({ view, teamLabel }, settings = {}) {
  const card = fromTemplate('tpl-reveal');
  card.dataset.pos = view.position || '';

  setText(card.querySelector('.reveal-round'), `Round ${view.round}`);
  setText(card.querySelector('.reveal-pick'),
    `${ordinal(view.pickNo)} overall · ${view.round}.${String(view.pickInRound).padStart(2, '0')}`);

  setText(card.querySelector('.drafted-by-text'), teamLabel ? `${teamLabel} select` : 'On the board');
  setText(card.querySelector('.reveal-name'), view.name);
  setText(card.querySelector('.tag.pos'), view.position || '');
  setText(card.querySelector('.tag.team'), view.nflTeam || 'FA');
  setText(card.querySelector('.tag.extra'), view.isKeeper ? 'Keeper' : (view.jersey ? `#${view.jersey}` : ''));

  const photo = card.querySelector('.photo');
  const fallback = card.querySelector('.photo-fallback');
  setText(fallback, initials(view.name));

  const logo = card.querySelector('.logo');
  const showImages = settings.photos !== false;

  if (showImages) {
    setImage(photo, playerPhotoUrl(view.playerId));
    setImage(logo, teamLogoUrl(view.nflTeam));
  } else {
    setImage(photo, '');
    setImage(logo, '');
  }
  return card;
}

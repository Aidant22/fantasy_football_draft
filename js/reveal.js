/**
 * Tiered pick reveals, staged like a pack walkout: the position flashes
 * first, then the club, then the player card itself walks out.
 *
 *   tier "full"    — round 1: screen takeover, three beats, ~5.8s
 *   tier "compact" — round 2+: the same three beats compressed into a corner
 *                    banner, done in ~1.6s
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

/** Beat sheet, in ms. Every number is a wall-clock offset you can tune. */
const BEATS = {
  full: {
    beam: 300,      // dark, light beam grows, riser builds
    posIn: 820,     // POSITION punches in and holds
    posOut: 170,    // …and snaps away (matches the phase-out animation)
    teamIn: 860,    // CLUB badge punches in and holds
    teamOut: 170,
    cardIn: 720,    // card rises out of the light
    hold: 2500,     // card holds for the camera
    out: 420,
  },
  compact: {
    beam: 0,
    posIn: 300,
    posOut: 0,
    teamIn: 300,
    teamOut: 0,
    cardIn: 240,
    hold: 720,
    out: 260,
  },
};

const SPARKS = 16;

export class RevealDirector {
  constructor({ stage, stageFlash, stageWalkout, stageBody, toasts, board, getSettings }) {
    this.stage = stage;
    this.stageFlash = stageFlash;
    this.stageWalkout = stageWalkout;
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

  /** Cut the current reveal short (Esc). */
  skip() {
    this.skipRequested = true;
  }

  async #drain() {
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        // eslint-disable-next-line no-await-in-loop
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
      this.#land(view);
      await this.#miniWalkout(item);
      return;
    }

    await this.#walkout(item);
    this.#land(view);
  }

  /* ------------------------------------------------------------ pieces */

  #land(view, animate = true) {
    const cell = this.board?.applyPick(view, { animate });
    if (cell && this.getSettings().autoScroll !== false) {
      this.board.scrollTo(view.round, view.slot);
    }
  }

  /**
   * Round 1: the full walkout.
   *   beam → POSITION → CLUB → card rises → hold → fade back to the board.
   */
  async #walkout(item) {
    const { view } = item;
    const settings = this.getSettings();
    const beats = settings.reduceMotion ? BEATS.compact : BEATS.full;

    audio.stopAll();   // don't let the previous pick's cue ring under this one

    const wo = fromTemplate('tpl-walkout');
    wo.dataset.pos = view.position || '';
    fillWalkout(wo, view, settings);
    this.stageWalkout.replaceChildren(wo);

    const card = buildCard(item, settings);
    this.stageBody.replaceChildren(card);

    this.stage.dataset.pos = view.position || '';
    this.stage.hidden = false;
    this.stage.classList.remove('out', 'card-in');
    void this.stage.offsetWidth;
    this.stage.classList.add('in');

    // Beat 0 — the light beam builds.
    wo.classList.add('beam-on');
    audio.riser(beats.beam + beats.posIn * 0.35);
    await this.#wait(beats.beam);

    // Beat 1 — POSITION.
    const pos = wo.querySelector('.wo-phase-pos');
    audio.hit(0);
    pos.classList.add('enter');
    await this.#wait(beats.posIn);
    pos.classList.remove('enter');
    pos.classList.add('leave');
    await this.#wait(beats.posOut);

    // Beat 2 — CLUB.
    const team = wo.querySelector('.wo-phase-team');
    audio.hit(1);
    team.classList.add('enter');
    await this.#wait(beats.teamIn);
    team.classList.remove('enter');
    team.classList.add('leave');
    await this.#wait(beats.teamOut);

    // Beat 3 — the card walks out.
    audio.reveal();
    this.#burst();
    wo.classList.add('sparking');
    this.stage.classList.add('card-in');
    card.classList.add('sweep');
    const bar = card.querySelector('.reveal-bar-fill');
    this.#runBar(bar, beats.cardIn + beats.hold);

    await this.#wait(beats.cardIn + beats.hold);

    this.stage.classList.remove('in');
    this.stage.classList.add('out');
    await this.#wait(beats.out);

    this.stage.classList.remove('out', 'card-in');
    this.stage.hidden = true;
    this.stageWalkout.replaceChildren();
    this.stageBody.replaceChildren();
  }

  /**
   * Round 2+: the same three beats, played inside the corner banner. The
   * banner slides in already covered by the walkout overlay, flips
   * position → club, then wipes to expose the card.
   */
  async #miniWalkout(item) {
    const { view } = item;
    const settings = this.getSettings();
    const beats = BEATS.compact;

    audio.stopAll();

    const card = buildCard(item, settings);
    card.classList.add('toast-item', 'in');

    const mini = fromTemplate('tpl-mini-walkout');
    mini.dataset.pos = view.position || '';
    setText(mini.querySelector('.mini-wo-pos'), view.position || '—');
    setText(mini.querySelector('.mini-wo-team-text'), view.nflTeam || 'FA');
    setImage(mini.querySelector('.mini-wo-logo'), settings.photos === false ? '' : teamLogoUrl(view.nflTeam));
    card.append(mini);

    this.toasts.append(card);
    audio.hit(0);
    await this.#wait(beats.posIn);

    mini.dataset.phase = 'team';
    audio.hit(1);
    await this.#wait(beats.teamIn);

    mini.dataset.phase = 'done';
    audio.sting();
    card.classList.add('sweep');
    const bar = card.querySelector('.reveal-bar-fill');
    this.#runBar(bar, beats.cardIn + beats.hold);
    await this.#wait(beats.cardIn + beats.hold);

    card.classList.remove('in');
    card.classList.add('out');
    await this.#wait(beats.out);
    card.remove();
  }

  /** White burst behind the card as it walks out. */
  #burst() {
    if (this.getSettings().reduceMotion || !this.stageFlash) return;
    this.stageFlash.classList.remove('go');
    void this.stageFlash.offsetWidth;
    this.stageFlash.classList.add('go');
  }

  #runBar(bar, ms) {
    if (!bar) return;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    bar.style.transition = `transform ${ms}ms linear`;
    bar.style.transform = 'scaleX(0)';
  }

  /** Sleep that can be cut short by skip() (Esc during a walkout). */
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

/** Fill the position/club phase cards and lay out the spark burst. */
function fillWalkout(wo, view, settings = {}) {
  setText(wo.querySelector('.wo-pos-text'), view.position || '—');
  setText(wo.querySelector('.wo-pos-sub'), positionLabel(view.position));
  setText(wo.querySelector('.wo-team-text'), view.nflTeam || 'Free agent');

  // If the club logo can't load, the ring behind it carries the beat — the
  // abbreviation is already spelled out underneath.
  setImage(wo.querySelector('.wo-logo'), settings.photos === false ? '' : teamLogoUrl(view.nflTeam));

  const sparks = wo.querySelector('.wo-sparks');
  if (sparks && !settings.reduceMotion) {
    for (let i = 0; i < SPARKS; i += 1) {
      const spark = document.createElement('span');
      spark.className = 'wo-spark';
      spark.style.setProperty('--a', `${(360 / SPARKS) * i + (Math.random() * 12 - 6)}deg`);
      spark.style.setProperty('--d', `${180 + Math.random() * 220}px`);
      spark.style.setProperty('--t', `${Math.random() * 160}ms`);
      sparks.append(spark);
    }
  }
}

const POSITION_LABELS = {
  QB: 'Quarterback',
  RB: 'Running back',
  WR: 'Wide receiver',
  TE: 'Tight end',
  K: 'Kicker',
  DEF: 'Team defense',
  DL: 'Defensive line',
  LB: 'Linebacker',
  DB: 'Defensive back',
};

function positionLabel(pos) {
  return POSITION_LABELS[pos] ?? '';
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

  const watermark = card.querySelector('.reveal-watermark');

  if (showImages) {
    setImage(photo, playerPhotoUrl(view.playerId));
    setImage(logo, teamLogoUrl(view.nflTeam));
    setImage(watermark, teamLogoUrl(view.nflTeam));
  } else {
    setImage(photo, '');
    setImage(logo, '');
    setImage(watermark, '');
  }
  return card;
}

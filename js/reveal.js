/**
 * Tiered pick reveals, staged like a pack walkout: the position flashes
 * first, then the club, then the player card itself walks out.
 *
 *   tier "full"    — screen takeover, three beats, ~6s, plus the chime. Used
 *                    through the "full walkout through round" setting.
 *   tier "compact" — the same three beats compressed into a silent corner
 *                    banner, done in ~1.8s
 *   tier "subtle"  — board highlight only (the cell animation still fires)
 *   tier "off"     — nothing but the board update
 *
 * Reveals play one at a time. A takeover runs to completion; any picks that
 * arrive during it queue up and then play as compact banners, which are short
 * enough to drain the backlog faster than picks arrive. cutSeq exists to cut
 * an in-flight reveal on Esc or a reconnect.
 */
import { fromTemplate, setText, setImage, playerPhotoUrl, teamLogoUrl, ordinal, sleep } from './util.js';
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
    /**
     * Bumped to cut whatever is on screen short. Every wait inside a reveal
     * carries the value it started with, so one bump unwinds the whole
     * animation at once instead of just shortening the beat it's sitting in.
     */
    this.cutSeq = 0;
  }

  /** Which tier a pick gets, given the round and the live intensity setting. */
  tierFor(round, queueDepth = 0) {
    const { intensity, showcaseRounds } = this.getSettings();
    if (intensity === 'off') return 'off';
    if (intensity === 'subtle') return 'subtle';
    if (queueDepth >= 6) return 'subtle';        // deep backlog: catch up fast
    if (intensity === 'compact') return 'compact';
    // Anything already waiting means the takeover would make it wait ~6s.
    // Play the 1.8s banner instead so the queue never builds in the first place.
    if (queueDepth >= 1) return 'compact';
    return round <= (showcaseRounds || 1) ? 'full' : 'compact';
  }

  enqueue(item) {
    this.queue.push(item);
    // A takeover already on screen is allowed to finish; whatever piled up
    // behind it then plays as compact banners, which run faster than picks
    // arrive and so drain the backlog.
    if (!this.running) this.#drain();
  }

  clear() {
    this.queue.length = 0;
    this.cutSeq += 1;
  }

  /** Cut the current reveal short (Esc). */
  skip() {
    this.cutSeq += 1;
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
    const seq = this.cutSeq;

    if (tier === 'off') {
      this.#land(view, false);   // board still updates, just silently
      return;
    }

    if (tier === 'subtle') {
      this.#land(view);
      await this.#wait(120, seq);
      return;
    }

    if (tier === 'compact') {
      this.#land(view);
      await this.#miniWalkout(item, seq);
      return;
    }

    // Land in a finally so a cut walkout still leaves the board truthful.
    try {
      await this.#walkout(item, seq);
    } finally {
      this.#land(view);
    }
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
  async #walkout(item, seq = this.cutSeq) {
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

    // Beat 0 — the light beam builds. The chime rides the walkout only.
    wo.classList.add('beam-on');
    audio.riser(beats.beam + beats.posIn * 0.35);
    if (!await this.#wait(beats.beam, seq)) return this.#hideStage();

    // Beat 1 — POSITION.
    const pos = wo.querySelector('.wo-phase-pos');
    pos.classList.add('enter');
    if (!await this.#wait(beats.posIn, seq)) return this.#hideStage();
    pos.classList.remove('enter');
    pos.classList.add('leave');
    if (!await this.#wait(beats.posOut, seq)) return this.#hideStage();

    // Beat 2 — CLUB.
    const team = wo.querySelector('.wo-phase-team');
    team.classList.add('enter');
    if (!await this.#wait(beats.teamIn, seq)) return this.#hideStage();
    team.classList.remove('enter');
    team.classList.add('leave');
    if (!await this.#wait(beats.teamOut, seq)) return this.#hideStage();

    // Beat 3 — the card walks out.
    this.#burst();
    wo.classList.add('sparking');
    this.stage.classList.add('card-in');
    card.classList.add('sweep');
    const bar = card.querySelector('.reveal-bar-fill');
    this.#runBar(bar, beats.cardIn + beats.hold);

    if (!await this.#wait(beats.cardIn + beats.hold, seq)) return this.#hideStage();

    this.stage.classList.remove('in');
    this.stage.classList.add('out');
    await this.#wait(beats.out, seq);

    return this.#hideStage();
  }

  /** Drop the takeover instantly — used at the end, and on every cut. */
  #hideStage() {
    this.stage.classList.remove('in', 'out', 'card-in');
    this.stage.hidden = true;
    this.stageWalkout.replaceChildren();
    this.stageBody.replaceChildren();
  }

  /**
   * Round 2+: the same three beats, played inside the corner banner. The
   * banner slides in already covered by the walkout overlay, flips
   * position → club, then wipes to expose the card.
   */
  async #miniWalkout(item, seq = this.cutSeq) {
    const { view } = item;
    const settings = this.getSettings();
    const beats = BEATS.compact;

    audio.stopAll();   // banners are silent — the chime is the walkout's alone

    const card = buildCard(item, settings);
    card.classList.add('toast-item', 'in');

    const mini = fromTemplate('tpl-mini-walkout');
    mini.dataset.pos = view.position || '';
    setText(mini.querySelector('.mini-wo-pos'), view.position || '—');
    setText(mini.querySelector('.mini-wo-team-text'), view.nflTeam || 'FA');
    setImage(mini.querySelector('.mini-wo-logo'), settings.photos === false ? '' : teamLogoUrl(view.nflTeam));
    card.append(mini);

    this.toasts.append(card);
    if (!await this.#wait(beats.posIn, seq)) return card.remove();

    mini.dataset.phase = 'team';
    if (!await this.#wait(beats.teamIn, seq)) return card.remove();

    mini.dataset.phase = 'done';
    card.classList.add('sweep');
    const bar = card.querySelector('.reveal-bar-fill');
    this.#runBar(bar, beats.cardIn + beats.hold);
    if (!await this.#wait(beats.cardIn + beats.hold, seq)) return card.remove();

    card.classList.remove('in');
    card.classList.add('out');
    await this.#wait(beats.out, seq);
    return card.remove();
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

  /**
   * Sleep in short slices so a cut lands within ~20ms rather than at the end
   * of the beat. Returns false once cutSeq has moved past `seq`, which is the
   * caller's signal to tear down and let the next pick through immediately.
   */
  async #wait(ms, seq) {
    const step = 20;
    let left = ms;
    while (left > 0) {
      if (this.cutSeq !== seq) return false;
      const chunk = Math.min(step, left);
      // eslint-disable-next-line no-await-in-loop
      await sleep(chunk);
      left -= chunk;
    }
    return this.cutSeq === seq;
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

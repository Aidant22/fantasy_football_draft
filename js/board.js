/**
 * The draft board: one column per draft slot, one cell per round.
 * All text goes in with textContent; nothing here builds markup from strings.
 */
import { fromTemplate, setText, setImage, initials, isTeam } from './util.js';
import { players } from './players.js';

const key = (round, slot) => `${round}:${slot}`;

export class Board {
  constructor(rootEl) {
    this.root = rootEl;
    this.cells = new Map();   // "round:slot" -> element
    this.columns = new Map(); // slot -> element
    this.teams = 0;
    this.rounds = 0;
    this.type = 'snake';
    this.reversalRound = 0;
  }

  /**
   * @param {object} cfg
   * @param {number} cfg.teams  number of draft slots
   * @param {number} cfg.rounds number of rounds
   * @param {string} cfg.type   'snake' | 'linear' | 'auction'
   * @param {number} cfg.reversalRound  Sleeper's third-round-reversal setting (0 = off)
   * @param {Map<number, {name:string, owner:string, avatar:string}>} cfg.slotTeams
   */
  render({ teams, rounds, type = 'snake', reversalRound = 0, slotTeams = new Map() }) {
    this.teams = Math.max(1, Number(teams) || 0);
    this.rounds = Math.max(1, Number(rounds) || 0);
    this.type = type;
    this.reversalRound = Number(reversalRound) || 0;
    this.cells.clear();
    this.columns.clear();
    this.root.replaceChildren();

    const frag = document.createDocumentFragment();

    for (let slot = 1; slot <= this.teams; slot += 1) {
      const col = fromTemplate('tpl-column');
      col.dataset.slot = String(slot);
      const info = slotTeams.get(slot) ?? {};

      setText(col.querySelector('.team-name'), info.name || `Team ${slot}`);
      setText(col.querySelector('.owner-name'), info.owner || '');
      setText(col.querySelector('.slot-no'), String(slot));

      const avatar = col.querySelector('.avatar');
      const wrap = col.querySelector('.avatar-wrap');
      setImage(avatar, info.avatar || '', {
        onFail: () => setText(wrap, initials(info.name || `T${slot}`)),
      });
      if (!info.avatar) setText(wrap, initials(info.name || `T${slot}`));

      const cellsWrap = col.querySelector('.col-cells');
      for (let round = 1; round <= this.rounds; round += 1) {
        const cell = fromTemplate('tpl-cell');
        cell.dataset.empty = 'true';
        cell.dataset.round = String(round);
        cell.dataset.slot = String(slot);
        const pickNo = this.pickNoFor(round, slot);
        setText(cell.querySelector('.cell-pick'), `${round}.${String(this.pickInRound(round, slot)).padStart(2, '0')}`);
        cell.setAttribute('aria-label', `Round ${round}, pick ${pickNo}: not made`);
        cellsWrap.append(cell);
        this.cells.set(key(round, slot), cell);
      }

      this.columns.set(slot, col);
      frag.append(col);
    }

    this.root.append(frag);
    this.fit();
  }

  /**
   * Size columns and cells so the whole board fits the window when it can —
   * a full board with no scrolling is what you want on camera. Falls back to
   * horizontal scrolling for very wide leagues or narrow windows.
   */
  fit() {
    const wrap = this.root.parentElement;
    if (!wrap || !this.teams || !this.rounds) return;
    const styles = getComputedStyle(this.root);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const padY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const gap = parseFloat(styles.columnGap) || 8;

    const availW = wrap.clientWidth - padX - gap * (this.teams - 1);
    const colW = Math.min(240, Math.max(150, Math.floor(availW / this.teams)));
    this.root.style.setProperty('--col-w', `${colW}px`);

    const headH = this.root.querySelector('.col-head')?.getBoundingClientRect().height ?? 54;
    const availH = wrap.clientHeight - padY - headH - 6 - 6 * (this.rounds - 1);
    const cellH = Math.min(68, Math.max(44, Math.floor(availH / this.rounds)));
    this.root.style.setProperty('--cell-h', `${cellH}px`);
    this.root.dataset.dense = String(cellH < 54);
    this.root.dataset.narrow = String(colW < 176);
  }

  /** Where a slot sits inside a round, honouring snake / reversal. */
  pickInRound(round, slot) {
    return this.isReversed(round) ? this.teams - slot + 1 : slot;
  }

  pickNoFor(round, slot) {
    return (round - 1) * this.teams + this.pickInRound(round, slot);
  }

  isReversed(round) {
    if (this.type !== 'snake') return false;
    let reversed = round % 2 === 0;
    if (this.reversalRound > 0 && round >= this.reversalRound) reversed = !reversed;
    return reversed;
  }

  /** Inverse of pickNoFor: which cell does overall pick N land in? */
  locate(pickNo) {
    if (!this.teams || pickNo < 1) return null;
    const round = Math.floor((pickNo - 1) / this.teams) + 1;
    const idx = (pickNo - 1) % this.teams;
    const slot = this.isReversed(round) ? this.teams - idx : idx + 1;
    return { round, slot };
  }

  cellFor(round, slot) {
    return this.cells.get(key(round, slot)) ?? null;
  }

  /**
   * Paint a pick into its cell.
   * @returns {HTMLElement|null} the cell, so callers can scroll to it.
   */
  applyPick(view, { animate = false } = {}) {
    const cell = this.cellFor(view.round, view.slot);
    if (!cell) return null;

    cell.dataset.empty = 'false';
    cell.dataset.pos = view.position || '';
    cell.dataset.next = 'false';
    setText(cell.querySelector('.cell-pos'), view.position || '—');
    setText(cell.querySelector('.cell-name'), view.name);
    setText(cell.querySelector('.cell-team'), [view.nflTeam, view.jersey ? `#${view.jersey}` : '']
      .filter(Boolean).join(' · ') || 'Free agent');
    setText(cell.querySelector('.cell-pick'), `${view.round}.${String(view.pickInRound).padStart(2, '0')}`);
    cell.setAttribute('aria-label',
      `Round ${view.round}, pick ${view.pickNo}: ${view.name}, ${view.position || 'unknown position'}, ${view.nflTeam || 'no team'}`);

    if (animate) {
      cell.classList.remove('landed');
      void cell.offsetWidth; // restart the keyframes
      cell.classList.add('landed');
    }
    return cell;
  }

  /** Highlight the cell and column that are on the clock. */
  markNext(pickNo) {
    for (const cell of this.cells.values()) if (cell.dataset.next === 'true') cell.dataset.next = 'false';
    for (const col of this.columns.values()) col.dataset.onClock = 'false';

    const at = this.locate(pickNo);
    if (!at) return null;
    const cell = this.cellFor(at.round, at.slot);
    if (cell && cell.dataset.empty === 'true') cell.dataset.next = 'true';
    const col = this.columns.get(at.slot);
    if (col) col.dataset.onClock = 'true';
    return at;
  }

  scrollTo(round, slot) {
    const cell = this.cellFor(round, slot);
    if (!cell) return;
    cell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

/** Build the record the board and reveal card both render from. */
export function toView(pick, { teams, board }) {
  const meta = pick?.metadata && typeof pick.metadata === 'object' ? pick.metadata : {};
  const dict = players.get(pick?.player_id);

  const metaName = [meta.first_name, meta.last_name].filter((s) => typeof s === 'string' && s).join(' ');
  const name = dict.n && !dict.n.startsWith('Player ') ? dict.n : (metaName || dict.n);
  const position = dict.p || (typeof meta.position === 'string' ? meta.position : '');
  const nflTeamRaw = dict.t || (typeof meta.team === 'string' ? meta.team : '');
  const nflTeam = isTeam(nflTeamRaw) ? nflTeamRaw.toUpperCase() : '';

  const pickNo = Number(pick?.pick_no) || 0;
  const round = Number(pick?.round) || (teams ? Math.floor((pickNo - 1) / teams) + 1 : 1);
  const slot = Number(pick?.draft_slot) || (board?.locate(pickNo)?.slot ?? 1);

  return {
    id: `${pickNo}:${pick?.player_id ?? ''}`,
    playerId: typeof pick?.player_id === 'string' ? pick.player_id : '',
    name: name || 'Unknown player',
    position,
    nflTeam,
    jersey: dict.j || '',
    round,
    slot,
    pickNo,
    pickInRound: board ? board.pickInRound(round, slot) : slot,
    rosterId: pick?.roster_id ?? null,
    pickedBy: typeof pick?.picked_by === 'string' ? pick.picked_by : '',
    isKeeper: Boolean(pick?.is_keeper),
  };
}

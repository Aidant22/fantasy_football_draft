/**
 * Mock draft source — rehearse the broadcast without a live league.
 *
 * It emits the same shapes the Sleeper endpoints return (league, users,
 * rosters, draft, picks), so the rest of the app can't tell the difference.
 * Player names come from the cached Sleeper dictionary when it is available;
 * otherwise it invents obviously-fictional placeholders.
 */
import { players } from './players.js';

const NFL_TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI',
  'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];

const POSITIONS = ['RB', 'WR', 'WR', 'TE', 'QB', 'RB', 'WR', 'QB', 'TE', 'K', 'DEF'];

const TEAM_NAMES = [
  'Gridiron Gremlins', 'Couch Commanders', 'Play Action Heroes', 'Third Down Tacos',
  'Blitz Brigade', 'Hail Mary Hooligans', 'Pylon Pirates', 'Snap Judgment',
  'Red Zone Rhinos', 'Two Minute Warning', 'Flea Flickers', 'Audible Anarchy',
];

const FIRST = ['Avery', 'Jalen', 'Marcus', 'Devon', 'Cole', 'Isaiah', 'Rory', 'Tavon', 'Emmett', 'Zane'];
const LAST = ['Whitfield', 'Okoye', 'Brennan', 'Salazar', 'Kimura', 'Vance', 'Ndiaye', 'Bellamy', 'Ortiz', 'Kowalski'];

let seq = 0;
// Build ids as strings: Sleeper ids are 18-19 digits, well past Number's safe range.
const nextId = () => `9${String((seq += 1)).padStart(17, '0')}`;

export class MockDraft {
  constructor({ teams = 12, rounds = 15, secondsPerPick = 5 } = {}) {
    this.teams = teams;
    this.rounds = rounds;
    this.secondsPerPick = secondsPerPick;
    this.picks = [];
    this.paused = false;
    this.startedAt = 0;
    this.nextAt = 0;
    this.pool = [];
    this.isMock = true;

    this.users = Array.from({ length: teams }, (_, i) => ({
      user_id: nextId(),
      display_name: `manager_${i + 1}`,
      metadata: { team_name: TEAM_NAMES[i % TEAM_NAMES.length] },
      avatar: null,
    }));

    this.rosters = this.users.map((u, i) => ({ roster_id: i + 1, owner_id: u.user_id }));

    this.draftOrder = Object.fromEntries(this.users.map((u, i) => [u.user_id, i + 1]));
    this.slotToRoster = Object.fromEntries(Array.from({ length: teams }, (_, i) => [i + 1, i + 1]));
  }

  #buildPool() {
    const sampled = players.sample(this.teams * this.rounds + 20, ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
    if (sampled.length >= this.teams * this.rounds) {
      this.pool = sampled;
      this.synthetic = false;
      return;
    }
    // No dictionary yet — invent placeholders so the rehearsal still works.
    this.synthetic = true;
    this.syntheticById = Object.create(null);
    this.pool = Array.from({ length: this.teams * this.rounds + 20 }, (_, i) => {
      const id = `mock${i}`;
      // Injective first/last pairing: unique names, but consecutive picks
      // don't all share a surname.
      const first = i % FIRST.length;
      const last = (Math.floor(i / FIRST.length) + first * 3) % LAST.length;
      const cycle = Math.floor(i / (FIRST.length * LAST.length));
      this.syntheticById[id] = {
        first_name: FIRST[first],
        last_name: LAST[last] + (cycle ? ` ${cycle + 1}` : ''),
        position: POSITIONS[i % POSITIONS.length],
        team: NFL_TEAMS[(i * 7) % NFL_TEAMS.length],
      };
      return id;
    });
  }

  start() {
    this.#buildPool();
    this.picks = [];
    this.paused = false;
    this.startedAt = Date.now();
    this.nextAt = this.startedAt + 1500;
  }

  pause() { this.paused = true; }

  resume() {
    this.paused = false;
    this.nextAt = Date.now() + 800;
  }

  /** Emit a pick immediately (bound to a key for testing animations). */
  forcePick() {
    this.#makePick();
    this.nextAt = Date.now() + this.secondsPerPick * 1000;
  }

  slotFor(pickNo) {
    const round = Math.floor((pickNo - 1) / this.teams) + 1;
    const idx = (pickNo - 1) % this.teams;
    const slot = round % 2 === 0 ? this.teams - idx : idx + 1;
    return { round, slot };
  }

  #makePick() {
    const pickNo = this.picks.length + 1;
    if (pickNo > this.teams * this.rounds) return;
    const { round, slot } = this.slotFor(pickNo);
    const playerId = this.pool[pickNo - 1] ?? `mock${pickNo}`;

    let metadata;
    if (this.synthetic) {
      metadata = { ...this.syntheticById[playerId] };
    } else {
      const rec = players.get(playerId);
      const [first, ...rest] = String(rec.n).split(' ');
      metadata = { first_name: first, last_name: rest.join(' '), position: rec.p, team: rec.t };
    }

    this.picks.push({
      round,
      draft_slot: slot,
      pick_no: pickNo,
      roster_id: this.slotToRoster[slot],
      picked_by: this.users[slot - 1].user_id,
      player_id: playerId,
      is_keeper: false,
      metadata,
    });
  }

  /** Called by the poller; advances the clock and returns the pick list. */
  fetchPicks() {
    const now = Date.now();
    if (!this.paused && this.startedAt) {
      let guard = 0;
      while (now >= this.nextAt && this.picks.length < this.teams * this.rounds && guard < 5) {
        this.#makePick();
        this.nextAt += this.secondsPerPick * 1000;
        guard += 1;
      }
    }
    return this.picks.slice();
  }

  get status() {
    if (!this.startedAt) return 'pre_draft';
    if (this.picks.length >= this.teams * this.rounds) return 'complete';
    return this.paused ? 'paused' : 'drafting';
  }

  context() {
    return {
      league: {
        league_id: 'mock',
        name: 'Mock Draft (rehearsal)',
        season: String(new Date().getFullYear()),
        settings: { num_teams: this.teams },
      },
      users: this.users,
      rosters: this.rosters,
      draft: {
        draft_id: 'mock',
        status: this.status,
        type: 'snake',
        settings: { teams: this.teams, rounds: this.rounds, reversal_round: 0 },
        draft_order: this.draftOrder,
        slot_to_roster_id: this.slotToRoster,
      },
    };
  }

  /** Player lookup fallback for synthetic entries. */
  lookup(playerId) {
    return this.synthetic ? this.syntheticById?.[playerId] ?? null : null;
  }
}

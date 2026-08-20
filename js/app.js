/**
 * Draft Room — controller.
 *
 * Wires the Sleeper client (or the mock source) to the board and the reveal
 * director, and owns the poll loop, the settings panel and the keyboard
 * shortcuts.
 *
 * Privacy/security notes:
 *  - No backend, no analytics, no cookies. The only outbound requests are to
 *    api.sleeper.app (public, unauthenticated) and sleepercdn.com (images),
 *    both pinned by the page's Content-Security-Policy.
 *  - Your league id and preferences live in this browser's localStorage and
 *    can be wiped from Setup → "Clear local data".
 *  - Every string from the API is rendered with textContent, never innerHTML.
 */
import { $, setText, store, clamp, isId, isUsername, isSeason, avatarUrl, timeAgo, ordinal } from './util.js';
import { api, ApiError } from './sleeper.js';
import { players } from './players.js';
import { audio } from './audio.js';
import { Board, toView } from './board.js';
import { RevealDirector, buildCard } from './reveal.js';
import { MockDraft } from './mock.js';
import { CUES } from './soundpack.js';

/* ------------------------------------------------------------------ state */

const cfg = (typeof window !== 'undefined' && window.DRAFT_CONFIG) || {};

const defaults = {
  leagueId: typeof cfg.leagueId === 'string' ? cfg.leagueId : '',
  draftId: typeof cfg.draftId === 'string' ? cfg.draftId : '',
  intensity: ['full', 'compact', 'subtle', 'off'].includes(cfg.intensity) ? cfg.intensity : 'full',
  sound: Boolean(cfg.soundOn),
  soundMode: cfg.soundMode === 'synth' ? 'synth' : 'auto',
  volume: 0.7,
  pollSeconds: clamp(Number(cfg.pollSeconds) || 4, 3, 10),
  photos: true,
  reduceMotion: false,
  autoScroll: true,
  season: String(new Date().getFullYear()),
};

const settings = { ...defaults, ...(store.get('settings', {}) || {}) };

const state = {
  leagueId: '',
  draftId: '',
  league: null,
  draft: null,
  teams: 0,
  rounds: 0,
  slotTeams: new Map(),     // slot -> { name, owner, avatar }
  rosterToSlot: new Map(),
  userToSlot: new Map(),
  appliedPicks: 0,
  lastPickNo: 0,
  primed: false,
  lastPollAt: 0,
  pollFailures: 0,
  mock: null,
  running: false,
  loopToken: 0,
  ticks: 0,
};

/* --------------------------------------------------------------- elements */

const el = {
  board: $('#board'),
  boardWrap: $('#board-wrap'),
  emptyState: $('#empty-state'),
  leagueName: $('#league-name'),
  leagueSub: $('#league-sub'),
  statusPill: $('#status-pill'),
  statusText: $('#status-text'),
  onClock: $('#on-clock'),
  pickCounter: $('#pick-counter'),
  intensity: $('#intensity'),
  soundToggle: $('#sound-toggle'),
  soundIcon: $('#sound-icon'),
  testBtn: $('#test-btn'),
  settingsBtn: $('#settings-btn'),
  modal: $('#settings-modal'),
  modalClose: $('#settings-close'),
  leagueInput: $('#league-input'),
  usernameInput: $('#username-input'),
  seasonInput: $('#season-input'),
  lookupBtn: $('#lookup-btn'),
  leagueList: $('#league-list'),
  pollInput: $('#poll-input'),
  pollValue: $('#poll-value'),
  volumeInput: $('#volume-input'),
  volumeValue: $('#volume-value'),
  soundSource: $('#sound-source'),
  audioReload: $('#audio-reload'),
  cueList: $('#cue-list'),
  photosInput: $('#photos-input'),
  reduceInput: $('#reduce-input'),
  clearBtn: $('#clear-btn'),
  mockBtn: $('#mock-btn'),
  connectBtn: $('#connect-btn'),
  settingsError: $('#settings-error'),
  emptyConnect: $('#empty-connect'),
  emptyMock: $('#empty-mock'),
  stage: $('#stage'),
  stageFlash: $('#stage-flash'),
  stageWalkout: $('#stage-walkout'),
  stageBody: $('#stage-body'),
  toasts: $('#toasts'),
  footLeft: $('#foot-left'),
  footRight: $('#foot-right'),
};

const board = new Board(el.board);
const director = new RevealDirector({
  stage: el.stage,
  stageFlash: el.stageFlash,
  stageWalkout: el.stageWalkout,
  stageBody: el.stageBody,
  toasts: el.toasts,
  board,
  getSettings: () => settings,
});

/** Previews never write to the board, so they get their own director. */
const previewDirector = new RevealDirector({
  stage: el.stage,
  stageFlash: el.stageFlash,
  stageWalkout: el.stageWalkout,
  stageBody: el.stageBody,
  toasts: el.toasts,
  board: null,
  getSettings: () => settings,
});

/* --------------------------------------------------------------- helpers */

function saveSettings() {
  store.set('settings', settings);
}

function setStatus(stateName, text) {
  el.statusPill.dataset.state = stateName;
  setText(el.statusText, text);
}

function foot(left, right) {
  if (left != null) setText(el.footLeft, left);
  if (right != null) setText(el.footRight, right);
}

function showError(message) {
  setText(el.settingsError, message);
  el.settingsError.hidden = !message;
}

/** Render which cue is coming from a file and which from the synth. */
function renderCueList(report) {
  const tpl = document.getElementById('tpl-cue-row');
  el.cueList.replaceChildren();

  for (const entry of report) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    setText(row.querySelector('.cue-name'), entry.label);

    let source = 'synthesized';
    if (entry.state === 'file') source = `${entry.file} · ${entry.seconds.toFixed(1)}s`;
    else if (entry.state === 'error') source = `${entry.file ?? 'file'} — ${entry.error}, using synth`;
    else if (entry.state === 'synth-forced') source = 'synthesized (pinned in manifest)';
    else if (entry.state === 'pending') source = 'not checked yet — press Reload';

    const sourceEl = row.querySelector('.cue-source');
    setText(sourceEl, settings.soundMode === 'synth' ? 'synthesized (synth-only mode)' : source);
    sourceEl.dataset.state = settings.soundMode === 'synth' ? 'synth' : entry.state;

    row.querySelector('.cue-play').addEventListener('click', () => {
      if (!settings.sound) setSound(true);
      audio.unlock();
      playCue(entry.cue);
    });
    el.cueList.append(row);
  }
}

/** Preview a single cue from the settings panel. */
function playCue(cue) {
  switch (cue) {
    case 'beam': audio.riser(900); break;
    case 'position': audio.hit(0); break;
    case 'team': audio.hit(1); break;
    case 'reveal': audio.reveal(); break;
    case 'sting': audio.sting(); break;
    case 'tick': audio.tick(); break;
    default: break;
  }
}

async function refreshCueList({ reload = false } = {}) {
  if (!CUES.length) return;
  renderCueList(reload ? [] : audio.pack.report());
  const report = reload ? await audio.reloadPack() : audio.pack.report();
  renderCueList(report);
}

function openModal() {
  showError('');
  refreshCueList();
  el.leagueInput.value = state.leagueId || settings.leagueId || '';
  el.seasonInput.value = settings.season;
  el.modal.hidden = false;
  el.leagueInput.focus();
}

function closeModal() {
  el.modal.hidden = true;
}

/* --------------------------------------------------- team / draft mapping */

function buildTeamMaps({ users, rosters, draft }) {
  const usersById = new Map();
  for (const u of users ?? []) if (u?.user_id) usersById.set(String(u.user_id), u);

  const rosterOwner = new Map();
  for (const r of rosters ?? []) if (r?.roster_id != null) rosterOwner.set(Number(r.roster_id), String(r.owner_id ?? ''));

  state.slotTeams.clear();
  state.rosterToSlot.clear();
  state.userToSlot.clear();

  const slotToRoster = draft?.slot_to_roster_id ?? {};
  const draftOrder = draft?.draft_order ?? {};

  for (let slot = 1; slot <= state.teams; slot += 1) {
    const rosterId = Number(slotToRoster?.[slot] ?? slotToRoster?.[String(slot)] ?? 0);
    let user = null;

    if (rosterId) {
      state.rosterToSlot.set(rosterId, slot);
      const ownerId = rosterOwner.get(rosterId);
      if (ownerId) user = usersById.get(ownerId) ?? null;
    }
    if (!user) {
      const entry = Object.entries(draftOrder).find(([, s]) => Number(s) === slot);
      if (entry) user = usersById.get(String(entry[0])) ?? null;
    }
    if (user?.user_id) state.userToSlot.set(String(user.user_id), slot);

    const teamName = (user?.metadata && typeof user.metadata.team_name === 'string' && user.metadata.team_name)
      || (typeof user?.display_name === 'string' ? user.display_name : '')
      || `Team ${slot}`;

    state.slotTeams.set(slot, {
      name: teamName,
      owner: typeof user?.display_name === 'string' ? `@${user.display_name}` : '',
      avatar: avatarUrl(typeof user?.avatar === 'string' ? user.avatar : ''),
    });
  }
}

function teamLabelFor(view) {
  let slot = view.slot;
  if (!slot && view.rosterId != null) slot = state.rosterToSlot.get(Number(view.rosterId));
  if (!slot && view.pickedBy) slot = state.userToSlot.get(view.pickedBy);
  return state.slotTeams.get(Number(slot))?.name ?? `Team ${slot ?? '?'}`;
}

/* ------------------------------------------------------------ connect */

async function connectLeague(leagueId) {
  stopPolling();
  director.clear();

  if (!isId(leagueId)) throw new ApiError('That does not look like a Sleeper league id (all digits).', { retryable: false });

  setStatus('waiting', 'Loading league');
  foot('Loading league…', '');

  const [league, users, rosters, drafts] = await Promise.all([
    api.getLeague(leagueId),
    api.getUsers(leagueId),
    api.getRosters(leagueId),
    api.getDrafts(leagueId),
  ]);

  if (!league) throw new ApiError('League not found. Double-check the id.', { retryable: false });

  const draft = pickDraft(drafts, settings.draftId);
  if (!draft) throw new ApiError('That league has no draft yet.', { retryable: false });

  state.leagueId = leagueId;
  state.draftId = String(draft.draft_id);
  state.league = league;
  settings.leagueId = leagueId;
  saveSettings();

  await startWithContext({ league, users, rosters, draft }, { mock: false });
}

function pickDraft(drafts, preferredId) {
  const list = Array.isArray(drafts) ? drafts.filter((d) => d && d.draft_id) : [];
  if (!list.length) return null;
  if (preferredId) {
    const found = list.find((d) => String(d.draft_id) === String(preferredId));
    if (found) return found;
  }
  const rank = { drafting: 0, paused: 1, pre_draft: 2, complete: 3 };
  return list.slice().sort((a, b) => {
    const byStatus = (rank[a.status] ?? 4) - (rank[b.status] ?? 4);
    if (byStatus !== 0) return byStatus;
    return Number(b.start_time ?? 0) - Number(a.start_time ?? 0);
  })[0];
}

async function startWithContext({ league, users, rosters, draft }, { mock }) {
  state.draft = draft;
  state.teams = Number(draft?.settings?.teams) || Number(league?.settings?.num_teams) || 12;
  state.rounds = Number(draft?.settings?.rounds) || 15;
  state.appliedPicks = 0;
  state.lastPickNo = 0;
  state.primed = false;

  buildTeamMaps({ users, rosters, draft });

  board.render({
    teams: state.teams,
    rounds: state.rounds,
    type: typeof draft?.type === 'string' ? draft.type : 'snake',
    reversalRound: Number(draft?.settings?.reversal_round) || 0,
    slotTeams: state.slotTeams,
  });

  el.emptyState.hidden = true;
  setText(el.leagueName, typeof league?.name === 'string' && league.name ? league.name : 'Draft Room');
  setText(el.leagueSub, `${state.teams} teams · ${state.rounds} rounds · ${mock ? 'mock' : (draft?.type ?? 'snake')}`);

  applyDraftStatus(draft?.status);
  loadPlayersInBackground();
  startPolling();
}

/** The dictionary is big; the board is usable before it lands. */
async function loadPlayersInBackground() {
  if (players.size) return;
  try {
    await players.ensure({
      onStage: (stage) => {
        if (stage === 'download') foot('Downloading the NFL player list (one time, ~5MB)…');
        if (stage === 'cache') foot('Loading cached player list…');
        if (stage === 'saving') foot('Caching player list for next time…');
      },
    });
    foot(`Player list ready — ${players.size.toLocaleString()} players cached.`);
  } catch {
    foot('Player list unavailable — falling back to the names Sleeper sends with each pick.');
  }
}

/* -------------------------------------------------------------- polling */

function startPolling() {
  state.running = true;
  state.pollFailures = 0;
  state.loopToken += 1;
  runLoop(state.loopToken);
}

function stopPolling() {
  state.running = false;
  state.loopToken += 1;
}

async function runLoop(token) {
  while (state.running && token === state.loopToken) {
    let wait = settings.pollSeconds * 1000;
    try {
      await tick();
      state.pollFailures = 0;
      if (state.draft?.status === 'complete') wait = 30000;
      else if (state.draft?.status === 'pre_draft') wait = Math.max(wait, 6000);
    } catch (err) {
      state.pollFailures += 1;
      const retryable = !(err instanceof ApiError) || err.retryable;
      setStatus('error', retryable ? 'Reconnecting' : 'Error');
      foot(err instanceof Error ? err.message : 'Poll failed', '');
      if (!retryable) { stopPolling(); return; }
      wait = Math.min(30000, 2000 * 2 ** Math.min(4, state.pollFailures - 1));
    }
    // Jitter keeps repeated polls from lining up exactly.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, wait + Math.random() * 400));
  }
}

async function tick() {
  state.ticks += 1;

  const picks = state.mock ? state.mock.fetchPicks() : (await api.getPicks(state.draftId)) ?? [];
  state.lastPollAt = Date.now();

  if (state.mock) {
    if (state.mock.status !== state.draft.status) {
      state.draft = { ...state.draft, status: state.mock.status };
      applyDraftStatus(state.draft.status);
    }
  } else if (state.ticks % 8 === 1) {
    // Cheap status refresh so pauses / completion are noticed without extra chatter.
    const fresh = await api.getDraft(state.draftId);
    if (fresh?.status && fresh.status !== state.draft?.status) {
      state.draft = fresh;
      applyDraftStatus(fresh.status);
    }
  }

  const sorted = picks
    .filter((p) => p && Number.isFinite(Number(p.pick_no)))
    .sort((a, b) => Number(a.pick_no) - Number(b.pick_no));

  // Only the first poll of a connection is history: joining a draft that is
  // already underway backfills silently, but a draft that starts while you're
  // watching animates from pick 1.
  const isFirstPaint = !state.primed;

  if (sorted.length > state.appliedPicks) {
    const fresh = sorted.slice(state.appliedPicks);
    state.appliedPicks = sorted.length;
    state.lastPickNo = Number(sorted[sorted.length - 1].pick_no) || state.lastPickNo;

    for (const pick of fresh) {
      const view = toView(pick, { teams: state.teams, board });
      if (isFirstPaint) {
        board.applyPick(view, { animate: false }); // backfill: never animate history
      } else {
        director.enqueue({ view, teamLabel: teamLabelFor(view) });
      }
    }
    if (isFirstPaint && fresh.length) {
      foot(`Loaded ${fresh.length} existing pick${fresh.length === 1 ? '' : 's'}.`);
    }
    if (state.draft?.status === 'drafting') setStatus('live', 'Live');
  }

  state.primed = true;
  updateClock();
  foot(null, `${state.mock ? 'Mock draft' : 'Sleeper'} · polled ${timeAgo(state.lastPollAt)} · ${state.appliedPicks} picks`);
}

function updateClock() {
  const nextPickNo = state.appliedPicks + 1;
  const total = state.teams * state.rounds;

  if (nextPickNo > total) {
    setText(el.onClock, 'Draft complete');
    setText(el.pickCounter, `${total} / ${total}`);
    board.markNext(0);
    return;
  }

  const at = board.markNext(nextPickNo);
  const team = at ? state.slotTeams.get(at.slot) : null;
  setText(el.onClock, team?.name ?? '—');
  setText(el.pickCounter, at ? `${at.round}.${String(board.pickInRound(at.round, at.slot)).padStart(2, '0')} · ${ordinal(nextPickNo)}` : '—');
}

function applyDraftStatus(status) {
  switch (status) {
    case 'drafting':
      setStatus('live', 'Live');
      foot('Draft is live — watching for picks.');
      break;
    case 'paused':
      setStatus('waiting', 'Paused');
      foot('Draft is paused. Still polling quietly.');
      break;
    case 'complete':
      setStatus('done', 'Complete');
      foot('Draft complete.');
      break;
    case 'pre_draft':
    default:
      setStatus('waiting', 'Pre-draft');
      foot('Draft has not started yet — polling quietly until picks appear.');
      break;
  }
}

/* ----------------------------------------------------------- mock mode */

function mockPace() {
  try {
    const raw = new URL(window.location.href).searchParams.get('mockPace');
    const secs = Number(raw);
    if (Number.isFinite(secs)) return clamp(secs, 0.5, 60);
  } catch { /* ignore */ }
  return 6;
}

function startMock() {
  stopPolling();
  director.clear();
  state.mock = new MockDraft({ teams: 12, rounds: 15, secondsPerPick: mockPace() });
  state.mock.start();
  state.leagueId = '';
  state.draftId = 'mock';
  const ctx = state.mock.context();
  state.league = ctx.league;
  startWithContext(ctx, { mock: true });
  foot('Mock draft running — press M to force a pick, Space to pause.');
}

/* ------------------------------------------------------------ controls */

function setIntensity(value) {
  if (!['full', 'compact', 'subtle', 'off'].includes(value)) return;
  settings.intensity = value;
  el.intensity.value = value;
  saveSettings();
  foot(`Intensity: ${value}`);
}

function setSound(on) {
  settings.sound = Boolean(on);
  if (settings.sound) audio.unlock();
  audio.setEnabled(settings.sound);
  audio.setVolume(settings.volume);
  el.soundToggle.setAttribute('aria-pressed', String(settings.sound));
  setText(el.soundIcon, settings.sound ? '🔊' : '🔇');
  saveSettings();
}

function previewReveal() {
  const view = {
    id: 'preview',
    playerId: '',
    name: 'Preview Player',
    position: 'WR',
    nflTeam: 'KC',
    jersey: '10',
    round: 1,
    slot: 1,
    pickNo: 1,
    pickInRound: 1,
    rosterId: null,
    pickedBy: '',
    isKeeper: false,
  };
  const item = { view, teamLabel: state.slotTeams.get(1)?.name ?? 'Your team' };
  const tier = settings.intensity === 'full' ? 'full' : 'compact';
  previewDirector.play(item, tier);
}

/* ------------------------------------------------------- settings panel */

async function handleConnectClick() {
  const value = el.leagueInput.value.trim();
  showError('');
  if (!isId(value)) {
    showError('League ids are 6+ digits, e.g. 1048291234567890123.');
    return;
  }
  el.connectBtn.disabled = true;
  try {
    state.mock = null;
    await connectLeague(value);
    closeModal();
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Could not connect.');
    setStatus('error', 'Error');
  } finally {
    el.connectBtn.disabled = false;
  }
}

async function handleLookupClick() {
  const username = el.usernameInput.value.trim().replace(/^@/, '');
  const season = el.seasonInput.value.trim() || settings.season;
  showError('');
  el.leagueList.replaceChildren();
  el.leagueList.hidden = true;

  if (!isUsername(username)) { showError('Usernames are letters, numbers, dots, dashes and underscores.'); return; }
  if (!isSeason(season)) { showError('Season should be a four-digit year, e.g. 2026.'); return; }

  el.lookupBtn.disabled = true;
  try {
    const user = await api.getUser(username);
    if (!user?.user_id) { showError('No Sleeper user with that username.'); return; }
    const leagues = await api.getUserLeagues(String(user.user_id), season);
    if (!Array.isArray(leagues) || !leagues.length) { showError(`No ${season} NFL leagues for that user.`); return; }

    settings.season = season;
    saveSettings();

    const tpl = document.getElementById('tpl-league-option');
    for (const league of leagues) {
      if (!league?.league_id) continue;
      const opt = tpl.content.firstElementChild.cloneNode(true);
      setText(opt.querySelector('.league-opt-name'), league.name ?? 'Unnamed league');
      setText(opt.querySelector('.league-opt-meta'),
        `${league.settings?.num_teams ?? '?'} teams · ${league.status ?? ''}`);
      opt.addEventListener('click', () => {
        el.leagueInput.value = String(league.league_id);
        el.leagueList.hidden = true;
        handleConnectClick();
      });
      el.leagueList.append(opt);
    }
    el.leagueList.hidden = false;
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Lookup failed.');
  } finally {
    el.lookupBtn.disabled = false;
  }
}

function wireUi() {
  el.intensity.value = settings.intensity;
  el.pollInput.value = String(settings.pollSeconds);
  setText(el.pollValue, settings.pollSeconds.toFixed(1));
  el.volumeInput.value = String(Math.round(settings.volume * 100));
  setText(el.volumeValue, String(Math.round(settings.volume * 100)));
  el.soundSource.value = settings.soundMode;
  audio.setMode(settings.soundMode);
  el.photosInput.checked = settings.photos !== false;
  el.reduceInput.checked = Boolean(settings.reduceMotion);
  document.body.dataset.reduceMotion = String(Boolean(settings.reduceMotion));
  setSound(settings.sound);

  el.intensity.addEventListener('change', () => setIntensity(el.intensity.value));
  el.soundToggle.addEventListener('click', () => setSound(!settings.sound));
  el.testBtn.addEventListener('click', () => { if (settings.sound) audio.unlock(); previewReveal(); });
  el.settingsBtn.addEventListener('click', openModal);
  el.modalClose.addEventListener('click', closeModal);
  el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });
  el.connectBtn.addEventListener('click', handleConnectClick);
  el.lookupBtn.addEventListener('click', handleLookupClick);
  el.leagueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleConnectClick(); });
  el.usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLookupClick(); });
  el.mockBtn.addEventListener('click', () => { closeModal(); startMock(); });
  el.emptyMock.addEventListener('click', startMock);
  el.emptyConnect.addEventListener('click', openModal);

  el.pollInput.addEventListener('input', () => {
    settings.pollSeconds = clamp(Number(el.pollInput.value) || 4, 3, 10);
    setText(el.pollValue, settings.pollSeconds.toFixed(1));
    saveSettings();
  });

  el.volumeInput.addEventListener('input', () => {
    settings.volume = clamp(Number(el.volumeInput.value) / 100, 0, 1);
    setText(el.volumeValue, String(Math.round(settings.volume * 100)));
    audio.setVolume(settings.volume);
    saveSettings();
  });

  el.soundSource.addEventListener('change', () => {
    settings.soundMode = el.soundSource.value === 'synth' ? 'synth' : 'auto';
    audio.setMode(settings.soundMode);
    saveSettings();
    refreshCueList();
    foot(settings.soundMode === 'synth' ? 'Using the built-in synth for every cue.' : 'Using audio files from audio/ where present.');
  });

  el.audioReload.addEventListener('click', async () => {
    if (!settings.sound) setSound(true);
    await refreshCueList({ reload: true });
    foot('Reloaded the audio/ folder.');
  });

  el.photosInput.addEventListener('change', () => { settings.photos = el.photosInput.checked; saveSettings(); });
  el.reduceInput.addEventListener('change', () => {
    settings.reduceMotion = el.reduceInput.checked;
    document.body.dataset.reduceMotion = String(settings.reduceMotion);
    saveSettings();
  });

  el.clearBtn.addEventListener('click', async () => {
    store.clearAll();
    await players.clearCache();
    showError('Local data cleared. Reload to start fresh.');
  });

  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (e.key === 'Escape') {
      if (!el.modal.hidden) closeModal();
      else director.skip();
      return;
    }
    if (typing) return;
    switch (e.key.toLowerCase()) {
      case '1': setIntensity('full'); break;
      case '2': setIntensity('compact'); break;
      case '3': setIntensity('subtle'); break;
      case '4': setIntensity('off'); break;
      case 's': setSound(!settings.sound); break;
      case 't': previewReveal(); break;
      case 'm': if (state.mock) state.mock.forcePick(); break;
      case ' ':
        if (state.mock) {
          e.preventDefault();
          if (state.mock.paused) state.mock.resume(); else state.mock.pause();
          foot(state.mock.paused ? 'Mock draft paused.' : 'Mock draft resumed.');
        }
        break;
      default: break;
    }
  });

  // Browsers only allow audio after a genuine gesture; if sound was left on
  // from a previous session, resume the context at the first interaction.
  const resumeAudio = () => { if (settings.sound) audio.unlock(); };
  document.addEventListener('pointerdown', resumeAudio, { once: false, passive: true });
  document.addEventListener('keydown', resumeAudio, { once: false });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => board.fit(), 120);
  });

  // Keep the "polled Ns ago" readout honest between polls.
  setInterval(() => {
    if (state.lastPollAt) {
      setText(el.footRight, `${state.mock ? 'Mock draft' : 'Sleeper'} · polled ${timeAgo(state.lastPollAt)} · ${state.appliedPicks} picks`);
    }
  }, 5000);
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  wireUi();

  // A league id may come from js/config.js, from a previous session, or from
  // ?league= — validated the same way in all three cases.
  let leagueId = settings.leagueId;
  try {
    const param = new URL(window.location.href).searchParams.get('league');
    if (param && isId(param)) leagueId = param;
  } catch { /* ignore */ }

  if (isId(leagueId)) {
    try {
      await connectLeague(leagueId);
      return;
    } catch (err) {
      setStatus('error', 'Error');
      foot(err instanceof Error ? err.message : 'Could not connect.');
    }
  }

  el.emptyState.hidden = false;
  setStatus('idle', 'Idle');
  foot('Connect a league or run a mock draft to begin.');
}

// Expose a tiny, read-only surface for the smoke test. No secrets here.
window.__draftRoom = { state, settings, board, director, players, audio, startMock, buildCard, toView, playCue };

boot();

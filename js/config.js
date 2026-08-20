/* eslint-disable no-var */
/**
 * Optional defaults. Nothing here is secret — a Sleeper league ID is public
 * data — but the app works fine with this file left blank: use the in-app
 * "Setup" panel instead and your league ID is stored in this browser only.
 *
 * If you'd rather not have your league ID in a public repo at all, copy this
 * file to js/config.local.js (already gitignored) and load that instead, or
 * just leave leagueId empty and type it into the app.
 */
window.DRAFT_CONFIG = {
  // Sleeper league ID, e.g. '1048291234567890123'. Leave '' to configure in-app.
  leagueId: '',

  // Optional: pin a specific draft. Leave '' to auto-detect the league's draft.
  draftId: '',

  // Seconds between polls for new picks (3–10).
  pollSeconds: 4,

  // 'full' | 'compact' | 'subtle' | 'off' — changeable live from the toolbar.
  intensity: 'full',

  // Start muted; the browser requires a click before audio can play anyway.
  soundOn: false,

  // 'auto' plays the files in audio/ (falling back to the built-in synth for
  // any cue you haven't supplied); 'synth' ignores the folder entirely.
  soundMode: 'auto',
};

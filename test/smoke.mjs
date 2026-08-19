/**
 * Headless smoke test: boots the app against the mock draft source with all
 * external hosts blocked, and checks that the board fills, both animation
 * tiers fire, the intensity control takes effect, and nothing logs an error
 * or trips the Content-Security-Policy.
 *
 * Run: npm test        (requires playwright; NODE_PATH may need to point at
 *                       a global install)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT ?? 8199);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'test', 'screenshots');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('playwright not found. Install it (npm i -D playwright) or set NODE_PATH to a global install.');
  process.exit(2);
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await wait(interval);
  }
}

// Static hygiene scan: the app must never build DOM from strings or eval.
const banned = [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /insertAdjacentHTML/];
const sources = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
const offenders = sources.filter((f) => {
  const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  return banned.some((re) => re.test(src));
});
check('no innerHTML / eval in app sources', offenders.length === 0, offenders.join(', '));

const server = spawn(process.execPath, [path.join(ROOT, 'serve.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.once('data', resolve));

fs.mkdirSync(SHOTS, { recursive: true });

// The autoplay flag lets the headless run verify the synthesized cues actually
// produce signal; a real browser needs a click instead.
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });

// Block every external host: the app must degrade gracefully with no CDN.
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  return route.abort();
});

const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

try {
  await page.goto(`${BASE}/index.html?mockPace=1.2`, { waitUntil: 'load' });

  check('page boots into the empty state', await page.isVisible('#empty-state'));
  check('setup panel starts hidden', !(await page.isVisible('#settings-modal')));

  await page.click('#empty-mock');
  await waitFor(() => page.$$eval('.col', (n) => n.length === 12), { label: '12 columns' });
  check('board renders one column per team', true, '12 columns');
  check('board renders every round', (await page.$$('.cell')).length === 12 * 15);

  // Round 1 pick -> full-screen takeover.
  await waitFor(() => page.isVisible('#stage'), { label: 'round 1 takeover' });
  const stageName = (await page.textContent('#stage .reveal-name'))?.trim();
  check('round 1 uses the full-screen stage', Boolean(stageName), `player: ${stageName}`);
  check('round 1 card labels the round', (await page.textContent('#stage .reveal-round'))?.includes('Round 1'));
  await page.screenshot({ path: path.join(SHOTS, '01-round1-takeover.png') });

  await waitFor(async () => !(await page.isVisible('#stage')), { timeout: 12000, label: 'takeover to clear' });
  check('takeover clears itself', true);

  // Picks land on the board.
  await waitFor(() => page.$$eval('.cell[data-empty="false"]', (n) => n.length >= 3), { label: 'picks on board' });
  const filled = (await page.$$('.cell[data-empty="false"]')).length;
  check('picks land on the board', filled >= 3, `${filled} cells filled`);
  check('on-the-clock column is marked', (await page.$$('.col[data-on-clock="true"]')).length === 1);
  check('next cell is highlighted', (await page.$$('.cell[data-next="true"]')).length === 1);

  // Round 2+ -> corner banner instead of takeover.
  await waitFor(() => page.$$eval('#toasts .reveal', (n) => n.length > 0), { timeout: 25000, label: 'toast banner' });
  check('round 2+ uses a corner banner', true);
  await page.screenshot({ path: path.join(SHOTS, '02-toast-banner.png') });

  // Intensity control.
  await page.selectOption('#intensity', 'subtle');
  check('intensity control switches to subtle', (await page.inputValue('#intensity')) === 'subtle');
  const beforeSubtle = (await page.$$('.cell[data-empty="false"]')).length;
  await wait(4000);
  const afterSubtle = (await page.$$('.cell[data-empty="false"]')).length;
  check('subtle mode still records picks', afterSubtle > beforeSubtle, `${beforeSubtle} → ${afterSubtle}`);
  check('subtle mode shows no overlay', !(await page.isVisible('#stage')) && (await page.$$('#toasts .reveal')).length === 0);

  await page.selectOption('#intensity', 'full');

  // Settings persist and no secrets are stored.
  await page.click('#settings-btn');
  check('setup panel opens', await page.isVisible('#settings-modal'));
  await page.screenshot({ path: path.join(SHOTS, '03-setup.png') });
  await page.click('#settings-close');

  const stored = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return out;
  });
  check('settings persist under a single namespace',
    Object.keys(stored).every((k) => k.startsWith('draftroom:')), Object.keys(stored).join(', '));

  // Invalid league ids are rejected before any request is made.
  await page.click('#settings-btn');
  await page.fill('#league-input', 'not-an-id');
  await page.click('#connect-btn');
  check('invalid league id is rejected client-side', await page.isVisible('#settings-error'));
  await page.click('#settings-close');

  // Broken images (all CDN hosts blocked here) must not leave broken glyphs.
  const visibleBrokenImages = await page.$$eval('img', (imgs) =>
    imgs.filter((i) => !i.hidden && i.getAttribute('src') && i.naturalWidth === 0).length);
  check('failed CDN images are hidden, not broken', visibleBrokenImages === 0, `${visibleBrokenImages} broken`);

  await page.screenshot({ path: path.join(SHOTS, '04-board.png'), fullPage: false });

  // The stingers are generated, not sampled — check they emit real signal.
  const levels = await page.evaluate(async () => {
    const { audio } = window.__draftRoom;
    audio.setEnabled(true);
    audio.unlock();
    if (audio.ctx.state === 'suspended') await audio.ctx.resume();
    const peak = async (fn, ms) => {
      const an = audio.ctx.createAnalyser();
      audio.master.connect(an);
      fn();
      const buf = new Float32Array(an.fftSize);
      let max = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        an.getFloatTimeDomainData(buf);
        for (const v of buf) max = Math.max(max, Math.abs(v));
        await new Promise((r) => setTimeout(r, 20));
      }
      audio.master.disconnect(an);
      return max;
    };
    return { fanfare: await peak(() => audio.fanfare(), 2600), sting: await peak(() => audio.sting(), 700) };
  });
  check('round 1 fanfare produces audio without clipping', levels.fanfare > 0.05 && levels.fanfare < 1,
    `peak ${levels.fanfare.toFixed(3)}`);
  check('round 2+ sting produces audio without clipping', levels.sting > 0.05 && levels.sting < 1,
    `peak ${levels.sting.toFixed(3)}`);

  const csp = consoleErrors.filter((t) => /Content Security Policy/i.test(t));
  check('no CSP violations', csp.length === 0, csp.slice(0, 2).join(' | '));
  const realErrors = consoleErrors.filter((t) => !/Failed to load resource|net::ERR|ERR_FAILED/i.test(t));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  check('no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  failures.push(String(err));
  console.error(err);
  try { await page.screenshot({ path: path.join(SHOTS, 'failure.png') }); } catch { /* ignore */ }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);

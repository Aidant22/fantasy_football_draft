/**
 * Optional: pre-fetch the Sleeper player dictionary to data/players.json so
 * the app never has to download 5MB during your draft (and works offline).
 *
 *   npm run players
 *
 * The file is gitignored — it is bulk public data, not something to commit.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slimPlayers } from '../js/players.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data');
const OUT = path.join(OUT_DIR, 'players.json');

const res = await fetch('https://api.sleeper.app/v1/players/nfl', {
  headers: { Accept: 'application/json' },
});
if (!res.ok) {
  console.error(`Sleeper returned ${res.status}`);
  process.exit(1);
}

const raw = await res.json();
const slim = slimPlayers(raw);
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(OUT, JSON.stringify(slim));

const { size } = await fs.stat(OUT);
console.log(`Wrote ${Object.keys(slim).length.toLocaleString()} players to data/players.json (${(size / 1e6).toFixed(1)} MB)`);

/**
 * Generates the placeholder cue files in audio/.
 *
 * Everything here is synthesized from oscillators and generated noise — the
 * shipped files are original, so there is no licensed audio in this repo.
 * Swap any of them for your own file and the app picks it up automatically.
 *
 *   node scripts/make-placeholder-audio.mjs            # writes .wav
 *   npm i -D @breezystack/lamejs && npm run audio      # writes .mp3 instead
 *
 * The MP3 encoder is optional and loaded lazily: without it you still get
 * perfectly good WAV placeholders, which every browser decodes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'audio');
const RATE = 44100;

/* ------------------------------------------------------------ synthesis */

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * RATE));

const add = (buf, at, value) => {
  const i = Math.round(at * RATE);
  if (i >= 0 && i < buf.length) buf[i] += value;
};

/** Exponential decay envelope with a short attack. */
function env(t, { attack = 0.005, decay = 0.3, sustain = 0, hold = 0 }) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  const afterHold = t - attack - hold;
  if (afterHold < 0) return 1;
  const level = Math.exp(-afterHold / decay);
  return Math.max(level, sustain * Math.exp(-afterHold / (decay * 3)));
}

/** A detuned saw-ish voice built from a handful of partials. */
function voice(buf, { freq, start, dur, gain = 0.2, partials = 6, detune = 0.004, attack = 0.008, decay = 0.5 }) {
  const n = Math.round(dur * RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const e = env(t, { attack, decay, hold: dur * 0.35 });
    if (e <= 0.0005) continue;
    let sample = 0;
    for (let p = 1; p <= partials; p += 1) {
      const amp = 1 / p;
      sample += amp * Math.sin(2 * Math.PI * freq * p * (1 + detune) * t);
      sample += amp * Math.sin(2 * Math.PI * freq * p * (1 - detune) * t);
    }
    add(buf, start + t, (sample / (partials * 2)) * gain * e);
  }
}

function bell(buf, { freq, start, dur, gain = 0.12 }) {
  const n = Math.round(dur * RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const e = Math.exp(-t / (dur * 0.32));
    add(buf, start + t, Math.sin(2 * Math.PI * freq * t) * gain * e * 0.9
      + Math.sin(2 * Math.PI * freq * 2.76 * t) * gain * e * 0.25);
  }
}

function sub(buf, { start, dur, from = 90, to = 38, gain = 0.6 }) {
  const n = Math.round(dur * RATE);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const f = from * (to / from) ** (t / dur);
    phase += (2 * Math.PI * f) / RATE;
    add(buf, start + t, Math.sin(phase) * gain * Math.exp(-t / (dur * 0.35)));
  }
}

/** Band-passed noise, swept with a simple state-variable filter. */
function noise(buf, { start, dur, gain = 0.25, fromHz = 400, toHz = 4200, q = 1.4, shape = 'up' }) {
  const n = Math.round(dur * RATE);
  let low = 0;
  let band = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const p = t / dur;
    const cutoff = fromHz * (toHz / fromHz) ** p;
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, RATE * 0.45)) / RATE);
    const input = Math.random() * 2 - 1;
    const high = input - low - q * band;
    band += f * high;
    low += f * band;
    const amp = shape === 'up' ? p ** 1.6 : Math.exp(-t / (dur * 0.22));
    add(buf, start + t, band * gain * amp);
  }
}

/* ----------------------------------------------------------------- cues */

const CUES = {
  /** The build under the light beam. */
  beam() {
    const buf = buffer(1.05);
    noise(buf, { start: 0, dur: 0.9, gain: 0.3, fromHz: 320, toHz: 5200, shape: 'up' });
    sub(buf, { start: 0, dur: 0.95, from: 44, to: 96, gain: 0.32 });
    return buf;
  },

  /** Punch on the position card. */
  position() {
    return chime(523.25);
  },

  /** Punch on the club card — a fourth higher. */
  team() {
    return chime(698.46);
  },

  /** The payoff as the player card walks out. */
  reveal() {
    const buf = buffer(2.2);
    noise(buf, { start: 0, dur: 0.12, gain: 0.3, fromHz: 3000, toHz: 900, shape: 'down' });
    sub(buf, { start: 0, dur: 1.7, from: 96, to: 34, gain: 0.62 });
    [261.63, 392.0, 523.25, 659.25, 783.99].forEach((f, i) => {
      voice(buf, { freq: f, start: 0.005 * i, dur: 1.75, gain: i === 0 ? 0.16 : 0.13, decay: 0.9 });
    });
    [1046.5, 1318.51, 1567.98, 2093.0].forEach((f, i) => {
      bell(buf, { freq: f, start: 0.04 + i * 0.055, dur: 1.2, gain: 0.1 });
    });
    return buf;
  },

  /** Round 2+ payoff. */
  sting() {
    const buf = buffer(0.5);
    noise(buf, { start: 0, dur: 0.09, gain: 0.28, fromHz: 3400, toHz: 1200, shape: 'down' });
    sub(buf, { start: 0, dur: 0.3, from: 70, to: 42, gain: 0.34 });
    voice(buf, { freq: 587.33, start: 0.005, dur: 0.16, gain: 0.2, decay: 0.09 });
    voice(buf, { freq: 880.0, start: 0.115, dur: 0.28, gain: 0.2, decay: 0.13 });
    bell(buf, { freq: 1760, start: 0.12, dur: 0.3, gain: 0.1 });
    return buf;
  },

  /** Subtle mode. */
  tick() {
    const buf = buffer(0.16);
    bell(buf, { freq: 1244.51, start: 0, dur: 0.09, gain: 0.14 });
    bell(buf, { freq: 1661.22, start: 0.035, dur: 0.08, gain: 0.09 });
    return buf;
  },
};

function chime(base) {
  const buf = buffer(0.62);
  noise(buf, { start: 0, dur: 0.08, gain: 0.3, fromHz: 3600, toHz: 1400, shape: 'down' });
  sub(buf, { start: 0, dur: 0.34, from: 86, to: 44, gain: 0.44 });
  voice(buf, { freq: base, start: 0, dur: 0.22, gain: 0.2, decay: 0.1 });
  bell(buf, { freq: base * 2, start: 0.006, dur: 0.45, gain: 0.16 });
  bell(buf, { freq: base * 3, start: 0.02, dur: 0.32, gain: 0.07 });
  return buf;
}

/* ------------------------------------------------------------- encoding */

/** Soft-clip, then trim the tail so files stay small. */
function finalize(buf) {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const norm = peak > 0 ? 0.89 / peak : 1;

  const pcm = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i += 1) {
    const v = Math.tanh(buf[i] * norm);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return pcm;
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(1, 22);          // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataSize)]);
}

async function loadEncoder() {
  try {
    const mod = await import('@breezystack/lamejs');
    return mod.default ?? mod;
  } catch {
    try {
      const mod = await import('lamejs');
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }
}

function mp3(lame, pcm) {
  const encoder = new lame.Mp3Encoder(1, RATE, 128);
  const chunks = [];
  const blockSize = 1152;
  for (let i = 0; i < pcm.length; i += blockSize) {
    const block = pcm.subarray(i, i + blockSize);
    const encoded = encoder.encodeBuffer(block);
    if (encoded.length) chunks.push(Buffer.from(encoded));
  }
  const end = encoder.flush();
  if (end.length) chunks.push(Buffer.from(end));
  return Buffer.concat(chunks);
}

/* ---------------------------------------------------------------- main */

const lame = await loadEncoder();
const ext = lame ? 'mp3' : 'wav';
await fs.mkdir(OUT_DIR, { recursive: true });

const manifest = {};
for (const [name, make] of Object.entries(CUES)) {
  const pcm = finalize(make());
  const bytes = lame ? mp3(lame, pcm) : wav(pcm);
  const file = `${name}.${ext}`;
  await fs.writeFile(path.join(OUT_DIR, file), bytes);
  manifest[name] = file;
  console.log(`${file.padEnd(16)} ${(bytes.length / 1024).toFixed(1)} KB  ${(pcm.length / RATE).toFixed(2)}s`);
}

await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nWrote audio/manifest.json (${ext.toUpperCase()} placeholders).`);
if (!lame) console.log('Install @breezystack/lamejs to emit MP3 instead of WAV.');

/**
 * Audio-file cues.
 *
 * Drop a file into audio/ named after a cue — reveal.mp3, position.wav,
 * whatever your browser can decode — and it replaces the synthesized version
 * of that cue. Anything you don't provide falls back to the built-in synth,
 * so a half-filled folder is fine.
 *
 * audio/manifest.json is optional: use it to point a cue at a differently
 * named file, or to set a per-cue gain.
 *
 *   { "reveal": "my-fanfare.mp3", "sting": { "file": "boop.wav", "gain": 0.6 } }
 *
 * Filenames are validated (no paths, no URLs) and every request stays inside
 * audio/ on this origin, which is also all the page's CSP allows.
 */

/** Cue names, in the order the walkout plays them. */
export const CUES = ['chime'];

export const CUE_LABELS = {
  chime: 'Light beam (build)',
  // position: 'Position card',
  // team: 'Club card',
  // reveal: 'Card walkout',
  // sting: 'Round 2+ sting',
  // tick: 'Subtle blip',
};

const EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'webm', 'aac', 'flac'];
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const isSafeFilename = (name) =>
  typeof name === 'string' && SAFE_FILENAME.test(name) && !name.includes('..');

const fileUrl = (name) => `audio/${encodeURIComponent(name)}`;

export class SoundPack {
  constructor() {
    this.buffers = new Map();   // cue -> AudioBuffer
    this.gains = new Map();     // cue -> number
    this.status = new Map();    // cue -> { state, file?, error? }
    this.playing = new Map();   // cue -> AudioBufferSourceNode
    this.loading = null;
  }

  /** What the settings panel shows. */
  report() {
    return CUES.map((cue) => ({
      cue,
      label: CUE_LABELS[cue] ?? cue,
      ...(this.status.get(cue) ?? { state: 'pending' }),
    }));
  }

  has(cue) {
    return this.buffers.has(cue);
  }

  /** Load (or reload) every cue. Never throws — missing files are normal. */
  load(ctx, { force = false } = {}) {
    if (this.loading && !force) return this.loading;
    this.loading = this.#load(ctx).catch(() => {});
    return this.loading;
  }

  async #load(ctx) {
    if (!ctx) return;
    this.buffers.clear();
    this.status.clear();

    const manifest = await this.#manifest();

    await Promise.all(CUES.map(async (cue) => {
      const entry = manifest[cue];

      // An explicit null in the manifest means "always use the synth".
      if (entry === null) {
        this.status.set(cue, { state: 'synth-forced' });
        return;
      }

      const named = typeof entry === 'string' ? entry : entry?.file;
      const gain = Number(typeof entry === 'object' && entry ? entry.gain : NaN);
      if (Number.isFinite(gain)) this.gains.set(cue, Math.max(0, Math.min(4, gain)));

      const candidates = named
        ? (isSafeFilename(named) ? [named] : [])
        : EXTENSIONS.map((ext) => `${cue}.${ext}`);

      if (named && !candidates.length) {
        this.status.set(cue, { state: 'error', file: String(named), error: 'unsafe filename' });
        return;
      }

      for (const file of candidates) {
        // eslint-disable-next-line no-await-in-loop
        const buffer = await this.#decode(ctx, file);
        if (buffer) {
          this.buffers.set(cue, buffer);
          this.status.set(cue, { state: 'file', file, seconds: buffer.duration });
          return;
        }
      }
      this.status.set(cue, { state: named ? 'error' : 'synth', file: named, error: named ? 'could not load' : undefined });
    }));
  }

  async #manifest() {
    try {
      const res = await fetch('audio/manifest.json', { cache: 'no-store' });
      if (!res.ok) return {};
      const json = await res.json();
      return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
    } catch {
      return {};   // no manifest is the normal case
    }
  }

  async #decode(ctx, file) {
    try {
      const res = await fetch(fileUrl(file), { cache: 'no-store' });
      if (!res.ok) return null;
      const bytes = await res.arrayBuffer();
      if (!bytes.byteLength) return null;
      return await ctx.decodeAudioData(bytes);
    } catch {
      return null;   // missing file, or a format this browser can't decode
    }
  }

  /**
   * Play a cue from its file.
   * @returns {boolean} false if there is no file for it — caller falls back.
   */
  play(ctx, destination, cue) {
    const buffer = this.buffers.get(cue);
    if (!buffer || !ctx || !destination) return false;

    this.stop(cue);

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const gainValue = this.gains.get(cue);
    if (gainValue == null) {
      src.connect(destination);
    } else {
      const gain = ctx.createGain();
      gain.gain.value = gainValue;
      src.connect(gain).connect(destination);
      src.onended = () => { try { gain.disconnect(); } catch { /* ignore */ } };
    }

    src.start();
    this.playing.set(cue, src);
    src.addEventListener('ended', () => {
      if (this.playing.get(cue) === src) this.playing.delete(cue);
    });
    return true;
  }

  stop(cue) {
    const src = this.playing.get(cue);
    if (!src) return;
    try { src.stop(); } catch { /* already finished */ }
    this.playing.delete(cue);
  }

  /** Cut every ringing cue — used when a new walkout starts. */
  stopAll() {
    for (const cue of [...this.playing.keys()]) this.stop(cue);
  }
}

/**
 * Original stingers, synthesized in the browser with the Web Audio API.
 *
 * Nothing here is sampled or copied: every sound is built from oscillators
 * and generated noise at runtime, so there is no licensed audio in this repo
 * and nothing to download.
 *
 * The walkout is scored in beats, so each cue is its own call:
 *
 *   riser(ms)  — the build under the light beam before the first flash
 *   hit(step)  — the percussive chime that punches in each phase card
 *                (position, then team); pitch rises with the step
 *   reveal()   — the payoff when the player card walks out: sub boom, a
 *                sustained major chord and a bell shimmer (~1.8s)
 *   sting()    — round 2+ payoff: a clipped two-note blip (~0.45s)
 *   tick()     — subtle mode: a single soft blip (~0.08s)
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.comp = null;
    this.noiseBuffer = null;
    this.enabled = false;
    this.volume = 0.7;
  }

  /** Must be called from a user gesture — browsers block audio otherwise. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return true;
    }
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) return false;
    try {
      this.ctx = new Ctor();
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 8;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.22;

      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;

      this.comp.connect(this.master).connect(this.ctx.destination);
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (this.enabled) this.unlock();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  get ready() {
    return Boolean(this.enabled && this.ctx && this.master);
  }

  /* ------------------------------------------------------- primitives */

  _noise() {
    if (!this.noiseBuffer) {
      const len = Math.floor(this.ctx.sampleRate * 2);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    return src;
  }

  /** One voice: two slightly detuned oscillators through a swept lowpass. */
  _voice(freq, t0, dur, { type = 'sawtooth', gain = 0.16, detune = 7, cutoff = [700, 5200], attack = 0.012 } = {}) {
    const { ctx } = this;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(cutoff[0], t0);
    filter.frequency.exponentialRampToValueAtTime(cutoff[1], t0 + Math.min(0.22, dur * 0.5));
    filter.frequency.exponentialRampToValueAtTime(Math.max(240, cutoff[0] * 0.6), t0 + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    env.gain.setValueAtTime(gain, t0 + Math.max(attack, dur * 0.55));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    filter.connect(env).connect(this.comp);

    for (const cents of [-detune, detune]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      osc.detune.setValueAtTime(cents, t0);
      osc.connect(filter);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
      osc.onended = () => osc.disconnect();
    }
    setTimeout(() => { try { env.disconnect(); filter.disconnect(); } catch { /* ignore */ } },
      (t0 - ctx.currentTime + dur + 0.4) * 1000);
  }

  _bell(freq, t0, dur, gain = 0.08) {
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env).connect(this.comp);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  }

  _sub(t0, { from = 78, to = 38, dur = 0.85, gain = 0.5 } = {}) {
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + dur * 0.8);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env).connect(this.comp);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  }

  _riser(t0, dur = 0.5, gain = 0.18) {
    const { ctx } = this;
    const src = this._noise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(340, t0);
    bp.frequency.exponentialRampToValueAtTime(4600, t0 + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.85);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.12);

    src.connect(bp).connect(env).connect(this.comp);
    src.start(t0);
    src.stop(t0 + dur + 0.2);
    src.onended = () => { src.disconnect(); bp.disconnect(); env.disconnect(); };
  }

  _transient(t0, gain = 0.22) {
    const { ctx } = this;
    const src = this._noise();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    src.connect(hp).connect(env).connect(this.comp);
    src.start(t0);
    src.stop(t0 + 0.12);
    src.onended = () => { src.disconnect(); hp.disconnect(); env.disconnect(); };
  }

  /* ----------------------------------------------------------- cues */

  /** The build under the light beam. `ms` matches the beam's growth. */
  riser(ms = 900) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.01;
    const dur = Math.max(0.2, ms / 1000);
    this._riser(t, dur, 0.16);
    this._sub(t, { from: 46, to: 92, dur, gain: 0.26 });
  }

  /**
   * A phase punch: metallic chime plus a transient and a short sub thump.
   * Step 0 is the position card, step 1 the team card, step 2+ climbs.
   */
  hit(step = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.01;
    const base = [523.25, 659.25, 783.99][Math.min(2, Math.max(0, step))];

    this._transient(t, 0.2);
    this._sub(t, { from: 86, to: 44, dur: 0.34, gain: 0.42 });
    this._voice(base, t, 0.2, { gain: 0.12, cutoff: [1000, 5600], attack: 0.005 });
    this._bell(base * 2, t + 0.006, 0.42, 0.075);
    this._bell(base * 3, t + 0.02, 0.3, 0.035);
  }

  /** The payoff when the card walks out. */
  reveal() {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.02;

    this._transient(t, 0.2);
    this._sub(t, { from: 96, to: 34, dur: 1.6, gain: 0.6 });

    const chord = [261.63, 392.0, 523.25, 659.25, 783.99];
    chord.forEach((f, i) => this._voice(f, t, 1.7, {
      gain: i === 0 ? 0.13 : 0.105,
      cutoff: [900, 6400],
      attack: 0.018,
    }));

    [1046.5, 1318.5, 1567.98, 2093.0].forEach((f, i) => this._bell(f, t + 0.04 + i * 0.055, 1.2, 0.05));
  }

  /** Round 2+: short sting, ~0.45s. */
  sting() {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.01;
    this._transient(t, 0.16);
    this._sub(t, { from: 70, to: 42, dur: 0.3, gain: 0.3 });
    this._voice(587.33, t + 0.005, 0.14, { gain: 0.13, cutoff: [900, 4800], attack: 0.006 });
    this._voice(880.0, t + 0.115, 0.24, { gain: 0.13, cutoff: [1100, 6000], attack: 0.006 });
    this._bell(1760.0, t + 0.12, 0.34, 0.045);
  }

  /** Subtle mode: barely-there confirmation blip. */
  tick() {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.01;
    this._bell(1244.51, t, 0.09, 0.05);
    this._bell(1661.22, t + 0.035, 0.08, 0.03);
  }
}

export const audio = new AudioEngine();

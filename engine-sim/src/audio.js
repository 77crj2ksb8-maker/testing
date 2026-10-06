// Procedural engine sound with the Web Audio API.
//
//  bank oscillators (PeriodicWave built from the real firing pattern, one per
//  exhaust bank, panned left/right) + sawtooth at firing frequency + triangle
//  at half of it → waveshaper (load-dependent drive) → dynamic low-pass →
//  exhaust resonance → engine gain ─┐
//  intake noise → band-pass (tracks rpm) → intake gain ─┼→ compressor → out
//  gear whine, starter motor, grind and overrun pops ───┘
//
// iOS Safari only lets audio start inside a user gesture, so nothing is created
// until unlock() runs from the first touchstart / pointerdown / keydown.

import { exhaustSpectra } from './exhaust.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function driveCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = Math.max(0.01, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.profile = null;
    this.banks = [];
    this.prevThrottle = 0;
    this.popCooldown = 0;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Call synchronously from a user gesture handler. Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        // Safari 17+: play through the ring/silent switch like a media app.
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {
        /* not supported */
      }
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.build();
      if (this.profile) this.setProfile(this.profile);
    }
    if (this.ctx.state !== 'running') {
      this.ctx.resume().catch(() => {});
      // A one-sample silent buffer started inside the gesture unlocks older iOS.
      const buffer = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.ctx.destination);
      src.start(0);
    }
    return true;
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running' && !this.muted) this.ctx.resume().catch(() => {});
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.03);
  }

  build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(ctx.destination);

    // Exhaust chain.
    this.engineBus = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.Q.value = 0.8;
    this.body = ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 140;
    this.body.Q.value = 1.1;
    this.body.gain.value = 7;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineBus.connect(this.shaper).connect(this.lowpass).connect(this.body).connect(this.engineGain).connect(this.master);

    // Tonal layer: sawtooth at firing frequency blended with a triangle sub-octave.
    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.sawGain = ctx.createGain();
    this.sawGain.gain.value = 0;
    this.saw.connect(this.sawGain).connect(this.engineBus);
    this.tri = ctx.createOscillator();
    this.tri.type = 'triangle';
    this.triGain = ctx.createGain();
    this.triGain.gain.value = 0;
    this.tri.connect(this.triGain).connect(this.engineBus);

    // Shared white-noise buffer for intake roar, pops and grinding.
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.noise = ctx.createBufferSource();
    this.noise.buffer = this.noiseBuffer;
    this.noise.loop = true;
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 0.9;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.noise.connect(this.intakeFilter).connect(this.intakeGain).connect(this.master);

    // Straight-cut gear whine.
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.master);

    // Starter motor: a buzzy square wave chopped by the compression strokes.
    this.starter = ctx.createOscillator();
    this.starter.type = 'square';
    this.starter.frequency.value = 92;
    this.starterFilter = ctx.createBiquadFilter();
    this.starterFilter.type = 'lowpass';
    this.starterFilter.frequency.value = 900;
    this.starterGain = ctx.createGain();
    this.starterGain.gain.value = 0;
    this.starterLfo = ctx.createOscillator();
    this.starterLfo.type = 'sine';
    this.starterLfo.frequency.value = 8;
    this.starterLfoGain = ctx.createGain();
    this.starterLfoGain.gain.value = 0;
    this.starterLfo.connect(this.starterLfoGain).connect(this.starterGain.gain);
    this.starter.connect(this.starterFilter).connect(this.starterGain).connect(this.master);

    for (const o of [this.saw, this.tri, this.noise, this.whine, this.starter, this.starterLfo]) o.start();
  }

  setProfile(profile) {
    this.profile = profile;
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (const b of this.banks) {
      b.osc.stop();
      b.osc.disconnect();
      b.gain.disconnect();
      b.pan?.disconnect();
    }
    const spectra = exhaustSpectra(profile, 180);
    this.banks = spectra.map((sp, i) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(ctx.createPeriodicWave(sp.real, sp.imag));
      osc.frequency.value = profile.idleRpm / 120;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      let pan = null;
      osc.connect(gain);
      if (spectra.length > 1 && ctx.createStereoPanner) {
        pan = ctx.createStereoPanner();
        pan.pan.value = i === 0 ? -0.45 : 0.45;
        gain.connect(pan).connect(this.engineBus);
      } else gain.connect(this.engineBus);
      osc.start();
      return { osc, gain, pan };
    });
    this.shaper.curve = driveCurve(profile.exhaust.drive);
    this.body.frequency.value = profile.kind === 'rotary' ? 210 : profile.cylinders.length >= 10 ? 190 : 130;
  }

  /** Per-frame update from the simulator state. */
  update(sim, dt) {
    if (!this.running || !this.profile) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const p = sim.profile;
    const rpm = Math.max(0, sim.rpm);
    const rpmN = clamp(rpm / p.redlineRpm, 0, 1.1);
    const tc = 0.012;

    const firing = (rpm / 60) * p.pulsesPerRev;
    const combusting = sim.running && !sim.fuelCut;
    const load = combusting ? sim.throttleEffective : 0;
    const level = sim.running ? (sim.fuelCut ? 0.12 : 0.35 + 0.65 * Math.sqrt(load)) : 0;

    for (const b of this.banks) {
      b.osc.frequency.setTargetAtTime(Math.max(0.5, rpm / 120), t, tc);
      b.gain.gain.setTargetAtTime(level * 0.8, t, tc);
    }
    this.saw.frequency.setTargetAtTime(Math.max(1, firing), t, tc);
    this.sawGain.gain.setTargetAtTime(level * (0.05 + 0.12 * load), t, tc);
    this.tri.frequency.setTargetAtTime(Math.max(1, firing / 2), t, tc);
    this.triGain.gain.setTargetAtTime(level * 0.12 * (1 - rpmN * 0.6), t, tc);

    const cutoff = 220 + rpm * 0.32 + load * 3200 + rpmN * 1200;
    this.lowpass.frequency.setTargetAtTime(clamp(cutoff, 120, 16000), t, 0.03);
    this.engineGain.gain.setTargetAtTime(sim.running ? 0.42 + 0.28 * rpmN : 0, t, sim.running ? 0.03 : 0.12);

    this.intakeFilter.frequency.setTargetAtTime(280 + rpm * 0.24, t, 0.03);
    this.intakeGain.gain.setTargetAtTime(combusting ? load * (0.05 + 0.13 * rpmN) : 0, t, 0.04);

    const inHz = Math.abs(sim.inputOmega) / (2 * Math.PI);
    const whine = sim.gear === 'N' ? 0 : clamp(sim.speedKmh / 250, 0, 1) * (sim.gear === 'R' ? 0.09 : 0.025);
    this.whine.frequency.setTargetAtTime(Math.max(20, inHz * 23), t, 0.03);
    this.whineGain.gain.setTargetAtTime(whine, t, 0.05);

    const cranking = sim.cranking;
    this.starterGain.gain.setTargetAtTime(cranking ? 0.1 : 0, t, 0.02);
    this.starterLfoGain.gain.setTargetAtTime(cranking ? 0.08 : 0, t, 0.02);
    this.starterLfo.frequency.setTargetAtTime(Math.max(2, (rpm / 60) * p.pulsesPerRev), t, 0.02);
    this.starter.frequency.setTargetAtTime(70 + rpm * 0.12, t, 0.05);

    // Overrun pops when the throttle snaps shut at high rpm.
    this.popCooldown -= dt;
    if (sim.running && this.prevThrottle > 0.6 && sim.throttleInput < 0.05 && rpm > p.redlineRpm * 0.55 && this.popCooldown <= 0) {
      this.popCooldown = 1.2;
      const count = 3 + Math.floor(Math.random() * 5);
      for (let i = 0; i < count; i++) this.pop(t + 0.06 + Math.random() * 0.7, 0.5 + Math.random() * 0.5);
    }
    this.prevThrottle = sim.throttleInput;
  }

  noiseBurst(at, duration, freq, q, gainValue) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gainValue, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, at + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(at, Math.random() * 1.5, duration + 0.05);
    return g;
  }

  pop(at, strength) {
    if (!this.running) return;
    this.noiseBurst(at, 0.07, 500 + Math.random() * 900, 1.4, 0.55 * strength);
  }

  grind() {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = this.noiseBurst(t, 0.45, 2300, 2.5, 0.5);
    // Rattle the grind with a fast tremolo.
    const lfo = ctx.createOscillator();
    lfo.type = 'sawtooth';
    lfo.frequency.value = 48;
    const depth = ctx.createGain();
    depth.gain.value = 0.35;
    lfo.connect(depth).connect(g.gain);
    lfo.start(t);
    lfo.stop(t + 0.5);
  }

  clunk() {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.12);
    this.noiseBurst(t, 0.03, 3200, 1, 0.12);
  }
}

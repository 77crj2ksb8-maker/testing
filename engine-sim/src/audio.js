// Procedural engine sound with the Web Audio API.
//
//  cycle clock (rpm/120 Hz, ConstantSource) drives every engine-synchronous oscillator
//
//  per bank: light-load wave ─┐ crossfade by load → pan ─┐
//            heavy-load wave ─┘                          │
//  engine bus → drive → tanh shaper → exhaust rasp(+) → muffler low-pass → body
//    → pipe resonator (feedback comb, length from the engine, pitch from EGT) → engine out
//  intake: noise + light wave → band-pass (airbox) pulsing at firing rate → VVL shelf
//  valvetrain ticks and rod knock: noise gated by click trains on the cycle clock
//  turbo whistle + spool hiss, supercharger whine, gear whine, starter motor
//  one-shots (pops, bangs, BOV, failure) from pre-rendered buffers, ≤ 12 alive
//  everything → master (mute) → compressor → safety limiter → out
//               └→ short generated-room reverb (ConvolverNode) ─┘
//
// iOS Safari only lets audio start inside a user gesture, so nothing is created
// until unlock() runs from the first touchstart / pointerdown / keydown.

import { clamp, driveCurve, follow, heavyMix, limiterCurve, LIMITER_INPUT_GAIN, mulberry32, smoothstep, whiteNoise } from './audio/dsp.js';
import { impulseResponse } from './audio/impulse.js';
import { renderSample, SAMPLE_KINDS } from './audio/samples.js';
import { backfirePlan, Cooldowns, MAX_ONE_SHOTS, PRIORITY, VoicePool } from './audio/voices.js';
import { loadWaveTables, pipeDelay, rodKnockTrain, valveTickTrain, waveKey } from './audio/wavetables.js';

const MASTER_LEVEL = 0.8;
const REVERB_WET = 0.25;
const TURBO_MAX_RPM = 200000;

/** setTargetAtTime that skips values that have not really changed, so idle frames queue no automation. */
class Glide {
  constructor(param) {
    this.param = param;
    this.last = NaN;
  }

  to(value, t, tc) {
    // A non-finite target would make setTargetAtTime throw on every frame.
    if (!Number.isFinite(value)) return;
    if (Math.abs(value - this.last) <= 1e-4 + Math.abs(value) * 1e-3) return;
    this.last = value;
    this.param.setTargetAtTime(value, t, tc);
  }

  reset() {
    this.last = NaN;
  }
}

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.offline = false;
    this.muted = false;
    this.wantSuspended = false;
    this.profile = null;
    this.banks = [];
    this.waveKey = '';
    this.buffers = {};
    this.pool = new VoicePool(MAX_ONE_SHOTS);
    this.cooldowns = new Cooldowns();
    this.rand = mulberry32(0x5eed);
    this.live = new Set(); // one-shot sources started and neither ended nor stolen
    this.dead = false; // blown engine: silent until repair
    this.simBlown = false; // the simulator itself reported blown while dead
    this.vvlOn = false;
    this.load = 0;
    this.vvlMix = 0;
    this.warmTimer = 0;
    this.meterNode = null;
    this.meterData = null;
    this.bankParams = [];
  }

  get running() {
    return !!this.ctx && (this.offline || this.ctx.state === 'running');
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
      let ctx;
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        return false;
      }
      this.attach(ctx);
    }
    if (this.ctx.state !== 'running' && !this.muted) {
      this.wantSuspended = false;
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

  /**
   * Build the graph on `ctx`. unlock() does this for the live context; tests
   * can pass an OfflineAudioContext with offline=true to render deterministically.
   */
  attach(ctx, { offline = false } = {}) {
    this.ctx = ctx;
    this.offline = offline;
    this.build();
    if (this.profile) this.setProfile(this.profile);
    if (offline) this.warm(true);
    else {
      // iOS interrupts audio for calls, Siri and other apps; try to come back on our own.
      ctx.onstatechange = () => {
        const s = ctx.state;
        if ((s === 'suspended' || s === 'interrupted') && !this.wantSuspended && !this.muted && !document.hidden) {
          setTimeout(() => {
            if (!this.wantSuspended && !this.muted && !document.hidden) this.resume();
          }, 400);
        }
      };
      this.warm(false);
    }
  }

  suspend() {
    this.wantSuspended = true;
    if (this.ctx && !this.offline && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume() {
    this.wantSuspended = false;
    if (this.ctx && !this.offline && this.ctx.state !== 'running' && !this.muted) this.ctx.resume().catch(() => {});
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, t, 0.03);
    if (this.offline) return;
    if (muted) {
      // Fade out, then stop the audio thread entirely to save battery.
      setTimeout(() => {
        if (this.muted && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
      }, 200);
    } else if (!this.wantSuspended) this.ctx.resume().catch(() => {});
  }

  // ── Graph ─────────────────────────────────────────────────────────────────

  build() {
    const ctx = this.ctx;
    // Nodes from any previous context are gone: setProfile() must rebuild the voice.
    this.waveKey = '';
    this.banks = [];
    const gain = (v = 1) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type, freq, q = 0.707) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const panner = (pan) => {
      if (!ctx.createStereoPanner) return gain(1);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      return p;
    };
    this.panner = panner;

    // Output stage: mute → compressor → limiter that can never exceed 0.98.
    this.master = gain(this.muted ? 0 : MASTER_LEVEL);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    const limitIn = gain(LIMITER_INPUT_GAIN);
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = limiterCurve();
    this.master.connect(comp).connect(limitIn).connect(this.limiter).connect(ctx.destination);

    // Room: a short generated impulse response, mixed in quietly.
    this.reverbSend = gain(1);
    this.convolver = ctx.createConvolver();
    this.reverbWet = gain(REVERB_WET);
    this.reverbSend.connect(this.convolver).connect(this.reverbWet).connect(this.master);

    // One looping noise source feeds intake, rasp, ticks, knock and spool hiss.
    const noiseLen = Math.round(ctx.sampleRate * 2);
    this.noiseBuffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    this.noiseBuffer.getChannelData(0).set(whiteNoise(noiseLen, 0x0dd));
    this.noise = ctx.createBufferSource();
    this.noise.buffer = this.noiseBuffer;
    this.noise.loop = true;

    // Cycle clock: one 720° engine cycle per period. Oscillators that hang off
    // it share the exact same frequency, so the load crossfade never beats.
    this.clock = ctx.createConstantSource ? ctx.createConstantSource() : null;
    if (this.clock) this.clock.offset.value = 0;
    this.toFiring = gain(4); // cycle → firing frequency (2 × pulses per rev)
    this.clock?.connect(this.toFiring);
    this.cycleParams = [];
    this.firingParams = [];
    const syncCycle = (param) => {
      if (this.clock) {
        param.value = 0;
        this.clock.connect(param);
      } else this.cycleParams.push(param);
    };
    const syncFiring = (param) => {
      if (this.clock) {
        param.value = 0;
        this.toFiring.connect(param);
      } else this.firingParams.push(param);
    };

    // Exhaust chain.
    this.engineBus = gain(1);
    this.drive = gain(1);
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.shaper.curve = driveCurve(2);
    this.driveAmount = 2;
    this.postDrive = gain(1);
    this.lowpass = filter('lowpass', 800, 0.8);
    this.body = filter('peaking', 140, 1.1);
    this.body.gain.value = 6;
    this.engineBus.connect(this.drive).connect(this.shaper).connect(this.postDrive).connect(this.lowpass).connect(this.body);
    // Pipe resonance: a damped feedback comb in parallel with the dry exhaust.
    this.pipeDelay = ctx.createDelay(0.05);
    this.pipeDelay.delayTime.value = 0.0075;
    this.pipeDamp = filter('lowpass', 1400, 0.5);
    this.pipeFeedback = gain(0.5);
    this.pipeOut = gain(0.4);
    this.body.connect(this.pipeDelay).connect(this.pipeDamp).connect(this.pipeFeedback).connect(this.pipeDelay);
    this.pipeDamp.connect(this.pipeOut);
    this.engineOut = gain(0);
    this.body.connect(this.engineOut);
    this.pipeOut.connect(this.engineOut);
    this.engineOut.connect(this.master);
    this.engineOut.connect(this.reverbSend);

    // Exhaust rasp: turbulent noise amplitude-modulated by the blowdown pulses.
    this.raspFilter = filter('bandpass', 2200, 0.7);
    this.raspGate = gain(0);
    this.raspGain = gain(0);
    this.noise.connect(this.raspFilter).connect(this.raspGate).connect(this.raspGain).connect(this.postDrive);

    // Intake: airbox band-pass over noise and a little of the pulse wave,
    // breathing at the firing rate, brighter with the high cam.
    this.intakeFilter = filter('bandpass', 400, 0.9);
    this.intakePulse = gain(0.65);
    this.intakeLfo = ctx.createOscillator();
    this.intakeLfo.type = 'sine';
    syncFiring(this.intakeLfo.frequency);
    const lfoDepth = gain(0.35);
    this.intakeLfo.connect(lfoDepth).connect(this.intakePulse.gain);
    this.intakeShelf = filter('highshelf', 2500);
    this.intakeShelf.gain.value = 0;
    this.intakeGain = gain(0);
    this.intakeTone = gain(0.15);
    this.intakeTone.connect(this.intakeFilter);
    this.noise.connect(this.intakeFilter).connect(this.intakePulse).connect(this.intakeShelf).connect(this.intakeGain);
    this.intakePan = panner(0.22);
    this.intakeGain.connect(this.intakePan).connect(this.master);
    this.intakePan.connect(this.reverbSend);

    // Valvetrain ticks and rod knock: noise gated by click trains.
    const gate = (filterNode) => {
      const osc = ctx.createOscillator();
      syncCycle(osc.frequency);
      const g = gain(0);
      const out = gain(0);
      osc.connect(g.gain);
      this.noise.connect(filterNode).connect(g).connect(out);
      return { osc, gate: g, out, level: 1 };
    };
    this.tick = gate(filter('highpass', 3800, 0.8));
    this.tick.out.connect(this.master);
    this.knock = gate(filter('bandpass', 620, 2.2));
    // The click pulses also strike a resonance: the metallic ring of the block.
    this.knockRing = filter('bandpass', 760, 6);
    const ringLevel = gain(6);
    this.knock.osc.connect(this.knockRing).connect(ringLevel).connect(this.knock.out);
    this.knockBody = filter('peaking', 280, 1.2);
    this.knockBody.gain.value = 9;
    this.knock.out.connect(this.knockBody).connect(this.master);
    this.knockBody.connect(this.reverbSend);

    // Turbo: shaft whistle (two detuned for twins) and spool hiss.
    this.turboPan = panner(0.3);
    this.turboPanB = panner(-0.3);
    this.whistleA = ctx.createOscillator();
    this.whistleB = ctx.createOscillator();
    this.whistleGainA = gain(0);
    this.whistleGainB = gain(0);
    this.whistleA.connect(this.whistleGainA).connect(this.turboPan);
    this.whistleB.connect(this.whistleGainB).connect(this.turboPanB);
    this.spoolFilter = filter('bandpass', 3000, 1.4);
    this.spoolGain = gain(0);
    this.noise.connect(this.spoolFilter).connect(this.spoolGain).connect(this.turboPan);
    for (const p of [this.turboPan, this.turboPanB]) {
      p.connect(this.master);
      p.connect(this.reverbSend);
    }

    // Supercharger: lobed-rotor whine (fundamental plus two partials).
    this.scOsc = ctx.createOscillator();
    this.scOsc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.5, 0.28])));
    this.scFilter = filter('bandpass', 1000, 1.6);
    this.scGain = gain(0);
    this.scOsc.connect(this.scFilter).connect(this.scGain).connect(this.master);

    // Straight-cut gear whine.
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whineGain = gain(0);
    this.whine.connect(this.whineGain).connect(this.master);

    // Starter motor: a buzzy square wave chopped by the compression strokes.
    this.starter = ctx.createOscillator();
    this.starter.type = 'square';
    this.starter.frequency.value = 92;
    this.starterFilter = filter('lowpass', 900);
    this.starterGain = gain(0);
    this.starterLfo = ctx.createOscillator();
    this.starterLfo.type = 'sine';
    this.starterLfo.frequency.value = 8;
    this.starterLfoGain = gain(0);
    this.starterLfo.connect(this.starterLfoGain).connect(this.starterGain.gain);
    this.starter.connect(this.starterFilter).connect(this.starterGain).connect(this.master);

    // One-shots.
    this.fxBus = gain(1);
    this.fxBus.connect(this.master);
    const fxSend = gain(0.6);
    this.fxBus.connect(fxSend).connect(this.reverbSend);

    const t0 = ctx.currentTime;
    for (const s of [this.noise, this.clock, this.intakeLfo, this.tick.osc, this.knock.osc, this.whistleA, this.whistleB,
      this.scOsc, this.whine, this.starter, this.starterLfo]) s?.start(t0);

    const G = (param) => new Glide(param);
    this.g = {
      clock: this.clock ? G(this.clock.offset) : null,
      drive: G(this.drive.gain), postDrive: G(this.postDrive.gain), lowpass: G(this.lowpass.frequency),
      pipeDelay: G(this.pipeDelay.delayTime), pipeFeedback: G(this.pipeFeedback.gain), pipeOut: G(this.pipeOut.gain),
      engineOut: G(this.engineOut.gain), raspGain: G(this.raspGain.gain), raspFilter: G(this.raspFilter.frequency),
      intakeFilter: G(this.intakeFilter.frequency), intakeQ: G(this.intakeFilter.Q), intakeGain: G(this.intakeGain.gain),
      intakeShelf: G(this.intakeShelf.gain), intakeTone: G(this.intakeTone.gain),
      tick: G(this.tick.out.gain), knock: G(this.knock.out.gain),
      whistleA: G(this.whistleA.frequency), whistleB: G(this.whistleB.frequency),
      whistleGainA: G(this.whistleGainA.gain), whistleGainB: G(this.whistleGainB.gain),
      spoolFilter: G(this.spoolFilter.frequency), spoolGain: G(this.spoolGain.gain),
      sc: G(this.scOsc.frequency), scFilter: G(this.scFilter.frequency), scGain: G(this.scGain.gain),
      whine: G(this.whine.frequency), whineGain: G(this.whineGain.gain),
      starterGain: G(this.starterGain.gain), starterLfoGain: G(this.starterLfoGain.gain),
      starterLfo: G(this.starterLfo.frequency), starter: G(this.starter.frequency),
    };
  }

  /** Render the impulse response and one-shot samples, spread over idle time unless `sync`. */
  warm(sync) {
    const jobs = [() => this.ensureReverb(), ...SAMPLE_KINDS.map((k) => () => this.sample(k))];
    if (sync) {
      for (const j of jobs) j();
      return;
    }
    let i = 0;
    const next = () => {
      if (i >= jobs.length) return;
      jobs[i++]();
      this.warmTimer = setTimeout(next, 16);
    };
    this.warmTimer = setTimeout(next, 30);
  }

  ensureReverb() {
    if (this.convolver.buffer) return;
    const ctx = this.ctx;
    const [l, r] = impulseResponse(ctx.sampleRate);
    const ir = ctx.createBuffer(2, l.length, ctx.sampleRate);
    ir.getChannelData(0).set(l);
    ir.getChannelData(1).set(r);
    this.convolver.normalize = true;
    this.convolver.buffer = ir;
  }

  sample(kind) {
    let buf = this.buffers[kind];
    if (!buf) {
      const data = renderSample(kind, this.ctx.sampleRate, 11);
      buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      buf.getChannelData(0).set(data);
      this.buffers[kind] = buf;
    }
    return buf;
  }

  setProfile(profile) {
    this.profile = profile;
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const key = waveKey(profile);
    if (key !== this.waveKey) {
      this.waveKey = key;
      for (const b of this.banks) {
        // Fade the old voice out instead of cutting it mid-cycle.
        b.level.gain.setTargetAtTime(0, t, 0.01);
        b.light.stop(t + 0.08);
        b.heavy.stop(t + 0.08);
        b.light.onended = () => {
          for (const n of [b.light, b.heavy, b.level, b.pan]) n.disconnect();
        };
      }
      const tables = loadWaveTables(profile, 160);
      const t0 = t + 0.01;
      const wide = tables.length > 1;
      this.banks = tables.map((tab, i) => {
        const light = ctx.createOscillator();
        const heavy = ctx.createOscillator();
        light.setPeriodicWave(ctx.createPeriodicWave(tab.light.real, tab.light.imag));
        heavy.setPeriodicWave(ctx.createPeriodicWave(tab.heavy.real, tab.heavy.imag));
        const lightGain = ctx.createGain();
        const heavyGain = ctx.createGain();
        const level = ctx.createGain();
        lightGain.gain.value = tab.lightGain;
        heavyGain.gain.value = 0;
        level.gain.value = 0;
        const pan = this.panner(wide ? (i === 0 ? -0.5 : 0.5) : -0.12);
        light.connect(lightGain).connect(level);
        heavy.connect(heavyGain).connect(level);
        level.connect(pan).connect(this.engineBus);
        if (this.clock) {
          light.frequency.value = 0;
          heavy.frequency.value = 0;
          this.clock.connect(light.frequency);
          this.clock.connect(heavy.frequency);
        } else {
          light.frequency.value = profile.idleRpm / 120;
          heavy.frequency.value = profile.idleRpm / 120;
        }
        light.start(t0);
        heavy.start(t0);
        return {
          light, heavy, level, pan,
          gLight: new Glide(lightGain.gain), gHeavy: new Glide(heavyGain.gain), gLevel: new Glide(level.gain),
          kLight: tab.lightGain, kHeavy: tab.heavyGain,
        };
      });
      // The first bank's waves also drive the exhaust rasp and the intake tone.
      const first = this.banks[0];
      first.heavy.connect(this.raspGate.gain);
      first.light.connect(this.intakeTone);
      // Without a ConstantSource the bank frequencies are set directly in update().
      this.bankParams = this.clock ? [] : this.banks.flatMap((b) => [b.light.frequency, b.heavy.frequency]);

      const tick = valveTickTrain(profile);
      this.tick.level = tick ? 1 : 0;
      if (tick) {
        this.tick.osc.setPeriodicWave(ctx.createPeriodicWave(tick.real, tick.imag, { disableNormalization: true }));
        this.tick.gate.gain.value = tick.mean;
      }
      const knock = rodKnockTrain(profile);
      this.knock.osc.setPeriodicWave(ctx.createPeriodicWave(knock.real, knock.imag, { disableNormalization: true }));
      this.knock.gate.gain.value = knock.mean;
    }
    this.toFiring.gain.value = 2 * profile.pulsesPerRev;
    if (this.driveAmount !== profile.exhaust.drive) {
      this.driveAmount = profile.exhaust.drive;
      this.shaper.curve = driveCurve(this.driveAmount);
    }
    this.body.frequency.value = profile.kind === 'rotary' ? 210 : profile.cylinders.length >= 10 ? 190 : profile.cylinders.length <= 2 ? 95 : 130;
    for (const g of Object.values(this.g)) g?.reset();
  }

  // ── Per-frame update ──────────────────────────────────────────────────────

  /** Per-frame update from the simulator state. Allocation-free. */
  update(sim, dt) {
    if (!this.running || !this.profile || !this.banks.length) return;
    const t = this.ctx.currentTime;
    const g = this.g;
    const p = sim.profile || this.profile;
    this.pool.prune(t);

    // Silent until repair, however the simulator gets repaired: the 'repair'
    // event, or a blown simulator that is healthy again.
    if (sim.blown) this.simBlown = true;
    else if (this.dead && this.simBlown) this.repair();
    const dead = this.dead || !!sim.blown;
    const rpm = Math.max(0, sim.rpm);
    const rpmN = clamp(rpm / p.redlineRpm, 0, 1.15);
    const running = sim.running && !dead;
    const combusting = running && !sim.fuelCut;
    const throttle = clamp(sim.throttleEffective ?? sim.throttle ?? 0, 0, 1);
    const boost = sim.boostBar ?? 0;
    const cycle = rpm / 120;
    const firing = (rpm / 60) * p.pulsesPerRev;
    const tc = 0.012;
    const offTc = dead ? 0.015 : 0.1;

    // Load: manifold filling relative to atmosphere, so boost reads as extra load.
    // It follows the throttle, not combustion, so a limiter cut dips the level
    // (below) without softening the pulse shape.
    const loadTarget = running ? clamp(throttle * (1 + Math.max(0, boost) * 0.5), 0, 1.5) : 0;
    this.load += (loadTarget - this.load) * follow(dt, 0.06);
    const load = Math.min(1, this.load);
    const heavy = heavyMix(this.load);
    const vvl = running && (this.vvlOn || !!sim.vvlActive);
    this.vvlMix += ((vvl ? 1 : 0) - this.vvlMix) * follow(dt, 0.08);
    const vvlMix = this.vvlMix;

    // Clocked oscillators.
    if (g.clock) g.clock.to(Math.max(0.5, cycle), t, tc);
    else {
      for (let i = 0; i < this.cycleParams.length; i++) this.cycleParams[i].setTargetAtTime(Math.max(0.5, cycle), t, tc);
      for (let i = 0; i < this.bankParams.length; i++) this.bankParams[i].setTargetAtTime(Math.max(0.5, cycle), t, tc);
      for (let i = 0; i < this.firingParams.length; i++) this.firingParams[i].setTargetAtTime(Math.max(1, firing), t, tc);
    }

    // Exhaust voice.
    const level = running ? (sim.fuelCut ? 0.2 + 0.2 * rpmN : 0.22 + 0.78 * Math.pow(load, 0.6)) : 0;
    for (let i = 0; i < this.banks.length; i++) {
      const b = this.banks[i];
      b.gLight.to((1 - heavy) * b.kLight, t, 0.03);
      b.gHeavy.to(heavy * b.kHeavy, t, 0.03);
      b.gLevel.to(level, t, running ? tc : offTc);
    }
    const drive = 0.6 + 1.5 * heavy + 0.4 * rpmN;
    g.drive.to(drive, t, 0.03);
    g.postDrive.to(1 / Math.sqrt(drive), t, 0.03);
    g.lowpass.to(clamp(180 + rpm * 0.28 + load * 2600 + rpmN * 1400 + vvlMix * 900, 120, 14000), t, 0.03);
    g.pipeDelay.to(pipeDelay(p, sim.egtC ?? 350 + 500 * load), t, 0.4);
    g.pipeFeedback.to(0.42 + 0.2 * load, t, 0.05);
    g.pipeOut.to(0.3 + 0.35 * load, t, 0.05);
    g.engineOut.to(running ? 0.3 + 0.4 * rpmN : 0, t, running ? 0.03 : offTc);
    g.raspGain.to(combusting ? 0.5 * load * (0.25 + rpmN) : 0, t, 0.03);
    g.raspFilter.to(1400 + 2200 * rpmN, t, 0.05);

    // Intake.
    g.intakeFilter.to(clamp((300 + rpm * 0.22) * (1 + 0.35 * vvlMix), 120, 9000), t, 0.03);
    g.intakeQ.to(0.9 + 1.4 * vvlMix, t, 0.05);
    g.intakeShelf.to(7 * vvlMix, t, 0.05);
    g.intakeTone.to(0.12 + 0.3 * vvlMix, t, 0.05);
    g.intakeGain.to(combusting ? load * (0.18 + 0.5 * rpmN) * (1 + 0.6 * vvlMix) : running ? 0.02 : 0, t, running ? 0.04 : offTc);

    // Valvetrain tick fades out as rpm and load mask it; rod knock grows with damage.
    g.tick.to(running ? this.tick.level * 0.025 * (1 - smoothstep(0.2, 0.55, rpmN)) * (1 - 0.6 * load) : 0, t, 0.05);
    const damage = sim.damage ?? 0;
    const knock = running && damage > 0.5 ? Math.pow((damage - 0.5) / 0.5, 0.7) : 0;
    g.knock.to(knock * 0.5 * (0.45 + 0.55 * load), t, 0.05);

    // Forced induction.
    const kind = sim.inductionKind ?? 'na';
    const turbo = kind === 'turbo' || kind === 'twin-turbo';
    const shaft = turbo && !dead ? Math.max(0, sim.turboRpm ?? 0) : 0;
    const shaftN = clamp(shaft / TURBO_MAX_RPM, 0, 1.2);
    const whistleHz = clamp(250 + (shaft / 60) * 1.1, 60, 8000);
    const whistle = 0.1 * shaftN * shaftN * (0.35 + 0.65 * Math.min(1, throttle * 1.2));
    g.whistleA.to(whistleHz, t, 0.03);
    g.whistleB.to(whistleHz * 1.017, t, 0.03);
    g.whistleGainA.to(whistle, t, 0.04);
    g.whistleGainB.to(kind === 'twin-turbo' ? whistle * 0.8 : 0, t, 0.04);
    g.spoolFilter.to(clamp(1500 + (shaft / 60) * 1.8, 400, 12000), t, 0.04);
    g.spoolGain.to(0.14 * Math.pow(shaftN, 1.5) * (0.2 + 0.8 * throttle) * (boost > 0 ? 1 : 0.5), t, 0.04);
    const sc = kind === 'supercharger' && running;
    const scHz = Math.max(20, rpm * 0.16);
    g.sc.to(scHz, t, tc);
    g.scFilter.to(scHz * 1.25, t, 0.03);
    g.scGain.to(sc ? 0.18 * rpmN * (0.3 + 0.7 * throttle) : 0, t, 0.04);

    // Drivetrain whine and starter.
    const inHz = Math.abs(sim.inputOmega) / (2 * Math.PI);
    const whine = dead || sim.gear === 'N' ? 0 : clamp(sim.speedKmh / 250, 0, 1) * (sim.gear === 'R' ? 0.09 : 0.025);
    g.whine.to(Math.max(20, inHz * 23), t, 0.03);
    g.whineGain.to(whine, t, 0.05);
    const cranking = sim.cranking && !dead;
    g.starterGain.to(cranking ? 0.1 : 0, t, 0.02);
    g.starterLfoGain.to(cranking ? 0.08 : 0, t, 0.02);
    g.starterLfo.to(Math.max(2, firing), t, 0.02);
    g.starter.to(70 + rpm * 0.12, t, 0.05);
  }

  // ── One-shots ─────────────────────────────────────────────────────────────

  /**
   * Play a pre-rendered sample. Returns the source, or null when muted, not
   * unlocked or dropped by the voice cap.
   */
  play(kind, { delay = 0, gain = 1, rate = 1, priority = PRIORITY.event } = {}) {
    if (!this.running || this.muted) return null;
    const ctx = this.ctx;
    const buf = this.sample(kind);
    const at = ctx.currentTime + Math.max(0, delay);
    const slot = this.pool.acquire(ctx.currentTime, at + buf.duration / rate + 0.02, priority);
    if (!slot) return null;
    const stolen = this.pool.stolen;
    if (stolen) {
      // Stops on the same render quantum the new voice starts on.
      this.live.delete(stolen);
      try {
        stolen.stop();
      } catch {
        /* already stopped */
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.fxBus);
    src.onended = () => {
      this.live.delete(src);
      this.pool.release(src);
      src.disconnect();
      g.disconnect();
    };
    src.start(at);
    this.live.add(src);
    slot.handle = src;
    return src;
  }

  /** Exhaust pops and bangs: payload of the 'backfire' event. */
  backfire({ strength = 0.5, source = 'overrun' } = {}) {
    if (this.dead || !this.running) return;
    // A two-step cut sends 'twostep' and then this backfire in the same tick:
    // the event already fired the bang, and a second copy 30 ms later would flam.
    const banged = source === 'twostep' && this.cooldowns.recent('twostep', this.ctx.currentTime, 0.05);
    for (const v of backfirePlan(strength, source, this.rand)) {
      if (banged && v.kind === 'bang') continue;
      this.play(v.kind, { delay: v.delay, gain: v.gain * 0.85, rate: v.rate, priority: source === 'overrun' ? PRIORITY.pop : PRIORITY.event });
    }
  }

  /** Launch-limiter cut: a hard bang. */
  twoStep() {
    if (this.dead || !this.running) return;
    if (!this.cooldowns.allow('twostep', this.ctx.currentTime, 0.05)) return;
    this.play('bang', { gain: 0.75, rate: 0.92 + 0.16 * this.rand(), priority: PRIORITY.event });
  }

  /** Gear change from the sequential box or the automatic: dog-box clack, flat-shift crack. */
  shift({ flat = false, source = '' } = {}) {
    if (!this.running) return;
    if (flat && !this.dead) this.play('crack', { gain: 0.75, rate: 0.95 + 0.1 * this.rand(), priority: PRIORITY.event });
    if (source === 'sequential') this.play('clunk', { gain: 0.25, rate: 1.35, priority: PRIORITY.ui });
  }

  /** Blow-off valve vent, louder and longer with more boost. */
  blowOff({ boostBar = 0.8 } = {}) {
    if (this.dead || !this.running) return;
    if (!this.cooldowns.allow('bov', this.ctx.currentTime, 0.25)) return;
    const b = clamp(boostBar, 0.2, 2);
    this.play('bov', { gain: 0.3 + 0.45 * clamp(b / 1.2, 0, 1), rate: 1.08 - 0.12 * clamp(b / 1.5, 0, 1) + 0.06 * this.rand(), priority: PRIORITY.event });
  }

  setVvl(on) {
    this.vvlOn = !!on;
  }

  /** Valve float on a mechanical over-rev: a burst of clatter scaled by severity. */
  overrev({ severity = 0.5 } = {}) {
    if (this.dead || !this.running) return;
    if (!this.cooldowns.allow('overrev', this.ctx.currentTime, 0.6)) return;
    this.play('clatter', { gain: 0.12 + 0.35 * clamp(severity, 0, 1), rate: 1.3, priority: PRIORITY.event });
  }

  stall() {
    this.play('clunk', { gain: 0.4, rate: 0.55, priority: PRIORITY.ui });
  }

  /** Catastrophic failure: explosion, flying metal, hissing, then silence until repair(). */
  blowUp() {
    if (this.dead) return;
    this.dead = true;
    if (!this.running) return;
    this.play('explosion', { gain: 1, priority: PRIORITY.critical });
    this.play('clatter', { delay: 0.06, gain: 0.7, priority: PRIORITY.critical });
    this.play('hiss', { delay: 0.2, gain: 0.5, priority: PRIORITY.critical });
  }

  repair() {
    this.dead = false;
    this.simBlown = false;
    this.vvlOn = false;
  }

  grind() {
    this.play('grind', { gain: 0.55, rate: 0.95 + 0.1 * this.rand(), priority: PRIORITY.ui });
  }

  clunk() {
    this.play('clunk', { gain: 0.35, rate: 0.95 + 0.1 * this.rand(), priority: PRIORITY.ui });
  }

  // ── Diagnostics (tests, ?debug) ───────────────────────────────────────────

  /** One-shot voice counts: pool slots in use, sources not yet ended, drops. */
  voiceStats() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    return { active: this.pool.active(now), live: this.live.size, dropped: this.pool.dropped, cap: this.pool.cap };
  }

  /** RMS and peak of the final output over the last ~43 ms (creates an analyser on first use). */
  meter() {
    if (!this.ctx) return { rms: 0, peak: 0 };
    if (!this.meterNode) {
      this.meterNode = this.ctx.createAnalyser();
      this.meterNode.fftSize = 2048;
      this.meterData = new Float32Array(this.meterNode.fftSize);
      this.limiter.connect(this.meterNode);
    }
    this.meterNode.getFloatTimeDomainData(this.meterData);
    let sum = 0;
    let peak = 0;
    for (const v of this.meterData) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    return { rms: Math.sqrt(sum / this.meterData.length), peak };
  }
}

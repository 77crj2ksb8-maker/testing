// Audio scenario: unlocks sound with a tap, then listens to the real output
// through an AudioWorklet meter on the final stage (after compressor + limiter)
// while driving idle, revs, overrun pops, BOV, two-step, turbo, supercharger,
// VVL, rod knock, a blown engine and the rebuild. Also checks the one-shot
// voice cap, mute/suspend and renders a few seconds offline to check levels.
//
// Simulator fields the powertrain track owns (turboRpm, boostBar, damage...)
// are forced right before audio.update() so this runs with or without it.

const METER = `
class Meter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peak = 0; this.sum = 0; this.n = 0; this.maxPeak = 0;
    this.port.onmessage = () => {
      this.port.postMessage({ peak: this.peak, rms: Math.sqrt(this.sum / Math.max(1, this.n)), maxPeak: this.maxPeak });
      this.peak = 0; this.sum = 0; this.n = 0;
    };
  }
  process(inputs) {
    for (const d of inputs[0] || []) {
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
        if (a > this.maxPeak) this.maxPeak = a;
        this.sum += v * v;
        this.n++;
      }
    }
    return true;
  }
}
registerProcessor('test-meter', Meter);
`;

export default async function audio({ page, evaluate, advance, shot, expect, log, tap }) {

  // Nothing may exist before the first gesture (iOS rule).
  const before = await evaluate(() => window.__app.audio.ctx === null);
  expect(before, 'no AudioContext before the first user gesture');

  await shot('audio-boot');
  await tap('#scene');
  await page.waitForFunction(() => window.__app.audio.ctx?.state === 'running', null, { timeout: 10000 });
  expect(true, 'a tap unlocks and starts the AudioContext');

  // Software rendering hogs the main thread; the audio checks do not need pixels.
  await evaluate(async (code) => {
    const a = window.__app;
    a.__render = a.view.render;
    a.view.render = () => {};
    const ctx = a.audio.ctx;
    const url = URL.createObjectURL(new window.Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new window.AudioWorkletNode(ctx, 'test-meter');
    const sink = ctx.createGain();
    sink.gain.value = 0;
    a.audio.limiter.connect(node);
    node.connect(sink).connect(ctx.destination);
    let resolve = null;
    node.port.onmessage = (e) => resolve?.(e.data);
    window.__meter = () => new Promise((r) => {
      resolve = r;
      node.port.postMessage('read');
    });
    // Forced simulator fields, applied right before every audio update, and a
    // count of updates (headless rAF can stall for seconds under CPU load).
    window.__force = {};
    window.__updates = 0;
    const update = a.audio.update.bind(a.audio);
    a.audio.update = (sim, dt) => {
      Object.assign(sim, window.__force);
      window.__updates++;
      update(sim, dt);
    };
  }, METER);

  // Wait for `seconds` of audio time and at least `frames` audio updates, so the
  // checks hold however slowly the headless page happens to run.
  const settle = async (seconds, frames = 3) => {
    const target = await evaluate(([s, f]) => ({ t: window.__app.audio.ctx.currentTime + s, n: window.__updates + f }), [seconds, frames]);
    await page.waitForFunction((x) => window.__app.audio.ctx.currentTime >= x.t && window.__updates >= x.n, target, { timeout: 30000, polling: 20 });
  };
  const listen = async (ms) => {
    await settle(0, 2);
    await evaluate(() => window.__meter());
    await settle(ms / 1000, 2);
    return evaluate(() => window.__meter());
  };
  const force = (fields) => evaluate((f) => Object.assign(window.__force, f), fields);
  const fmt = (m) => `rms ${m.rms.toFixed(4)} peak ${m.peak.toFixed(3)}`;

  // Idle.
  await advance(1, {});
  const idle = await listen(700);
  log(`idle ${fmt(idle)}`);
  expect(idle.rms > 0.01, `idle engine is audible (${fmt(idle)})`);
  const voiceIdle = await evaluate(() => {
    const a = window.__app.audio;
    const b = a.banks[0];
    return { light: b.gLight.last / b.kLight, heavy: b.gHeavy.last / b.kHeavy, tick: a.g.tick.last };
  });
  expect(voiceIdle.light > 0.8 && voiceIdle.tick > 0.02, `idle uses the light-load wave and the valvetrain tick (light ${voiceIdle.light.toFixed(2)}, tick ${voiceIdle.tick.toFixed(3)})`);

  // Revs: hold the gas key.
  await evaluate(() => (window.__app.pedals.gas.keyHeld = 1));
  await settle(0.6, 20);
  const rev = await listen(600);
  const revState = await evaluate(() => {
    const a = window.__app;
    const b = a.audio.banks[0];
    return { rpm: a.sim.rpm, heavy: b.gHeavy.last / b.kHeavy };
  });
  log(`rev ${revState.rpm.toFixed(0)} rpm ${fmt(rev)}`);
  expect(rev.rms > idle.rms * 1.4, `full throttle is louder than idle (${fmt(rev)})`);
  expect(revState.heavy > 0.8, `full throttle crossfades to the heavy-load wave (${revState.heavy.toFixed(2)})`);
  await evaluate(() => (window.__app.pedals.gas.keyHeld = 0));
  await settle(0.8, 20);

  // Overrun pops through the voice cap: 40 at once.
  const cap = await evaluate(() => {
    const a = window.__app;
    for (let i = 0; i < 40; i++) a.bus.emit('backfire', { strength: 0.9, source: 'overrun' });
    return a.audio.voiceStats();
  });
  log(`after 40 backfires: ${JSON.stringify(cap)}`);
  expect(cap.active <= 12 && cap.live <= 12, `one-shots stay capped at 12 (active ${cap.active}, live ${cap.live})`);
  expect(cap.dropped > 0, 'extra pops are dropped rather than piling up');
  const pops = await listen(300);
  expect(pops.peak > idle.peak * 1.5, `pops are clearly audible over idle (${fmt(pops)})`);
  await settle(0.5);
  const drained = await evaluate(() => window.__app.audio.voiceStats());
  expect(drained.active === 0 && drained.live === 0, `pop voices are released when they end (active ${drained.active}, live ${drained.live})`);

  // Every backfire source and the two-step.
  await evaluate(() => {
    const b = window.__app.bus;
    b.emit('backfire', { strength: 0.5, source: 'limiter' });
    b.emit('twostep', {});
    b.emit('backfire', { strength: 0.9, source: 'twostep' });
    b.emit('shift', { from: 2, to: 3, kind: 'up', source: 'sequential', flat: true });
    b.emit('backfire', { strength: 0.7, source: 'shift' });
  });
  const bangs = await listen(250);
  expect(bangs.peak > idle.peak * 1.5, `two-step bang and flat-shift crack are audible (${fmt(bangs)})`);
  const bangVoices = await evaluate(() => window.__app.audio.voiceStats());
  expect(bangVoices.live <= 12, `voices still capped (${bangVoices.live})`);
  await settle(0.4);

  // Turbo: spool + whistle, then the blow-off valve.
  await evaluate(() => window.__app.apply({ induction: 'turbo' }, 'engine'));
  await force({ inductionKind: 'turbo', turboRpm: 170000, boostBar: 1.1 });
  await evaluate(() => (window.__app.pedals.gas.keyHeld = 1));
  await settle(0.5, 10);
  const turbo = await evaluate(() => {
    const a = window.__app.audio;
    return { whistle: a.whistleGainA.gain.value, hz: a.whistleA.frequency.value, spool: a.spoolGain.gain.value };
  });
  log(`turbo ${JSON.stringify(turbo)}`);
  expect(turbo.whistle > 0.02 && turbo.hz > 2000 && turbo.spool > 0.01, `turbo whistle and spool follow turboRpm (${turbo.hz.toFixed(0)} Hz)`);
  await evaluate(() => (window.__app.pedals.gas.keyHeld = 0));
  const bov = await evaluate(() => {
    window.__app.bus.emit('bov', { boostBar: 1.1 });
    return window.__app.audio.voiceStats();
  });
  expect(bov.live >= 1, 'blow-off valve plays on the bov event');
  const pssh = await listen(400);
  expect(pssh.rms > 0.01, `blow-off "pssh" is audible (${fmt(pssh)})`);

  // Supercharger whine.
  await evaluate(() => window.__app.apply({ induction: 'supercharger' }, 'engine'));
  await force({ inductionKind: 'supercharger', turboRpm: 0, boostBar: 0.6 });
  await evaluate(() => (window.__app.pedals.gas.keyHeld = 1));
  await settle(0.5, 10);
  const sc = await evaluate(() => {
    const a = window.__app.audio;
    return { gain: a.scGain.gain.value, hz: a.scOsc.frequency.value, whistle: a.whistleGainA.gain.value };
  });
  log(`supercharger ${JSON.stringify(sc)}`);
  expect(sc.gain > 0.01 && sc.hz > 300 && sc.whistle < 0.005, `supercharger whine replaces the turbo (${sc.hz.toFixed(0)} Hz)`);
  await evaluate(() => (window.__app.pedals.gas.keyHeld = 0));
  await evaluate(() => window.__app.apply({ induction: 'na' }, 'engine'));
  await force({ inductionKind: 'na', turboRpm: 0, boostBar: -0.6 });

  // Variable valve lift brightens the intake.
  await evaluate(() => window.__app.bus.emit('vvl', { on: true }));
  await settle(0.5);
  const vvl = await evaluate(() => window.__app.audio.intakeShelf.gain.value);
  expect(vvl > 3, `vvl on brightens the intake (+${vvl.toFixed(1)} dB shelf)`);
  await evaluate(() => window.__app.bus.emit('vvl', { on: false }));

  // Rod knock with heavy damage.
  await force({ damage: 0.9 });
  await settle(0.4);
  const knock = await evaluate(() => window.__app.audio.knock.out.gain.value);
  expect(knock > 0.1, `rod knock above 50 % damage (gain ${knock.toFixed(2)})`);
  await force({ damage: 0.3 });
  await settle(0.3);
  const noKnock = await evaluate(() => window.__app.audio.knock.out.gain.value);
  expect(noKnock < 0.01, 'no rod knock at light damage');
  await force({ damage: 0 });

  // Blown: explosion, clatter, hiss... then silence until repair.
  await evaluate(() => window.__app.bus.emit('blown', { cause: 'over-rev' }));
  const boom = await listen(500);
  log(`blown ${fmt(boom)}`);
  expect(boom.peak > 0.3, `blowing up is loud (${fmt(boom)})`);
  await settle(4.2);
  const silent = await listen(600);
  log(`after blown ${fmt(silent)}`);
  expect(silent.rms < 0.0005, `silence after the engine blows (${fmt(silent)})`);
  await evaluate(() => window.__app.bus.emit('backfire', { strength: 1, source: 'overrun' }));
  const stillSilent = await listen(300);
  expect(stillSilent.peak < 0.01, 'no pops from a blown engine');
  await evaluate(() => window.__app.actions.repair());
  await settle(0.5, 10);
  const repaired = await listen(500);
  expect(repaired.rms > 0.01, `sound returns after repair (${fmt(repaired)})`);

  // Mute fades out and suspends the context; unmute resumes.
  await evaluate(() => window.__app.actions.setMuted(true));
  // The audio clock stops once suspended, so wait on the state itself.
  await page.waitForFunction(() => window.__app.audio.ctx.state === 'suspended', null, { timeout: 5000 }).catch(() => {});
  const muted = await evaluate(() => window.__app.audio.ctx.state);
  expect(muted === 'suspended', `muting suspends the audio thread (${muted})`);
  await evaluate(() => window.__app.actions.setMuted(false));
  await page.waitForFunction(() => window.__app.audio.ctx.state === 'running', null, { timeout: 5000 });
  const unmuted = await listen(500);
  expect(unmuted.rms > 0.01, 'unmuting brings the sound back');

  const overall = await evaluate(() => window.__meter());
  expect(overall.maxPeak < 1, `final output never clips (max peak ${overall.maxPeak.toFixed(3)})`);

  // Offline render: a scripted pull through the whole graph, checked for clipping and silence.
  const offline = await evaluate(async () => {
    const live = window.__app.audio;
    const sr = 48000;
    const seconds = 4;
    const ctx = new window.OfflineAudioContext(2, sr * seconds, sr);
    const a = new live.constructor();
    a.attach(ctx, { offline: true });
    a.setProfile(window.__app.profile);
    const p = window.__app.profile;
    const sim = {
      profile: p, rpm: p.idleRpm, running: true, fuelCut: false, throttleEffective: 0.05, inputOmega: 0, speedKmh: 0,
      gear: 'N', cranking: false, boostBar: 0, turboRpm: 0, inductionKind: 'turbo', damage: 0, egtC: 400,
    };
    const step = 0.02;
    for (let t = step; t < seconds; t += step) {
      ctx.suspend(t).then(() => {
        const now = ctx.currentTime;
        if (now > 1 && now < 2.5) {
          sim.throttleEffective = 1;
          sim.rpm = Math.min(p.redlineRpm, sim.rpm + 5000 * step);
          sim.turboRpm = Math.min(190000, sim.turboRpm + 140000 * step);
          sim.boostBar = Math.min(1.2, sim.boostBar + 1 * step);
        } else if (now >= 2.5) {
          sim.throttleEffective = 0;
          sim.fuelCut = true;
          sim.rpm = Math.max(p.idleRpm, sim.rpm - 3000 * step);
          sim.turboRpm *= 0.97;
          sim.boostBar = -0.6;
        }
        a.update(sim, step);
        if (Math.abs(now - 2.5) < step / 2) {
          a.blowOff({ boostBar: 1.2 });
          for (let i = 0; i < 6; i++) a.backfire({ strength: 1, source: 'overrun' });
        }
        if (Math.abs(now - 3.2) < step / 2) a.blowUp();
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const seg = (from, to) => {
      let peak = 0;
      let sum = 0;
      let n = 0;
      let nan = false;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = Math.floor(from * sr); i < Math.floor(to * sr); i++) {
          const v = d[i];
          if (!Number.isFinite(v)) nan = true;
          peak = Math.max(peak, Math.abs(v));
          sum += v * v;
          n++;
        }
      }
      return { peak, rms: Math.sqrt(sum / n), nan };
    };
    return { idle: seg(0.3, 1), pull: seg(1.5, 2.5), pops: seg(2.5, 3.1), boom: seg(3.2, 4), all: seg(0, seconds) };
  });
  log(`offline ${JSON.stringify(offline)}`);
  expect(!offline.all.nan, 'offline render has no NaN samples');
  expect(offline.all.peak < 1, `offline render never clips (peak ${offline.all.peak.toFixed(3)})`);
  expect(offline.idle.rms > 0.01 && offline.pull.rms > offline.idle.rms * 1.4, `offline: a pull is louder than idle (${offline.idle.rms.toFixed(3)} → ${offline.pull.rms.toFixed(3)})`);
  expect(offline.boom.peak > 0.3, 'offline: the failure is loud');

  // Older engines without ConstantSourceNode / StereoPannerNode take the fallback paths.
  const fallback = await evaluate(async () => {
    const sr = 48000;
    const ctx = new window.OfflineAudioContext(2, sr, sr);
    ctx.createConstantSource = undefined;
    ctx.createStereoPanner = undefined;
    const a = new window.audio.constructor();
    a.attach(ctx, { offline: true });
    a.setProfile(window.__app.profile);
    const p = window.__app.profile;
    const sim = { profile: p, rpm: 3000, running: true, fuelCut: false, throttleEffective: 0.8, inputOmega: 0, speedKmh: 0, gear: 'N', cranking: false };
    for (let i = 1; i < 20; i++) {
      ctx.suspend(i * 0.05).then(() => {
        a.update(sim, 0.05);
        ctx.resume();
      });
    }
    a.update(sim, 0.05);
    const d = (await ctx.startRendering()).getChannelData(0);
    let sum = 0;
    let finite = true;
    for (let i = sr / 2; i < sr; i++) {
      finite = finite && Number.isFinite(d[i]);
      sum += d[i] * d[i];
    }
    return { rms: Math.sqrt(sum / (sr / 2)), finite, clock: a.clock };
  });
  expect(fallback.finite && fallback.rms > 0.01 && fallback.clock === null, `fallback graph without ConstantSource/StereoPanner still sounds (rms ${fallback.rms.toFixed(3)})`);

  // Back to normal rendering for a last look.
  await evaluate(() => {
    const a = window.__app;
    a.view.render = a.__render;
    window.__force = {};
  });
  await advance(0.5, {});
  await shot('audio-end');
}

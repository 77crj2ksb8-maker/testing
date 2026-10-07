import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS } from '../src/config.js';
import { bankWaveform, harmonicEnergy } from '../src/exhaust.js';
import { driveCurve, heavyMix, limiterCurve, LIMITER_INPUT_GAIN, mulberry32, smoothstep } from '../src/audio/dsp.js';
import { impulseResponse } from '../src/audio/impulse.js';
import { backfirePlan, Cooldowns, MAX_ONE_SHOTS, PRIORITY, VoicePool } from '../src/audio/voices.js';
import {
  clickTrain, exhaustSoundSpeed, loadWaveTables, pipeDelay, rodKnockTrain, spectrumLevels, valveTickTrain, WAVE_RMS, waveKey,
} from '../src/audio/wavetables.js';

const profile = (preset, cylinders) => buildProfile({ ...DEFAULT_SETTINGS, preset, cylinders });

// Share of energy in harmonics above `from` (brightness).
function highShare(spec, from, upTo) {
  let hi = 0;
  let total = 0;
  for (let h = 1; h <= upTo; h++) {
    const e = harmonicEnergy(spec, h);
    total += e;
    if (h > from) hi += e;
  }
  return hi / total;
}

/** Evaluate a Fourier series (as createPeriodicWave would) at phase 0..1. */
function synth({ real, imag }, phase) {
  let v = 0;
  for (let h = 1; h < real.length; h++) v += real[h] * Math.cos(2 * Math.PI * h * phase) + imag[h] * Math.sin(2 * Math.PI * h * phase);
  return v;
}

// ── dsp ─────────────────────────────────────────────────────────────────────

test('seeded PRNG is deterministic and stays in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('limiter curve is unity below the knee, monotonic, and never reaches 1', () => {
  const curve = limiterCurve();
  const n = curve.length;
  const at = (signal) => curve[Math.round(((signal * LIMITER_INPUT_GAIN + 1) / 2) * (n - 1))];
  assert.ok(Math.abs(at(0.5) - 0.5) < 1e-3, 'quiet signals pass unchanged');
  assert.ok(Math.abs(at(-0.3) + 0.3) < 1e-3);
  for (let i = 1; i < n; i++) assert.ok(curve[i] >= curve[i - 1], 'monotonic');
  assert.ok(curve[n - 1] < 0.99 && curve[0] > -0.99, 'ceiling below full scale');
  assert.ok(at(1.5) > at(1.0), 'still rising above the knee');
});

test('drive curve is odd-symmetric and normalised to ±1', () => {
  const c = driveCurve(2.1, 1025);
  assert.ok(Math.abs(c[0] + 1) < 1e-6 && Math.abs(c[1024] - 1) < 1e-6);
  assert.ok(Math.abs(c[512]) < 1e-6);
  for (let i = 0; i < 512; i++) assert.ok(Math.abs(c[i] + c[1024 - i]) < 1e-6);
});

test('heavy-load mix eases from 0 at idle to 1 at full load', () => {
  assert.equal(heavyMix(0), 0);
  assert.equal(heavyMix(0.05), 0);
  assert.equal(heavyMix(1), 1);
  let prev = 0;
  for (let l = 0; l <= 1.0001; l += 0.05) {
    const m = heavyMix(l);
    assert.ok(m >= prev - 1e-12);
    prev = m;
  }
  assert.ok(Math.abs(smoothstep(0, 1, 0.5) - 0.5) < 1e-12);
});

// ── impulse response ────────────────────────────────────────────────────────

test('impulse response: stereo, decaying, decorrelated, deterministic, click-free end', () => {
  const sr = 48000;
  const [l, r] = impulseResponse(sr, { seconds: 0.7 });
  assert.equal(l.length, Math.round(0.7 * sr));
  assert.equal(r.length, l.length);
  const energy = (d, from, to) => {
    let s = 0;
    for (let i = Math.floor(from * d.length); i < Math.floor(to * d.length); i++) s += d[i] * d[i];
    return s;
  };
  assert.ok(energy(l, 0, 0.2) > energy(l, 0.6, 1) * 50, 'the tail decays by well over 17 dB');
  let peak = 0;
  for (const d of [l, r]) for (const v of d) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak - 0.9) < 1e-6, 'peak-normalised');
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < l.length; i++) {
    lr += l[i] * r[i];
    ll += l[i] * l[i];
    rr += r[i] * r[i];
  }
  assert.ok(Math.abs(lr / Math.sqrt(ll * rr)) < 0.3, 'left and right are decorrelated (stereo width)');
  assert.ok(l[l.length - 1] === 0 && r[r.length - 1] === 0, 'ends at zero');
  const [l2] = impulseResponse(sr, { seconds: 0.7 });
  assert.deepEqual(l2, l);
});

// ── voice pool ──────────────────────────────────────────────────────────────

test('voice pool never holds more than the cap and drops equal-priority extras', () => {
  const pool = new VoicePool();
  assert.equal(pool.cap, MAX_ONE_SHOTS);
  let granted = 0;
  for (let i = 0; i < 40; i++) {
    const slot = pool.acquire(0, 0.1, PRIORITY.pop);
    if (slot) {
      slot.handle = { id: i };
      granted++;
    }
  }
  assert.equal(granted, 12);
  assert.equal(pool.active(0.05), 12);
  assert.equal(pool.dropped, 28);
  assert.equal(pool.active(0.2), 0, 'ended voices are freed');
});

test('a scheduled voice holds its slot from the moment it is scheduled', () => {
  const pool = new VoicePool(2);
  // Two short sounds now, then a third scheduled after they end: it must still
  // wait for a free slot because scheduled sources are already live nodes.
  assert.ok(pool.acquire(0, 0.05));
  assert.ok(pool.acquire(0, 0.05));
  assert.equal(pool.acquire(0, 0.5), null);
  assert.ok(pool.acquire(0.06, 0.5), 'free again once they have ended');
});

test('higher priority steals the oldest lowest-priority voice and reports it', () => {
  const pool = new VoicePool(3);
  const handles = ['a', 'b', 'c'];
  handles.forEach((h, i) => (pool.acquire(i * 0.01, 1, PRIORITY.pop).handle = h));
  const slot = pool.acquire(0.03, 2, PRIORITY.critical);
  assert.ok(slot);
  assert.equal(pool.stolen, 'a');
  slot.handle = 'boom';
  assert.equal(pool.active(0.04), 3);
  assert.equal(pool.acquire(0.04, 1, PRIORITY.pop), null, 'a pop cannot steal');
  assert.equal(pool.stolen, null);
  assert.ok(pool.release('b'));
  assert.equal(pool.release('b'), false);
  assert.equal(pool.active(0.04), 2);
});

test('cooldowns space out repeated triggers per key', () => {
  const c = new Cooldowns();
  assert.ok(c.allow('bov', 1, 0.25));
  assert.ok(!c.allow('bov', 1.1, 0.25));
  assert.ok(c.allow('twostep', 1.1, 0.25), 'keys are independent');
  assert.ok(c.allow('bov', 1.3, 0.25));
  // recent(): did this key just fire? (merges a backfire into the two-step bang it belongs to)
  assert.ok(c.recent('bov', 1.3, 0.05));
  assert.ok(c.recent('bov', 1.34, 0.05));
  assert.ok(!c.recent('bov', 1.36, 0.05), 'too long ago');
  assert.ok(!c.recent('pop', 1.3, 0.05), 'never fired');
  assert.ok(!c.recent('bov', 1.2, 0.05), 'a clock from before the trigger (new context) is not recent');
  assert.ok(!c.allow('bov', 1.36, 0.25) && c.recent('bov', 1.34, 0.05), 'a refused trigger does not move the timestamp');
});

test('backfire plans: crackle volleys grow with strength, two-step is a bang', () => {
  const rand = mulberry32(3);
  assert.equal(backfirePlan(0.2, 'overrun', rand).length, 1);
  assert.equal(backfirePlan(0.95, 'overrun', rand).length, 3);
  const two = backfirePlan(0.8, 'twostep', rand);
  assert.equal(two.length, 1);
  assert.equal(two[0].kind, 'bang');
  assert.equal(backfirePlan(0.3, 'shift', rand)[0].kind, 'pop');
  assert.equal(backfirePlan(0.9, 'shift', rand)[0].kind, 'bang');
  for (const src of ['overrun', 'limiter', 'twostep', 'shift', 'unknown']) {
    for (const s of [0, 0.5, 1, NaN, 7]) {
      for (const v of backfirePlan(s, src, rand)) {
        assert.ok(v.gain > 0 && v.gain <= 1, `${src} gain in range`);
        assert.ok(v.delay >= 0 && v.delay < 0.5 && v.rate > 0.5 && v.rate < 1.5);
      }
    }
  }
  // Deterministic for the same PRNG state.
  assert.deepEqual(backfirePlan(0.9, 'overrun', mulberry32(9)), backfirePlan(0.9, 'overrun', mulberry32(9)));
});

// ── wave tables ─────────────────────────────────────────────────────────────

test('explicit default pulse shape matches the original waveform', () => {
  const fires = [0, 180, 360, 540];
  assert.deepEqual(bankWaveform(fires, 40, 0.08), bankWaveform(fires, 40, 0.08, undefined, { rise: 0, reflection: 0 }));
});

test('load wave tables: one light/heavy pair per bank, heavy is brighter', () => {
  for (const [preset, n, banks] of [['v8-cross', 8, 2], ['v8-flat', 8, 2], ['i4', 4, 1], ['v6', 6, 2], ['rotary', 2, 1]]) {
    const tables = loadWaveTables(profile(preset, n), 96);
    assert.equal(tables.length, banks, preset);
    for (const t of tables) {
      assert.equal(t.light.real.length, 97);
      assert.ok(highShare(t.heavy, 24, 96) > highShare(t.light, 24, 96) * 1.5, `${preset}: full load has more upper harmonics`);
    }
  }
});

test('light and heavy tables carry gains that match their RMS after peak normalisation', () => {
  for (const [preset, n] of [['v8-cross', 8], ['i4', 4], ['rotary', 2]]) {
    for (const t of loadWaveTables(profile(preset, n), 64)) {
      for (const shape of ['light', 'heavy']) {
        const { peak, rms } = spectrumLevels(t[shape], 512);
        assert.ok(Math.abs((rms / peak) * t[`${shape}Gain`] - WAVE_RMS) < 1e-6, `${preset} ${shape}`);
      }
    }
  }
});

test('load shapes keep the layout rhythm: flatplane banks stay even, crossplane stays uneven', () => {
  const sub = (spec, order) => {
    let s = 0;
    let t = 0;
    for (let h = 1; h <= 64; h++) {
      const e = harmonicEnergy(spec, h);
      t += e;
      if (h % order) s += e;
    }
    return s / t;
  };
  for (const shape of ['light', 'heavy']) {
    for (const b of loadWaveTables(profile('v8-flat', 8), 64)) assert.ok(sub(b[shape], 4) < 0.05, `flatplane ${shape}`);
    for (const b of loadWaveTables(profile('v8-cross', 8), 64)) assert.ok(sub(b[shape], 4) > 0.3, `crossplane ${shape}`);
  }
});

test('wave key changes with the firing pattern only', () => {
  assert.equal(waveKey(profile('v8-cross', 8)), waveKey(buildProfile({ ...DEFAULT_SETTINGS, preset: 'v8-cross', cylinders: 8, redlineRpm: 7000 })));
  assert.notEqual(waveKey(profile('v8-cross', 8)), waveKey(profile('v8-flat', 8)));
});

test('click trains: narrow non-negative pulses at the requested angles once the mean is added back', () => {
  const train = clickTrain([90, 450], [1, 0.5], 6, 64);
  const at = (deg) => synth(train, deg / 720) + train.mean;
  assert.ok(at(90) > 0.9 && at(90) < 1.1, 'full click');
  assert.ok(Math.abs(at(450) - 0.5) < 0.1, 'half click');
  for (const deg of [0, 200, 300, 600]) assert.ok(Math.abs(at(deg)) < 0.03, `closed between clicks at ${deg}°`);
});

test('valvetrain ticks: two per cylinder, none for rotaries; rod knock once per turn', () => {
  const v8 = valveTickTrain(profile('v8-cross', 8));
  assert.ok(v8.mean > 0 && v8.mean < 0.5);
  assert.equal(valveTickTrain(profile('rotary', 2)), null);
  const knock = rodKnockTrain(profile('i4', 4));
  const p = profile('i4', 4);
  const fire = p.cylinders[0].fireDeg;
  const at = (deg) => synth(knock, deg / 720) + knock.mean;
  assert.ok(at(fire + 8) > 0.9 && at(fire + 368) > 0.4 && at(fire + 188) < 0.05);
});

test('pipe resonance delay fits a DelayNode feedback loop and rises in pitch with EGT', () => {
  assert.ok(exhaustSoundSpeed(900) > exhaustSoundSpeed(350));
  for (const [preset, n] of [['v8-cross', 8], ['i4', 4], ['rotary', 2], ['v6', 6]]) {
    const p = profile(preset, n);
    const cold = pipeDelay(p, 300);
    const hot = pipeDelay(p, 1000);
    assert.ok(hot < cold, 'hotter gas, shorter delay, higher resonance');
    // A feedback loop needs at least one render quantum (128 frames, 2.9 ms at 44.1 kHz).
    assert.ok(hot > 128 / 44100 && cold < 0.05, `${preset} delay ${cold}..${hot}`);
  }
});

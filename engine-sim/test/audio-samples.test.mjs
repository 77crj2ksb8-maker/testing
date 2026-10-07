import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSample, SAMPLE_KINDS } from '../src/audio/samples.js';
import { biquad, peakOf, whiteNoise } from '../src/audio/dsp.js';

const SR = 48000;
const rendered = Object.fromEntries(SAMPLE_KINDS.map((k) => [k, renderSample(k, SR, 11)]));

const rms = (d, from = 0, to = d.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

test('every one-shot renders finite, below full scale and ends in silence', () => {
  for (const kind of SAMPLE_KINDS) {
    const d = rendered[kind];
    assert.ok(d.length > SR * 0.05, `${kind} has a body`);
    for (const v of d) assert.ok(Number.isFinite(v), `${kind} finite`);
    const peak = peakOf(d);
    assert.ok(peak > 0.5 && peak <= 0.951, `${kind} peak ${peak}`);
    assert.ok(d[d.length - 1] === 0, `${kind} ends at zero (no click)`);
  }
});

test('impacts front-load their energy; the failure hiss lasts longest', () => {
  for (const kind of ['pop', 'bang', 'crack', 'explosion', 'clunk']) {
    const d = rendered[kind];
    const q = Math.floor(d.length / 4);
    assert.ok(rms(d, 0, q) > rms(d, 3 * q) * 4, `${kind} decays`);
  }
  const len = (k) => rendered[k].length / SR;
  assert.ok(len('pop') < 0.15 && len('crack') < 0.15, 'pops and cracks are short');
  assert.ok(len('hiss') > len('explosion') && len('hiss') > 2.5);
  assert.ok(len('bov') > 0.4 && len('bov') < 1);
});

test('the blow-off valve is airy (high-passed) and the bang is heavy (low end)', () => {
  const lowShare = (d) => {
    const low = biquad(Float32Array.from(d), SR, 'lowpass', 200, 0.707);
    return rms(low) / rms(d);
  };
  assert.ok(lowShare(rendered.bov) < 0.1, 'bov has almost no low end');
  assert.ok(lowShare(rendered.bang) > lowShare(rendered.pop), 'bang is deeper than a pop');
  assert.ok(lowShare(rendered.explosion) > 0.3, 'explosion is a deep boom');
});

test('samples are deterministic per seed and differ across seeds', () => {
  assert.deepEqual(renderSample('pop', SR, 11), rendered.pop);
  assert.notDeepEqual(renderSample('pop', SR, 12), rendered.pop);
  assert.throws(() => renderSample('kazoo', SR));
});

test('sample length scales with the sample rate', () => {
  const a = renderSample('crack', 44100);
  const b = renderSample('crack', 48000);
  assert.ok(Math.abs(a.length / 44100 - b.length / 48000) < 1e-3);
});

test('band-pass helper keeps its band and rejects the rest', () => {
  const n = 48000;
  const tone = (f) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR));
  const pass = biquad(tone(1000), SR, 'bandpass', 1000, 1);
  const stop = biquad(tone(100), SR, 'bandpass', 1000, 1);
  assert.ok(rms(pass, n / 2) > 0.6 && rms(stop, n / 2) < 0.1);
  const noise = whiteNoise(1024, 5);
  assert.ok(peakOf(noise) <= 1 && rms(noise) > 0.5);
});

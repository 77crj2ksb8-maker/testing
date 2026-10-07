// Procedurally synthesised one-shot samples. Each is rendered once per audio
// context into an AudioBuffer and then replayed by a single buffer source, which
// is far cheaper on a phone than building a filter graph for every pop.
// Pure and deterministic: a seeded PRNG, no Web Audio.

import { biquad, mulberry32, normalize } from './dsp.js';

const TAU = 2 * Math.PI;

function noiseInto(out, rand, from = 0, to = out.length) {
  for (let i = from; i < to; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** Multiply by an exponential decay with time constant tau (s) after a linear attack. */
function envelope(data, sr, attack, tau, delay = 0) {
  const a = Math.max(1, Math.round(attack * sr));
  const d = Math.round(delay * sr);
  for (let i = 0; i < data.length; i++) {
    const j = i - d;
    data[i] *= j < 0 ? 0 : j < a ? j / a : Math.exp(-(j - a) / (tau * sr));
  }
  return data;
}

/** Sine thump whose pitch glides from f0 to f1 (exponentially, time constant glide). */
function thump(length, sr, f0, f1, glide, tau, attack = 0.002) {
  const out = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / glide);
    phase += (TAU * f) / sr;
    out[i] = Math.sin(phase);
  }
  return envelope(out, sr, attack, tau);
}

function mix(target, src, gain = 1, offset = 0) {
  for (let i = 0; i < src.length && i + offset < target.length; i++) target[i + offset] += src[i] * gain;
  return target;
}

/** Fade the last `seconds` to zero so a buffer never ends on a click. */
function tailFade(data, sr, seconds = 0.01) {
  const n = Math.min(data.length, Math.round(seconds * sr));
  for (let i = 0; i < n; i++) data[data.length - 1 - i] *= i / n;
  return data;
}

// Small exhaust pop: a band-limited noise snap with a short low thud.
function pop(sr, rand) {
  const n = Math.round(0.11 * sr);
  const snap = biquad(noiseInto(new Float32Array(n), rand), sr, 'bandpass', 950, 1.1);
  envelope(snap, sr, 0.0008, 0.011);
  const out = mix(new Float32Array(n), snap, 1.6);
  mix(out, thump(n, sr, 130, 60, 0.02, 0.022), 0.55);
  return normalize(tailFade(out, sr), 0.9);
}

// Heavy two-step / anti-lag bang: a crack, a deep pressure thump and a rumble.
function bang(sr, rand) {
  const n = Math.round(0.32 * sr);
  const out = new Float32Array(n);
  const crack = biquad(noiseInto(new Float32Array(n), rand), sr, 'highpass', 1800, 0.7);
  mix(out, envelope(crack, sr, 0.0004, 0.004), 0.9);
  const body = biquad(noiseInto(new Float32Array(n), rand), sr, 'lowpass', 1600, 0.8);
  mix(out, envelope(body, sr, 0.001, 0.035), 1.6);
  mix(out, thump(n, sr, 95, 38, 0.035, 0.07), 1.0);
  const rumble = biquad(noiseInto(new Float32Array(n), rand), sr, 'lowpass', 260, 0.9);
  mix(out, envelope(rumble, sr, 0.01, 0.09), 1.8);
  return normalize(tailFade(out, sr, 0.03), 0.95);
}

// Flat-shift ignition cut: a dry, sharp crack.
function crack(sr, rand) {
  const n = Math.round(0.09 * sr);
  const out = new Float32Array(n);
  const hi = biquad(noiseInto(new Float32Array(n), rand), sr, 'highpass', 2400, 0.8);
  mix(out, envelope(hi, sr, 0.0003, 0.006), 1);
  const mid = biquad(noiseInto(new Float32Array(n), rand), sr, 'bandpass', 700, 1.4);
  mix(out, envelope(mid, sr, 0.0005, 0.014), 1.4);
  mix(out, thump(n, sr, 180, 90, 0.01, 0.016), 0.45);
  return normalize(tailFade(out, sr), 0.9);
}

// Blow-off valve: a burst of air that sweeps down as the pressure drops, with a
// little flutter at the start.
function bov(sr, rand) {
  const n = Math.round(0.75 * sr);
  const air = noiseInto(new Float32Array(n), rand);
  biquad(air, sr, 'bandpass', (i) => 1300 + 2300 * Math.exp(-i / (0.16 * sr)), 0.9);
  biquad(air, sr, 'highpass', 600, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const flutter = 1 - 0.25 * Math.exp(-t / 0.08) * (0.5 + 0.5 * Math.sin(TAU * 34 * t));
    const env = (t < 0.006 ? t / 0.006 : 1) * Math.exp(-t / 0.2) * (t < 0.04 ? 1 : 0.85 + 0.15 * Math.exp(-(t - 0.04) / 0.05));
    air[i] *= env * flutter;
  }
  return normalize(tailFade(air, sr, 0.05), 0.85);
}

// Catastrophic failure: a deep boom with a cracking front.
function explosion(sr, rand) {
  const n = Math.round(1.8 * sr);
  const out = new Float32Array(n);
  const front = biquad(noiseInto(new Float32Array(n), rand), sr, 'highpass', 900, 0.7);
  mix(out, envelope(front, sr, 0.0005, 0.02), 0.9);
  const blast = biquad(noiseInto(new Float32Array(n), rand), sr, 'lowpass', 900, 0.7);
  mix(out, envelope(blast, sr, 0.002, 0.18), 2.2);
  mix(out, thump(n, sr, 70, 24, 0.12, 0.35, 0.003), 1.3);
  const roll = biquad(noiseInto(new Float32Array(n), rand), sr, 'lowpass', 140, 0.8);
  mix(out, envelope(roll, sr, 0.05, 0.45), 4);
  return normalize(tailFade(out, sr, 0.15), 0.95);
}

// Metal parts bouncing: inharmonic ringing impacts that thin out over time.
function clatter(sr, rand) {
  const n = Math.round(1.5 * sr);
  const out = new Float32Array(n);
  const modes = [1180, 2730, 4310, 6020];
  let t = 0;
  let k = 0;
  while (t < 1.25) {
    const at = Math.round(t * sr);
    const amp = (0.4 + 0.6 * rand()) * Math.exp(-t / 0.5);
    const detune = 0.85 + 0.3 * rand();
    const len = Math.min(n - at, Math.round(0.12 * sr));
    for (let m = 0; m < modes.length; m++) {
      const f = modes[m] * detune * (1 + 0.04 * m * rand());
      const decay = 0.03 / (1 + m * 0.6);
      const g = amp / (1 + m * 0.5);
      for (let i = 0; i < len; i++) out[at + i] += g * Math.sin((TAU * f * i) / sr) * Math.exp(-i / (decay * sr));
    }
    // A knock of noise at each impact.
    for (let i = 0; i < Math.min(len, Math.round(0.004 * sr)); i++) out[at + i] += amp * 0.6 * (rand() * 2 - 1);
    k++;
    t += 0.02 + 0.09 * rand() * (1 + k * 0.08);
  }
  return normalize(tailFade(out, sr, 0.05), 0.8);
}

// Steam and oil hissing out of a broken engine, fading over a few seconds.
function hiss(sr, rand) {
  const n = Math.round(3.2 * sr);
  const out = biquad(noiseInto(new Float32Array(n), rand), sr, 'highpass', 2200, 0.6);
  biquad(out, sr, 'lowpass', 9000, 0.6);
  let sputter = 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 511) === 0) sputter = 0.75 + 0.25 * rand();
    const env = (t < 0.08 ? t / 0.08 : 1) * Math.exp(-t / 0.9);
    out[i] *= env * sputter;
  }
  return normalize(tailFade(out, sr, 0.3), 0.6);
}

// Gear lever clunk: a low knock with a small click.
function clunk(sr, rand) {
  const n = Math.round(0.14 * sr);
  const out = thump(n, sr, 150, 62, 0.03, 0.03);
  const click = biquad(noiseInto(new Float32Array(n), rand), sr, 'bandpass', 3200, 1);
  mix(out, envelope(click, sr, 0.0005, 0.008), 0.6);
  return normalize(tailFade(out, sr), 0.8);
}

// Grinding gears: rough band-passed noise chopped by the dog teeth.
function grind(sr, rand) {
  const n = Math.round(0.5 * sr);
  const out = biquad(noiseInto(new Float32Array(n), rand), sr, 'bandpass', 2300, 2.5);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const saw = (t * 48) % 1;
    out[i] *= (1 - 0.7 * saw) * (t < 0.004 ? t / 0.004 : Math.exp(-t / 0.16));
  }
  return normalize(tailFade(out, sr, 0.03), 0.8);
}

const RENDERERS = { pop, bang, crack, bov, explosion, clatter, hiss, clunk, grind };

export const SAMPLE_KINDS = Object.keys(RENDERERS);

/** Render one sample kind as mono Float32Array at `sampleRate`. Deterministic per (kind, seed). */
export function renderSample(kind, sampleRate, seed = 1) {
  const fn = RENDERERS[kind];
  if (!fn) throw new Error(`Unknown sample "${kind}"`);
  let h = seed;
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 16777619);
  return fn(sampleRate, mulberry32(h));
}

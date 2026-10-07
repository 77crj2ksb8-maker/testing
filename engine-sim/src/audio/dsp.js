// Small, pure DSP helpers shared by the audio modules. No Web Audio, no DOM and
// no Math.random(): everything here runs (and is tested) in Node.

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Seeded PRNG (mulberry32) returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** White noise in [-1, 1). */
export function whiteNoise(length, seed = 1) {
  const rand = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1;
  return out;
}

/**
 * RBJ biquad, direct form I, processed in place. type: 'lowpass' 'highpass'
 * 'bandpass' (constant 0 dB peak gain). freq may be a number or a function of
 * the sample index for sweeps (coefficients are then refreshed every 32 samples).
 */
export function biquad(data, sampleRate, type, freq, q = 0.707) {
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  const design = (f) => {
    const w = (2 * Math.PI * clamp(f, 10, sampleRate * 0.45)) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0;
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0;
    } else {
      b0 = alpha; b1 = 0; b2 = -alpha;
    }
    b0 /= a0; b1 /= a0; b2 /= a0;
    a1 = (-2 * cos) / a0;
    a2 = (1 - alpha) / a0;
  };
  const sweep = typeof freq === 'function';
  if (!sweep) design(freq);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    if (sweep && (i & 31) === 0) design(freq(i));
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
    data[i] = y;
  }
  return data;
}

/** Scale so the absolute peak equals `peak`. Returns the array. */
export function normalize(data, peak = 0.9) {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < data.length; i++) data[i] *= k;
  }
  return data;
}

export function peakOf(data) {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
  return max;
}

/** Symmetric tanh saturation curve for a WaveShaper, normalised to ±1. */
export function driveCurve(amount, n = 1024) {
  const curve = new Float32Array(n);
  const k = Math.max(0.01, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/**
 * Output safety limiter as a WaveShaper curve. The shaper is fed at half level,
 * so the curve spans signals of ±2: unity gain below `knee`, then a tanh
 * shoulder that never reaches `ceiling`. Anything louder than ±2 clamps to the
 * curve ends, so the output can never exceed the ceiling.
 */
export const LIMITER_INPUT_GAIN = 0.5;
export function limiterCurve(n = 4097, knee = 0.7, ceiling = 0.98) {
  const curve = new Float32Array(n);
  const room = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const s = ((i / (n - 1)) * 2 - 1) / LIMITER_INPUT_GAIN;
    const a = Math.abs(s);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = Math.sign(s) * y;
  }
  return curve;
}

/** Heavy-load wave table weight for a load of 0..1 (eased so part throttle still sounds soft). */
export function heavyMix(load) {
  return smoothstep(0.12, 0.9, load);
}

/** Exponential smoothing coefficient for a time constant at a step dt. */
export function follow(dt, tau) {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

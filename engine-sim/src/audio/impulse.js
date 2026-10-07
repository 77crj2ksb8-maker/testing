// Generated stereo impulse response for a ConvolverNode: a handful of early
// reflections (a garage's walls and floor) followed by an exponentially
// decaying noise tail that loses its highs as it fades. Short on purpose: the
// convolution cost on a phone grows with the length.

import { mulberry32 } from './dsp.js';

/**
 * @param {number} sampleRate
 * @param {object} [o]
 * @param {number} [o.seconds=0.7] total length
 * @param {number} [o.rt60=0.55] time for the tail to fall by 60 dB
 * @param {number} [o.predelay=0.012] gap before the tail starts, s
 * @param {number} [o.damping=0.6] 0 bright … 1 dark, how fast highs die away
 * @param {number} [o.seed=7]
 * @returns {Float32Array[]} [left, right], peak-normalised to 0.9
 */
export function impulseResponse(sampleRate, { seconds = 0.7, rt60 = 0.55, predelay = 0.012, damping = 0.6, seed = 7 } = {}) {
  const length = Math.max(1, Math.round(seconds * sampleRate));
  const channels = [new Float32Array(length), new Float32Array(length)];
  const decayPerSample = Math.log(1000) / (rt60 * sampleRate); // 60 dB = ×1000
  const start = Math.round(predelay * sampleRate);
  channels.forEach((data, ch) => {
    const rand = mulberry32(seed * 31 + ch * 977);
    // Early reflections: sparse, slightly different per ear.
    const taps = [0.0031, 0.0057, 0.0083, 0.0119, 0.0161];
    taps.forEach((t, k) => {
      const i = Math.round((t + ch * 0.0007 * (k + 1)) * sampleRate);
      if (i < length) data[i] += (rand() < 0.5 ? -1 : 1) * (0.55 - k * 0.08);
    });
    // Diffuse tail through a one-pole low-pass whose cutoff falls over time.
    let lp = 0;
    for (let i = start; i < length; i++) {
      const t = (i - start) / (length - start);
      const env = Math.exp(-(i - start) * decayPerSample);
      const a = 0.85 - 0.75 * damping * t; // filter coefficient: 1 = no filtering
      lp += a * ((rand() * 2 - 1) - lp);
      data[i] += lp * env * 0.6;
    }
    // Fade the last 5 % so the tail never ends in a click.
    const fade = Math.max(1, Math.round(length * 0.05));
    for (let i = 0; i < fade; i++) data[length - 1 - i] *= i / fade;
  });
  let peak = 0;
  for (const d of channels) for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (const d of channels) for (let i = 0; i < length; i++) d[i] *= 0.9 / peak;
  return channels;
}

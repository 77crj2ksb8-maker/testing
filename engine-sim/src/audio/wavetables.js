// Wave tables for the engine voice, all derived from the engine's real firing
// pattern (src/exhaust.js) so every layout keeps its own rhythm:
//
//  - light / heavy load exhaust pulse shapes per bank, crossfaded by load
//    (a cruising engine's soft, round pulses vs. full-load blowdown spikes
//    with a strong reflected suction wave);
//  - click trains that gate noise into valvetrain ticks and rod knock;
//  - the exhaust pipe's acoustic delay, which sets its resonances.
// Pure: no Web Audio here.

import { bankFirings, bankWaveform, waveSpectrum } from '../exhaust.js';
import { clamp } from './dsp.js';

export const LOAD_SHAPES = {
  light: { width: 1.1, roughness: 0.6, rise: 1, shape: { reflection: 0.12, reflectionDeg: 120 } },
  heavy: { width: 0.75, roughness: 1.25, rise: 0.1, shape: { reflection: 0.4, reflectionDeg: 75 } },
};

/** Stable key of everything the wave tables depend on, to skip needless rebuilds. */
export function waveKey(profile) {
  const fires = bankFirings(profile).map((b) => b.fires.map((d) => Math.round(d)).join(',')).join('|');
  const { pulseWidth, roughness } = profile.exhaust;
  return `${profile.kind}:${fires}:${pulseWidth}:${roughness}`;
}

/** Peak and RMS of the band-limited waveform a set of coefficients synthesises. */
export function spectrumLevels({ real, imag }, points = 1024) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < points; i++) {
    const ph = (2 * Math.PI * i) / points;
    let v = 0;
    for (let h = 1; h < real.length; h++) v += real[h] * Math.cos(h * ph) + imag[h] * Math.sin(h * ph);
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / points) };
}

/**
 * Per bank: {light, heavy} Fourier coefficient sets for createPeriodicWave(),
 * plus `lightGain`/`heavyGain`. Web Audio normalises every PeriodicWave to a
 * peak of 1, which would make the spiky full-load wave quieter than the round
 * light one; these gains bring both to the same RMS so the crossfade changes
 * the timbre, not the loudness.
 */
export const WAVE_RMS = 0.3;
export function loadWaveTables(profile, harmonics = 160) {
  const { pulseWidth, roughness } = profile.exhaust;
  return bankFirings(profile).map(({ fires, ids }) => {
    const table = {};
    for (const [name, s] of Object.entries(LOAD_SHAPES)) {
      const shape = { ...s.shape, rise: pulseWidth * s.rise };
      const wave = bankWaveform(fires, pulseWidth * s.width, roughness * s.roughness, ids, shape);
      const spec = waveSpectrum(wave, harmonics);
      const { peak, rms } = spectrumLevels(spec, 512);
      table[name] = spec;
      table[`${name}Gain`] = clamp(WAVE_RMS / (rms / peak || 1), 0.4, 3);
    }
    return table;
  });
}

const CLICK_SAMPLES = 2048;

/**
 * A train of narrow Gaussian bumps over one 720° cycle, for an oscillator
 * that gates noise (gain.gain = mean + oscillator). Returns the Fourier
 * coefficients plus the cycle mean, so the gate can add the DC back and stay
 * closed between clicks.
 * @param {number[]} degs click positions in crank degrees
 * @param {number[]} [amps] relative click strengths (default 1)
 * @param {number} [sigmaDeg] bump width
 */
export function clickTrain(degs, amps = degs.map(() => 1), sigmaDeg = 6, harmonics = 64) {
  const wave = new Float32Array(CLICK_SAMPLES);
  for (let s = 0; s < CLICK_SAMPLES; s++) {
    const deg = (s / CLICK_SAMPLES) * 720;
    let v = 0;
    for (let j = 0; j < degs.length; j++) {
      let d = Math.abs(deg - (((degs[j] % 720) + 720) % 720));
      if (d > 360) d = 720 - d;
      v += amps[j] * Math.exp(-0.5 * (d / sigmaDeg) ** 2);
    }
    wave[s] = v;
  }
  let peak = 0;
  for (let s = 0; s < CLICK_SAMPLES; s++) peak = Math.max(peak, wave[s]);
  let mean = 0;
  for (let s = 0; s < CLICK_SAMPLES; s++) {
    wave[s] /= peak || 1;
    mean += wave[s];
  }
  mean /= CLICK_SAMPLES;
  for (let s = 0; s < CLICK_SAMPLES; s++) wave[s] -= mean;
  return { ...waveSpectrum(wave, harmonics), mean };
}

/** Valve-closing ticks: exhaust valves seat ~375° and intake valves ~590° after firing TDC. */
export function valveTickTrain(profile) {
  if (profile.kind === 'rotary' || !profile.cylinders.length) return null;
  const degs = [];
  const amps = [];
  for (const c of profile.cylinders) {
    degs.push(c.fireDeg + 375, c.fireDeg + 590);
    // Each valve seats a little differently, which keeps the tick from sounding like a metronome.
    amps.push(0.75 + 0.25 * Math.abs(Math.sin(c.num * 2.3)), 0.6 + 0.3 * Math.abs(Math.cos(c.num * 1.7)));
  }
  return clickTrain(degs, amps, Math.min(6, 160 / degs.length));
}

/**
 * Rod knock from one worn big-end bearing: a hard knock as the power stroke
 * loads it and a lighter one at the exhaust TDC a turn later.
 */
export function rodKnockTrain(profile) {
  const fire = profile.cylinders?.length ? profile.cylinders[0].fireDeg : 0;
  return clickTrain([fire + 8, fire + 368], [1, 0.55], 7);
}

/** Speed of sound in exhaust gas at `egtC` (m/s). */
export function exhaustSoundSpeed(egtC) {
  return 20.05 * Math.sqrt(clamp(egtC, 0, 1400) + 273.15);
}

/** Effective tailpipe length (m) for an engine: bigger engines, longer systems. */
export function pipeLength(profile) {
  const base = profile.kind === 'rotary' ? 1.3 : 1.55;
  return clamp(base + 0.12 * (profile.displacementL ?? 2), 1.2, 2.6);
}

/**
 * Round-trip delay (s) of a pressure wave down the pipe and back. A feedback
 * delay of this length resonates at multiples of 1/delay; hotter gas is faster,
 * so the drone rises as the exhaust heats up.
 */
export function pipeDelay(profile, egtC = 450) {
  return (2 * pipeLength(profile)) / exhaustSoundSpeed(egtC);
}

// Exhaust pulse-train spectra. Each exhaust bank hears a pressure pulse every
// time one of its cylinders fires; the uneven spacing of those pulses is what
// makes a crossplane V8 burble and a flatplane V8 scream. We sample one full
// 720° engine cycle per bank and turn it into Fourier coefficients for a Web
// Audio PeriodicWave whose fundamental is rpm / 120 Hz (one cycle = two revs).

const SAMPLES = 4096;

// Deterministic per-cylinder strength wobble so the same engine always sounds the same.
function wobble(i, amount) {
  const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return 1 + (x - Math.floor(x) - 0.5) * 2 * amount;
}

/**
 * Pressure waveform of one bank over a 720° cycle.
 * @param {number[]} fireDegs firing TDC of each cylinder on this bank (0..720)
 * @param {number} pulseWidth crank degrees from valve opening to pulse peak
 * @param {number} roughness per-cylinder strength variation (0..0.3)
 * @param {number[]} ids stable cylinder ids for the wobble
 */
export function bankWaveform(fireDegs, pulseWidth = 40, roughness = 0.08, ids = fireDegs.map((_, i) => i)) {
  const wave = new Float32Array(SAMPLES);
  const exhaustOpen = 140; // the exhaust valve opens ~140° after firing TDC
  fireDegs.forEach((fire, j) => {
    const amp = wobble(ids[j], roughness);
    const start = fire + exhaustOpen;
    for (let s = 0; s < SAMPLES; s++) {
      const deg = (s / SAMPLES) * 720;
      let x = deg - start;
      x = ((x % 720) + 720) % 720;
      const u = x / pulseWidth;
      if (u < 6) wave[s] += amp * u * Math.exp(1 - u); // fast rise, exponential decay
    }
  });
  let mean = 0;
  for (let s = 0; s < SAMPLES; s++) mean += wave[s];
  mean /= SAMPLES;
  for (let s = 0; s < SAMPLES; s++) wave[s] -= mean;
  return wave;
}

/** Real/imag Fourier coefficients (index 0 = DC = 0) for harmonics 1..count. */
export function waveSpectrum(wave, count = 256) {
  const n = wave.length; // a power of two, so (h·s) mod n is a bit mask
  const cos = new Float32Array(n);
  const sin = new Float32Array(n);
  for (let s = 0; s < n; s++) {
    cos[s] = Math.cos((2 * Math.PI * s) / n);
    sin[s] = Math.sin((2 * Math.PI * s) / n);
  }
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  for (let h = 1; h <= count; h++) {
    let re = 0;
    let im = 0;
    for (let s = 0; s < n; s++) {
      const k = (h * s) & (n - 1);
      re += wave[s] * cos[k];
      im += wave[s] * sin[k];
    }
    real[h] = (2 * re) / n;
    imag[h] = (2 * im) / n;
  }
  return { real, imag };
}

/** Energy in a harmonic band, used by tests to check the character of each layout. */
export function harmonicEnergy({ real, imag }, h) {
  return real[h] * real[h] + imag[h] * imag[h];
}

/**
 * Per-bank spectra for an engine profile. For rotaries every rotor fires once
 * per shaft revolution, i.e. twice per 720° window.
 */
export function exhaustSpectra(profile, harmonics = 256) {
  const { banks, pulseWidth, roughness } = profile.exhaust;
  return banks.map((members) => {
    let fires;
    let ids;
    if (profile.kind === 'rotary') {
      fires = [];
      ids = [];
      members.forEach((r) => {
        const phase = profile.rotorPhases[r];
        fires.push(phase, phase + 360);
        ids.push(r * 2, r * 2 + 1);
      });
    } else {
      fires = members.map((i) => profile.cylinders[i].fireDeg);
      ids = members.map((i) => profile.cylinders[i].num);
    }
    return waveSpectrum(bankWaveform(fires, pulseWidth, roughness, ids), harmonics);
  });
}

// Render-quality policy: bloom on/off and the pixel ratio, from the user's
// quality setting and measured frame times. Pure: no three.js, no DOM.
//
// 'high' keeps bloom and only trades resolution; 'low' never blooms; 'auto'
// starts with bloom on capable devices, drops bloom first when frames run
// slow, then resolution, and recovers in the reverse order. Bloom comes back
// at most twice per session so a borderline device does not flicker.

export const QUALITY_WINDOW = 90; // frames per measurement window
export const SLOW_MS = 24; // average above this: shed load
export const FAST_MS = 13; // average below this: room to spare
const STEP = 0.25;
const MAX_BLOOM_DROPS = 2;

/** Whether a device should start with bloom in 'auto'. caps: {dpr, cores, coarse}. */
export function bloomCapable(caps = {}) {
  const cores = caps.cores ?? 4;
  // Phones are fine at 60 fps with a half-resolution bloom, but very old or
  // low-core devices are not.
  return cores >= 4 || (!caps.coarse && cores >= 2);
}

export function initialQuality(mode, caps = {}) {
  const dpr = caps.dpr || 1;
  const maxPixelRatio = Math.max(1, Math.min(dpr, mode === 'low' ? 1.5 : 2));
  return {
    mode,
    bloom: mode === 'high' || (mode === 'auto' && bloomCapable(caps)),
    pixelRatio: maxPixelRatio,
    maxPixelRatio,
    bloomDrops: 0,
  };
}

/**
 * Typical frame time of a measurement window: the median, so a handful of
 * hitches (shader compiles at boot, a rebuild, a tab switch) cannot read as
 * a slow device. Sorts `samples` in place.
 */
export function typicalFrameMs(samples) {
  const n = samples.length;
  if (!n) return 0;
  samples.sort((a, b) => a - b);
  const m = n >> 1;
  return n % 2 ? samples[m] : (samples[m - 1] + samples[m]) / 2;
}

/**
 * Feed one window's typical frame time (typicalFrameMs). Mutates `state` and returns what
 * changed: 'bloom-off' | 'bloom-on' | 'resolution' | null.
 */
export function adaptQuality(state, avgMs) {
  if (avgMs > SLOW_MS) {
    if (state.mode === 'auto' && state.bloom) {
      state.bloom = false;
      state.bloomDrops++;
      return 'bloom-off';
    }
    if (state.pixelRatio > 1) {
      state.pixelRatio = Math.max(1, state.pixelRatio - STEP);
      return 'resolution';
    }
    return null;
  }
  if (avgMs < FAST_MS) {
    if (state.pixelRatio < state.maxPixelRatio) {
      state.pixelRatio = Math.min(state.maxPixelRatio, state.pixelRatio + STEP);
      return 'resolution';
    }
    if (state.mode === 'auto' && !state.bloom && state.bloomDrops < MAX_BLOOM_DROPS) {
      state.bloom = true;
      return 'bloom-on';
    }
  }
  return null;
}

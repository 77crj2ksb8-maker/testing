// Tone-mapping maths for keeping the bloom and non-bloom render paths
// visually identical. Pure: no three.js, no DOM.

// three.js ACES filmic curve (tonemapping_pars_fragment) on a linear RGB triple.
export function acesFilmic(rgb, exposure, out) {
  const k = exposure / 0.6;
  const r = rgb[0] * k;
  const g = rgb[1] * k;
  const b = rgb[2] * k;
  const i0 = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const i1 = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const i2 = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const f0 = fit(i0);
  const f1 = fit(i1);
  const f2 = fit(i2);
  out[0] = 1.60475 * f0 - 0.53108 * f1 - 0.07367 * f2;
  out[1] = -0.10208 * f0 + 1.10813 * f1 - 0.00605 * f2;
  out[2] = -0.00327 * f0 - 0.07276 * f1 + 1.07602 * f2;
  return out;
}

/**
 * The linear colour that the ACES curve maps to `target` (linear RGB). The
 * direct render path clears to the background untouched while the composer
 * path tone-maps it, so the composer is given this pre-compensated colour.
 */
export function untoneMapped(target, exposure) {
  const x = [...target];
  const y = [0, 0, 0];
  for (let n = 0; n < 80; n++) {
    acesFilmic(x, exposure, y);
    for (let c = 0; c < 3; c++) x[c] = Math.max(0, x[c] + (target[c] - y[c]) * 2.5);
  }
  return x;
}

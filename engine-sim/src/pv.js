// Single-zone cylinder-pressure model for one cylinder of a four-stroke piston
// engine. Pure JS (no DOM): the telemetry charts draw what it returns.
//
// Angles are crank degrees from this cylinder's firing TDC, −360 … +360:
// intake −360…−180, compression −180…0, power 0…180, exhaust 180…360.
//
//  - Volume from the slider-crank: V = Vc + A·(l + a − a·cosθ − √(l² − a²sin²θ)).
//  - The intake stroke sits at manifold pressure (throttle and boost); the
//    charge is trapped at IVC and compressed polytropically.
//  - Heat is released on a Wiebe curve around TDC and the first law gives
//    dp = −γ·p·dV/V + (γ−1)·dQ/V (exact polytropic steps between heat inputs).
//  - The exhaust valve opens before BDC: blowdown decays the pressure to the
//    exhaust back-pressure, which the piston then pushes against.
//  - Heat released per cycle is chosen so the gross indicated mean effective
//    pressure matches the simulator's combustion torque: IMEP = 4π·T / Vd.

const DEG = Math.PI / 180;
export const PV_STEP_DEG = 1;
export const PV_POINTS = 720 / PV_STEP_DEG + 1; // −360 … +360 inclusive
const GAMMA = 1.3; // lumped polytropic exponent for compression and expansion
const IVC_DEG = -160; // effective inlet valve closing (20° after BDC)
const EVO_DEG = 130; // exhaust valve opening (50° before BDC)
const BLOWDOWN_DEG = 22; // e-folding angle of the blowdown pressure drop
const WIEBE_A = 5;
const WIEBE_M = 2;
const BAR = 1e5;

/** Cylinder geometry (SI units) from an engine profile. */
export function pvGeometry(profile) {
  const bore = (profile.boreMm ?? 86) / 1000;
  const stroke = (profile.strokeMm ?? 86) / 1000;
  const crank = stroke / 2;
  const rod = (profile.rodRatio ?? 1.7) * stroke;
  const area = (Math.PI * bore * bore) / 4;
  const vd = area * stroke;
  const cr = Math.max(6, profile.compressionRatio ?? 10.5);
  const vc = vd / (cr - 1);
  return { bore, stroke, crank, rod, area, vd, vc, cr, cylinders: Math.max(1, profile.cylinders?.length ?? 1) };
}

/** Cylinder volume (m³) at a crank angle (degrees from firing TDC). */
export function volumeAt(g, deg) {
  const th = deg * DEG;
  const s = g.crank * Math.sin(th);
  const x = g.crank * Math.cos(th) + Math.sqrt(g.rod * g.rod - s * s);
  return g.vc + g.area * (g.rod + g.crank - x);
}

/** Cumulative Wiebe burn fraction at angle deg for start `soc` and duration `dur`. */
export function wiebe(deg, soc, dur) {
  if (deg <= soc) return 0;
  const x = Math.min(1, (deg - soc) / dur);
  return 1 - Math.exp(-WIEBE_A * Math.pow(x, WIEBE_M + 1));
}

/** Combustion timing for an engine speed: start of combustion and burn duration (deg). */
export function burnTiming(rpm, redlineRpm) {
  const u = Math.min(1.2, Math.max(0, rpm / Math.max(1000, redlineRpm)));
  // Advance grows with speed so half the charge has burnt ~8° after TDC.
  return { soc: -12 - 14 * u, dur: 44 + 18 * u };
}

/** Gross IMEP (bar) a combustion torque implies for the whole engine. */
export const imepFromTorque = (torqueNm, displacementL) => (4 * Math.PI * Math.max(0, torqueNm)) / (displacementL / 1000) / BAR;

/** Preallocated output buffers for computeCycle (reuse one per chart). */
export function createCycle() {
  return {
    deg: new Float32Array(PV_POINTS),
    v: new Float32Array(PV_POINTS), // m³
    p: new Float32Array(PV_POINTS), // bar absolute
    pMotored: new Float32Array(PV_POINTS),
    pHeat: new Float64Array(PV_POINTS), // scratch: response to the reference heat input
    peakBar: 0,
    peakDeg: 0,
    imep: 0, // gross (compression + power strokes), bar
    pmep: 0, // pumping loop (intake + exhaust strokes), bar
    imepNet: 0,
    heatJ: 0,
    vMin: 0,
    vMax: 0,
  };
}

const Q_REF = 1000; // J: reference heat input for the superposition

/**
 * Fill `out` with one cycle. Options:
 *  - pIntake: manifold pressure, bar absolute (≈1 at wide-open throttle NA)
 *  - pExhaust: exhaust back-pressure, bar absolute
 *  - rpm, redlineRpm: combustion timing
 *  - imepTarget: wanted gross IMEP (bar); 0 = motoring (no combustion)
 */
export function computeCycle(g, opts, out = createCycle()) {
  const pIn = Math.max(0.15, opts.pIntake ?? 1);
  const pEx = Math.max(0.9, opts.pExhaust ?? 1.05);
  const { soc, dur } = burnTiming(opts.rpm ?? 3000, opts.redlineRpm ?? 7000);
  const { deg, v, p, pMotored, pHeat } = out;

  for (let i = 0; i < PV_POINTS; i++) {
    deg[i] = -360 + i * PV_STEP_DEG;
    v[i] = volumeAt(g, deg[i]);
  }
  out.vMin = g.vc;
  out.vMax = g.vc + g.vd;

  // Two passes from the same trapped charge: no heat (motoring) and a
  // reference heat input. The pressure is affine in the heat released, so
  // any heat input is a blend of the two.
  const iIvc = Math.round((IVC_DEG + 360) / PV_STEP_DEG);
  const iEvo = Math.round((EVO_DEG + 360) / PV_STEP_DEG);
  for (let pass = 0; pass < 2; pass++) {
    const target = pass === 0 ? pMotored : pHeat;
    const q = pass === 0 ? 0 : Q_REF;
    for (let i = 0; i <= iIvc; i++) target[i] = gasExchange(deg[i], pIn, pEx);
    let pr = pIn * BAR;
    let burnt = wiebe(deg[iIvc], soc, dur);
    let evoPoly = 0;
    for (let i = iIvc + 1; i < PV_POINTS; i++) {
      const v0 = v[i - 1];
      const v1 = v[i];
      const b = wiebe(deg[i], soc, dur);
      const dQ = q * (b - burnt);
      burnt = b;
      pr = pr * Math.pow(v0 / v1, GAMMA) + ((GAMMA - 1) * dQ) / (0.5 * (v0 + v1));
      if (i <= iEvo) {
        target[i] = pr / BAR;
        if (i === iEvo) evoPoly = pr / BAR;
      } else {
        // Blowdown: what is left above the back-pressure bleeds away, then
        // the piston pushes the rest out against the exhaust system.
        const w = Math.exp(-(deg[i] - EVO_DEG) / BLOWDOWN_DEG);
        const poly = evoPoly * Math.pow(v[iEvo] / v1, GAMMA);
        target[i] = gasExchange(deg[i], pIn, pEx) + Math.max(0, poly - pEx) * w;
      }
    }
  }

  const imep0 = workBar(out, pMotored, -180, 180, g.vd);
  const imep1 = workBar(out, pHeat, -180, 180, g.vd);
  const perJ = (imep1 - imep0) / Q_REF;
  const wanted = Math.max(0, opts.imepTarget ?? 0);
  const heat = perJ > 0 ? Math.max(0, (wanted - imep0) / perJ) : 0;
  const k = heat / Q_REF;
  let peak = 0;
  let peakDeg = 0;
  for (let i = 0; i < PV_POINTS; i++) {
    const val = pMotored[i] + k * (pHeat[i] - pMotored[i]);
    p[i] = val;
    if (val > peak) {
      peak = val;
      peakDeg = deg[i];
    }
  }
  out.heatJ = heat;
  out.peakBar = peak;
  out.peakDeg = peakDeg;
  out.imep = workBar(out, p, -180, 180, g.vd);
  out.imepNet = workBar(out, p, -360, 360, g.vd);
  out.pmep = out.imepNet - out.imep;
  return out;
}

// Pressure during the gas-exchange strokes (outside the closed part of the cycle).
function gasExchange(deg, pIn, pEx) {
  // Valve overlap around TDC: the cylinder swings from exhaust to manifold
  // pressure (continuous across the ±360° wrap).
  if (deg < -330) {
    const t = (deg + 360) / 30;
    return pEx + (pIn - pEx) * (0.25 + 0.75 * t * t * (3 - 2 * t));
  }
  if (deg <= IVC_DEG) return pIn;
  if (deg >= 330) return pEx + (pIn - pEx) * 0.25 * ((deg - 330) / 30);
  return pEx;
}

// Work over [from, to] degrees divided by the swept volume, in bar (trapezoids).
function workBar(out, p, from, to, vd) {
  const { v } = out;
  const a = Math.round((from + 360) / PV_STEP_DEG);
  const b = Math.round((to + 360) / PV_STEP_DEG);
  let w = 0;
  for (let i = a + 1; i <= b; i++) w += 0.5 * (p[i] + p[i - 1]) * (v[i] - v[i - 1]);
  return w / vd;
}

/** Index into a cycle's arrays for a crank angle from firing TDC (any value; wraps to −360…360). */
export function cycleIndex(deg) {
  let d = ((deg % 720) + 720) % 720; // 0..720
  if (d > 360) d -= 720; // −360..360
  return Math.max(0, Math.min(PV_POINTS - 1, Math.round((d + 360) / PV_STEP_DEG)));
}

/** Pressure (bar abs) at a crank angle, linearly interpolated. */
export function pressureAt(out, deg) {
  let d = ((deg % 720) + 720) % 720;
  if (d > 360) d -= 720;
  const x = (d + 360) / PV_STEP_DEG;
  const i = Math.min(PV_POINTS - 2, Math.max(0, Math.floor(x)));
  const f = x - i;
  return out.p[i] + (out.p[i + 1] - out.p[i]) * f;
}

/**
 * Operating point for the model from the live simulator: manifold and exhaust
 * pressure and the gross IMEP its combustion torque implies.
 */
export function operatingPoint(sim, profile, target = {}) {
  const boost = Number.isFinite(sim.boostBar) ? sim.boostBar : -0.7 + 0.7 * (sim.throttleEffective ?? 0);
  const turbo = sim.inductionKind === 'turbo' || sim.inductionKind === 'twin-turbo';
  const rpm = sim.rpm;
  const u = rpm / profile.redlineRpm;
  target.rpm = rpm;
  target.redlineRpm = profile.redlineRpm;
  target.pIntake = Math.max(0.2, 1 + boost);
  // A turbine in the exhaust costs back-pressure roughly in step with boost.
  target.pExhaust = 1.03 + 0.12 * u * u + (turbo ? 0.9 * Math.max(0, boost) : 0);
  target.imepTarget = sim.running && !sim.fuelCut ? imepFromTorque(sim.combustionTorque, profile.displacementL) : 0;
  return target;
}

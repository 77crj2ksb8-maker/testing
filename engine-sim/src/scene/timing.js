// Valve timing, cam phasing, stroke phases and colour ramps for the renderer.
// Pure maths shared by the 3D view and the tests: no three.js, no DOM.
//
// Angles are crank degrees after this cylinder's firing TDC (0..720) unless
// a name says otherwise. The crank is drawn turning −θ about +Z and the cams
// follow it at half speed in the same direction.

/** Four-stroke valve events, crank degrees after firing TDC. */
export const VALVE_EVENTS = Object.freeze({ evo: 130, evc: 375, ivo: 345, ivc: 590 });
export const INTAKE_DURATION = VALVE_EVENTS.ivc - VALVE_EVENTS.ivo;
export const EXHAUST_DURATION = VALVE_EVENTS.evc - VALVE_EVENTS.evo;
export const INTAKE_PEAK = (VALVE_EVENTS.ivo + VALVE_EVENTS.ivc) / 2;
export const EXHAUST_PEAK = (VALVE_EVENTS.evo + VALVE_EVENTS.evc) / 2;

export const STROKES = Object.freeze([
  { id: 'power', label: 'Power' },
  { id: 'exhaust', label: 'Exhaust' },
  { id: 'intake', label: 'Intake' },
  { id: 'compression', label: 'Compression' },
]);

const wrap = (a, n) => ((a % n) + n) % n;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Signed angle in (−180, 180]. */
export const wrapSigned = (deg) => {
  const a = wrap(deg, 360);
  return a > 180 ? a - 360 : a;
};

/** Normalised lift (0..1) of a valve that opens at `open` and closes at `close` crank degrees. */
export function valveLift(deg, open, close) {
  const dur = close - open;
  const u = wrap(deg - open, 720) / dur;
  if (u >= 1) return 0;
  const s = Math.sin(Math.PI * u);
  return s * s;
}

export const intakeLift = (deg) => valveLift(deg, VALVE_EVENTS.ivo, VALVE_EVENTS.ivc);
export const exhaustLift = (deg) => valveLift(deg, VALVE_EVENTS.evo, VALVE_EVENTS.evc);

/** Cam rotation (degrees about +Z) at a crank angle: half speed, same direction as the crank. */
export const camRotationDeg = (crankDeg) => -crankDeg / 2;

/**
 * Lobe angle in the cam's own frame so the lobe points at its follower
 * (followerDeg, measured like atan2 in the crank plane) exactly when the valve
 * is fully open, i.e. at crank angle fireDeg + peakDeg.
 */
export function camLobeAngle(fireDeg, peakDeg, followerDeg) {
  return wrap(followerDeg - camRotationDeg(fireDeg + peakDeg), 360);
}

/** Signed cam degrees between a lobe and its follower at a crank angle (0 = nose on the follower). */
export function lobeOffsetDeg(lobeDeg, crankDeg, followerDeg) {
  return wrapSigned(lobeDeg + camRotationDeg(crankDeg) - followerDeg);
}

/**
 * Lobe profile: normalised lift the follower sees when the nose is `offsetCamDeg`
 * cam degrees away. Uses the same curve as valveLift, so the cam's shape and
 * the valve motion agree.
 */
export function lobeLift(offsetCamDeg, durationCrankDeg) {
  const u = 0.5 + (2 * offsetCamDeg) / durationCrankDeg;
  if (u <= 0 || u >= 1) return 0;
  const s = Math.sin(Math.PI * u);
  return s * s;
}

/** Stroke index into STROKES (0 power, 1 exhaust, 2 intake, 3 compression). */
export const strokeIndex = (deg) => Math.floor(wrap(deg, 720) / 180) % 4;
/** Progress through the current stroke, 0..1. */
export const strokeProgress = (deg) => (wrap(deg, 720) % 180) / 180;

// Gas colour keyframes: [deg, r, g, b, alpha, glow]. Burning cycle, then a
// motoring cycle (no combustion: the compressed charge just expands again).
const GAS_BURN = [
  0, 1.0, 0.78, 0.42, 0.62, 1.0,
  25, 1.0, 0.55, 0.16, 0.6, 0.9,
  90, 1.0, 0.36, 0.08, 0.52, 0.55,
  170, 0.6, 0.15, 0.06, 0.45, 0.2,
  205, 0.44, 0.42, 0.44, 0.46, 0.04,
  345, 0.38, 0.38, 0.42, 0.14, 0,
  385, 0.3, 0.6, 1.0, 0.2, 0,
  520, 0.32, 0.58, 1.0, 0.3, 0,
  560, 0.48, 0.45, 1.0, 0.32, 0,
  700, 0.66, 0.38, 1.0, 0.55, 0.05,
];
const GAS_MOTOR = [
  0, 0.66, 0.4, 1.0, 0.55, 0.04,
  170, 0.5, 0.45, 0.85, 0.3, 0,
  205, 0.45, 0.47, 0.6, 0.2, 0,
  345, 0.38, 0.4, 0.5, 0.1, 0,
  385, 0.3, 0.6, 1.0, 0.2, 0,
  520, 0.32, 0.58, 1.0, 0.3, 0,
  560, 0.48, 0.45, 1.0, 0.32, 0,
  700, 0.66, 0.38, 1.0, 0.55, 0.05,
];

function sampleKeys(keys, deg, out) {
  const n = keys.length / 6;
  const d = wrap(deg, 720);
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (keys[k * 6] > d) break;
    i = k;
  }
  const j = (i + 1) % n;
  const a0 = keys[i * 6];
  let a1 = keys[j * 6];
  let x = d;
  if (a1 <= a0) {
    a1 += 720;
    if (x < a0) x += 720;
  }
  const t = (x - a0) / (a1 - a0);
  for (let c = 1; c < 6; c++) out[c - 1] = keys[i * 6 + c] + (keys[j * 6 + c] - keys[i * 6 + c]) * t;
  return out;
}

/**
 * Stroke-gas tint for a cylinder: out = [r, g, b, alpha, glow].
 * load (0..1) thickens the intake charge; burning=false (fuel cut, stopped)
 * leaves the power stroke as expanding unburnt charge.
 */
export function gasColor(deg, load, burning, out) {
  sampleKeys(burning ? GAS_BURN : GAS_MOTOR, deg, out);
  const d = wrap(deg, 720);
  if (d >= 345) out[3] *= 0.55 + 0.45 * clamp01(load); // thinner charge at closed throttle
  return out;
}

/**
 * Wankel port flow (0..1) for a rotor, from shaft degrees since its last
 * firing (0..360). The three faces are 360° apart; each spends 270° in each
 * phase. out = [intake, exhaust].
 */
export function rotaryPortFlow(deg, out) {
  const d = wrap(deg, 360);
  let intake = 0;
  let exhaust = 0;
  for (let k = 0; k < 3; k++) {
    const phase = d + 360 * k;
    if (phase >= 270 && phase < 540) exhaust += Math.sin((Math.PI * (phase - 270)) / 270) ** 2;
    if (phase >= 540 && phase < 810) intake += Math.sin((Math.PI * (phase - 540)) / 270) ** 2;
  }
  out[0] = intake;
  out[1] = exhaust;
  return out;
}

/** Exhaust-gas temperature (°C) to a 0..1 glow level: dark below ~420 °C, white-hot near 950 °C. */
export const egtHeat = (egtC) => clamp01(((egtC ?? 350) - 420) / 530);

const HEAT = [
  0, 0, 0, 0,
  0.25, 0.32, 0.02, 0.0,
  0.55, 0.9, 0.17, 0.02,
  0.8, 1.0, 0.42, 0.07,
  1.0, 1.0, 0.7, 0.34,
];

/** Black-body-ish glow colour for a heat level 0..1; out = [r, g, b]. */
export function heatColor(t, out) {
  const x = clamp01(t);
  for (let k = 1; k < 5; k++) {
    if (x <= HEAT[k * 4] || k === 4) {
      const a = HEAT[(k - 1) * 4];
      const f = (x - a) / (HEAT[k * 4] - a);
      for (let c = 1; c < 4; c++) out[c - 1] = HEAT[(k - 1) * 4 + c] + (HEAT[k * 4 + c] - HEAT[(k - 1) * 4 + c]) * f;
      break;
    }
  }
  return out;
}

// ── Motion helpers ─────────────────────────────────────────────────────────

export const easeInOutCubic = (t) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

/**
 * Interpolate two orbits {radius, theta, phi} (three.js Spherical order) along
 * the shorter way round, so fly-to moves arc around the target instead of
 * cutting through the model.
 */
export function lerpOrbit(a, b, t, out) {
  let dTheta = wrap(b.theta - a.theta + Math.PI, Math.PI * 2) - Math.PI;
  if (dTheta === -Math.PI) dTheta = Math.PI;
  out.radius = a.radius + (b.radius - a.radius) * t;
  out.theta = a.theta + dTheta * t;
  out.phi = a.phi + (b.phi - a.phi) * t;
  return out;
}

/** Smooth deterministic noise in [−1, 1] for camera shake (sum of incommensurate sines). */
export function shakeNoise(t, seed) {
  return (
    Math.sin(t * 37.1 + seed * 1.7) * 0.5
    + Math.sin(t * 23.3 + seed * 4.1) * 0.3
    + Math.sin(t * 61.7 + seed * 2.9) * 0.2
  );
}

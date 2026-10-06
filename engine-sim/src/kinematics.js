// Slider-crank and Wankel geometry. Pure math shared by the renderer and tests.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const wrap = (a, n) => ((a % n) + n) % n;

/**
 * Piston pin distance from the crank axis along the cylinder axis.
 *   pY = r·cos(θ) + sqrt(L² − (r·sin(θ))²)
 * θ is the crank angle measured from this cylinder's top dead centre (radians).
 */
export function pistonPosition(theta, crankRadius, rodLength) {
  const s = crankRadius * Math.sin(theta);
  return crankRadius * Math.cos(theta) + Math.sqrt(rodLength * rodLength - s * s);
}

// Unit vector for an angle measured from +Y towards +X (degrees).
export function axisFromVertical(deg) {
  const a = deg * DEG;
  return [Math.sin(a), Math.cos(a)];
}

/**
 * Full 2-D pose of one cylinder's moving parts at crank angle thetaDeg.
 * Returns the crank-pin centre, piston-pin centre (both in the crank plane,
 * origin on the crank axis) and the local crank angle from this cylinder's TDC.
 */
export function cylinderPose(cyl, thetaDeg, crankRadius, rodLength) {
  const pinWorld = (cyl.pinDeg + thetaDeg) * DEG;
  const pin = [crankRadius * Math.sin(pinWorld), crankRadius * Math.cos(pinWorld)];
  const local = (cyl.pinDeg + thetaDeg - cyl.bankDeg) * DEG; // = θ − fireDeg
  const pY = pistonPosition(local, crankRadius, rodLength);
  const [ax, ay] = axisFromVertical(cyl.bankDeg);
  return { pin, piston: [ax * pY, ay * pY], pY, localDeg: wrap((thetaDeg - cyl.fireDeg), 720) };
}

// Degrees since this cylinder's last firing TDC (0..720).
export const degreesSinceFiring = (fireDeg, thetaDeg) => wrap(thetaDeg - fireDeg, 720);

/**
 * Combustion flash intensity (0..1) for a cylinder. Peaks right after firing
 * TDC and fades over the first part of the power stroke.
 */
export function combustionFlash(degSinceFire, lengthDeg = 120) {
  if (degSinceFire >= lengthDeg) return 0;
  const k = 1 - degSinceFire / lengthDeg;
  return k * k;
}

// ── Wankel ──────────────────────────────────────────────────────────────────

/** Point on the epitrochoid housing bore. t in radians. R = generating radius, e = eccentricity. */
export function epitrochoid(t, R, e) {
  return [e * Math.cos(3 * t) + R * Math.cos(t), e * Math.sin(3 * t) + R * Math.sin(t)];
}

/**
 * Rotor pose for eccentric-shaft angle shaftDeg plus this rotor's phase.
 * The rotor centre orbits the shaft at radius e while the rotor turns at one
 * third of shaft speed, so each apex traces the epitrochoid.
 */
export function rotorPose(shaftDeg, phaseDeg, R, e) {
  const a = (shaftDeg + phaseDeg) * DEG;
  const center = [e * Math.cos(a), e * Math.sin(a)];
  const rotation = a / 3;
  const apexes = [0, 1, 2].map((k) => {
    const t = rotation + (k * 2 * Math.PI) / 3;
    return [center[0] + R * Math.cos(t), center[1] + R * Math.sin(t)];
  });
  return { center, rotation, apexes };
}

// Shaft angle (relative to rotor phase) at which a rotor face sits on the spark-plug side minor axis.
export const ROTOR_SPARK_DEG = 270;

export const rotorDegreesSinceFiring = (shaftDeg, phaseDeg) => wrap(shaftDeg + phaseDeg - ROTOR_SPARK_DEG, 360);

/**
 * Cylinders (or rotors) whose firing TDC falls in the crank interval (from, to].
 * Angles are cumulative degrees; handles several cycles in one step.
 */
export function firingsBetween(fromDeg, toDeg, fireAngles, cycleDeg = 720) {
  const out = [];
  if (toDeg <= fromDeg) return out;
  fireAngles.forEach((fire, i) => {
    // First firing strictly after fromDeg.
    let k = Math.floor((fromDeg - fire) / cycleDeg) + 1;
    for (let a = fire + k * cycleDeg; a <= toDeg; a += cycleDeg) out.push({ index: i, at: a });
  });
  return out.sort((a, b) => a.at - b.at);
}

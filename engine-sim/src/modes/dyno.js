// Chassis dyno maths. Pure JS (no DOM): the feature module swaps the car onto
// a roller drive, runs the pull and feeds samples into a DynoRecorder.
//
// An inertia dyno measures nothing but roller speed. The driven wheels push
// the rollers (equivalent mass M) and the engine's own rotating parts along,
// so with the clutch locked in gear G:
//
//   wheel force      F  = M·a
//   crank torque     Te = F·r / (G·η)  +  I·a·G / r
//
// where a is the roller acceleration, r the tyre radius, η the driveline
// efficiency and I the engine inertia (the second term is the torque spent
// spinning up the crank and flywheel, which a real dyno corrects for too).

const TWO_PI = Math.PI * 2;
const RPM_TO_RAD = TWO_PI / 60;
const HP_PER_NM_RPM = 1 / 7023.5; // metric horsepower

export const DYNO_GEAR = 4;
export const SWEEP_RPM_PER_S = 600; // nominal sweep rate the roller mass is sized for
export const BIN_RPM = 100;
const ROLLER_MASS_MIN = 250; // kg
const ROLLER_MASS_MAX = 4000;
const ROLLER_BRAKE_DECEL = 16; // m/s² the roller brake can pull after a pull
const REGRESSION_HALF_WINDOW = 0.12; // s either side of a sample for the slope fit

/** Engine rpm a pull starts from. */
export function pullStartRpm(profile) {
  return Math.round(Math.min(Math.max(2000, profile.idleRpm + 900), profile.redlineRpm * 0.42) / 100) * 100;
}

/** Engine rpm a pull ends at (just short of the limiter). */
export const pullEndRpm = (profile) => profile.redlineRpm - 150;

/**
 * Drive config for the rollers: the car's own gearing and tyres, no aero or
 * rolling loss, no traction limit, and an equivalent roller mass sized so a
 * full-throttle pull sweeps at about SWEEP_RPM_PER_S whatever the engine.
 * peakNm: the engine's rated peak torque.
 */
export function rollerDrive(drive, peakNm, gear = DYNO_GEAR, sweepRpmPerS = SWEEP_RPM_PER_S) {
  const G = drive.gearRatios[gear - 1] * drive.finalDrive;
  const r = drive.tireDiameter / 2;
  const eta = drive.drivelineEfficiency;
  const alpha = sweepRpmPerS * RPM_TO_RAD; // engine rad/s²
  const raw = (peakNm * G * G * eta) / (r * r * alpha);
  const mass = Math.min(ROLLER_MASS_MAX, Math.max(ROLLER_MASS_MIN, Math.round(raw / 10) * 10));
  return {
    ...drive,
    gearRatios: [...drive.gearRatios],
    vehicleMass: mass,
    dragArea: 0,
    rollingCoeff: 0,
    tractionLimit: 1e9,
    brakeForce: mass * ROLLER_BRAKE_DECEL,
  };
}

/** Everything needed to turn roller acceleration into crank torque. */
export function dynoConfig(drive, profile, gear = DYNO_GEAR) {
  return {
    rollerMass: drive.vehicleMass,
    wheelRadius: drive.tireDiameter / 2,
    ratio: drive.gearRatios[gear - 1] * drive.finalDrive,
    efficiency: drive.drivelineEfficiency,
    engineInertia: profile.inertia,
  };
}

/** Crank torque (Nm) from roller acceleration (m/s²). */
export function crankTorqueFromRoller(accel, c) {
  const wheelTorque = c.rollerMass * accel * c.wheelRadius;
  return wheelTorque / (c.ratio * c.efficiency) + (c.engineInertia * accel * c.ratio) / c.wheelRadius;
}

/** Engine rpm for a roller surface speed (m/s) in the dyno gear. */
export const rpmFromRoller = (v, c) => ((v / c.wheelRadius) * c.ratio) / RPM_TO_RAD;

export const hpFrom = (nm, rpm) => nm * rpm * HP_PER_NM_RPM;

/** Centred moving average over ±radius points (new array). */
export function smoothSeries(values, radius = 1) {
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      sum += values[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/** Peak torque and power of a curve [{rpm, nm, hp}]. */
export function curvePeaks(points) {
  const out = { peakNm: 0, peakNmRpm: 0, peakHp: 0, peakHpRpm: 0 };
  for (const p of points) {
    if (p.nm > out.peakNm) {
      out.peakNm = p.nm;
      out.peakNmRpm = p.rpm;
    }
    if (p.hp > out.peakHp) {
      out.peakHp = p.hp;
      out.peakHpRpm = p.rpm;
    }
  }
  return out;
}

/**
 * Collects roller samples during a pull into preallocated buffers (no
 * allocation per sample) and turns them into a torque curve: a least-squares
 * slope of roller speed over a short time window gives the acceleration,
 * which becomes crank torque, binned by rpm and lightly smoothed.
 */
export class DynoRecorder {
  constructor(capacity = 12000) {
    this.capacity = capacity;
    this.t = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
    this.rpm = new Float32Array(capacity);
    // Live curve drawn while the pull runs.
    this.liveRpm = new Float32Array(2048);
    this.liveNm = new Float32Array(2048);
    this.config = null;
    this.reset(null);
  }

  reset(config) {
    this.config = config;
    this.n = 0;
    this.liveN = 0;
    this.liveCursor = 0; // next sample index to evaluate for the live curve
    this.lastLiveRpm = -Infinity;
  }

  /** Add one sample: sim time (s), roller speed (m/s), engine rpm. */
  push(t, v, rpm) {
    if (this.n >= this.capacity) return;
    if (this.n && t <= this.t[this.n - 1]) return; // ignore zero-length steps
    this.t[this.n] = t;
    this.v[this.n] = v;
    this.rpm[this.n] = rpm;
    this.n++;
  }

  /** Least-squares dv/dt over samples within ±halfWindow s of sample i. */
  slopeAt(i, halfWindow = REGRESSION_HALF_WINDOW) {
    const { t, v, n } = this;
    const t0 = t[i];
    let a = i;
    let b = i;
    while (a > 0 && t0 - t[a - 1] <= halfWindow) a--;
    while (b < n - 1 && t[b + 1] - t0 <= halfWindow) b++;
    if (b - a < 2) return null;
    let st = 0;
    let sv = 0;
    for (let k = a; k <= b; k++) {
      st += t[k] - t0;
      sv += v[k];
    }
    const m = b - a + 1;
    const tm = st / m;
    const vm = sv / m;
    let num = 0;
    let den = 0;
    for (let k = a; k <= b; k++) {
      const dt = t[k] - t0 - tm;
      num += dt * (v[k] - vm);
      den += dt * dt;
    }
    return den > 0 ? num / den : null;
  }

  /** Crank torque at sample i, or null near the ends of the record. */
  torqueAt(i) {
    const acc = this.slopeAt(i);
    return acc === null ? null : crankTorqueFromRoller(acc, this.config);
  }

  /**
   * Extend the live curve with every sample whose full regression window has
   * arrived, from `fromRpm` up (the first moments of a pull are the throttle
   * opening, not the engine's curve). Returns true when points were added.
   */
  updateLive(fromRpm = 0, minStepRpm = 30) {
    const { t, n } = this;
    let added = false;
    while (this.liveCursor < n && t[n - 1] - t[this.liveCursor] >= REGRESSION_HALF_WINDOW) {
      const i = this.liveCursor++;
      if (t[i] - t[0] < REGRESSION_HALF_WINDOW) continue;
      const rpm = this.rpm[i];
      if (rpm < fromRpm || rpm - this.lastLiveRpm < minStepRpm || this.liveN >= this.liveRpm.length) continue;
      const nm = this.torqueAt(i);
      if (nm === null) continue;
      this.liveRpm[this.liveN] = rpm;
      this.liveNm[this.liveN] = nm;
      this.liveN++;
      this.lastLiveRpm = rpm;
      added = true;
    }
    return added;
  }

  /**
   * Final curve: torque per sample, averaged into `binRpm` bins between
   * fromRpm and toRpm, then a light 3-point smooth. Returns
   * { points: [{rpm, nm, hp}], peakNm, peakNmRpm, peakHp, peakHpRpm }.
   */
  finish({ fromRpm = 0, toRpm = Infinity, binRpm = BIN_RPM } = {}) {
    const sums = new Map();
    for (let i = 0; i < this.n; i++) {
      if (this.t[i] - this.t[0] < REGRESSION_HALF_WINDOW) continue; // throttle still opening
      const rpm = this.rpm[i];
      if (rpm < fromRpm || rpm > toRpm) continue;
      const nm = this.torqueAt(i);
      if (nm === null) continue;
      const bin = Math.round(rpm / binRpm) * binRpm;
      const s = sums.get(bin) ?? { nm: 0, count: 0 };
      s.nm += nm;
      s.count++;
      sums.set(bin, s);
    }
    const bins = [...sums.keys()].sort((a, b) => a - b);
    const nms = smoothSeries(bins.map((b) => sums.get(b).nm / sums.get(b).count), 1);
    const points = bins.map((rpm, i) => ({ rpm, nm: nms[i], hp: hpFrom(nms[i], rpm) }));
    return { points, ...curvePeaks(points) };
  }
}

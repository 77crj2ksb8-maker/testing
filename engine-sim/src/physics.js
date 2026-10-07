// Engine + clutch + vehicle physics. Pure JS, no DOM and no three.js.
//
// The engine and the car are two inertias joined by a friction clutch. While
// the clutch slips it passes its full capacity torque; once the slip speed
// crosses zero and the capacity can hold the load, the two lock and move as
// one body until the torque through the clutch exceeds its capacity again.
//
// Around that core: forced induction (src/induction.js), temperatures and
// damage (src/thermal.js), variable valve lift, a two-step launch limiter,
// traction control and exhaust backfires drawn from a seeded PRNG so runs
// are reproducible.

import { naTorque, wotTorque } from './config.js';
import { Induction } from './induction.js';
import { Thermal, overrevSeverity } from './thermal.js';

const TWO_PI = Math.PI * 2;
export const RPM_TO_RAD = TWO_PI / 60;
const AIR_DENSITY = 1.225;
const G_ACCEL = 9.81;
const SUBSTEP = 0.002; // s
const LIMITER_HYSTERESIS = 250; // rpm
const TWO_STEP_HYSTERESIS = 140; // rpm: a tighter cut makes the two-step crackle
const VVL_HYSTERESIS = 300; // rpm
const BACKFIRE_MIN_GAP = 0.035; // s between backfire events
const TWO_STEP_MIN_GAP = 0.08; // s between 'twostep' events
const TC_MIN_GAP = 0.8; // s between 'tc' events
const RNG_SEED = 0x5eed1e55;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Clutch engagement (0 = open, 1 = fully clamped) from pedal travel (1 = floored). */
export function clutchEngagement(pedal) {
  if (pedal >= 0.8) return 0; // pedal past 80 %: fully disengaged, the engine revs freely
  const x = clamp((0.8 - pedal) / 0.55, 0, 1);
  return Math.pow(x, 1.6);
}

/** Small deterministic PRNG (mulberry32). Returns a function giving floats in [0, 1). */
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

/** Rated (peak) crank power of a profile in watts, for normalising heat. */
function ratedPowerW(profile) {
  let best = 1;
  for (let i = 1; i <= 40; i++) {
    const rpm = (profile.redlineRpm * i) / 40;
    best = Math.max(best, wotTorque(profile, rpm) * rpm * RPM_TO_RAD);
  }
  return best;
}

export class Drivetrain {
  constructor(profile, drive) {
    this.profile = profile;
    this.drive = drive;
    this.induction = new Induction(profile.induction);
    this.thermal = new Thermal();
    this.ratedW = ratedPowerW(profile);
    this.reset();
  }

  setProfile(profile) {
    this.profile = profile;
    this.induction.configure(profile.induction);
    this.inductionKind = this.induction.kind;
    this.boostTarget = this.induction.boostTarget;
    this.ratedW = ratedPowerW(profile);
    if (!profile.vvlRpm) this.vvlActive = false;
    if (this.running) this.omega = Math.max(this.omega, profile.idleRpm * RPM_TO_RAD * 0.9);
    this.locked = false;
  }

  setDrive(drive) {
    this.drive = drive;
    this.locked = false;
  }

  reset() {
    const p = this.profile;
    this.omega = p.idleRpm * RPM_TO_RAD;
    this.inputOmega = this.omega;
    this.running = true;
    this.cranking = false;
    this.crankTime = 0;
    this.startGrace = 0;
    this.v = 0; // m/s, signed (negative when reversing)
    this.gear = 'N';
    this.locked = false;
    this.throttleInput = 0;
    this.throttle = 0;
    this.throttlePlate = 0; // throttle plate incl. the idle valve (ignores ignition cuts)
    this.throttleEffective = 0;
    this.clutchPedal = 0;
    this.brake = 0;
    this.torqueCut = false; // automated-gearbox ignition cut during shifts
    this.idleI = 0.03;
    this.fuelCut = false;
    this.combustionTorque = 0;
    this.engineTorque = 0;
    this.clutchTorque = 0;
    this.slipPower = 0;
    this.wheelspin = false;
    this.distance = 0;
    this.time = 0;
    this.events = [];
    this.rng = mulberry32(RNG_SEED);

    this.induction.configure(p.induction);
    this.induction.reset();
    this.thermal.reset();
    this.inductionKind = this.induction.kind; // 'na' | 'turbo' | 'twin-turbo' | 'supercharger'
    this.boostBar = this.induction.boostBar; // manifold pressure, bar gauge (negative = vacuum)
    this.boostTarget = this.induction.boostTarget;
    this.turboRpm = 0;
    this.coolantC = this.thermal.coolantC;
    this.oilC = this.thermal.oilC;
    this.egtC = this.thermal.egtC;
    this.damage = 0; // 0 healthy … 1 destroyed
    this.blown = false; // catastrophic failure: cannot run until repair()
    this.blownCause = null;
    this.vvlActive = false; // high-lift cam engaged
    this.launchArmed = false; // two-step conditions met (stationary, clutch in or brake held)
    this.launchActive = false; // two-step limiter currently holding revs
    this.tcActive = false; // traction control currently cutting torque
    this.tcFactor = 1; // torque fraction traction control lets through
    this.limiterRpm = p.redlineRpm;
    this.assists = { autoBlip: false, launchControl: false, launchRpm: 4500, tractionControl: false };

    this.misfire = 1;
    this.misfireClock = 0;
    this.liftTime = 10; // s since the throttle last closed (overrun crackle window)
    this.backfireClock = 0;
    this.lastBackfire = -1;
    this.lastTwoStep = -1;
    this.lastTc = -1;
  }

  /**
   * Apply runtime options from the settings object (assists). Called on every
   * settings change. Induction comes from the profile (setProfile), which
   * app.apply rebuilds from the same settings.
   */
  configure(settings) {
    this.assists = {
      autoBlip: !!settings.autoBlip,
      launchControl: !!settings.launchControl,
      launchRpm: clamp(Number(settings.launchRpm) || 4500, 2500, 8000),
      tractionControl: !!settings.tractionControl,
    };
  }

  /** Undo damage and let a blown engine run again. A blown engine stays off until started. */
  repair() {
    this.thermal.reset();
    this.damage = 0;
    this.blown = false;
    this.blownCause = null;
    this.coolantC = this.thermal.coolantC;
    this.oilC = this.thermal.oilC;
    this.egtC = this.thermal.egtC;
    this.misfire = 1;
  }

  // ── Derived quantities ────────────────────────────────────────────────────

  get rpm() {
    return this.omega / RPM_TO_RAD;
  }

  get speedKmh() {
    return Math.abs(this.v) * 3.6;
  }

  get wheelRadius() {
    return this.drive.tireDiameter / 2;
  }

  get tireCircumference() {
    return Math.PI * this.drive.tireDiameter;
  }

  /** Overall ratio engine → wheel for a gear (signed; reverse is negative, neutral 0). */
  ratioFor(gear) {
    const d = this.drive;
    if (gear === 'N') return 0;
    if (gear === 'R') return -d.reverseRatio * d.finalDrive;
    return d.gearRatios[gear - 1] * d.finalDrive;
  }

  /** Gearbox input-shaft speed (rad/s) the wheels would impose in a gear. */
  inputOmegaFor(gear) {
    return (this.v / this.wheelRadius) * this.ratioFor(gear);
  }

  /** Road speed (km/h) for an engine rpm in a gear, from ratio, final drive and tyre size. */
  speedForRpm(rpm, gear) {
    const ratio = this.ratioFor(gear);
    if (!ratio) return 0;
    const wheelRpm = rpm / Math.abs(ratio);
    return (wheelRpm * this.tireCircumference * 60) / 1000;
  }

  get outputOmega() {
    return (this.v / this.wheelRadius) * this.drive.finalDrive;
  }

  get clutchCapacity() {
    const p = this.profile;
    return 1.6 * Math.max(p.peakTorqueNm, p.maxTorqueNm ?? 0) * clutchEngagement(this.clutchPedal);
  }

  /** Engine friction plus pumping losses (Nm, positive = resisting). */
  lossTorque(rpm, throttle) {
    const k = 0.15 + 0.17 * this.profile.displacementL;
    const krpm = rpm / 1000;
    const friction = k * (10 + 4 * krpm + 0.8 * krpm * krpm);
    const pumping = (1 - throttle) * k * (10 + 4 * krpm);
    return friction + pumping;
  }

  canCrank() {
    return !this.blown && (this.gear === 'N' || this.clutchPedal >= 0.8);
  }

  /** Turn the starter. Returns false when the clutch-safety switch blocks it or the engine is blown. */
  startEngine() {
    if (this.blown) return false;
    if (this.running || this.cranking) return true;
    if (!this.canCrank()) return false;
    this.cranking = true;
    this.crankTime = 0;
    this.events.push({ type: 'crank' });
    return true;
  }

  setGear(gear) {
    if (gear === this.gear) return;
    this.gear = gear;
    this.locked = false;
  }

  /** Queue an exhaust backfire event (rate-limited). strength 0..1. */
  backfire(source, strength) {
    if (this.time - this.lastBackfire < BACKFIRE_MIN_GAP) return;
    this.lastBackfire = this.time;
    this.events.push({ type: 'backfire', strength: clamp(strength, 0, 1), source });
  }

  // ── Integration ───────────────────────────────────────────────────────────

  step(dt) {
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
  }

  substep(h) {
    const p = this.profile;
    const d = this.drive;
    const a = this.assists;
    this.time += h;

    // Throttle body → manifold lag.
    const tau = this.throttleInput > this.throttle ? 0.07 : 0.1;
    this.throttle += (this.throttleInput - this.throttle) * (1 - Math.exp(-h / tau));

    const rpm = this.rpm;
    const kmh = this.speedKmh;

    // Starter motor.
    let starter = 0;
    if (this.cranking) {
      this.crankTime += h;
      starter = Math.max(0, 140 * (1 - rpm / 320)) * Math.max(0.5, p.displacementL / 5);
      if (this.crankTime > 0.55 && rpm > 140) {
        this.cranking = false;
        this.running = true;
        this.startGrace = 1.0;
        this.idleI = 0.12;
        this.events.push({ type: 'start' });
      } else if (this.crankTime > 3) {
        this.cranking = false;
      }
    }

    // Idle speed control: a PI loop that opens the idle valve when rpm sags.
    let plate = 0;
    let thr = 0;
    if (this.running) {
      const err = (p.idleRpm - rpm) / p.idleRpm;
      if (rpm < p.idleRpm * 1.6) this.idleI = clamp(this.idleI + err * h * 2.5, -0.05, 0.45);
      const idleThr = clamp(0.03 + 2.2 * err + this.idleI, 0, 0.7);
      plate = Math.max(this.throttle, idleThr);
      thr = this.torqueCut ? 0 : plate;
    }
    this.throttlePlate = plate;
    this.throttleEffective = thr;

    // Two-step launch limiter: armed while stationary with the clutch in or the brake held.
    const launchRpm = clamp(a.launchRpm, p.idleRpm + 1000, p.redlineRpm - 300);
    this.launchArmed = a.launchControl && this.running && kmh < 3 && this.gear !== 'R'
      && (this.clutchPedal >= 0.5 || this.brake >= 0.3);
    const limit = this.launchArmed ? launchRpm : p.redlineRpm;
    this.limiterRpm = limit;
    if (!this.running) {
      this.fuelCut = false; // nothing to cut: a dead engine dragged past redline is not on the limiter
    } else if (rpm >= limit) {
      if (!this.fuelCut) {
        if (this.launchArmed) {
          if (this.time - this.lastTwoStep >= TWO_STEP_MIN_GAP) {
            this.lastTwoStep = this.time;
            this.events.push({ type: 'twostep' });
            if (this.rng() < 0.8) this.backfire('twostep', 0.6 + 0.4 * this.rng());
          }
        } else {
          this.events.push({ type: 'limiter' });
          if (this.rng() < 0.45) this.backfire('limiter', 0.4 + 0.4 * this.rng());
        }
      }
      this.fuelCut = true;
    } else if (rpm < limit - (this.launchArmed ? TWO_STEP_HYSTERESIS : LIMITER_HYSTERESIS)) this.fuelCut = false;
    this.launchActive = this.launchArmed && plate > 0.3 && rpm > launchRpm - 400;

    // Variable valve lift: high cam above vvlRpm under load, back to the low cam below it.
    if (p.vvlRpm && this.running) {
      if (!this.vvlActive && rpm >= p.vvlRpm && plate >= 0.2) {
        this.vvlActive = true;
        this.events.push({ type: 'vvl', on: true });
      } else if (this.vvlActive && rpm < p.vvlRpm - VVL_HYSTERESIS) {
        this.vvlActive = false;
        this.events.push({ type: 'vvl', on: false });
      }
    } else if (this.vvlActive) {
      this.vvlActive = false;
      this.events.push({ type: 'vvl', on: false });
    }

    // Forced induction.
    const vented = this.induction.update(h, rpm, p.redlineRpm, plate, this.running, p.peakTorqueNm, this.fuelCut ? 0 : thr);
    if (vented > 0) this.events.push({ type: 'bov', boostBar: vented });
    this.boostBar = this.induction.boostBar;
    this.turboRpm = this.induction.turboRpm;

    // Damage: lost power and misfires that roughen the idle.
    const damage = this.thermal.damage;
    if (damage > 0 && this.running) {
      this.misfireClock -= h;
      if (this.misfireClock <= 0) {
        const pulsesPerSec = Math.max(5, (rpm / 60) * p.pulsesPerRev);
        this.misfireClock = 1 / pulsesPerSec;
        const units = p.kind === 'rotary' ? p.rotors : p.cylinders.length;
        this.misfire = this.rng() < damage * 0.55 ? 1 - Math.min(0.9, 1.6 / units) : 1;
      }
    } else this.misfire = 1;
    const health = (1 - 0.35 * damage) * this.misfire;

    // Traction control: pull torque while the tyres spin with the clutch clamped.
    if (a.tractionControl && this.wheelspin && this.running && clutchEngagement(this.clutchPedal) > 0.9) {
      const wheelRpm = Math.abs(this.inputOmegaFor(this.gear)) / RPM_TO_RAD;
      const slip = (rpm - wheelRpm) / Math.max(wheelRpm, 400);
      this.tcFactor = Math.max(0.12, this.tcFactor - h * (3 + 40 * Math.max(0, slip - 0.04)));
    } else {
      this.tcFactor = Math.min(1, this.tcFactor + h * 1.6);
    }
    const tcWasActive = this.tcActive;
    this.tcActive = a.tractionControl && this.tcFactor < 0.97;
    if (this.tcActive && !tcWasActive && this.time - this.lastTc >= TC_MIN_GAP) {
      this.lastTc = this.time;
      this.events.push({ type: 'tc' });
    }

    const combustion = this.running && !this.fuelCut
      ? thr * naTorque(p, rpm, this.vvlActive) * this.induction.multiplier * health * this.tcFactor
      : 0;
    let loss = this.lossTorque(rpm, this.running ? thr : 0) * Math.min(1, this.omega / 8) + this.induction.parasitic;
    if (this.blown) loss *= 3; // a wrecked bottom end barely turns
    const Te = combustion + starter - loss;
    this.combustionTorque = combustion;
    this.engineTorque = Te;

    const G = this.ratioFor(this.gear);
    const r = this.wheelRadius;
    const m = d.vehicleMass;
    const eta = d.drivelineEfficiency;
    const I = p.inertia;
    const tractionCap = G ? (d.tractionLimit * r) / (Math.abs(G) * eta) : 0;
    const cap = G ? Math.min(this.clutchCapacity, tractionCap) : 0;
    const aero = 0.5 * AIR_DENSITY * d.dragArea * this.v * Math.abs(this.v);
    const coulomb = d.rollingCoeff * m * G_ACCEL + this.brake * d.brakeForce;

    let Tc = 0;
    if (cap <= 0) {
      this.locked = false;
      this.omega += (Te / I) * h;
      this.integrateVehicle(-aero, coulomb, h);
    } else {
      if (this.locked) {
        // Engine and car as one body, seen from the wheels.
        const Fengine = (Te * G * eta) / r;
        const mEff = m + (I * G * G * eta) / (r * r);
        let acc;
        const Fnet = Fengine - aero;
        if (Math.abs(this.v) < 1e-3 && Math.abs(Fnet) <= coulomb) acc = 0;
        else acc = (Fnet - coulomb * sign(Math.abs(this.v) < 1e-3 ? Fnet : this.v)) / mEff;
        Tc = Te - (I * acc * G) / r;
        if (Math.abs(Tc) > cap) {
          this.locked = false;
        } else {
          const vPrev = this.v;
          this.v += acc * h;
          if (vPrev !== 0 && sign(this.v) !== sign(vPrev) && Math.abs(Fnet) <= coulomb) this.v = 0;
          this.omega = (this.v * G) / r;
        }
      }
      if (!this.locked) {
        const wt = (this.v * G) / r;
        const dw = this.omega - wt;
        const coulombDir = Math.abs(this.v) > 1e-3 ? sign(this.v) : sign(dw * G);
        const Fext = -aero - coulomb * coulombDir;
        // Clutch torque that would bring the slip to zero by the end of this step.
        const tcStar = (dw / h + Te / I - (G * Fext) / (r * m)) / (1 / I + (G * G * eta) / (r * r * m));
        const lock = Math.abs(tcStar) <= cap;
        Tc = lock ? tcStar : cap * sign(dw);
        this.omega += ((Te - Tc) / I) * h;
        this.integrateVehicle((Tc * G * eta) / r - aero, coulomb, h);
        this.slipPower = Math.abs(Tc * dw);
        if (lock) {
          this.locked = true;
          this.omega = (this.v * G) / r;
        }
      } else {
        this.slipPower = 0;
      }
    }
    if (cap <= 0) this.slipPower = 0;
    this.clutchTorque = Tc;
    // Slipping because the tyres, not the clutch, ran out of grip.
    this.wheelspin = !this.locked && cap > 0 && cap === tractionCap && this.clutchCapacity > tractionCap;

    if (this.omega < 0) this.omega = 0; // compression stops the engine turning backwards

    // Gearbox input shaft (for the visuals): tied to the wheels in gear, to the
    // engine through the clutch in neutral, otherwise spinning down.
    if (G) this.inputOmega = (this.v * G) / r;
    else if (clutchEngagement(this.clutchPedal) > 0.3) this.inputOmega = this.omega;
    else this.inputOmega *= Math.exp(-h / 1.2);

    this.distance += Math.abs(this.v) * h;
    const now = this.rpm;

    // Overrun crackle: a few pops in the first moments after lifting at high rpm.
    this.liftTime = plate > 0.3 ? 0 : this.liftTime + h;
    this.backfireClock -= h;
    if (this.backfireClock <= 0) {
      this.backfireClock = 0.05 + 0.11 * this.rng();
      const window = 1.6;
      const high = Math.max(2200, p.redlineRpm * 0.38);
      if (this.running && plate < 0.08 && now > high && this.liftTime < window) {
        const frac = now / p.redlineRpm;
        const boosted = this.inductionKind === 'na' ? 1 : 1.3;
        if (this.rng() < 0.42 * frac * (1 - this.liftTime / window) * boosted) {
          this.backfire('overrun', 0.25 + 0.5 * frac * this.rng());
        }
      }
    }

    // Temperatures, over-rev and failure.
    const th = this.thermal;
    const flags = th.update(h, {
      running: this.running,
      powerFrac: (combustion * this.omega) / this.ratedW,
      load: combustion / p.peakTorqueNm,
      rpm: now,
      redlineRpm: p.redlineRpm,
      kmh,
      boostBar: this.boostBar,
      fuelCut: this.fuelCut,
    });
    if (!this.blown) {
      if (flags & 1) this.events.push({ type: 'overheat', coolantC: th.coolantC });
      if (flags & 2) this.events.push({ type: 'overrev', rpm: now, severity: overrevSeverity(now, p.redlineRpm) });
      if (th.damage >= 1 || overrevSeverity(now, p.redlineRpm) >= 1) this.blowUp(th.damage >= 1 ? th.cause : 'over-rev');
    }
    this.coolantC = th.coolantC;
    this.oilC = th.oilC;
    this.egtC = th.egtC;
    this.damage = th.damage;

    // Stall when the crank speed collapses under load; bump-start when the
    // wheels spin a dead engine fast enough with the ignition on.
    if (this.startGrace > 0) this.startGrace -= h;
    if (this.running && this.startGrace <= 0 && now < p.stallRpm) {
      this.running = false;
      this.fuelCut = false;
      this.events.push({ type: 'stall', speedKmh: this.speedKmh, gear: this.gear });
    } else if (!this.running && !this.cranking && !this.blown && now > p.stallRpm * 1.5) {
      this.running = true;
      this.startGrace = 0.5;
      this.events.push({ type: 'start', bump: true });
    }
  }

  /** Catastrophic failure: the engine stops and stays dead until repair(). */
  blowUp(cause) {
    this.blown = true;
    this.blownCause = cause;
    this.thermal.damage = 1;
    this.damage = 1;
    this.running = false;
    this.cranking = false;
    this.fuelCut = false;
    this.vvlActive = false;
    this.events.push({ type: 'blown', cause });
  }

  /** Integrate the car alone with a driving force and a Coulomb (rolling + brake) force. */
  integrateVehicle(force, coulomb, h) {
    const m = this.drive.vehicleMass;
    if (Math.abs(this.v) < 1e-3 && Math.abs(force) <= coulomb) {
      this.v = 0;
      return;
    }
    const dir = Math.abs(this.v) < 1e-3 ? sign(force) : sign(this.v);
    const vPrev = this.v;
    this.v += ((force - coulomb * dir) / m) * h;
    if (vPrev !== 0 && sign(this.v) !== sign(vPrev) && Math.abs(force) <= coulomb) this.v = 0;
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}

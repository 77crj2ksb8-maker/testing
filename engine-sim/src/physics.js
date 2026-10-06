// Engine + clutch + vehicle physics. Pure JS, no DOM and no three.js.
//
// The engine and the car are two inertias joined by a friction clutch. While
// the clutch slips it passes its full capacity torque; once the slip speed
// crosses zero and the capacity can hold the load, the two lock and move as
// one body until the torque through the clutch exceeds its capacity again.

import { wotTorque } from './config.js';

const TWO_PI = Math.PI * 2;
export const RPM_TO_RAD = TWO_PI / 60;
const AIR_DENSITY = 1.225;
const G_ACCEL = 9.81;
const SUBSTEP = 0.002; // s

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Clutch engagement (0 = open, 1 = fully clamped) from pedal travel (1 = floored). */
export function clutchEngagement(pedal) {
  if (pedal >= 0.8) return 0; // pedal past 80 %: fully disengaged, the engine revs freely
  const x = clamp((0.8 - pedal) / 0.55, 0, 1);
  return Math.pow(x, 1.6);
}

export class Drivetrain {
  constructor(profile, drive) {
    this.profile = profile;
    this.drive = drive;
    this.reset();
  }

  setProfile(profile) {
    this.profile = profile;
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
    this.throttleEffective = 0;
    this.clutchPedal = 0;
    this.brake = 0;
    this.torqueCut = false; // automated-gearbox torque interruption during shifts
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

    // ── Contract fields (docs/CONTRACT.md). Defaults are inert placeholders
    // that the powertrain track replaces with real models.
    this.inductionKind = 'na'; // 'na' | 'turbo' | 'twin-turbo' | 'supercharger'
    this.boostBar = 0; // manifold pressure, bar gauge (negative = vacuum)
    this.boostTarget = 0;
    this.turboRpm = 0; // turbo shaft rpm (0 for NA/supercharger)
    this.coolantC = 88;
    this.oilC = 95;
    this.egtC = 350; // exhaust gas temperature, °C
    this.damage = 0; // 0 healthy … 1 destroyed
    this.blown = false; // catastrophic failure: cannot run until repair()
    this.vvlActive = false; // high-lift cam engaged
    this.launchActive = false; // two-step limiter currently holding revs
    this.tcActive = false; // traction control currently cutting torque
    this.limiterRpm = this.profile.redlineRpm;
    this.assists = { autoBlip: false, launchControl: false, launchRpm: 4500, tractionControl: false };
  }

  /** Apply runtime options from the settings object (assists, induction). Called on every settings change. */
  configure(settings) {
    this.assists = {
      autoBlip: !!settings.autoBlip,
      launchControl: !!settings.launchControl,
      launchRpm: settings.launchRpm ?? 4500,
      tractionControl: !!settings.tractionControl,
    };
    this.inductionKind = settings.induction ?? 'na';
  }

  /** Undo damage and let a blown engine run again. */
  repair() {
    this.damage = 0;
    this.blown = false;
    this.coolantC = 88;
    this.oilC = 95;
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
    return 1.6 * this.profile.peakTorqueNm * clutchEngagement(this.clutchPedal);
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
    return this.gear === 'N' || this.clutchPedal >= 0.8;
  }

  /** Turn the starter. Returns false when the clutch-safety switch blocks it. */
  startEngine() {
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

  // ── Integration ───────────────────────────────────────────────────────────

  step(dt) {
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
  }

  substep(h) {
    const p = this.profile;
    const d = this.drive;
    this.time += h;

    // Throttle body → manifold lag.
    const tau = this.throttleInput > this.throttle ? 0.07 : 0.1;
    this.throttle += (this.throttleInput - this.throttle) * (1 - Math.exp(-h / tau));

    const rpm = this.rpm;

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
    let thr = 0;
    if (this.running) {
      const err = (p.idleRpm - rpm) / p.idleRpm;
      if (rpm < p.idleRpm * 1.6) this.idleI = clamp(this.idleI + err * h * 2.5, -0.05, 0.45);
      const idleThr = clamp(0.03 + 2.2 * err + this.idleI, 0, 0.7);
      thr = this.torqueCut ? 0 : Math.max(this.throttle, idleThr);
    }
    this.throttleEffective = thr;

    // Rev limiter: hard fuel cut with 250 rpm of hysteresis.
    if (rpm >= p.redlineRpm) {
      if (!this.fuelCut) this.events.push({ type: 'limiter' });
      this.fuelCut = true;
    } else if (rpm < p.redlineRpm - 250) this.fuelCut = false;

    const combustion = this.running && !this.fuelCut ? thr * wotTorque(p, rpm) : 0;
    const loss = this.lossTorque(rpm, this.running ? thr : 0) * Math.min(1, this.omega / 8);
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
        let a;
        const Fnet = Fengine - aero;
        if (Math.abs(this.v) < 1e-3 && Math.abs(Fnet) <= coulomb) a = 0;
        else a = (Fnet - coulomb * sign(Math.abs(this.v) < 1e-3 ? Fnet : this.v)) / mEff;
        Tc = Te - (I * a * G) / r;
        if (Math.abs(Tc) > cap) {
          this.locked = false;
        } else {
          const vPrev = this.v;
          this.v += a * h;
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

    // Stall when the crank speed collapses under load; bump-start when the
    // wheels spin a dead engine fast enough with the ignition on.
    if (this.startGrace > 0) this.startGrace -= h;
    const now = this.rpm;
    if (this.running && this.startGrace <= 0 && now < p.stallRpm) {
      this.running = false;
      this.fuelCut = false;
      this.events.push({ type: 'stall', speedKmh: this.speedKmh, gear: this.gear });
    } else if (!this.running && !this.cranking && now > p.stallRpm * 1.5) {
      this.running = true;
      this.startGrace = 0.5;
      this.events.push({ type: 'start', bump: true });
    }
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

// Forced induction: turbo, twin-turbo and supercharger. Pure JS, no DOM.
//
// The compressor raises the charge pressure ahead of the throttle; the
// throttle plate then sets the manifold pressure the cylinders actually see.
// A turbo's shaft has to be spun up by exhaust energy (lag, threshold), a
// positive-displacement supercharger is geared to the crank (instant boost
// proportional to rpm) and costs crank torque to drive. A wastegate or
// bypass caps the charge pressure at the target.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export const INDUCTION_KINDS = ['na', 'turbo', 'twin-turbo', 'supercharger'];

/** Torque gained per bar of manifold boost (fraction of naturally aspirated torque). */
export const BOOST_TORQUE_GAIN = 0.85;
/** Charge pressure (bar gauge) above which a closing throttle vents the blow-off valve. */
export const BOV_MIN_BAR = 0.3;
const BOV_COOLDOWN = 0.6; // s
const MANIFOLD_TAU = 0.04; // s, plenum filling
const EXHAUST_TAU = 0.25; // s, smoothing of the fuelling that drives the turbine
const SC_DRIVE_LOSS = 0.2; // supercharger drive torque per bar, as a fraction of peak NA torque

// threshold: rpm / redline where a turbo reaches full boost at wide-open
// throttle. tauUp: shaft spool-up time constant (≈ 3·tauUp to full boost).
export const INDUCTION_SPECS = Object.freeze({
  na: { label: 'Naturally aspirated', boosted: false },
  turbo: { label: 'Turbo', boosted: true, turbo: true, threshold: 0.35, tauUp: 0.28, tauDown: 0.9, shaftMax: 190000 },
  'twin-turbo': { label: 'Twin-turbo', boosted: true, turbo: true, threshold: 0.27, tauUp: 0.16, tauDown: 0.7, shaftMax: 215000 },
  supercharger: { label: 'Supercharger', boosted: true, turbo: false, fullAt: 0.5, tau: 0.03 },
});

const specOf = (kind) => INDUCTION_SPECS[kind] ?? INDUCTION_SPECS.na;

/** Manifold pressure as a fraction of the pressure ahead of the throttle (0.28 closed … 1 wide open). */
export const throttleFactor = (plate) => 0.28 + 0.72 * Math.pow(clamp(plate, 0, 1), 0.55);

/**
 * Fraction of the target boost the compressor can make at wide-open
 * throttle once settled (0..1), from rpm as a fraction of redline.
 */
export function boostCapacity(kind, rpmFrac) {
  const s = specOf(kind);
  if (!s.boosted) return 0;
  if (s.turbo) {
    // Spools from ~55 % of the threshold rpm, full boost a little past it.
    const th = s.threshold;
    const spool = smoothstep((rpmFrac - 0.55 * th) / (0.6 * th));
    return spool * spool;
  }
  return clamp(rpmFrac / s.fullAt, 0, 1);
}

/** Steady-state wide-open-throttle boost (bar gauge) at an rpm. */
export function steadyBoostBar(induction, rpm, redlineRpm) {
  if (!induction || !specOf(induction.kind).boosted) return 0;
  return induction.targetBar * boostCapacity(induction.kind, rpm / redlineRpm);
}

/** Supercharger drive torque (Nm) at a charge pressure and rpm. */
export function parasiticTorque(kind, chargeBar, rpmFrac, peakNaTorqueNm) {
  if (kind !== 'supercharger' || chargeBar <= 0) return 0;
  return SC_DRIVE_LOSS * peakNaTorqueNm * chargeBar * (0.35 + 0.65 * clamp(rpmFrac, 0, 1.2));
}

export const boostMultiplier = (boostBar) => 1 + BOOST_TORQUE_GAIN * Math.max(0, boostBar);

/** Live induction state for one engine. update() runs every physics substep. */
export class Induction {
  constructor(config) {
    this.configure(config);
    this.reset();
  }

  /** config: { kind, targetBar } (profile.induction). Keeps the shaft state when only the target changes. */
  configure(config = {}) {
    const kind = specOf(config.kind) === INDUCTION_SPECS.na ? 'na' : config.kind;
    if (kind !== this.kind) this.spool = 0;
    this.kind = kind;
    this.spec = specOf(kind);
    this.targetBar = this.spec.boosted ? clamp(config.targetBar ?? 0.8, 0.3, 2) : 0;
  }

  reset() {
    this.spool = 0; // turbo shaft speed / speed at target boost (0..1)
    this.chargeBar = 0; // pressure ahead of the throttle, bar gauge
    this.boostBar = -0.72; // manifold pressure, bar gauge
    this.turboRpm = 0;
    this.multiplier = 1;
    this.parasitic = 0;
    this.bovArmed = false;
    this.bovCooldown = 0;
    this.exhaustLoad = 0; // smoothed fuelling (0..1): exhaust energy available to the turbine
  }

  get boostTarget() {
    return this.targetBar;
  }

  /**
   * Advance by h seconds. plate: throttle plate opening incl. the idle valve
   * (0..1). fueling: plate opening that is actually burning fuel (0 during a
   * fuel or ignition cut). Returns the charge pressure vented by the blow-off
   * valve this step (bar), or 0.
   */
  update(h, rpm, redlineRpm, plate, running, peakNaTorqueNm, fueling = plate) {
    const s = this.spec;
    const u = rpm / redlineRpm;
    let vented = 0;
    // A free-revving engine bouncing off the limiter burns little fuel, so the
    // turbine sees far less exhaust energy than under load.
    this.exhaustLoad += ((running ? fueling : 0) - this.exhaustLoad) * (1 - Math.exp(-h / EXHAUST_TAU));
    if (!s.boosted) {
      this.chargeBar = 0;
      this.turboRpm = 0;
      this.parasitic = 0;
    } else if (s.turbo) {
      // Exhaust energy spins the shaft; the wastegate stops it at target boost.
      const idleSpin = running ? 0.08 + 0.12 * clamp(u, 0, 1) : 0;
      const energy = 0.3 + 0.7 * clamp(this.exhaustLoad, 0, 1);
      const want = running ? Math.max(idleSpin, Math.sqrt(boostCapacity(this.kind, u) * energy) * Math.pow(plate, 0.6)) : 0;
      const tau = want > this.spool ? s.tauUp : s.tauDown;
      this.spool += (want - this.spool) * (1 - Math.exp(-h / tau));
      this.chargeBar = this.targetBar * this.spool * this.spool;
      this.turboRpm = s.shaftMax * this.spool;
      this.parasitic = 0;
    } else {
      // Belt-driven: boost follows rpm at once; the bypass valve opens off throttle.
      const want = running ? this.targetBar * boostCapacity(this.kind, u) * smoothstep(plate / 0.6) : 0;
      this.chargeBar += (want - this.chargeBar) * (1 - Math.exp(-h / s.tau));
      this.turboRpm = 0;
      this.parasitic = parasiticTorque(this.kind, this.chargeBar, u, peakNaTorqueNm);
    }

    // Blow-off valve: the throttle snaps shut with pressure in the charge pipes.
    if (this.bovCooldown > 0) this.bovCooldown -= h;
    if (s.turbo) {
      if (plate > 0.45 && this.chargeBar > BOV_MIN_BAR) this.bovArmed = true;
      if (this.bovArmed && plate < 0.2) {
        this.bovArmed = false;
        if (this.chargeBar > BOV_MIN_BAR && this.bovCooldown <= 0) {
          vented = this.chargeBar;
          this.bovCooldown = BOV_COOLDOWN;
          // Venting dumps the charge pipe and lets the shaft run down faster.
          this.spool *= 0.75;
          this.chargeBar = this.targetBar * this.spool * this.spool;
        }
      }
    }

    // A stopped engine pumps nothing, so its manifold sits at atmospheric
    // pressure; one dragged round by the wheels still pulls vacuum.
    const pumping = running ? 1 : clamp(rpm / 600, 0, 1);
    const target = ((1 + this.chargeBar) * throttleFactor(running ? plate : 0) - 1) * pumping;
    this.boostBar += (target - this.boostBar) * (1 - Math.exp(-h / MANIFOLD_TAU));
    this.multiplier = boostMultiplier(this.boostBar);
    return vented;
  }
}

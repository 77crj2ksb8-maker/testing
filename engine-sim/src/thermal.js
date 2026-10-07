// Engine temperatures and mechanical damage. Pure JS, no DOM.
//
// Coolant: combustion heat in, radiator heat out. The thermostat opens from
// ~82 °C and airflow comes from the fan plus road speed, so a car driven hard
// stays near 90–100 °C while one parked on the limiter slowly boils (the
// coolant tops out at its boiling point and the damage builds). Over-rev
// damage comes from the wheels dragging the engine past redline (a missed
// downshift): the limiter cannot help because the fuel is already cut.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export const COOLANT_START_C = 90;
export const COOLANT_WARN_C = 112; // 'overheat' event
const COOLANT_REARM_C = 104;
export const COOLANT_DAMAGE_C = 120; // head gasket starts to suffer
export const COOLANT_BOIL_C = 130; // pressurised coolant boils: the gauge pegs here while damage piles up
export const OVERREV_START = 1.05; // × redline: mechanical over-rev begins
export const OVERREV_FATAL = 1.3; // × redline: instant failure
const HEAT_GAIN = 3.7; // °C/s at full rated power, before cooling
const COOL_GAIN = 0.036; // °C/s per °C above ambient per unit airflow
const AMBIENT_C = 35; // under-bonnet air

/** Severity 0..1 of a mechanical over-rev at this rpm (0 below OVERREV_START, 1 = fatal). */
export const overrevSeverity = (rpm, redlineRpm) => clamp((rpm / redlineRpm - OVERREV_START) / (OVERREV_FATAL - OVERREV_START), 0, 1);

export class Thermal {
  constructor() {
    this.reset();
  }

  reset() {
    this.coolantC = COOLANT_START_C;
    this.oilC = 95;
    this.egtC = 350;
    this.damage = 0; // 0 healthy … 1 destroyed
    this.cause = null; // what did the most recent damage: 'over-rev' | 'overheat'
    this.warned = false;
    this.overrevPeak = 0; // highest severity emitted in the current over-rev episode
  }

  /**
   * Advance by h seconds. s: { running, powerFrac (combustion power / rated),
   * load (0..~2), rpm, redlineRpm, kmh, boostBar, fuelCut }.
   * Returns a bit mask of things that happened: 1 = coolant crossed the warning
   * temperature, 2 = an over-rev episode started or got worse.
   */
  update(h, s) {
    let flags = 0;
    const rpmFrac = s.rpm / s.redlineRpm;

    // Exhaust gas: idle ~350 °C, hard load ~900 °C, hotter with boost; cools on overrun.
    let egtTarget = 60;
    if (s.running) {
      egtTarget = s.fuelCut ? 260 : 330 + 560 * Math.pow(clamp(s.load, 0, 1.6), 0.8) + 80 * rpmFrac + 60 * Math.max(0, s.boostBar);
    }
    const egtTau = egtTarget > this.egtC ? 0.8 : s.running ? 2 : 25;
    this.egtC += (egtTarget - this.egtC) * (1 - Math.exp(-h / egtTau));

    // Coolant: friction and combustion heat in, thermostat-gated radiator out.
    const heatIn = s.running ? HEAT_GAIN * (0.1 + Math.max(0, s.powerFrac)) : 0;
    const air = s.running ? 0.25 + Math.min(1.6, s.kmh / 70) : 0.05 + Math.min(1.6, s.kmh / 70);
    const open = smoothstep((this.coolantC - 82) / 12);
    const heatOut = COOL_GAIN * Math.max(0, this.coolantC - AMBIENT_C) * (air * (0.06 + 0.94 * open));
    this.coolantC = Math.min(COOLANT_BOIL_C, this.coolantC + (heatIn - heatOut) * h);
    if (!this.warned && this.coolantC >= COOLANT_WARN_C) {
      this.warned = true;
      flags |= 1;
    } else if (this.warned && this.coolantC < COOLANT_REARM_C) this.warned = false;
    if (this.coolantC > COOLANT_DAMAGE_C && s.running) {
      this.addDamage(h * 0.004 * (this.coolantC - COOLANT_DAMAGE_C), 'overheat');
    }

    // Oil lags the coolant and runs hotter at high rpm.
    const oilTarget = this.coolantC + 6 + (s.running ? 32 * rpmFrac * rpmFrac : 0);
    this.oilC += (oilTarget - this.oilC) * (1 - Math.exp(-h / 12));

    // Mechanical over-rev.
    const sev = overrevSeverity(s.rpm, s.redlineRpm);
    if (sev > 0) {
      this.addDamage(h * (0.08 * sev + 2.2 * sev * sev), 'over-rev');
      if (this.overrevPeak === 0 || sev >= this.overrevPeak + 0.25) {
        this.overrevPeak = Math.max(sev, 1e-6);
        flags |= 2;
      }
    } else if (s.rpm < s.redlineRpm) this.overrevPeak = 0;
    return flags;
  }

  addDamage(amount, cause) {
    if (amount <= 0) return;
    this.damage = Math.min(1, this.damage + amount);
    this.cause = cause;
  }
}

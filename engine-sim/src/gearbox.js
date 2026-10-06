// Gear selection (manual H-pattern with synchro/grind rules) and the automatic
// controller (shift schedule + automated clutch). Pure JS.

import { clutchEngagement, RPM_TO_RAD } from './physics.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

// Pedal travel that gives a wanted clutch engagement (inverse of clutchEngagement).
const pedalForEngagement = (e) => (e <= 0 ? 1 : 0.8 - 0.55 * Math.pow(clamp(e, 0, 1), 1 / 1.6));

export const MAX_CLUTCHLESS_MISMATCH_RPM = 300;
export const REVERSE_MAX_KMH = 3;

export class Gearbox {
  constructor(sim, tracker) {
    this.sim = sim;
    this.tracker = tracker;
    this.mode = 'manual';
    this.selector = 'N'; // automatic: 'N' | 'R' | 'D'
    this.shift = null;
    this.sinceShift = 10;
    this.launching = true;
    this.autoPedal = 1;
  }

  setMode(mode) {
    this.mode = mode;
    this.shift = null;
    this.sim.torqueCut = false;
    const g = this.sim.gear;
    this.selector = g === 'N' ? 'N' : g === 'R' ? 'R' : 'D';
  }

  /**
   * Try to put the box in a gear (manual), or move the selector (automatic).
   * Returns { ok, grind, reason, mismatchRpm }.
   */
  request(gear) {
    const sim = this.sim;
    if (this.mode === 'auto') return this.requestAuto(gear);
    if (gear === sim.gear) return { ok: true };
    const from = sim.gear;
    if (gear === 'N') {
      sim.setGear('N');
      this.tracker?.leaveGear(from, sim.time);
      return { ok: true };
    }
    const clutchOpen = clutchEngagement(sim.clutchPedal) === 0;
    // Reverse has no synchro: it only goes in with the car (nearly) stopped.
    if (gear === 'R' && sim.v * 3.6 > REVERSE_MAX_KMH) {
      return this.grind(gear, 'Stop the car before selecting reverse', Infinity);
    }
    const targetRpm = sim.inputOmegaFor(gear) / RPM_TO_RAD;
    const mismatchRpm = Math.abs(sim.rpm - targetRpm);
    if (!clutchOpen && mismatchRpm > MAX_CLUTCHLESS_MISMATCH_RPM) {
      return this.grind(gear, 'Press the clutch before shifting', mismatchRpm);
    }
    if (from !== 'N') this.tracker?.leaveGear(from, sim.time);
    sim.setGear(gear);
    this.tracker?.engage(gear, sim, { clutchless: !clutchOpen });
    return { ok: true, clutchless: !clutchOpen, mismatchRpm };
  }

  grind(gear, reason, mismatchRpm) {
    this.tracker?.grind(this.sim.gear, gear, reason, mismatchRpm, this.sim.time);
    return { ok: false, grind: true, reason, mismatchRpm };
  }

  requestAuto(gear) {
    const sim = this.sim;
    const sel = gear === 'N' ? 'N' : gear === 'R' ? 'R' : 'D';
    if (sel === this.selector) return { ok: true };
    if (sel === 'R' && sim.v * 3.6 > REVERSE_MAX_KMH) return this.grind('R', 'Stop the car before selecting reverse', Infinity);
    if (sel === 'D' && sim.v < -REVERSE_MAX_KMH / 3.6) return this.grind(1, 'Stop the car before selecting drive', Infinity);
    this.selector = sel;
    this.shift = null;
    sim.torqueCut = false;
    if (sel === 'N') sim.setGear('N');
    else if (sel === 'R') sim.setGear('R');
    else sim.setGear(this.bestGearForSpeed());
    return { ok: true };
  }

  bestGearForSpeed() {
    const sim = this.sim;
    const p = sim.profile;
    const ratios = sim.drive.gearRatios;
    for (let g = ratios.length; g >= 1; g--) {
      const rpm = Math.abs(sim.inputOmegaFor(g)) / RPM_TO_RAD;
      if (rpm > p.downshiftRpm * 1.15) return g;
    }
    return 1;
  }

  /** Sequential box: one gear up. Returns { ok, reason?, gear }. Placeholder until the powertrain track lands. */
  shiftUp() {
    const g = this.sim.gear;
    const next = g === 'R' ? 'N' : g === 'N' ? 1 : Math.min(this.sim.drive.gearRatios.length, g + 1);
    const res = this.request(next);
    return { ...res, gear: this.sim.gear };
  }

  /** Sequential box: one gear down. Returns { ok, reason?, gear }. */
  shiftDown() {
    const g = this.sim.gear;
    const next = g === 'N' ? 'R' : g === 1 ? 'N' : g === 'R' ? 'R' : g - 1;
    const res = this.request(next);
    return { ...res, gear: this.sim.gear };
  }

  /** Apply runtime options from the settings object. Called on every settings change. */
  configure(settings) {
    this.assists = { autoBlip: !!settings.autoBlip };
  }

  /** Called every frame before the physics step. */
  update(dt, { gas, clutch, brake }) {
    const sim = this.sim;
    sim.brake = brake;
    if (this.mode === 'manual') {
      sim.throttleInput = gas;
      sim.clutchPedal = clutch;
      sim.torqueCut = false;
      return;
    }
    this.updateAuto(dt, gas);
  }

  upshiftPoint(gas) {
    const p = this.sim.profile;
    const low = Math.max(2600, p.idleRpm * 3.2);
    return low + (p.upshiftRpm - low) * smooth(gas * 1.15);
  }

  updateAuto(dt, gas) {
    const sim = this.sim;
    const p = sim.profile;
    this.sinceShift += dt;
    let throttle = gas;

    if (this.shift) {
      const s = this.shift;
      s.t += dt;
      if (s.phase === 'open') {
        this.autoPedal = 1;
        // Rev-match a downshift with a throttle blip; cut torque on an upshift.
        sim.torqueCut = !s.down;
        if (s.down) {
          const target = Math.abs(sim.inputOmegaFor(s.to)) / RPM_TO_RAD;
          throttle = sim.rpm < target ? 1 : 0;
        }
        if (s.t >= 0.09) {
          sim.setGear(s.to);
          this.tracker?.engage(s.to, sim, { auto: true });
          s.phase = 'close';
          s.t = 0;
        }
      } else {
        sim.torqueCut = false;
        this.autoPedal = pedalForEngagement(smooth(s.t / 0.16));
        if (s.t >= 0.16) {
          this.shift = null;
          this.autoPedal = 0;
        }
      }
      sim.throttleInput = throttle;
      sim.clutchPedal = this.autoPedal;
      return;
    }

    sim.torqueCut = false;
    if (this.selector === 'D' && typeof sim.gear === 'number' && sim.running) {
      const g = sim.gear;
      const top = sim.drive.gearRatios.length;
      const rpm = sim.rpm;
      const rpmIn = (gear) => Math.abs(sim.inputOmegaFor(gear)) / RPM_TO_RAD;
      if (g < top && !this.launching && rpm > this.upshiftPoint(gas) && this.sinceShift > 0.6) {
        this.beginShift(g, g + 1, false);
      } else if (g > 1 && this.sinceShift > 0.8) {
        const lower = rpmIn(g - 1);
        const roomBelowUpshift = lower < p.upshiftRpm - 300;
        const lugging = rpmIn(g) < p.downshiftRpm;
        const kickdown = gas > 0.9 && rpm < p.upshiftRpm * 0.55 && lower < p.upshiftRpm - 700;
        if (roomBelowUpshift && (lugging || kickdown)) this.beginShift(g, g - 1, true);
      }
      if (this.shift) {
        sim.throttleInput = gas;
        sim.clutchPedal = 1;
        return;
      }
    }

    // Automated clutch: slip it like a torque converter when pulling away,
    // clamp it once the gearbox input shaft is above idle.
    if (sim.gear === 'N') {
      this.autoPedal = 1;
    } else {
      const inRpm = Math.abs(sim.inputOmegaFor(sim.gear)) / RPM_TO_RAD;
      if (inRpm < p.idleRpm * 1.1) this.launching = true;
      else if (inRpm > p.idleRpm * 1.3 || (sim.locked && inRpm > p.idleRpm * 1.15)) this.launching = false;
      if (!sim.running || sim.rpm < p.idleRpm * 0.85) {
        this.autoPedal = 1; // anti-stall
      } else if (this.launching) {
        const launchRpm = p.idleRpm + 900 + 1700 * gas;
        const e = gas < 0.02 ? 0 : smooth((sim.rpm - p.idleRpm * 1.05) / (launchRpm - p.idleRpm * 1.05));
        this.autoPedal = pedalForEngagement(e);
      } else {
        this.autoPedal = 0;
      }
    }
    sim.throttleInput = throttle;
    sim.clutchPedal = this.autoPedal;
  }

  beginShift(from, to, down) {
    this.tracker?.leaveGear(from, this.sim.time);
    this.shift = { from, to, down, phase: 'open', t: 0 };
    this.sinceShift = 0;
  }
}

/** Shift quality, grinds and stalls for the telemetry panel. */
export class ShiftTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.records = [];
    this.grinds = 0;
    this.stalls = 0;
    this.pending = null;
    this.leftFrom = null;
    this.leftAt = null;
  }

  leaveGear(gear, time) {
    if (gear === 'N') return;
    this.leftFrom = gear;
    this.leftAt = time;
  }

  engage(gear, sim, { clutchless = false, auto = false } = {}) {
    const from = this.leftFrom;
    const launch = !from || sim.speedKmh < 3;
    this.pending = {
      from: launch ? 'N' : from,
      to: gear,
      start: launch ? sim.time : this.leftAt,
      launch,
      clutchless,
      auto,
      biteMismatch: null,
      slipEnergy: 0,
    };
    this.leftFrom = null;
  }

  grind(from, to, reason, mismatchRpm, time) {
    this.grinds++;
    this.pending = null;
    this.push({ from, to, grind: true, score: 0, grade: 'Grind', note: reason, mismatchRpm, time });
  }

  stall(time) {
    this.stalls++;
    this.pending = null;
    this.push({ from: '—', to: '—', stall: true, score: 0, grade: 'Stall', note: 'Engine stalled', time });
  }

  push(rec) {
    this.records.unshift(rec);
    if (this.records.length > 30) this.records.length = 30;
    this.lastRecord = rec;
  }

  update(dt, sim) {
    const s = this.pending;
    if (!s) return;
    const changedAway = sim.gear !== s.to;
    if (!changedAway && s.biteMismatch === null && sim.clutchCapacity > 0) {
      s.biteMismatch = Math.abs(sim.rpm - Math.abs(sim.inputOmegaFor(s.to)) / RPM_TO_RAD);
    }
    s.slipEnergy += sim.slipPower * dt;
    const age = sim.time - s.start;
    if (changedAway || (sim.locked && sim.clutchPedal < 0.05) || age > 6) {
      this.pending = null;
      const mismatch = s.biteMismatch ?? 0;
      const kj = s.slipEnergy / 1000;
      let score;
      // Rev mismatch at the bite point and heat dumped into the clutch cost the
      // most; a long time between gears costs a little.
      if (s.launch) score = 100 - Math.max(0, kj - 10) * 0.9 - Math.max(0, age - 2.5) * 6;
      else score = 100 - mismatch / 40 - kj * 2 - Math.max(0, age - 0.8) * 15;
      score = Math.round(clamp(score, 0, 100));
      const grade = score >= 85 ? 'Smooth' : score >= 60 ? 'OK' : 'Rough';
      const note = s.launch ? 'Launch' : s.auto ? 'Auto' : s.clutchless ? 'Clutchless' : '';
      this.push({
        from: s.from, to: s.to, time: sim.time, duration: age, mismatchRpm: Math.round(mismatch),
        slipKj: kj, score, grade, note, launch: s.launch,
      });
    }
  }

  get shiftRecords() {
    return this.records.filter((r) => !r.stall && !r.launch);
  }

  get averageScore() {
    const rs = this.shiftRecords;
    if (!rs.length) return null;
    return Math.round(rs.reduce((a, r) => a + r.score, 0) / rs.length);
  }
}

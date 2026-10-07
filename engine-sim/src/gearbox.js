// Gear selection and the automated controllers. Pure JS.
//
//  - manual:     H-pattern with synchro/grind rules; optional auto-blip assist
//                that rev-matches downshifts while the driver works the clutch.
//  - sequential: one gear up or down per request, automated clutch for
//                pull-away, flat-shift upshifts under an ignition cut,
//                auto-blipped downshifts and refusal of downshifts that would
//                over-rev. N sits between 1 and R.
//  - auto:       shift schedule + automated clutch.

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
/** Sequential downshifts are refused when the lower gear would put the engine past redline minus this. */
export const DOWNSHIFT_MARGIN_RPM = 100;

// Shift timings (s).
const AUTO_OPEN = 0.09;
const AUTO_CLOSE = 0.16;
const FLAT_CUT = 0.05; // ignition cut before the dogs swap
const FLAT_SYNC = 0.09; // cut held while the drivetrain pulls the revs down
const SEQ_OPEN = 0.08;
const SEQ_CLOSE = 0.14;
const BLIP_MAX = 0.35; // longest a sequential downshift waits for the blip
const MANUAL_BLIP_MAX = 1.5; // H-pattern blip assist gives up after this long
const BLIP_LEAD = 0.12; // s of rev rise the blip anticipates (throttle-body lag)

// Order of the sequential selector drum.
const seqIndex = (g) => (g === 'R' ? -1 : g === 'N' ? 0 : g);
const formatRpm = (rpm) => String(Math.round(rpm / 50) * 50).replace(/\B(?=(\d{3})+$)/g, ',');
const gearName = (g) => (g === 'R' ? 'reverse' : g === 'N' ? 'neutral' : `${g}${['st', 'nd', 'rd'][g - 1] ?? 'th'}`);

export class Gearbox {
  constructor(sim, tracker) {
    this.sim = sim;
    this.tracker = tracker;
    this.mode = 'manual';
    this.selector = 'N'; // automatic: 'N' | 'R' | 'D'
    this.shift = null;
    this.queued = 0; // sequential: one more shift requested mid-shift (+1 up, −1 down)
    this.blip = null; // manual auto-blip assist: { t }
    this.blipRpm = null; // rpm on the previous blip tick (rev-rate estimate)
    this.sinceShift = 10;
    this.launching = true;
    this.autoPedal = 1;
    this.assists = { autoBlip: false };
  }

  setMode(mode) {
    this.mode = mode;
    this.shift = null;
    this.queued = 0;
    this.blip = null;
    this.sim.torqueCut = false;
    const g = this.sim.gear;
    this.selector = g === 'N' ? 'N' : g === 'R' ? 'R' : 'D';
  }

  /** Engine rpm the wheels would impose in a gear. */
  rpmIn(gear) {
    return Math.abs(this.sim.inputOmegaFor(gear)) / RPM_TO_RAD;
  }

  /**
   * Try to put the box in a gear (manual), move the selector (automatic) or
   * shift straight to a gear (sequential). Returns { ok, grind, reason, mismatchRpm }.
   */
  request(gear) {
    const sim = this.sim;
    if (this.mode === 'auto') return this.requestAuto(gear);
    if (this.mode === 'sequential') return this.requestSequential(gear);
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
    const targetRpm = this.rpmIn(gear);
    const mismatchRpm = Math.abs(sim.rpm - targetRpm);
    if (!clutchOpen && mismatchRpm > MAX_CLUTCHLESS_MISMATCH_RPM) {
      return this.grind(gear, 'Press the clutch before shifting', mismatchRpm);
    }
    if (from !== 'N') this.tracker?.leaveGear(from, sim.time);
    sim.setGear(gear);
    this.tracker?.engage(gear, sim, { clutchless: !clutchOpen });
    // Auto-blip: the gear needs more revs than the engine has, so blip to match.
    this.blip = this.assists.autoBlip && typeof gear === 'number' && sim.running && targetRpm > sim.rpm + 250 ? { t: 0 } : null;
    this.blipRpm = null;
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
    const from = sim.gear;
    this.selector = sel;
    this.shift = null;
    sim.torqueCut = false;
    if (sel === 'N') sim.setGear('N');
    else if (sel === 'R') sim.setGear('R');
    else sim.setGear(this.bestGearForSpeed());
    if (sim.gear !== from) this.emitShift(from, sim.gear, 'auto', false);
    return { ok: true };
  }

  bestGearForSpeed() {
    const sim = this.sim;
    const p = sim.profile;
    const ratios = sim.drive.gearRatios;
    for (let g = ratios.length; g >= 1; g--) {
      if (this.rpmIn(g) > p.downshiftRpm * 1.15) return g;
    }
    return 1;
  }

  /** One gear up (sequential: R → N → 1 → 2 …). Returns { ok, reason?, gear, queued? }. */
  shiftUp() {
    if (this.mode === 'sequential') return this.stepSequential(1);
    const g = this.sim.gear;
    const next = g === 'R' ? 'N' : g === 'N' ? 1 : Math.min(this.sim.drive.gearRatios.length, g + 1);
    const res = this.request(next);
    return { ...res, gear: this.sim.gear };
  }

  /** One gear down (sequential: … 2 → 1 → N → R). Returns { ok, reason?, gear, queued? }. */
  shiftDown() {
    if (this.mode === 'sequential') return this.stepSequential(-1);
    const g = this.sim.gear;
    const next = g === 'N' ? 'R' : g === 1 ? 'N' : g === 'R' ? 'R' : g - 1;
    const res = this.request(next);
    return { ...res, gear: this.sim.gear };
  }

  // ── Sequential ────────────────────────────────────────────────────────────

  stepSequential(dir) {
    const sim = this.sim;
    if (this.shift) {
      // A second tap mid-shift runs as soon as this one finishes.
      this.queued = dir;
      return { ok: true, queued: true, gear: sim.gear };
    }
    const i = seqIndex(sim.gear) + dir;
    const top = sim.drive.gearRatios.length;
    if (i > top || i < -1) return { ok: false, gear: sim.gear };
    return this.requestSequential(i === -1 ? 'R' : i === 0 ? 'N' : i);
  }

  /** Why a sequential shift to `gear` is not allowed right now, or null. */
  sequentialRefusal(gear) {
    const sim = this.sim;
    const kmh = sim.speedKmh;
    if (gear === 'R' && kmh > REVERSE_MAX_KMH) return 'Stop the car before selecting reverse';
    if (typeof gear === 'number' && sim.v < -REVERSE_MAX_KMH / 3.6) return 'Stop the car before selecting a forward gear';
    if (typeof gear === 'number' && seqIndex(gear) < seqIndex(sim.gear)) {
      const rpm = this.rpmIn(gear);
      const limit = sim.profile.redlineRpm - DOWNSHIFT_MARGIN_RPM;
      if (rpm > limit) {
        return `Too fast for ${gearName(gear)}: it would over-rev to ${formatRpm(rpm)} rpm. Slow down first.`;
      }
    }
    return null;
  }

  requestSequential(gear) {
    const sim = this.sim;
    const from = sim.gear;
    if (gear === from) return { ok: true, gear: from };
    const reason = this.sequentialRefusal(gear);
    if (reason) return { ok: false, reason, gear: from };
    this.queued = 0;
    const moving = sim.speedKmh > 2;
    if (gear === 'N' || gear === 'R' || from === 'N' || from === 'R' || !moving) {
      // Into or out of neutral, or at a standstill: the automated clutch is
      // open (or opens now) and the dogs simply slide across.
      this.shift = null;
      sim.torqueCut = false;
      if (from !== 'N' && from !== 'R') this.tracker?.leaveGear(from, sim.time);
      sim.setGear(gear);
      if (typeof gear === 'number' && moving) {
        // Selecting a gear while rolling in neutral: rev-match as on a downshift.
        this.shift = { from, to: gear, down: true, flat: false, phase: 'close', t: 0, source: 'sequential' };
        this.blipRpm = null;
        this.tracker?.engage(gear, sim, { auto: true, note: 'Sequential' });
      } else if (typeof gear === 'number') {
        this.tracker?.engage(gear, sim, { auto: true, note: 'Sequential' });
      }
      this.emitShift(from, gear, 'sequential', false);
      return { ok: true, gear: sim.gear };
    }
    const down = seqIndex(gear) < seqIndex(from);
    this.tracker?.leaveGear(from, sim.time);
    // 'start' decides on the next tick, from the pedal actually held, whether this is a flat shift.
    this.shift = { from, to: gear, down, flat: false, phase: down ? 'open' : 'start', t: 0, source: 'sequential' };
    this.blipRpm = null;
    this.sinceShift = 0;
    return { ok: true, gear: from, pending: gear };
  }

  emitShift(from, to, source, flat) {
    const kind = seqIndex(to) > seqIndex(from) ? 'up' : 'down';
    const e = { type: 'shift', from, to, kind, source };
    if (flat) e.flat = true;
    this.sim.events.push(e);
  }

  /** Apply runtime options from the settings object. Called on every settings change. */
  configure(settings) {
    this.assists = { autoBlip: !!settings.autoBlip };
    if (!this.assists.autoBlip) this.blip = null;
  }

  /** Called every physics tick before the simulator steps. */
  update(dt, { gas, clutch, brake }) {
    const sim = this.sim;
    sim.brake = brake;
    if (this.mode === 'manual') {
      sim.clutchPedal = clutch;
      sim.torqueCut = false;
      sim.throttleInput = this.blip ? this.manualBlip(dt, gas) : gas;
      return;
    }
    if (this.mode === 'sequential') this.updateSequential(dt, gas, brake);
    else this.updateAuto(dt, gas, brake);
  }

  /** H-pattern auto-blip: hold the revs at the new gear's speed until the clutch bites. */
  manualBlip(dt, gas) {
    const sim = this.sim;
    const b = this.blip;
    b.t += dt;
    if (typeof sim.gear !== 'number' || !sim.running || sim.locked || b.t > MANUAL_BLIP_MAX) {
      this.blip = null;
      return gas;
    }
    return Math.max(gas, this.blipThrottle(this.rpmIn(sim.gear), dt));
  }

  /**
   * Throttle that brings the engine to targetRpm without overshooting: aims at
   * where the revs will be once the throttle-body lag has played out.
   */
  blipThrottle(targetRpm, dt) {
    const rpm = this.sim.rpm;
    const rate = this.blipRpm === null || dt <= 0 ? 0 : (rpm - this.blipRpm) / dt;
    this.blipRpm = rpm;
    const predicted = rpm + Math.max(0, rate) * BLIP_LEAD;
    return clamp((targetRpm - predicted) / 400, 0, 1);
  }

  upshiftPoint(gas) {
    const p = this.sim.profile;
    const low = Math.max(2600, p.idleRpm * 3.2);
    return low + (p.upshiftRpm - low) * smooth(gas * 1.15);
  }

  /** Run an in-progress shift. Returns the throttle to use this tick. */
  runShift(dt, gas) {
    const sim = this.sim;
    const s = this.shift;
    s.t += dt;
    let throttle = gas;
    if (s.phase === 'start') {
      // Flat shift: upshift with the throttle pinned; the ignition cut unloads the dogs.
      s.flat = gas > 0.5 && sim.running;
      s.phase = s.flat ? 'cut' : 'open';
    }
    if (s.phase === 'cut') {
      // Flat shift: clutch stays clamped, ignition cut unloads the gear.
      sim.torqueCut = true;
      if (s.t >= FLAT_CUT) this.swapGear(s, 'sync');
    } else if (s.phase === 'sync') {
      // The drivetrain drags the revs down to the new gear under the cut.
      sim.torqueCut = true;
      this.autoPedal = pedalForEngagement(0.55 + 0.45 * smooth(s.t / FLAT_SYNC));
      if (s.t >= FLAT_SYNC) {
        this.tracker?.engage(s.to, sim, { auto: true, note: 'Flat shift' });
        this.endShift();
      }
    } else if (s.phase === 'open') {
      this.autoPedal = 1;
      // Rev-match a downshift with a throttle blip; cut torque on an upshift.
      sim.torqueCut = !s.down;
      const target = this.rpmIn(s.to);
      if (s.down) throttle = s.source === 'auto' ? (sim.rpm < target ? 1 : 0) : this.blipThrottle(target, dt);
      const minOpen = s.source === 'auto' ? AUTO_OPEN : SEQ_OPEN;
      const matched = !s.down || s.source === 'auto' || sim.rpm >= target - 150 || s.t >= BLIP_MAX;
      if (s.t >= minOpen && matched) this.swapGear(s, 'close');
    } else {
      sim.torqueCut = false;
      const close = s.source === 'auto' ? AUTO_CLOSE : SEQ_CLOSE;
      if (s.down && s.source === 'sequential') throttle = Math.max(gas, this.blipThrottle(this.rpmIn(s.to), dt));
      this.autoPedal = pedalForEngagement(smooth(s.t / close));
      if (s.t >= close) this.endShift();
    }
    // Anti-stall: a shift at walking pace must not drag the engine below idle.
    if (s.phase !== 'open' && (!sim.running || sim.rpm < sim.profile.idleRpm * 0.85)) this.autoPedal = 1;
    return throttle;
  }

  swapGear(s, nextPhase) {
    const sim = this.sim;
    sim.setGear(s.to);
    // A flat shift is judged once the drivetrain has pulled the revs into line.
    if (!s.flat) this.tracker?.engage(s.to, sim, { auto: true, note: s.source === 'sequential' ? 'Sequential' : null });
    this.emitShift(s.from, s.to, s.source, s.flat);
    if (s.flat) sim.backfire?.('shift', 0.55 + 0.45 * sim.rng());
    s.phase = nextPhase;
    s.t = 0;
  }

  endShift() {
    this.shift = null;
    this.autoPedal = 0;
    this.sim.torqueCut = false;
  }

  updateSequential(dt, gas, brake) {
    const sim = this.sim;
    this.sinceShift += dt;
    if (this.shift) {
      sim.throttleInput = this.runShift(dt, gas);
      sim.clutchPedal = this.autoPedal;
      if (!this.shift && this.queued) {
        const dir = this.queued;
        this.queued = 0;
        this.stepSequential(dir);
      }
      return;
    }
    sim.torqueCut = false;
    sim.throttleInput = gas;
    sim.clutchPedal = this.automatedClutch(gas, brake);
  }

  updateAuto(dt, gas, brake = 0) {
    const sim = this.sim;
    const p = sim.profile;
    this.sinceShift += dt;

    if (this.shift) {
      sim.throttleInput = this.runShift(dt, gas);
      sim.clutchPedal = this.autoPedal;
      return;
    }

    sim.torqueCut = false;
    if (this.selector === 'D' && typeof sim.gear === 'number' && sim.running) {
      const g = sim.gear;
      const top = sim.drive.gearRatios.length;
      const rpm = sim.rpm;
      if (g < top && !this.launching && rpm > this.upshiftPoint(gas) && this.sinceShift > 0.6) {
        this.beginShift(g, g + 1, false);
      } else if (g > 1 && this.sinceShift > 0.8) {
        const lower = this.rpmIn(g - 1);
        const roomBelowUpshift = lower < p.upshiftRpm - 300;
        const lugging = this.rpmIn(g) < p.downshiftRpm;
        const kickdown = gas > 0.9 && rpm < p.upshiftRpm * 0.55 && lower < p.upshiftRpm - 700;
        if (roomBelowUpshift && (lugging || kickdown)) this.beginShift(g, g - 1, true);
      }
      if (this.shift) {
        sim.throttleInput = gas;
        sim.clutchPedal = 1;
        return;
      }
    }
    sim.throttleInput = gas;
    sim.clutchPedal = this.automatedClutch(gas, brake);
  }

  /**
   * Automated clutch: slip it like a torque converter when pulling away, clamp
   * it once the gearbox input shaft is above idle, open it before the engine
   * stalls. Holding the brake with launch control on keeps it open so the
   * two-step can hold the launch revs. Returns the pedal position.
   */
  automatedClutch(gas, brake) {
    const sim = this.sim;
    const p = sim.profile;
    if (sim.gear === 'N') {
      this.autoPedal = 1;
      return this.autoPedal;
    }
    const inRpm = this.rpmIn(sim.gear);
    if (inRpm < p.idleRpm * 1.1) this.launching = true;
    else if (inRpm > p.idleRpm * 1.3 || (sim.locked && inRpm > p.idleRpm * 1.15)) this.launching = false;
    if (!sim.running || sim.rpm < p.idleRpm * 0.85) {
      this.autoPedal = 1; // anti-stall
    } else if (this.launching && sim.assists?.launchControl && brake >= 0.3 && sim.speedKmh < 3) {
      this.autoPedal = 1; // staged on the two-step
    } else if (this.launching) {
      const launchRpm = p.idleRpm + 900 + 1700 * gas;
      const e = gas < 0.02 ? 0 : smooth((sim.rpm - p.idleRpm * 1.05) / (launchRpm - p.idleRpm * 1.05));
      this.autoPedal = pedalForEngagement(e);
    } else {
      this.autoPedal = 0;
    }
    return this.autoPedal;
  }

  beginShift(from, to, down) {
    this.tracker?.leaveGear(from, this.sim.time);
    this.shift = { from, to, down, flat: false, phase: 'open', t: 0, source: 'auto' };
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

  engage(gear, sim, { clutchless = false, auto = false, note = null } = {}) {
    const from = this.leftFrom;
    const launch = !from || sim.speedKmh < 3;
    this.pending = {
      from: launch ? 'N' : from,
      to: gear,
      start: launch ? sim.time : this.leftAt,
      launch,
      clutchless,
      auto,
      note,
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
      const note = s.launch ? 'Launch' : s.note ?? (s.auto ? 'Auto' : s.clutchless ? 'Clutchless' : '');
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

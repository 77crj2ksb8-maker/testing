// Drag strip timing: staging, a sportsman Christmas tree, red-light fouls,
// reaction time, incremental ETs and speeds, trap speed and personal bests.
// Pure JS (no DOM, no randomness): the feature module feeds it the car's
// odometer and speed every physics step and drains the events it queues.
//
// Timing follows a real strip: the ET clock starts when the car leaves the
// stage beam (after ~11.5 in of rollout), reaction time is the gap between
// the green and that moment (negative = red light), and the trap speed is
// the average over the last 66 ft before the finish line.

const FT = 0.3048; // m

export const QUARTER_M = 1320 * FT; // 402.336 m
export const ROLLOUT_M = 11.5 * 0.0254; // stage beam to the front tyre's contact patch
export const TRAP_M = 66 * FT; // speed trap length before each finish line

/** Timing marks from the start line. `trap` marks also get an average trap speed. */
export const DRAG_MARKS = Object.freeze([
  { id: '60ft', label: '60′', m: 60 * FT },
  { id: '330ft', label: '330′', m: 330 * FT },
  { id: 'eighth', label: '1/8', m: 660 * FT, trap: true },
  { id: '1000ft', label: '1000′', m: 1000 * FT },
  { id: 'quarter', label: '1/4', m: QUARTER_M, trap: true },
]);

export const AMBER_STEP = 0.5; // s between ambers on a sportsman tree; green follows the last by the same
const STAGE_HOLD = 0.6; // s stationary before the car counts as staged
const TREE_DELAY = 1.1; // s from staged to the first amber
const STOPPED_MS = 0.15; // m/s: the car counts as stopped below this
const ABORT_STILL = 3; // s stopped mid-run before the run is abandoned
const MAX_RUN = 90; // s: give up on a run that never finishes

/**
 * Phases: 'idle' (off) → 'pre' (waiting for a stationary, running car) →
 * 'staged' → 'tree' (ambers) → 'green' (waiting for the car) → 'run' →
 * 'done' (finished or aborted).
 */
export class DragRace {
  constructor() {
    this.events = [];
    this.result = null;
    this.odometer = 0; // forward distance fed by step(), never decreasing
    this.reset();
    this.phase = 'idle';
  }

  /** Back to pre-stage for a fresh run (keeps nothing from the last one but `result`). */
  reset() {
    this.phase = 'pre';
    this.clock = 0; // s since this run was armed
    this.stillFor = 0;
    this.stageOdo = 0; // odometer at the stage beam
    this.treeAt = 0; // clock when the first amber lit
    this.greenAt = Infinity; // clock when the green lit
    this.startAt = null; // clock when the car left the stage beam
    this.startOdo = 0; // odometer at the start line
    this.reaction = null;
    this.foul = false;
    this.splits = DRAG_MARKS.map((m) => ({ id: m.id, label: m.label, m: m.m, t: null, speedKmh: null, trapKmh: null }));
    this.trapEntry = DRAG_MARKS.map(() => null); // ET entering each speed trap
    this.nextMark = 0;
    this.distance = 0; // m past the start line (0 before the start)
    this.et = 0; // live ET (s)
    this.speedKmh = 0;
    this.prevOdo = null;
    this.prevSpeed = 0;
    this.prevClock = 0;
    this.abortReason = null;
  }

  /** Arm the strip (from 'idle' or after a finished run). */
  arm() {
    this.reset();
    this.events.length = 0;
  }

  /** Turn the strip off. */
  stop() {
    this.phase = 'idle';
  }

  get active() {
    return this.phase !== 'idle';
  }

  /** Number of ambers lit (0..3) during the tree. */
  get ambers() {
    if (this.phase === 'tree' || (this.foul && this.clock < this.greenAt)) {
      return Math.max(0, Math.min(3, Math.floor((this.clock - this.treeAt) / AMBER_STEP) + 1));
    }
    return 0;
  }

  get greenLit() {
    return this.clock >= this.greenAt && !this.foul;
  }

  emit(type, extra) {
    this.events.push(extra ? { type, ...extra } : { type });
  }

  drainEvents() {
    if (!this.events.length) return this.events;
    const e = this.events;
    this.events = [];
    return e;
  }

  /**
   * Advance by dt seconds from the car's signed road speed v (m/s, forward
   * positive). Only forward travel moves the car down the strip: rolling or
   * reversing backwards never counts towards the rollout or the marks.
   */
  step(dt, v, running) {
    if (v > 0) this.odometer += v * dt;
    this.update(dt, this.odometer, Math.abs(v), running);
  }

  /**
   * Advance by dt seconds. odometer: forward distance the car has covered (m,
   * never decreasing); speed: |v| in m/s; running: engine running.
   */
  update(dt, odometer, speed, running) {
    if (this.phase === 'idle' || this.phase === 'done') return;
    const prevClock = this.clock;
    this.clock += dt;

    if (this.phase === 'pre') {
      if (speed < STOPPED_MS && running) {
        this.stillFor += dt;
        if (this.stillFor >= STAGE_HOLD) {
          this.phase = 'staged';
          this.stageOdo = odometer;
          this.treeAt = this.clock + TREE_DELAY;
          this.emit('stage');
        }
      } else this.stillFor = 0;
    } else if (this.phase === 'staged' || this.phase === 'tree' || this.phase === 'green') {
      if (this.phase === 'staged' && this.clock >= this.treeAt) this.phase = 'tree';
      if (this.phase === 'tree' && this.clock >= this.treeAt + 3 * AMBER_STEP) {
        this.phase = 'green';
        this.greenAt = this.treeAt + 3 * AMBER_STEP;
        this.emit('green');
      }
      const moved = odometer - this.stageOdo;
      if (moved >= ROLLOUT_M) {
        // Interpolate the moment the car cleared the beam within this step.
        const prevMoved = (this.prevOdo ?? odometer) - this.stageOdo;
        const f = moved > prevMoved ? (ROLLOUT_M - prevMoved) / (moved - prevMoved) : 1;
        const at = prevClock + Math.min(1, Math.max(0, f)) * dt;
        const greenAt = this.phase === 'green' ? this.greenAt : this.treeAt + 3 * AMBER_STEP;
        this.startAt = at;
        this.startOdo = this.stageOdo + ROLLOUT_M;
        this.reaction = at - greenAt;
        this.foul = this.reaction < 0;
        if (this.foul) {
          this.greenAt = greenAt; // the green never shows; the red does
          this.emit('foul', { reaction: this.reaction });
        }
        this.phase = 'run';
        this.stillFor = 0;
        this.emit('start', { reaction: this.reaction, foul: this.foul });
      }
    }

    if (this.phase === 'run') this.runStep(dt, prevClock, odometer, speed);
    this.prevOdo = odometer;
    this.prevSpeed = speed;
    this.prevClock = this.clock;
  }

  runStep(dt, prevClock, odometer, speed) {
    const d = odometer - this.startOdo;
    const prevD = (this.prevOdo ?? odometer) - this.startOdo;
    this.distance = Math.max(0, d);
    this.et = this.clock - this.startAt;
    this.speedKmh = speed * 3.6;
    while (this.nextMark < DRAG_MARKS.length) {
      const mark = DRAG_MARKS[this.nextMark];
      // Trap entry (66 ft before a trapped mark) can fall in the same step.
      const i = this.nextMark;
      if (mark.trap && this.trapEntry[i] === null && d >= mark.m - TRAP_M) {
        this.trapEntry[i] = this.crossing(mark.m - TRAP_M, prevD, d, prevClock, dt);
      }
      if (d < mark.m) break;
      const t = this.crossing(mark.m, prevD, d, prevClock, dt);
      const f = d > prevD ? (mark.m - prevD) / (d - prevD) : 1;
      const split = this.splits[i];
      split.t = t;
      split.speedKmh = (this.prevSpeed + (speed - this.prevSpeed) * f) * 3.6;
      if (mark.trap) split.trapKmh = (TRAP_M / Math.max(1e-6, t - this.trapEntry[i])) * 3.6;
      this.nextMark++;
      this.emit('split', { split });
    }
    if (this.nextMark >= DRAG_MARKS.length) {
      this.distance = QUARTER_M;
      this.et = this.splits[this.splits.length - 1].t;
      this.finish(null);
      return;
    }
    this.stillFor = speed < STOPPED_MS ? this.stillFor + dt : 0;
    if (this.stillFor > ABORT_STILL) this.finish('The car stopped before the finish line');
    else if (this.et > MAX_RUN) this.finish('The run took too long');
  }

  /** ET at which the car crossed `at` metres past the start line, interpolated inside the last step. */
  crossing(at, prevD, d, prevClock, dt) {
    const f = d > prevD ? Math.min(1, Math.max(0, (at - prevD) / (d - prevD))) : 1;
    return prevClock + f * dt - this.startAt;
  }

  finish(abortReason) {
    this.phase = 'done';
    this.abortReason = abortReason;
    const q = this.splits[this.splits.length - 1];
    this.result = abortReason ? null : {
      et: q.t,
      reaction: this.reaction,
      foul: this.foul,
      trapKmh: q.trapKmh,
      speedKmh: q.speedKmh,
      splits: this.splits.map((s) => ({ ...s })),
    };
    if (abortReason) this.emit('abort', { reason: abortReason });
    else this.emit('finish', { result: this.result });
  }
}

// ── Personal bests ──────────────────────────────────────────────────────────

/**
 * Personal bests per engine, kept through an injected storage adapter
 * ({ load() → object | null, save(object) }) so the module stays pure.
 * A red-light run never counts for ET or trap records.
 */
export class DragRecords {
  constructor(storage = null) {
    this.storage = storage;
    this.byEngine = {};
    try {
      const saved = storage?.load();
      if (saved && typeof saved === 'object') this.byEngine = saved;
    } catch {
      this.byEngine = {};
    }
  }

  best(engineKey) {
    return this.byEngine[engineKey] ?? null;
  }

  /**
   * Record a finished run. Returns { et, trap, reaction, sixty } flags for the
   * records it improved (all false for a foul).
   */
  record(engineKey, result, meta = {}) {
    const improved = { et: false, trap: false, reaction: false, sixty: false };
    if (!result || result.foul) return improved;
    const prev = this.byEngine[engineKey] ?? {};
    const next = { ...prev, name: meta.name ?? prev.name ?? engineKey };
    const sixty = result.splits?.[0]?.t ?? null;
    if (prev.et == null || result.et < prev.et) {
      next.et = result.et;
      next.etTrapKmh = result.trapKmh;
      next.etAt = meta.at ?? null;
      improved.et = true;
    }
    if (prev.trapKmh == null || result.trapKmh > prev.trapKmh) {
      next.trapKmh = result.trapKmh;
      improved.trap = true;
    }
    if (result.reaction >= 0 && (prev.reaction == null || result.reaction < prev.reaction)) {
      next.reaction = result.reaction;
      improved.reaction = true;
    }
    if (sixty !== null && (prev.sixty == null || sixty < prev.sixty)) {
      next.sixty = sixty;
      improved.sixty = true;
    }
    next.runs = (prev.runs ?? 0) + 1;
    this.byEngine[engineKey] = next;
    try {
      this.storage?.save(this.byEngine);
    } catch {
      /* storage full or unavailable: keep the records for this session */
    }
    return improved;
  }
}

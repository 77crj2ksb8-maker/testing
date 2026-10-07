// Achievements: definitions and the rules that unlock them. Pure JS (no DOM):
// the feature module forwards bus events, finished shift records and a small
// per-step state snapshot, then drains what got unlocked. Progress persists
// through an injected storage adapter ({ load() → object | null, save(object) }).

export const CORE_LAYOUTS = Object.freeze(['inline', 'v', 'boxer', 'vtwin', 'rotary']);
const LAYOUT_NAMES = { inline: 'inline', v: 'V', boxer: 'boxer', vtwin: 'V-twin', rotary: 'rotary' };
const LAYOUT_DISTANCE_M = 200; // driven under power before a layout counts
const LAUNCH_WINDOW = 3; // s from leaving the two-step to reaching LAUNCH_KMH
const LAUNCH_KMH = 30;

export const ACHIEVEMENTS = Object.freeze([
  { id: 'first-stall', title: 'Stalled it', detail: 'Stall the engine for the first time.' },
  { id: 'bump-start', title: 'Bump start', detail: 'Start a dead engine by rolling the car in gear.' },
  { id: 'perfect-shift', title: 'Perfect shift', detail: 'Score 95 or more on an H-pattern shift.' },
  { id: 'smooth-five', title: 'Silk', detail: 'Five smooth H-pattern shifts in a row.' },
  { id: 'clutchless', title: 'No clutch needed', detail: 'Match the revs and shift without the clutch.' },
  { id: 'speed-100', title: '100 club', detail: 'Reach 100 km/h (62 mph).' },
  { id: 'speed-200', title: '200 club', detail: 'Reach 200 km/h (124 mph).' },
  { id: 'speed-300', title: '300 club', detail: 'Reach 300 km/h (186 mph).' },
  { id: 'quarter-12', title: 'Twelve-second car', detail: 'Run the quarter mile in under 12 s without a red light.' },
  { id: 'quarter-10', title: 'Single digits', detail: 'Run the quarter mile in under 10 s without a red light.' },
  { id: 'red-light', title: 'Jumped the light', detail: 'Leave before the green on the drag strip.' },
  { id: 'launch-control', title: 'Two-step launch', detail: 'Pull away off the launch limiter.' },
  { id: 'vvl', title: 'Cam switch', detail: 'Rev past the switch point onto the high-lift cam.' },
  { id: 'blown', title: 'Kaboom', detail: 'Blow up an engine.' },
  { id: 'rebuild', title: 'Back from the dead', detail: 'Rebuild a blown engine.' },
  { id: 'dyno', title: 'On the rollers', detail: 'Finish a dyno pull.' },
  { id: 'all-layouts', title: 'Collector', detail: 'Drive an inline, a V, a boxer, a V-twin and a rotary.' },
]);

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
// H-pattern shifts the driver made (auto and sequential boxes shift for you).
const isManualShift = (r) => !r.launch && !r.grind && !r.stall && (r.note === '' || r.note === 'Clutchless');

export class AchievementTracker {
  /** storage: { load, save } or null; now: () => timestamp for unlock dates. */
  constructor(storage = null, { now = () => 0 } = {}) {
    this.storage = storage;
    this.now = now;
    this.unlocked = {}; // id → timestamp
    this.layouts = []; // core layouts driven so far
    this.pending = [];
    try {
      const saved = storage?.load();
      if (saved && typeof saved === 'object') {
        if (saved.unlocked && typeof saved.unlocked === 'object') {
          for (const [id, at] of Object.entries(saved.unlocked)) if (BY_ID.has(id)) this.unlocked[id] = at;
        }
        if (Array.isArray(saved.layouts)) this.layouts = saved.layouts.filter((l) => CORE_LAYOUTS.includes(l));
      }
    } catch {
      /* unreadable: start fresh */
    }
    this.smoothStreak = 0;
    this.wasBlown = false;
    this.layoutDistance = 0;
    this.layoutNow = null;
    this.launchHeld = false;
    this.sinceLaunch = Infinity;
  }

  get total() {
    return ACHIEVEMENTS.length;
  }

  get count() {
    return Object.keys(this.unlocked).length;
  }

  has(id) {
    return id in this.unlocked;
  }

  /** Unlock an achievement once; returns true when it is new. */
  unlock(id) {
    const def = BY_ID.get(id);
    if (!def || this.has(id)) return false;
    this.unlocked[id] = this.now();
    this.pending.push(def);
    this.save();
    return true;
  }

  /** Newly unlocked definitions since the last drain. */
  drain() {
    if (!this.pending.length) return this.pending;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  save() {
    try {
      this.storage?.save({ unlocked: this.unlocked, layouts: this.layouts });
    } catch {
      /* storage unavailable: keep progress for this session */
    }
  }

  /** Forget everything (and persist the empty state). */
  resetAll() {
    this.unlocked = {};
    this.layouts = [];
    this.pending = [];
    this.smoothStreak = 0;
    this.save();
  }

  /** A bus event (simulator, core or modes). */
  handleEvent(type, payload = {}) {
    switch (type) {
      case 'stall':
        this.unlock('first-stall');
        break;
      case 'start':
        if (payload.bump) this.unlock('bump-start');
        break;
      case 'vvl':
        if (payload.on) this.unlock('vvl');
        break;
      case 'blown':
        this.wasBlown = true;
        this.unlock('blown');
        break;
      case 'repair':
        if (this.wasBlown) this.unlock('rebuild');
        this.wasBlown = false;
        break;
      case 'drag:foul':
        this.unlock('red-light');
        break;
      case 'drag:finish': {
        const r = payload.result;
        if (r && !r.foul && Number.isFinite(r.et)) {
          if (r.et < 12) this.unlock('quarter-12');
          if (r.et < 10) this.unlock('quarter-10');
        }
        break;
      }
      case 'dyno:done':
        this.unlock('dyno');
        break;
      default:
    }
  }

  /** A finished ShiftTracker record ({score, grade, note, launch, grind, stall}). */
  handleShift(rec) {
    if (rec.grind || rec.stall) {
      this.smoothStreak = 0;
      return;
    }
    if (rec.note === 'Clutchless') this.unlock('clutchless');
    if (!isManualShift(rec)) return;
    if (rec.score >= 95) this.unlock('perfect-shift');
    this.smoothStreak = rec.grade === 'Smooth' ? this.smoothStreak + 1 : 0;
    if (this.smoothStreak >= 5) this.unlock('smooth-five');
  }

  /**
   * Per-step state: { dt, kmh, running, launchActive, layout, onRollers }.
   * Speeds and distances on the dyno rollers do not count.
   */
  observe(s) {
    if (s.onRollers) return;
    const kmh = s.kmh;
    if (kmh >= 100) this.unlock('speed-100');
    if (kmh >= 200) this.unlock('speed-200');
    if (kmh >= 300) this.unlock('speed-300');

    // Launch control: the car left the two-step and kept pulling.
    if (s.launchActive && kmh < 3) {
      this.launchHeld = true;
      this.sinceLaunch = 0;
    } else if (this.launchHeld) {
      this.sinceLaunch += s.dt;
      if (kmh >= LAUNCH_KMH) {
        this.launchHeld = false;
        if (this.sinceLaunch <= LAUNCH_WINDOW) this.unlock('launch-control');
      } else if (this.sinceLaunch > LAUNCH_WINDOW) this.launchHeld = false;
    }

    // Layout collection: drive each layout some distance under its own power.
    if (s.layout !== this.layoutNow) {
      this.layoutNow = s.layout;
      this.layoutDistance = 0;
    }
    if (s.running && CORE_LAYOUTS.includes(s.layout) && !this.layouts.includes(s.layout)) {
      this.layoutDistance += (kmh / 3.6) * s.dt;
      if (this.layoutDistance >= LAYOUT_DISTANCE_M) {
        this.layouts.push(s.layout);
        this.save();
        if (CORE_LAYOUTS.every((l) => this.layouts.includes(l))) this.unlock('all-layouts');
      }
    }
  }

  /** Human list of the layouts still missing for the collector achievement. */
  missingLayouts() {
    return CORE_LAYOUTS.filter((l) => !this.layouts.includes(l)).map((l) => LAYOUT_NAMES[l]);
  }
}

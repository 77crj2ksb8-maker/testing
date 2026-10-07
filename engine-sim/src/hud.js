// Core HUD: tach card (digital or analog), shift lights, gauges, assist pills,
// gear and speed, the sequential paddle readout and the stall card.
// main.js calls update(dt) once per frame. The helpers exported at the top are
// pure (no DOM) so Node tests can use them.

import { el, formatSpeed, speedUnit } from './dom.js';
import { buildProfile, DEFAULT_SETTINGS, peakFigures, layoutOf } from './config.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mod = (a, n) => ((a % n) + n) % n;

// ── Pure helpers ────────────────────────────────────────────────────────────

export const SHIFT_LEDS = 10;
/** shiftLightLevel() value meaning "all LEDs flash blue". */
export const SHIFT_FLASH = SHIFT_LEDS + 1;

/** The rpm at which the shift lights flash: just short of the limiter. */
export function shiftPointRpm(profile) {
  return Math.round(profile.redlineRpm - Math.max(250, profile.redlineRpm * 0.05));
}

/**
 * How many shift LEDs are lit (0..10), or SHIFT_FLASH at/after the shift point
 * or while a limiter (rev or launch) is cutting.
 */
export function shiftLightLevel(rpm, profile, limiting = false) {
  const shift = shiftPointRpm(profile);
  if (limiting || rpm >= shift) return SHIFT_FLASH;
  const start = Math.max(profile.idleRpm + 600, shift * 0.6);
  if (rpm <= start) return 0;
  return clamp(Math.ceil(((rpm - start) / (shift - start)) * SHIFT_LEDS), 0, SHIFT_LEDS);
}

/** Temperature state: 0 cold, 1 normal, 2 hot (warning), 3 critical. */
export function tempLevel(c, kind = 'coolant') {
  const [cold, hot, crit] = kind === 'oil' ? [70, 128, 140] : [65, 108, 118];
  return c >= crit ? 3 : c >= hot ? 2 : c < cold ? 0 : 1;
}

/** Engine health state from damage 0..1: 1 good, 2 worn, 3 critical. */
export const healthLevel = (damage) => (damage >= 0.65 ? 3 : damage >= 0.3 ? 2 : 1);

/** Boost gauge text: two decimals, a real minus sign for vacuum. */
export function formatBoost(bar) {
  const v = Math.round(bar * 100) / 100;
  return v < 0 ? `−${Math.abs(v).toFixed(2)}` : v.toFixed(2);
}

/** Stall-card copy for an engine that is off. blownCause: 'over-rev' | 'overheat' | null. */
export function stallCopy({ blown, blownCause, canCrank }) {
  if (blown) {
    if (blownCause === 'overheat') {
      return { title: 'Engine cooked', help: 'It overheated until the head gasket failed. Rebuild it, then watch the water gauge.', button: 'REBUILD', tone: 'blown' };
    }
    if (blownCause === 'over-rev') {
      return { title: 'Engine blown', help: 'It was over-revved past the redline and a rod let go. Rebuild it to drive on.', button: 'REBUILD', tone: 'blown' };
    }
    return { title: 'Engine destroyed', help: 'It is not going to start like this. Rebuild it first.', button: 'REBUILD', tone: 'blown' };
  }
  return {
    title: 'Engine stalled',
    help: canCrank ? 'Ready. Tap START to crank it over.' : 'Press the clutch or select neutral, then start.',
    button: 'START',
    tone: 'stall',
  };
}

// Analog dial sweep: 240° clockwise from lower-left to lower-right (canvas angles).
export const DIAL_START = (5 * Math.PI) / 6;
export const DIAL_SWEEP = (4 * Math.PI) / 3;

/** Full-scale rpm for the analog dial: redline plus headroom, in whole thousands. */
export const dialMaxRpm = (redlineRpm) => Math.ceil((redlineRpm * 1.08) / 1000) * 1000;

/** Needle angle (radians, canvas convention) for an rpm. */
export const dialAngle = (rpm, maxRpm) => DIAL_START + DIAL_SWEEP * clamp(rpm / maxRpm, 0, 1);

/** px under the gear readout for the speed line and status tag. */
const DIAL_TEXT = 34;

/** Crank degrees in one full cycle: 720 for four-strokes, 1080 for a rotary (rotor turns once). */
export const scrubPeriod = (profile) => (profile.kind === 'rotary' ? 1080 : 720);

/** Crank angles (sorted, within one cycle) at which something fires. */
export function firingAngles(profile) {
  if (profile.kind === 'rotary') {
    const step = 360 / Math.max(1, profile.rotors || 1);
    const out = [];
    for (let d = 0; d < 1080 - 1e-6; d += step) out.push(Math.round(d * 1000) / 1000);
    return out;
  }
  return [...new Set(profile.cylinders.map((c) => mod(c.fireDeg, 720)))].sort((a, b) => a - b);
}

/** Next (dir 1) or previous (dir -1) firing angle from deg, wrapping around the cycle. */
export function stepFiring(profile, deg, dir) {
  const angles = firingAngles(profile);
  const d = mod(deg, scrubPeriod(profile));
  if (dir > 0) return angles.find((a) => a > d + 0.5) ?? angles[0];
  for (let i = angles.length - 1; i >= 0; i--) if (angles[i] < d - 0.5) return angles[i];
  return angles[angles.length - 1];
}

export const STROKES = ['power', 'exhaust', 'intake', 'compression'];

/** The cylinder that fired most recently at crank angle deg, and the stroke it is now in. */
export function lastFired(profile, deg) {
  if (profile.kind === 'rotary' || !profile.cylinders?.length) return null;
  let best = null;
  let since = Infinity;
  for (const c of profile.cylinders) {
    const s = mod(deg - c.fireDeg, 720);
    if (s < since) {
      since = s;
      best = c;
    }
  }
  return { num: best.num, since, stroke: STROKES[Math.min(3, Math.floor(since / 180))] };
}

export const DISPLAY_MODES = [
  { id: 'glass', label: 'Glass', patch: { xray: false, cutaway: false } },
  { id: 'xray', label: 'X-ray', patch: { xray: true, cutaway: false } },
  { id: 'cutaway', label: 'Cutaway', patch: { xray: false, cutaway: true } },
];

/** Which display mode the settings describe. Both x-ray and cutaway on counts as cutaway. */
export const displayModeOf = (s) => (s.cutaway ? 'cutaway' : s.xray ? 'xray' : 'glass');

/** The display mode after the current one: glass → x-ray → cutaway → glass. */
export function nextDisplayMode(s) {
  const i = DISPLAY_MODES.findIndex((m) => m.id === displayModeOf(s));
  return DISPLAY_MODES[(i + 1) % DISPLAY_MODES.length];
}

/** Short label for a cylinder count within a layout family: V8, I4, B4, F6, V2, "2 rotors". */
export function cylinderLabel(family, n) {
  if (family === 'rotary') return `${n} rotor${n > 1 ? 's' : ''}`;
  if (family === 'boxer') return n === 4 ? 'B4' : `F${n}`;
  if (family === 'vtwin') return 'V2';
  if (family === 'v') return `V${n}`;
  return `I${n}`;
}

/** Layout name for a profile: V8, I4, Boxer-4, Flat-6, V-twin, 2-rotor. */
export function layoutLabel(profile) {
  const layout = layoutOf(profile);
  const n = profile.kind === 'rotary' ? profile.rotors : profile.cylinders.length;
  if (layout === 'rotary') return `${n}-rotor`;
  if (layout === 'vtwin') return 'V-twin';
  if (layout === 'boxer') return n === 4 ? 'Boxer-4' : `Flat-${n}`;
  if (layout === 'v') return `V${n}`;
  return `I${n}`;
}

export const INDUCTION_LABELS = { na: 'Naturally aspirated', turbo: 'Turbo', 'twin-turbo': 'Twin-turbo', supercharger: 'Supercharged' };

/** Headline numbers for a garage build: layout, displacement, peak power and torque, redline, induction. */
export function garageSpecs(entry) {
  const profile = buildProfile({ ...DEFAULT_SETTINGS, ...entry.settings });
  const peak = peakFigures(profile);
  const induction = profile.induction?.kind ?? 'na';
  return {
    layout: layoutLabel(profile),
    displacementL: Math.round(profile.displacementL * 10) / 10,
    induction,
    inductionLabel: INDUCTION_LABELS[induction] ?? induction,
    boostBar: induction === 'na' ? 0 : profile.induction.targetBar,
    peakHp: Math.round(peak.hp),
    peakHpRpm: peak.hpRpm,
    peakNm: Math.round(peak.nm),
    peakNmRpm: peak.nmRpm,
    redlineRpm: profile.redlineRpm,
    vvl: !!profile.vvlRpm,
  };
}

/**
 * The garage build the settings still describe exactly, or null. settings.garage
 * alone can be stale when something changes the engine without clearing it.
 */
export function fittedGarage(settings, entries) {
  const entry = settings.garage ? entries.find((g) => g.id === settings.garage) : null;
  if (!entry) return null;
  for (const [k, v] of Object.entries(entry.settings)) if (settings[k] !== v) return null;
  return entry;
}

/** 6,600 style thousands separators without locale lookups. */
export const groupThousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * What the sequential paddle readout shows: the gear now, or the gear a shift
 * in flight is heading for. gearbox.shift is the in-flight sequential shift.
 */
export function paddleReadout(gear, shift) {
  if (shift && shift.source === 'sequential' && shift.to !== gear && shift.from === gear) return { gear: String(shift.to), pending: true };
  return { gear: String(gear), pending: false };
}

// ── Analog tachometer ───────────────────────────────────────────────────────

/** Canvas tachometer. The static face is cached; the live layer redraws only when something shown changes. */
export class AnalogTach {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.face = document.createElement('canvas');
    this.faceCtx = this.face.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.redline = 0;
    this.max = 1000;
    this.faceDirty = true;
    this.theme = null;
    // Last drawn state, compared field by field so the check allocates nothing.
    this.drawn = { rpmQ: -1, gear: '', speed: -1, units: '', flags: -1, mode: '' };
    this.speedText = '';
  }

  /** Re-measure (on layout changes, never per frame). */
  measure() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    for (const c of [this.canvas, this.face]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
    }
    this.faceDirty = true;
  }

  invalidate() {
    this.faceDirty = true;
    this.theme = null;
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.theme = {
      fg: v('--fg'), muted: v('--muted'), faint: v('--faint'), red: v('--red'), amber: v('--amber'),
      accent: v('--throttle'), track: '#222833', hub: v('--panel-solid'), display: v('--font-display'), data: v('--font-data'),
    };
  }

  // Gear, speed and the status tag stack under the hub, inside the open
  // bottom of the 240° sweep, so the canvas is r + 0.42 r + DIAL_TEXT tall.
  geometry() {
    const pad = 3;
    const r = Math.max(20, Math.min(this.w / 2 - pad, (this.h - pad - DIAL_TEXT) / 1.42));
    return { cx: this.w / 2, cy: pad + r, r };
  }

  drawFace(redlineRpm) {
    if (!this.theme) this.readTheme();
    const t = this.theme;
    const ctx = this.faceCtx;
    const { cx, cy, r } = this.geometry();
    const max = dialMaxRpm(redlineRpm);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineCap = 'butt';

    // Track and redline band.
    const ring = r - 4;
    ctx.lineWidth = 6;
    ctx.strokeStyle = t.track;
    ctx.beginPath();
    ctx.arc(cx, cy, ring, DIAL_START, DIAL_START + DIAL_SWEEP);
    ctx.stroke();
    ctx.strokeStyle = t.red;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(cx, cy, ring, dialAngle(redlineRpm, max), DIAL_START + DIAL_SWEEP);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Ticks every 500 rpm, numerals every 1000 (every 2000 on small dials with a long scale).
    const big = r > 64;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${big ? 13 : 11}px ${t.display}`;
    const numStep = max > 10000 && !big ? 2000 : 1000;
    for (let rpm = 0; rpm <= max; rpm += 500) {
      const a = dialAngle(rpm, max);
      const major = rpm % 1000 === 0;
      const inRed = rpm >= redlineRpm;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const r0 = ring - 6;
      const r1 = r0 - (major ? 8 : 4);
      ctx.strokeStyle = inRed ? t.red : major ? t.fg : t.faint;
      ctx.lineWidth = major ? 2 : 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + c * r0, cy + s * r0);
      ctx.lineTo(cx + c * r1, cy + s * r1);
      ctx.stroke();
      if (major && rpm % numStep === 0) {
        const rn = r1 - (big ? 11 : 9);
        ctx.fillStyle = inRed ? t.red : t.muted;
        ctx.fillText(String(rpm / 1000), cx + c * rn, cy + s * rn);
      }
    }
    if (big) {
      ctx.font = `500 9px ${t.data}`;
      ctx.fillStyle = t.faint;
      ctx.fillText('×1000 rpm', cx, cy - r * 0.34);
    }
    this.redline = redlineRpm;
    this.max = max;
    this.faceDirty = false;
  }

  /**
   * Draw if anything visible changed. flags: bit 1 limiter, bit 2 wheelspin.
   * speed is a number in the display units. Returns true when it redrew.
   */
  update(rpm, redlineRpm, gear, speed, units, flags, mode) {
    if (this.w < 10) return false;
    const rpmQ = Math.round(rpm / 10);
    const d = this.drawn;
    const faceChanged = this.faceDirty || redlineRpm !== this.redline;
    if (!faceChanged && d.rpmQ === rpmQ && d.gear === gear && d.speed === speed && d.units === units && d.flags === flags && d.mode === mode) return false;
    if (faceChanged) this.drawFace(redlineRpm);
    if (d.speed !== speed) this.speedText = String(speed);
    d.rpmQ = rpmQ;
    d.gear = gear;
    d.speed = speed;
    d.units = units;
    d.flags = flags;
    d.mode = mode;

    const t = this.theme;
    const ctx = this.ctx;
    const { cx, cy, r } = this.geometry();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.face, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Live arc on the track.
    const a = dialAngle(rpm, this.max);
    const hot = rpm > redlineRpm * 0.92;
    const color = hot ? t.red : t.accent;
    ctx.lineCap = 'butt';
    ctx.lineWidth = 6;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 4, DIAL_START, a);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Needle with a short tail and a hub.
    const c = Math.cos(a);
    const s = Math.sin(a);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx - c * 10, cy - s * 10);
    ctx.lineTo(cx + c * (r - 9), cy + s * (r - 9));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = t.hub;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.stroke();

    // Gear and speed under the hub, where the needle never sits.
    const big = r > 64;
    const gy = cy + r * 0.42;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${big ? 30 : 24}px ${t.display}`;
    ctx.fillStyle = gear === 'R' ? t.fg : t.accent;
    ctx.fillText(gear, cx, gy);
    const sy = gy + (big ? 17 : 14);
    ctx.font = `600 ${big ? 14 : 12}px ${t.display}`;
    const wNum = ctx.measureText(this.speedText).width;
    const unit = speedUnit(units);
    ctx.font = `600 ${big ? 10 : 9}px ${t.display}`;
    const wUnit = ctx.measureText(unit).width;
    const x0 = cx - (wNum + 3 + wUnit) / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = t.muted;
    ctx.fillText(unit, x0 + wNum + 3, sy);
    ctx.font = `600 ${big ? 14 : 12}px ${t.display}`;
    ctx.fillStyle = t.fg;
    ctx.fillText(this.speedText, x0, sy);

    // Status tag between the arc ends: limiter, then wheelspin, then gearbox mode.
    const tag = flags & 1 ? 'LIMITER' : flags & 2 ? 'WHEELSPIN' : mode;
    if (tag) {
      ctx.textAlign = 'center';
      ctx.font = `500 9px ${t.data}`;
      ctx.fillStyle = flags & 1 ? t.red : flags & 2 ? t.amber : t.muted;
      ctx.fillText(tag, cx, sy + 13);
    }
    return true;
  }
}

// ── HUD ─────────────────────────────────────────────────────────────────────

const LEVEL_CLASS = ['is-cold', '', 'is-warn', 'is-crit'];
const boostText = (centibar) => formatBoost(centibar / 100);

function gauge(kind, label, unit) {
  const value = el('output', { class: 'gauge-value' }, '—');
  const fill = el('i');
  const node = el('div', { class: 'gauge', dataset: { kind } },
    el('span', { class: 'gauge-label' }, label),
    el('span', { class: 'gauge-read' }, value, unit ? el('span', { class: 'gauge-unit' }, unit) : null),
    el('span', { class: 'gauge-bar', 'aria-hidden': 'true' }, fill));
  return { node, value, fill, key: NaN, level: -1, fillQ: -1, visible: true };
}

export class Hud {
  constructor(app) {
    this.app = app;
    this.el = {
      rpm: $('rpm'), fill: $('rpm-fill'), redline: $('rpm-redline'), gear: $('gear'), speed: $('speed'),
      speedUnit: $('speed-unit'), limiter: $('limiter'), traction: $('traction'), stall: $('stall'),
      stallTitle: $('stall-title'), stallHelp: $('stall-help'), start: $('btn-start'),
      paddleGear: $('paddle-gear'),
    };
    this.shown = {};
    this.spinTime = 0;
    this.spinHold = 0;
    this.tcHold = 0;
    this.fillQ = -1;
    this.rpmQ = -1;
    this.speedQ = -1;
    this.gearShown = '';
    this.gearKey = null;
    this.gearText = 'N';
    this.wide = false;
    this.hot = false;
    this.redlineShown = 0;
    this.paddleState = { gear: '', pending: null };
    this.stallKey = '';

    // Shift lights.
    this.lights = $('shift-lights');
    this.leds = this.lights ? [...this.lights.querySelectorAll('.led')] : [];
    this.ledLevel = -1;

    // Analog cluster.
    this.digital = $('tach-digital');
    this.dialCanvas = $('tach-dial');
    this.dial = this.dialCanvas ? new AnalogTach(this.dialCanvas) : null;
    this.analog = false;
    document.fonts?.ready?.then(() => this.dial?.invalidate());

    // Gauges and assist pills under the tach.
    this.gauges = {
      water: gauge('water', 'Water', '°C'),
      oil: gauge('oil', 'Oil', '°C'),
      boost: gauge('boost', 'Boost', 'bar'),
      health: gauge('health', 'Health', '%'),
    };
    this.gaugeRow = el('div', { class: 'gauges', role: 'group', 'aria-label': 'Gauges' }, ...Object.values(this.gauges).map((g) => g.node));
    this.pills = {
      launch: el('span', { class: 'pill pill-assist', hidden: true, title: 'Launch control' }, 'LAUNCH'),
      tc: el('span', { class: 'pill pill-assist', hidden: true, title: 'Traction control' }, 'TC'),
      vvl: el('span', { class: 'pill pill-assist', hidden: true, title: 'Variable valve lift' }, 'VVL'),
    };
    this.pillState = { launch: -1, tc: -1, vvl: -1 };
    this.pillRow = el('div', { class: 'assist-pills', hidden: true }, ...Object.values(this.pills));
    app.ui?.hudExtra?.prepend(this.gaugeRow, this.pillRow);
    this.setGaugeVisible(this.gauges.boost, false);
    this.setGaugeVisible(this.gauges.health, false);

    app.bus?.on('settings', () => this.onSettings());
    app.bus?.on('layout', () => this.dial?.measure());
  }

  setText(key, value) {
    if (this.shown[key] !== value) {
      this.shown[key] = value;
      this.el[key].textContent = value;
    }
  }

  setGaugeVisible(g, on) {
    if (g.visible === on) return false;
    g.visible = on;
    g.node.hidden = !on;
    return true;
  }

  /** Settings-driven visibility (cluster style, assist pills). Height changes re-run the app layout. */
  onSettings() {
    const { settings, profile } = this.app;
    let relayout = false;
    const analog = settings.cluster === 'analog' && !!this.dial;
    if (analog !== this.analog) {
      this.analog = analog;
      this.digital.hidden = analog;
      this.dialCanvas.hidden = !analog;
      // Force the digital readouts to refresh when they come back.
      this.rpmQ = this.speedQ = this.fillQ = -1;
      this.gearShown = '';
      relayout = true;
    }
    const want = {
      launch: !!settings.launchControl,
      tc: !!settings.tractionControl,
      vvl: !!profile.vvlRpm,
    };
    let any = false;
    for (const k of Object.keys(want)) {
      if (this.pills[k].hidden === want[k]) this.pills[k].hidden = !want[k];
      if (want[k]) any = true;
    }
    if (this.pillRow.hidden === any) {
      this.pillRow.hidden = !any;
      relayout = true;
    }
    // Boost gauge follows the configured induction so the card height only changes with settings.
    const boosted = (profile.induction?.kind ?? settings.induction ?? 'na') !== 'na';
    relayout = this.setGaugeVisible(this.gauges.boost, boosted) || relayout;
    if (relayout) this.app.layout?.();
    this.dial?.invalidate();
  }

  setPill(key, state) {
    if (this.pillState[key] === state) return;
    this.pillState[key] = state;
    const p = this.pills[key];
    p.classList.toggle('is-on', state === 2);
    p.classList.toggle('is-armed', state === 1);
  }

  /** key: the quantised value shown; text() only runs when it changes. */
  updateGauge(g, key, text, level, frac) {
    if (g.key !== key) {
      g.key = key;
      g.value.textContent = text(key);
    }
    if (g.level !== level) {
      if (LEVEL_CLASS[g.level]) g.node.classList.remove(LEVEL_CLASS[g.level]);
      if (LEVEL_CLASS[level]) g.node.classList.add(LEVEL_CLASS[level]);
      g.level = level;
    }
    const q = Math.round(clamp(frac, 0, 1) * 50);
    if (g.fillQ !== q) {
      g.fillQ = q;
      g.fill.style.transform = `scaleX(${q / 50})`;
    }
  }

  update(dt) {
    const { sim, profile, settings, gearbox } = this.app;
    const el = this.el;
    const rpm = sim.rpm;
    const gear = sim.gear;
    if (gear !== this.gearKey) {
      this.gearKey = gear;
      this.gearText = String(gear);
    }
    const speed = formatSpeed(sim.speedKmh, settings.units);
    const limiter = !!sim.fuelCut && !sim.launchActive;

    // Wheelspin: only flag it when sustained, not the blip of a clutch catching.
    this.spinTime = sim.wheelspin && sim.throttleEffective > 0.3 ? this.spinTime + dt : 0;
    this.spinHold = this.spinTime > 0.2 ? 0.35 : Math.max(0, this.spinHold - dt);
    const spinning = this.spinHold > 0;

    // Shift lights.
    const level = shiftLightLevel(rpm, profile, !!(sim.fuelCut || sim.launchActive));
    if (level !== this.ledLevel && this.lights) {
      const lit = level === SHIFT_FLASH ? SHIFT_LEDS : level;
      const was = this.ledLevel === SHIFT_FLASH ? SHIFT_LEDS : Math.max(0, this.ledLevel);
      for (let i = Math.min(lit, was); i < Math.max(lit, was); i++) this.leds[i].classList.toggle('is-on', i < lit);
      if ((level === SHIFT_FLASH) !== (this.ledLevel === SHIFT_FLASH)) this.lights.classList.toggle('is-flash', level === SHIFT_FLASH);
      this.ledLevel = level;
    }

    if (this.analog) {
      const mode = settings.mode === 'auto' ? 'AUTO' : settings.mode === 'sequential' ? 'SEQ' : '';
      this.dial.update(rpm, profile.redlineRpm, this.gearText, speed, settings.units, (limiter ? 1 : 0) | (spinning ? 2 : 0), mode);
    } else {
      const rpmQ = Math.round(rpm / 10);
      if (rpmQ !== this.rpmQ) {
        this.rpmQ = rpmQ;
        el.rpm.textContent = String(rpmQ * 10);
        // Five digits (money shifts reach 10,000+) get a narrower size so the row never overflows.
        const wide = rpmQ >= 1000;
        if (wide !== this.wide) {
          this.wide = wide;
          el.rpm.classList.toggle('is-wide', wide);
        }
      }
      const scale = profile.redlineRpm * 1.06;
      const q = Math.round(Math.min(1000, (rpm / scale) * 1000));
      if (q !== this.fillQ) {
        this.fillQ = q;
        el.fill.style.transform = `scaleX(${q / 1000})`;
        const hot = rpm > profile.redlineRpm * 0.92;
        if (hot !== this.hot) {
          this.hot = hot;
          el.fill.classList.toggle('is-red', hot);
        }
      }
      if (this.redlineShown !== profile.redlineRpm) {
        this.redlineShown = profile.redlineRpm;
        el.redline.style.left = `${((profile.redlineRpm / scale) * 100).toFixed(1)}%`;
      }
      if (this.gearShown !== gear) {
        this.gearShown = gear;
        el.gear.textContent = this.gearText;
        el.gear.classList.toggle('is-reverse', gear === 'R');
      }
      if (speed !== this.speedQ) {
        this.speedQ = speed;
        el.speed.textContent = String(speed);
      }
      this.setText('speedUnit', speedUnit(settings.units));
      if (el.limiter.hidden === limiter) el.limiter.hidden = !limiter;
      if (el.traction.hidden === spinning) el.traction.hidden = !spinning;
    }

    // Sequential paddles: the gear now, or the one a shift in flight is heading for.
    if (el.paddleGear) {
      const shift = gearbox?.shift;
      const pendingTo = shift && shift.source === 'sequential' && shift.from === gear && shift.to !== gear ? shift.to : null;
      const ps = this.paddleState;
      if (ps.gear !== gear || ps.pending !== pendingTo) {
        ps.gear = gear;
        ps.pending = pendingTo;
        const r = paddleReadout(gear, shift);
        el.paddleGear.textContent = r.gear;
        el.paddleGear.classList.toggle('is-pending', r.pending);
      }
    }

    // Gauges.
    const g = this.gauges;
    const water = sim.coolantC ?? 90;
    const oil = sim.oilC ?? 95;
    this.updateGauge(g.water, Math.round(water), String, tempLevel(water, 'coolant'), (water - 40) / 90);
    this.updateGauge(g.oil, Math.round(oil), String, tempLevel(oil, 'oil'), (oil - 40) / 110);
    if (g.boost.visible) {
      const b = sim.boostBar ?? 0;
      const target = Math.max(0.3, sim.boostTarget || settings.boostBar || 1);
      this.updateGauge(g.boost, Math.round(b * 100), boostText, b > target * 1.12 ? 2 : 1, (b + 1) / (target * 1.15 + 1));
    }
    const damage = sim.damage ?? 0;
    const showHealth = damage > 0.005 || !!sim.blown;
    if (this.setGaugeVisible(g.health, showHealth)) this.app.layout?.();
    if (showHealth) {
      const health = sim.blown ? 0 : 1 - damage;
      this.updateGauge(g.health, Math.round(health * 100), String, sim.blown ? 3 : healthLevel(damage), health);
    }

    // Assist pills: 0 idle, 1 armed, 2 working. TC holds briefly so a short cut is readable.
    this.tcHold = sim.tcActive ? 0.4 : Math.max(0, this.tcHold - dt);
    if (!this.pillRow.hidden) {
      if (!this.pills.launch.hidden) this.setPill('launch', sim.launchActive ? 2 : sim.launchArmed ? 1 : 0);
      if (!this.pills.tc.hidden) this.setPill('tc', this.tcHold > 0 ? 2 : 0);
      if (!this.pills.vvl.hidden) this.setPill('vvl', sim.vvlActive ? 2 : 0);
    }

    const off = !sim.running && !sim.cranking;
    if (el.stall.hidden === off) el.stall.hidden = !off;
    if (off) {
      const ready = !sim.blown && sim.canCrank();
      const key = sim.blown ? `b:${sim.blownCause}` : ready ? 'ready' : 'wait';
      if (key !== this.stallKey) {
        this.stallKey = key;
        const copy = stallCopy({ blown: sim.blown, blownCause: sim.blownCause, canCrank: ready });
        this.setText('stallTitle', copy.title);
        this.setText('stallHelp', copy.help);
        this.setText('start', copy.button);
        el.start.disabled = !sim.blown && !ready;
        el.stall.classList.toggle('is-blown', !!sim.blown);
        // While the card shows, toasts drop below it (styles.css): measure it
        // once per change of copy rather than every frame.
        const r = el.stall.getBoundingClientRect();
        document.documentElement.style.setProperty('--toast-under-stall', `${Math.round(r.bottom + 8)}px`);
      }
    } else this.stallKey = '';
  }
}

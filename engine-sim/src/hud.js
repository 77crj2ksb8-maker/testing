// Core HUD: tach card (digital or analog), shift lights, gauges, assist pills,
// gear and speed, and the stall card. main.js calls update(dt) once per frame.
// The helpers exported at the top are pure (no DOM) so Node tests can use them.

import { el, formatSpeed, speedUnit } from './dom.js';
import { buildProfile, DEFAULT_SETTINGS, wotTorque, powerHp } from './config.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

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
  const [cold, hot, crit] = kind === 'oil' ? [70, 128, 140] : [65, 108, 116];
  return c >= crit ? 3 : c >= hot ? 2 : c < cold ? 0 : 1;
}

/** Engine health state from damage 0..1: 1 good, 2 worn, 3 critical. */
export const healthLevel = (damage) => (damage >= 0.65 ? 3 : damage >= 0.3 ? 2 : 1);

// Analog dial sweep: 240° clockwise from lower-left to lower-right (canvas angles).
export const DIAL_START = (5 * Math.PI) / 6;
export const DIAL_SWEEP = (4 * Math.PI) / 3;

/** Full-scale rpm for the analog dial: redline plus headroom, in whole thousands. */
export const dialMaxRpm = (redlineRpm) => Math.ceil((redlineRpm * 1.08) / 1000) * 1000;

/** Needle angle (radians, canvas convention) for an rpm. */
export const dialAngle = (rpm, maxRpm) => DIAL_START + DIAL_SWEEP * clamp(rpm / maxRpm, 0, 1);

/** Crank degrees in one full cycle: 720 for four-strokes, 1080 for a rotary (rotor turns once). */
export const scrubPeriod = (profile) => (profile.kind === 'rotary' ? 1080 : 720);

const mod = (a, n) => ((a % n) + n) % n;

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
  const period = scrubPeriod(profile);
  const angles = firingAngles(profile);
  const d = mod(deg, period);
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

/** Short layout name for a profile: V8, I4, Flat-6, V-twin, 2-rotor. */
export function layoutLabel(profile) {
  const layout = profile.layout ?? (profile.kind === 'rotary' ? 'rotary' : profile.banks === 2 ? 'v' : 'inline');
  const n = profile.kind === 'rotary' ? profile.rotors : profile.cylinders.length;
  if (layout === 'rotary') return `${n}-rotor`;
  if (layout === 'vtwin') return 'V-twin';
  if (layout === 'boxer') return n === 4 ? 'Boxer-4' : `Flat-${n}`;
  if (layout === 'v') return `V${n}`;
  return `I${n}`;
}

export const INDUCTION_LABELS = { na: 'NA', turbo: 'Turbo', 'twin-turbo': 'Twin-turbo', supercharger: 'Supercharged' };

/** Headline numbers for a garage build: displacement, layout, peak power and torque, redline. */
export function garageSpecs(entry) {
  const profile = buildProfile({ ...DEFAULT_SETTINGS, ...entry.settings });
  let peakNm = 0;
  let peakNmRpm = 0;
  let peakHp = 0;
  let peakHpRpm = 0;
  for (let rpm = 1000; rpm <= profile.redlineRpm; rpm += 50) {
    const t = wotTorque(profile, rpm);
    const hp = powerHp(t, rpm);
    if (t > peakNm) {
      peakNm = t;
      peakNmRpm = rpm;
    }
    if (hp > peakHp) {
      peakHp = hp;
      peakHpRpm = rpm;
    }
  }
  const induction = entry.settings?.induction ?? 'na';
  return {
    displacementL: profile.displacementL,
    layout: layoutLabel(profile),
    induction: INDUCTION_LABELS[induction] ?? induction,
    peakHp: Math.round(peakHp),
    peakHpRpm,
    peakNm: Math.round(peakNm),
    peakNmRpm,
    redlineRpm: profile.redlineRpm,
  };
}

// ── Analog tachometer ───────────────────────────────────────────────────────

/** Canvas tachometer. Static face is cached; the needle layer redraws only when something shown changes. */
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
    this.faceDirty = true;
    // Last drawn state (numbers only, compared without allocating).
    this.drawn = { rpmQ: -1, gear: '', speed: -1, units: '', flags: -1, mode: '' };
    this.fonts = null;
  }

  /** Re-measure (call on layout changes, never per frame). */
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
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.theme = {
      fg: v('--fg'), muted: v('--muted'), faint: v('--faint'), red: v('--red'), amber: v('--amber'),
      accent: v('--throttle'), track: '#222833', display: v('--font-display'), data: v('--font-data'),
    };
  }

  geometry() {
    const pad = 4;
    const r = Math.min(this.w / 2 - pad, (this.h - pad * 2) / 1.5);
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

    // Ticks every 500 rpm, numerals every 1000.
    const big = r > 70;
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
    ctx.font = `500 9px ${t.data}`;
    ctx.fillStyle = t.faint;
    ctx.fillText('×1000 rpm', cx, cy - r * 0.42);
    this.redline = redlineRpm;
    this.max = max;
    this.faceDirty = false;
  }

  /**
   * Draw if anything visible changed. flags: bit 1 limiter, bit 2 wheelspin.
   * Returns true when it redrew.
   */
  update(rpm, redlineRpm, gear, speed, units, flags, mode) {
    if (this.w < 10) return false;
    const rpmQ = Math.round(rpm / 10);
    const d = this.drawn;
    const faceChanged = this.faceDirty || redlineRpm !== this.redline;
    if (!faceChanged && d.rpmQ === rpmQ && d.gear === gear && d.speed === speed && d.units === units && d.flags === flags && d.mode === mode) return false;
    if (faceChanged) this.drawFace(redlineRpm);
    d.rpmQ = rpmQ;
    d.gear = gear;
    d.speed = speed;
    d.units = units;
    d.flags = flags;
    d.mode = mode;

    const t = this.theme;
    const ctx = this.ctx;
    const { cx, cy, r } = this.geometry();
    const max = this.max;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.face, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Live arc on the track.
    const a = dialAngle(rpm, max);
    const hot = rpm > redlineRpm * 0.92;
    ctx.lineCap = 'butt';
    ctx.lineWidth = 6;
    ctx.strokeStyle = hot ? t.red : t.accent;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 4, DIAL_START, a);
    ctx.stroke();

    // Needle with a short tail and a hub.
    const c = Math.cos(a);
    const s = Math.sin(a);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = hot ? t.red : t.accent;
    ctx.beginPath();
    ctx.moveTo(cx - c * 10, cy - s * 10);
    ctx.lineTo(cx + c * (r - 9), cy + s * (r - 9));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#0d1016';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.stroke();

    // Gear and speed in the lower half, where the needle rarely sits.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const big = r > 70;
    ctx.font = `800 ${big ? 30 : 24}px ${t.display}`;
    ctx.fillStyle = gear === 'R' ? t.fg : t.accent;
    ctx.fillText(gear, cx, cy + r * 0.42);
    ctx.font = `600 ${big ? 14 : 12}px ${t.display}`;
    ctx.fillStyle = t.fg;
    const unit = speedUnit(units);
    const num = String(speed);
    const wNum = ctx.measureText(num).width;
    ctx.font = `600 ${big ? 10 : 9}px ${t.display}`;
    const wUnit = ctx.measureText(unit).width;
    const x0 = cx - (wNum + 3 + wUnit) / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = t.muted;
    ctx.fillText(unit, x0 + wNum + 3, cy + r * 0.42 + (big ? 17 : 14));
    ctx.font = `600 ${big ? 14 : 12}px ${t.display}`;
    ctx.fillStyle = t.fg;
    ctx.fillText(num, x0, cy + r * 0.42 + (big ? 17 : 14));

    // Status tag between the arc ends: limiter, then wheelspin, then gearbox mode.
    const tag = flags & 1 ? 'LIMITER' : flags & 2 ? 'WHEELSPIN' : mode;
    if (tag) {
      ctx.textAlign = 'center';
      ctx.font = `500 9px ${t.data}`;
      ctx.fillStyle = flags & 1 ? t.red : flags & 2 ? t.amber : t.muted;
      ctx.fillText(tag, cx, Math.min(this.h - 2, cy + r * 0.5 + 4));
    }
    return true;
  }
}

// ── HUD ─────────────────────────────────────────────────────────────────────

const LEVEL_CLASS = ['is-cold', '', 'is-warn', 'is-crit'];

function gauge(kind, label) {
  const value = el('output', { class: 'gauge-value' }, '—');
  const fill = el('i');
  const node = el('div', { class: 'gauge', dataset: { kind } },
    el('span', { class: 'gauge-label' }, label), value, el('span', { class: 'gauge-bar', 'aria-hidden': 'true' }, fill));
  return { node, value, fill, shown: '', level: -1, fillQ: -1, visible: true };
}

export class Hud {
  constructor(app) {
    this.app = app;
    this.el = {
      rpm: $('rpm'), fill: $('rpm-fill'), redline: $('rpm-redline'), gear: $('gear'), speed: $('speed'),
      speedUnit: $('speed-unit'), limiter: $('limiter'), traction: $('traction'), stall: $('stall'),
      stallTitle: $('stall-title'), stallHelp: $('stall-help'), start: $('btn-start'),
      paddleGear: $('paddle-gear'), modeTag: $('mode-tag'),
    };
    this.shown = {};
    this.spinTime = 0;
    this.spinHold = 0;
    this.tcHold = 0;
    this.fillQ = -1;
    this.redlineShown = 0;

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
    const extra = app.ui?.hudExtra;
    this.gauges = {
      water: gauge('water', 'Water'),
      oil: gauge('oil', 'Oil'),
      boost: gauge('boost', 'Boost'),
      health: gauge('health', 'Health'),
    };
    this.gaugeRow = el('div', { class: 'gauges', role: 'group', 'aria-label': 'Gauges' }, ...Object.values(this.gauges).map((g) => g.node));
    this.pills = {
      launch: el('span', { class: 'pill pill-assist', hidden: true }, 'LAUNCH'),
      tc: el('span', { class: 'pill pill-assist', hidden: true }, 'TC'),
      vvl: el('span', { class: 'pill pill-assist', hidden: true }, 'VVL'),
    };
    this.pillState = { launch: -1, tc: -1, vvl: -1 };
    this.pillRow = el('div', { class: 'assist-pills', hidden: true }, ...Object.values(this.pills));
    if (extra) extra.prepend(this.gaugeRow, this.pillRow);
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
    if (g.visible === on) return;
    g.visible = on;
    g.node.hidden = !on;
  }

  /** Settings-driven visibility (cluster style, assist pills). Height changes re-run the app layout. */
  onSettings() {
    const { settings, profile } = this.app;
    let relayout = false;
    const analog = settings.cluster === 'analog';
    if (analog !== this.analog && this.dial) {
      this.analog = analog;
      this.digital.hidden = analog;
      this.dialCanvas.hidden = !analog;
      relayout = true;
    }
    const want = {
      launch: !!settings.launchControl,
      tc: !!settings.tractionControl,
      vvl: profile.kind !== 'rotary' && !!(profile.vvlRpm ?? settings.vvlRpm),
    };
    let any = false;
    for (const k of Object.keys(want)) {
      this.pills[k].hidden = !want[k];
      any ||= want[k];
    }
    if (this.pillRow.hidden === any) {
      this.pillRow.hidden = !any;
      relayout = true;
    }
    if (relayout && this.app.layout) {
      // Measure after the DOM change lands; layout() also re-measures the dial.
      this.app.layout();
    }
    this.dial?.invalidate();
  }

  setPill(key, state) {
    if (this.pillState[key] === state) return;
    this.pillState[key] = state;
    const p = this.pills[key];
    p.classList.toggle('is-on', state === 2);
    p.classList.toggle('is-armed', state === 1);
  }

  updateGauge(g, text, level, frac) {
    if (g.shown !== text) {
      g.shown = text;
      g.value.textContent = text;
    }
    if (g.level !== level) {
      if (g.level >= 0 && LEVEL_CLASS[g.level]) g.node.classList.remove(LEVEL_CLASS[g.level]);
      if (LEVEL_CLASS[level]) g.node.classList.add(LEVEL_CLASS[level]);
      g.level = level;
    }
    const q = Math.round(clamp(frac, 0, 1) * 100);
    if (g.fillQ !== q) {
      g.fillQ = q;
      g.fill.style.transform = `scaleX(${q / 100})`;
    }
  }

  update(dt) {
    const { sim, profile, settings } = this.app;
    const el = this.el;
    const rpm = sim.rpm;
    const gear = String(sim.gear);
    const speed = formatSpeed(sim.speedKmh, settings.units);
    const limiting = !!(sim.fuelCut || sim.launchActive);

    // Wheelspin: only flag it when sustained, not the blip of a clutch catching.
    this.spinTime = sim.wheelspin && sim.throttleEffective > 0.3 ? this.spinTime + dt : 0;
    this.spinHold = this.spinTime > 0.2 ? 0.35 : Math.max(0, this.spinHold - dt);
    const spinning = this.spinHold > 0;

    // Shift lights.
    const level = shiftLightLevel(rpm, profile, limiting);
    if (level !== this.ledLevel) {
      this.ledLevel = level;
      const lit = level === SHIFT_FLASH ? SHIFT_LEDS : level;
      for (let i = 0; i < this.leds.length; i++) this.leds[i].classList.toggle('is-on', i < lit);
      this.lights.classList.toggle('is-flash', level === SHIFT_FLASH);
    }

    if (this.analog) {
      const mode = settings.mode === 'auto' ? 'AUTO' : settings.mode === 'sequential' ? 'SEQ' : '';
      this.dial.update(rpm, profile.redlineRpm, gear, speed, settings.units, (sim.fuelCut ? 1 : 0) | (spinning ? 2 : 0), mode);
    } else {
      this.setText('rpm', String(Math.round(rpm / 10) * 10));
      const scale = profile.redlineRpm * 1.06;
      const q = Math.round(Math.min(1000, (rpm / scale) * 1000));
      if (q !== this.fillQ) {
        this.fillQ = q;
        el.fill.style.width = `${q / 10}%`;
        el.fill.classList.toggle('is-red', rpm > profile.redlineRpm * 0.92);
      }
      if (this.redlineShown !== profile.redlineRpm) {
        this.redlineShown = profile.redlineRpm;
        el.redline.style.left = `${((profile.redlineRpm / scale) * 100).toFixed(1)}%`;
      }
      this.setText('gear', gear);
      el.gear.classList.toggle('is-reverse', sim.gear === 'R');
      this.setText('speed', String(speed));
      this.setText('speedUnit', speedUnit(settings.units));
      if (el.limiter.hidden === !!sim.fuelCut) el.limiter.hidden = !sim.fuelCut;
      if (el.traction.hidden === spinning) el.traction.hidden = !spinning;
    }
    if (el.paddleGear) this.setText('paddleGear', gear);

    // Gauges.
    const g = this.gauges;
    const water = sim.coolantC ?? 88;
    const oil = sim.oilC ?? 95;
    this.updateGauge(g.water, `${Math.round(water)}°`, tempLevel(water, 'coolant'), (water - 40) / 90);
    this.updateGauge(g.oil, `${Math.round(oil)}°`, tempLevel(oil, 'oil'), (oil - 40) / 110);
    const boosted = !!sim.inductionKind && sim.inductionKind !== 'na';
    this.setGaugeVisible(g.boost, boosted);
    if (boosted) {
      const b = sim.boostBar ?? 0;
      const target = Math.max(0.3, sim.boostTarget || settings.boostBar || 1);
      const text = b < -0.005 ? `−${Math.abs(b).toFixed(2)}` : b.toFixed(2);
      this.updateGauge(g.boost, text, b > target * 1.12 ? 2 : 1, b / (target * 1.15));
    }
    const damage = sim.damage ?? 0;
    this.setGaugeVisible(g.health, damage > 0.005 || !!sim.blown);
    if (g.health.visible) {
      const health = sim.blown ? 0 : 1 - damage;
      this.updateGauge(g.health, `${Math.round(health * 100)}%`, sim.blown ? 3 : healthLevel(damage), health);
    }

    // Assist pills: 0 idle, 1 armed, 2 working. TC holds briefly so a short cut is readable.
    this.tcHold = sim.tcActive ? 0.4 : Math.max(0, this.tcHold - dt);
    if (!this.pills.launch.hidden) this.setPill('launch', sim.launchActive ? 2 : sim.launchArmed ? 1 : 0);
    if (!this.pills.tc.hidden) this.setPill('tc', this.tcHold > 0 ? 2 : 0);
    if (!this.pills.vvl.hidden) this.setPill('vvl', sim.vvlActive ? 2 : 0);

    const off = !sim.running && !sim.cranking;
    if (el.stall.hidden === off) el.stall.hidden = !off;
    if (off) {
      if (sim.blown) {
        this.setText('stallTitle', 'Engine destroyed');
        this.setText('stallHelp', 'It is not going to start like this. Rebuild it first.');
        this.setText('start', 'REBUILD');
        el.start.disabled = false;
      } else {
        const ready = sim.canCrank();
        this.setText('stallTitle', 'Engine stalled');
        this.setText('start', 'START');
        el.start.disabled = !ready;
        this.setText('stallHelp', ready ? 'Ready. Tap START to crank it over.' : 'Press the clutch or select neutral, then start.');
      }
    }
  }
}

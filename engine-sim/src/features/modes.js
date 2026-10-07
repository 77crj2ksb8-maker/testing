// Modes & analytics: the drag strip, the chassis dyno, a cylinder-pressure
// view in the telemetry panel and achievements. The maths lives in pure
// modules (src/modes/drag.js, src/modes/dyno.js, src/pv.js,
// src/achievements.js); this file wires them to the app (docs/CONTRACT.md)
// and owns their DOM, CSS and canvas charts.

import { el, injectStyles, formatSpeed, speedUnit } from '../dom.js';
import { wotTorque, powerHp, layoutOf, peakFigures } from '../config.js';
import { RPM_TO_RAD } from '../physics.js';
import { DragRace, DragRecords, DRAG_MARKS, QUARTER_M } from '../modes/drag.js';
import { rollerDrive, dynoConfig, DynoRecorder, DYNO_GEAR, pullStartRpm, pullEndRpm, hpFrom } from '../modes/dyno.js';
import { pvGeometry, computeCycle, createCycle, operatingPoint, cycleIndex, PV_POINTS } from '../pv.js';
import { AchievementTracker, ACHIEVEMENTS } from '../achievements.js';

const KEYS = {
  drag: 'firing-order:drag-records:v1',
  dyno: 'firing-order:dyno-runs:v1',
  achievements: 'firing-order:achievements:v1',
};

const ICONS = {
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V3"/><path d="M5 4h14v9H5"/><path d="M9.7 4v9M14.3 4v9M5 8.5h14"/></svg>',
  dyno: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 16a8.5 8.5 0 0 1 17 0"/><path d="M12 16l4.2-5"/><circle cx="7" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M8 20h8M10 17h4"/></svg>',
};

const SPINUP_S = 1.2; // dyno: rollers bring the engine from idle to the start rpm
const HOLD_S = 0.5; // dyno: held at the start rpm before the throttle opens
const PULL_MAX_S = 40;
const RUNS_KEPT = 3;
const PV_RECOMPUTE_S = 0.12;
const TOAST_GAP_S = 2.6;
const SPEED_ACHIEVEMENTS = { 'speed-100': 100, 'speed-200': 200, 'speed-300': 300 };

// One formatter for every readout (toLocaleString builds a new one per call).
const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmtInt = (n) => NUM.format(Math.round(n));
const fmtRpm = (rpm) => NUM.format(Math.round(rpm / 50) * 50);
const KMH_TO_MPH = 0.621371;
/** Speed with one decimal in the user's units (time slips). */
const speedFixed = (kmh, units) => `${(units === 'mph' ? kmh * KMH_TO_MPH : kmh).toFixed(1)} ${speedUnit(units)}`;
const smooth01 = (x) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

function storageFor(key) {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save(data) {
      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch {
        /* private mode or full: keep it for this session */
      }
    },
  };
}

// Theme tokens for canvas drawing (one deliberate theme, so read once).
const tokens = {};
const token = (name) => {
  if (!(name in tokens)) tokens[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  return tokens[name];
};

function niceStep(range, targetTicks) {
  const raw = range / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

// ── A small DPR-aware canvas plot with one y-axis ──────────────────────────
class Plot {
  constructor(canvas, pad = { l: 36, r: 10, t: 8, b: 18 }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pad = pad;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.sizeDirty = true;
    this.x0 = 0;
    this.x1 = 1;
    this.y0 = 0;
    this.y1 = 1;
    this.logY = false;
    this.observed = typeof ResizeObserver !== 'undefined';
    if (this.observed) {
      new ResizeObserver(() => {
        this.sizeDirty = true;
      }).observe(canvas);
    }
  }

  /**
   * Match the backing store to the element size. Returns false while hidden.
   * Measures only after the ResizeObserver reports a change, so a hidden or
   * squeezed canvas costs no layout read per frame.
   */
  fit() {
    if (!this.sizeDirty) return this.w > 0;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.observed) this.sizeDirty = false;
    if (!w || !h) {
      this.w = 0;
      return false;
    }
    this.sizeDirty = false;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.resized = true;
    return true;
  }

  setRange(x0, x1, y0, y1, logY = false) {
    this.x0 = x0;
    this.x1 = x1;
    this.y0 = y0;
    this.y1 = y1;
    this.logY = logY;
  }

  x(v) {
    const { l, r } = this.pad;
    return l + ((v - this.x0) / (this.x1 - this.x0)) * (this.w - l - r);
  }

  y(v) {
    const { t, b } = this.pad;
    const f = this.logY
      ? (Math.log(Math.max(v, this.y0)) - Math.log(this.y0)) / (Math.log(this.y1) - Math.log(this.y0))
      : (v - this.y0) / (this.y1 - this.y0);
    return t + (1 - f) * (this.h - t - b);
  }

  xAt(clientX, rect) {
    const { l, r } = this.pad;
    return this.x0 + ((clientX - rect.left - l) / (rect.width - l - r)) * (this.x1 - this.x0);
  }

  begin(ctx = this.ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    return ctx;
  }

  /** Grid, y labels and x labels. xTicks: [{v, label}]; yTicks: numbers. */
  axes(ctx, xTicks, yTicks, yFmt = String) {
    const { pad, w, h } = this;
    ctx.font = `10px ${token('--font-data')}`;
    ctx.lineWidth = 1;
    ctx.strokeStyle = token('--line');
    ctx.fillStyle = token('--muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yTicks) {
      const y = Math.round(this.y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(yFmt(v), pad.l - 5, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of xTicks) ctx.fillText(t.label, this.x(t.v), h - pad.b + 5);
  }

  /** Vertical hairline at x value v. */
  vline(ctx, v, color, alpha = 1) {
    const x = Math.round(this.x(v)) + 0.5;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, this.pad.t);
    ctx.lineTo(x, this.h - this.pad.b);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  dot(ctx, xv, yv, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = token('--bg');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.x(xv), this.y(yv), 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fill();
  }
}

const CSS = `
.mo-card {
  position: absolute;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
  color: var(--fg);
}
.mo-close { flex: none; }
.mo-close svg, .mo-ach-ico svg { fill: none; stroke: var(--fg); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

/* Drag strip: live card under the top HUD, clear of the tool rail and the controls. */
/* Where the HUD leaves room: the drag card and the slip are positioned from JS. */
.mo-safe {
  position: absolute;
  left: calc(var(--safe-left) + var(--gutter));
  right: calc(var(--safe-right) + var(--gutter));
  top: calc(var(--safe-top) + 8px);
  bottom: calc(var(--safe-bottom) + 8px);
  visibility: hidden;
  pointer-events: none !important;
}
.mo-drag {
  top: calc(var(--hud-top-h, 120px) + 10px);
  left: calc(var(--safe-left) + var(--gutter));
  width: 320px;
  overflow: hidden;
  display: flex;
  gap: 12px;
  padding: 10px 12px 10px 10px;
}
.mo-tree {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 6px 5px;
  border-radius: 10px;
  background: #07090d;
  border: 1px solid var(--line);
}
.mo-bulb { width: 18px; height: 18px; border-radius: 50%; background: #1b2028; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05); }
.mo-bulb.is-stage { width: 12px; height: 12px; }
.mo-bulb.is-stage.is-on { background: #fff6d8; box-shadow: 0 0 8px rgba(255, 246, 216, 0.8); }
.mo-bulb.is-amber.is-on { background: var(--amber); box-shadow: 0 0 12px var(--amber); }
.mo-bulb.is-green.is-on { background: var(--good); box-shadow: 0 0 14px var(--good); }
.mo-bulb.is-red.is-on { background: var(--red); box-shadow: 0 0 14px var(--red); }
.mo-drag-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; container-type: inline-size; }
.mo-drag-head { display: flex; align-items: center; gap: 8px; }
.mo-kicker { margin: 0 auto 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: var(--muted); text-transform: uppercase; }
.mo-drag-msg { margin: 0; font-size: 15px; font-weight: 700; min-height: 1.2em; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-drag-msg.is-go { color: var(--good); }
.mo-drag-msg.is-bad { color: var(--red); }
.mo-drag-nums { display: grid; grid-template-columns: 1.25fr 1fr 1fr; gap: 6px; }
.mo-num { display: flex; flex-direction: column; min-width: 0; }
.mo-num output { font-family: var(--font-data); font-size: 19px; font-weight: 500; line-height: 1.1; white-space: nowrap; }
.mo-num span { font-size: 10px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
.mo-track { position: relative; height: 6px; border-radius: 3px; background: var(--raise); overflow: hidden; }
.mo-track-fill { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--throttle); border-radius: 3px; }
.mo-track-tick { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(234, 238, 244, 0.35); }
.mo-splits { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
.mo-splits li { display: flex; flex-direction: column; align-items: center; padding: 3px 0; border-radius: 6px; background: var(--raise); min-width: 0; }
.mo-splits b { font-size: 10px; font-weight: 600; color: var(--muted); }
.mo-splits span { font-family: var(--font-data); font-size: 11px; color: var(--faint); }
.mo-splits li.is-hit span { color: var(--fg); }
@container (max-width: 230px) {
  .mo-num output { font-size: 16px; }
  .mo-splits { gap: 3px; }
  .mo-splits b, .mo-splits span { font-size: 9.5px; }
}

/* Time slip: a printed receipt that takes the live card's place after a run. */
.mo-slip {
  position: absolute;
  top: calc(var(--hud-top-h, 120px) + 10px);
  left: calc(var(--safe-left) + var(--gutter));
  width: 300px;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
  padding: 16px 16px 14px;
  background: var(--fg);
  color: var(--bg);
  font-family: var(--font-data);
  font-size: 12px;
  line-height: 1.5;
  border-radius: 3px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
  -webkit-mask: radial-gradient(circle 5px at 50% 100%, transparent 98%, #000) 0 0 / 14px 100% repeat-x;
  mask: radial-gradient(circle 5px at 50% 100%, transparent 98%, #000) 0 0 / 14px 100% repeat-x;
  padding-bottom: 20px;
}
.mo-slip h3 { margin: 0; font-family: var(--font-display); font-size: 16px; font-weight: 800; letter-spacing: 0.14em; text-align: center; }
.mo-slip .mo-slip-sub { margin: 2px 0 8px; text-align: center; font-size: 11px; opacity: 0.75; }
.mo-slip table { width: 100%; border-collapse: collapse; border-top: 1px dashed rgba(9, 11, 16, 0.5); border-bottom: 1px dashed rgba(9, 11, 16, 0.5); }
.mo-slip td { padding: 1px 0; white-space: nowrap; }
.mo-slip td:nth-child(2) { text-align: right; font-weight: 500; }
.mo-slip td:nth-child(3) { text-align: right; opacity: 0.75; padding-left: 8px; }
.mo-slip tr.is-final td { font-weight: 700; font-size: 14px; }
.mo-slip-foot { margin: 8px 0 10px; display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
.mo-slip-foot b { font-weight: 700; }
.mo-pb { color: #0b6b33; font-weight: 700; }
.mo-stamp {
  position: absolute;
  top: 46px;
  right: 10px;
  padding: 2px 8px;
  border: 3px solid var(--red);
  border-radius: 6px;
  color: var(--red);
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.08em;
  transform: rotate(-12deg);
  opacity: 0.85;
  pointer-events: none;
}
.mo-slip-actions { display: flex; gap: 8px; justify-content: center; }
.mo-slip-actions .text-btn { border-color: rgba(9, 11, 16, 0.35); color: var(--bg); }

/* Dyno: a sheet over the driving controls (the car is strapped down). */
.mo-scrim { position: absolute; inset: var(--hud-top-h, 120px) 0 0; background: rgba(5, 7, 10, 0.55); pointer-events: none !important; }
.mo-scrim[hidden] { display: none; }
@media (orientation: landscape) { .mo-scrim { display: none; } }
.mo-dyno {
  left: calc(var(--safe-left) + var(--gutter));
  right: calc(var(--safe-right) + var(--gutter));
  bottom: calc(var(--safe-bottom) + 10px);
  max-width: 560px;
  margin-inline: auto;
  max-height: calc(100% - var(--hud-top-h, 120px) - var(--safe-bottom) - 22px);
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
  padding: 12px 14px 14px;
}
.mo-dyno .panel-head { margin-bottom: 8px; }
.mo-dyno .panel-head h2 { margin: 0; font-size: 17px; }
.mo-sub { margin: 0 auto 0 0; font-family: var(--font-data); font-size: 11px; color: var(--muted); }
.mo-dyno-bar { display: flex; align-items: center; gap: 10px; }
.mo-dyno-msg { flex: 1; margin: 0; font-size: 13px; color: var(--muted); line-height: 1.35; min-width: 0; }
.mo-dyno-msg b { color: var(--fg); }
.mo-dyno .primary-btn:disabled { opacity: 0.45; cursor: default; }
.mo-progress { height: 4px; margin: 8px 0 10px; border-radius: 2px; background: var(--raise); overflow: hidden; }
.mo-progress div { height: 100%; width: 0; background: var(--throttle); }
.mo-peaks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 4px; }
.mo-peaks .tile-value { font-size: 20px; }
.mo-peaks .tile-at { display: block; font-family: var(--font-data); font-size: 11px; color: var(--muted); }
.mo-chart { height: 112px; }
.mo-chart-box { min-width: 0; }
.mo-dyno .chart-readout { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.mo-legend { margin: 4px 0 2px; display: flex; justify-content: flex-end; align-items: center; gap: 6px; font-family: var(--font-data); font-size: 11px; color: var(--muted); }
.mo-key { display: inline-block; width: 16px; height: 0; margin-left: 8px; border-top: 2px solid var(--muted); }
.mo-key.is-dash { border-top-style: dashed; }
.mo-note { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.4; }
.mo-runs { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mo-runs li { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 6px 10px; border-radius: 9px; background: var(--raise); font-size: 13px; }
.mo-runs .mo-run-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.mo-runs .mo-run-figs { font-family: var(--font-data); font-size: 12px; }
.mo-runs .mo-run-n { font-weight: 800; }
.mo-runs li.is-latest .mo-run-n { color: var(--throttle); }

/* Telemetry sections. */
.mo-section h3 .mo-tag { margin-left: 6px; font-family: var(--font-data); font-size: 10px; font-weight: 500; color: var(--muted); }
/* Side by side only when the panel itself is wide (a container query, not the viewport). */
.mo-pv { container-type: inline-size; }
.mo-pv-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 14px; }
.mo-chart-pv { height: 112px; }
@container (min-width: 560px) {
  .mo-pv-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .mo-chart-pv { height: 150px; }
}
.mo-ach-list { list-style: none; margin: 4px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.mo-ach-list li { display: grid; grid-template-columns: 22px 1fr; gap: 8px; align-items: start; padding: 7px 9px; border-radius: 9px; background: var(--raise); min-width: 0; }
.mo-ach-list b { display: block; font-size: 13px; font-weight: 700; line-height: 1.2; }
.mo-ach-list span { display: block; font-size: 11px; color: var(--muted); line-height: 1.3; }
.mo-ach-ico svg { width: 20px; height: 20px; stroke: var(--faint); }
.mo-ach-list li:not(.is-on) b { color: var(--muted); }
.mo-ach-list li.is-on { box-shadow: inset 0 0 0 1px rgba(60, 207, 122, 0.35); }
.mo-ach-list li.is-on .mo-ach-ico svg { stroke: var(--good); }

@media (max-height: 500px) {
  /* Landscape phones: the drag card and the slip sit top-centre, between the
     tach and the buttons and clear of the lever and pedals below. */
  .mo-drag { padding: 8px 10px 8px 8px; gap: 9px; }
  .mo-drag-msg { font-size: 14px; }
  .mo-splits span { font-size: 10px; }
  .mo-bulb { width: 14px; height: 14px; }
  .mo-bulb.is-stage { width: 10px; height: 10px; }
  .mo-tree { gap: 4px; padding: 5px 4px; }
  .mo-num output { font-size: 16px; }
  .mo-slip {
    padding: 10px 12px 18px;
    font-size: 11px;
    line-height: 1.35;
  }
  .mo-slip h3 { font-size: 13px; letter-spacing: 0.06em; }
  .mo-slip .mo-slip-sub { margin-bottom: 6px; }
  .mo-slip-foot { flex-direction: column; gap: 0; margin: 6px 0 8px; }
  .mo-stamp { top: 34px; font-size: 15px; }
  .mo-dyno {
    top: calc(var(--safe-top) + 8px);
    bottom: calc(var(--safe-bottom) + 8px);
    left: auto;
    right: calc(var(--safe-right) + var(--gutter));
    width: min(440px, 56%);
    max-height: none;
  }
  .mo-chart { height: 100px; }
  .mo-dyno { padding: 10px 12px 12px; }
  .mo-dyno .panel-head { margin-bottom: 4px; }
  .mo-progress { margin: 6px 0 8px; }
  .mo-peaks .tile { padding: 6px 10px; }
  .mo-peaks .tile-value { font-size: 17px; }
  .mo-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
}
`;

export default {
  id: 'modes',
  install(app) {
    const { bus, sim } = app;
    injectStyles('modes', CSS);

    // ── Achievements ───────────────────────────────────────────────────────
    const achievements = new AchievementTracker(storageFor(KEYS.achievements), { now: () => Date.now() });
    const toastQueue = [];
    let toastCooldown = 0;
    const observed = { dt: 0, kmh: 0, running: false, launchActive: false, layout: layoutOf(app.profile), onRollers: false };
    let lastRecord = app.tracker.records[0] ?? null;

    function flushAchievements() {
      for (const a of achievements.drain()) {
        toastQueue.push(a);
        bus.emit('achievement', { id: a.id, title: a.title });
        achUi.dirty = true;
      }
    }

    // ── Drag strip ─────────────────────────────────────────────────────────
    const race = new DragRace();
    let msgKey = ''; // what the drag card's status line currently says
    const dragRecords = new DragRecords(storageFor(KEYS.drag));
    // Records and dyno runs are per engine: layout, displacement and induction
    // (a 5.0 and a 6.2 V8 of the same layout are different engines).
    const litres = () => (Number.isFinite(app.profile.displacementL) ? app.profile.displacementL.toFixed(1) : '');
    const engineKey = () => {
      const kind = app.profile.induction?.kind ?? 'na';
      const base = litres() ? `${app.profile.id}@${litres()}` : app.profile.id;
      return kind === 'na' ? base : `${base}+${kind}`;
    };
    const engineLabel = () => {
      const kind = app.profile.induction?.kind ?? 'na';
      const ind = { turbo: 'turbo', 'twin-turbo': 'twin-turbo', supercharger: 'supercharged' }[kind];
      return `${app.profile.name}${litres() ? ` ${litres()} L` : ''}${ind ? ` · ${ind}` : ''}`;
    };

    // ── Dyno ───────────────────────────────────────────────────────────────
    const recorder = new DynoRecorder();
    const dyno = {
      open: false,
      phase: 'off', // 'ready' | 'spinup' | 'pull' | 'coast'
      t: 0,
      startRpm: 0,
      endRpm: 0,
      config: null,
      rollerMass: 0,
      snapshot: null,
      runs: loadRuns(),
      lastResult: null,
      dirty: true,
      chartsDirty: true,
      hoverRpm: null,
      msgKey: null,
      barWidth: '',
    };

    function loadRuns() {
      const saved = storageFor(KEYS.dyno).load();
      return Array.isArray(saved) ? saved.filter((r) => r && Array.isArray(r.points)).slice(0, RUNS_KEPT) : [];
    }

    // ── DOM ────────────────────────────────────────────────────────────────
    const overlay = app.ui.overlay;
    const dragUi = buildDragUi();
    const slipUi = buildSlipUi();
    const dynoUi = buildDynoUi();
    const pvUi = buildPvUi();
    const achUi = buildAchievementsUi();
    // Portrait: the dyno sheet covers the driving controls, so dim them behind it.
    const scrim = el('div', { class: 'mo-scrim', hidden: true, 'aria-hidden': 'true' });
    overlay.append(dragUi.root, slipUi.root, scrim, dynoUi.root);
    app.ui.addTelemetrySection(pvUi.root, 60);
    app.ui.addTelemetrySection(achUi.root, 70);

    const dragBtn = app.ui.addToolButton({ id: 'drag', label: 'Drag strip', icon: ICONS.flag, order: 60, onClick: () => (race.active ? exitDrag() : openDrag()) });
    const dynoBtn = app.ui.addToolButton({ id: 'dyno', label: 'Dyno', icon: ICONS.dyno, order: 65, onClick: () => (dyno.open ? closeDyno() : openDyno()) });
    dragBtn.setAttribute('aria-pressed', 'false');
    dynoBtn.setAttribute('aria-pressed', 'false');

    // Cache of text written to the DOM so frames only touch what changed.
    const textCache = new WeakMap();
    const setText = (node, text) => {
      if (textCache.get(node) === text) return;
      textCache.set(node, text);
      node.textContent = text;
    };
    const setClass = (node, cls, on) => {
      if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
    };

    // ── Placement ──────────────────────────────────────────────────────────
    // The drag card and the time slip float over the 3D view. The HUD around
    // them (tach, top-right buttons, tool rail, lever, pedals) is sized by
    // other features at run time, so measure it on layout changes (never per
    // frame) and take the highest spot that clears it: the HUD cards and the
    // driving controls always, the rail buttons too whenever there is room.
    const safeArea = el('div', { class: 'mo-safe', 'aria-hidden': 'true' });
    overlay.append(safeArea);
    const HARD = ['.tach', '.hud-right', '.shifter-wrap', '.pedal-wrap'];
    const CLEAR = 8; // px kept between a card and anything it avoids
    const COMFY_W = 330; // px: wider than this is nice to have, not worth moving down for
    const railEl = app.ui.toolRail ?? document.getElementById('tool-rail');

    function rectsOf(nodes, origin) {
      const out = [];
      for (const node of nodes) {
        if (!node || node.hidden) continue;
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        out.push({ l: r.left - origin.left - CLEAR, r: r.right - origin.left + CLEAR, t: r.top - origin.top - CLEAR, b: r.bottom - origin.top + CLEAR });
      }
      return out;
    }

    /** Widest free span of [l, r] across the band [t, b]. */
    function widestGap(obs, t, b, l, r) {
      const spans = obs.filter((o) => o.t < b && o.b > t).sort((p, q) => p.l - q.l);
      let best = { l: 0, r: 0 };
      let x = l;
      for (const o of spans) {
        if (o.l - x > best.r - best.l) best = { l: x, r: Math.min(o.l, r) };
        x = Math.max(x, o.r);
      }
      if (r - x > best.r - best.l) best = { l: x, r };
      return best;
    }

    /** Highest, widest spot for a w0..w1 × h box (width counts fully up to a comfortable size, moving down costs). */
    function findSpot(area, obs, w0, w1, h) {
      let best = null;
      for (let y = area.t; y + h <= area.b; y += 4) {
        const g = widestGap(obs, y, y + h, area.l, area.r);
        const w = Math.min(w1, g.r - g.l);
        if (w < w0) continue;
        const score = Math.min(w, COMFY_W) + 0.15 * Math.max(0, w - COMFY_W) - 0.4 * (y - area.t);
        if (!best || score > best.score) best = { score, x: g.l + (g.r - g.l - w) / 2, y, w, gl: g.l, gr: g.r };
        if (w >= w1) break;
      }
      return best;
    }

    /** Overlap area of a box with a list of rects. */
    function overlapArea(x, y, w, h, rects) {
      let sum = 0;
      for (const o of rects) sum += Math.max(0, Math.min(x + w, o.r) - Math.max(x, o.l)) * Math.max(0, Math.min(y + h, o.b) - Math.max(y, o.t));
      return sum;
    }

    function placeCard(node, w0, w1, minH) {
      const origin = overlay.getBoundingClientRect();
      const sa = safeArea.getBoundingClientRect();
      const area = { l: sa.left - origin.left, r: sa.right - origin.left, t: sa.top - origin.top, b: sa.bottom - origin.top };
      const maxW = Math.min(w1, area.r - area.l);
      const minW = Math.min(w0, maxW);
      const heightAt = (w) => {
        node.style.width = `${w}px`;
        return node.offsetHeight;
      };
      node.style.maxHeight = 'none';
      const full = heightAt(maxW);
      const hard = rectsOf(HARD.map((sel) => document.querySelector(sel)), origin);
      const rail = railEl ? rectsOf(railEl.children, origin) : [];
      const all = hard.concat(rail);
      // Full height clear of everything, then full height over the rail, then
      // shorter (the card scrolls) in the same order.
      let spot = null;
      let h = full;
      search: for (let hh = full; hh >= Math.min(full, minH); hh -= 30) {
        for (const obs of [all, hard]) {
          let s = findSpot(area, obs, minW, maxW, hh);
          if (s && s.w < maxW && hh === full) {
            const need = heightAt(s.w); // narrower than measured: lines may wrap
            if (need > hh) s = findSpot(area, obs, s.w, s.w, need);
            if (s) hh = Math.max(hh, need);
          }
          if (!s) continue;
          if (obs === hard && rail.length) {
            // Over the rail: slide along the free span to cover as few buttons as possible.
            const xs = [s.gl, s.x, s.gr - s.w];
            s.x = xs.reduce((best, x) => (overlapArea(x, s.y, s.w, hh, rail) < overlapArea(best, s.y, s.w, hh, rail) ? x : best), s.x);
          }
          spot = s;
          h = hh;
          break search;
        }
      }
      if (!spot) spot = { x: area.l, y: area.t, w: maxW }; // nothing clears: top left, scrolling
      node.style.left = `${Math.round(spot.x)}px`;
      node.style.top = `${Math.round(spot.y)}px`;
      node.style.width = `${Math.round(spot.w)}px`;
      node.style.maxHeight = `${Math.round(Math.max(minH, Math.min(h, area.b - spot.y)))}px`;
    }

    // Landscape phones: the dyno sheet runs full height between the tach and
    // lever on the left and the top-right buttons on the right, so mute,
    // telemetry and settings stay reachable (it may cover the pedals: the car
    // is strapped down). It keeps clear of the tool rail too when there is
    // room, else covers rail buttons as the portrait sheet does. Too narrow
    // even then: the CSS right-hand sheet.
    const landscapeQuery = matchMedia('(max-height: 500px)'); // the CSS landscape breakpoint
    const DYNO_MAX_W = 440;
    function placeDyno() {
      const node = dynoUi.root;
      node.style.left = '';
      node.style.right = '';
      node.style.width = '';
      if (!landscapeQuery.matches) return;
      const origin = overlay.getBoundingClientRect();
      const sa = safeArea.getBoundingClientRect();
      let l = sa.left - origin.left;
      for (const o of rectsOf([document.querySelector('.tach'), document.querySelector('.shifter-wrap')], origin)) l = Math.max(l, o.r);
      const rightEdge = (nodes) => {
        let r = sa.right - origin.left;
        for (const o of rectsOf(nodes, origin)) if (o.l > l) r = Math.min(r, o.l);
        return r;
      };
      const hudRight = [document.querySelector('.hud-right')];
      let r = rightEdge(hudRight.concat(railEl ? [...railEl.children] : []));
      if (r - l < 330) r = rightEdge(hudRight);
      if (r - l < 300) return;
      const w = Math.min(DYNO_MAX_W, r - l);
      node.style.left = `${Math.round(r - w)}px`;
      node.style.right = 'auto';
      node.style.width = `${Math.round(w)}px`;
    }

    let placeQueued = 0;
    function placeOverlays() {
      placeQueued = 0;
      if (!dragUi.root.hidden) placeCard(dragUi.root, 250, 420, 120);
      if (!slipUi.root.hidden) placeCard(slipUi.root, 200, 300, 190);
      if (!dynoUi.root.hidden) placeDyno();
    }
    const queuePlacement = () => {
      if (!placeQueued && (!dragUi.root.hidden || !slipUi.root.hidden || !dynoUi.root.hidden)) placeQueued = requestAnimationFrame(placeOverlays);
    };
    // The rail and the HUD cards change size when other features show or hide things.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(queuePlacement);
      for (const node of [railEl, document.querySelector('.tach'), document.querySelector('.hud-bottom'), overlay]) if (node) ro.observe(node);
    }

    function buildDragUi() {
      const bulb = (cls) => el('span', { class: `mo-bulb ${cls}` });
      const bulbs = {
        pre: bulb('is-stage'), stage: bulb('is-stage'),
        ambers: [bulb('is-amber'), bulb('is-amber'), bulb('is-amber')],
        green: bulb('is-green'), red: bulb('is-red'),
      };
      const tree = el('div', { class: 'mo-tree', 'aria-hidden': 'true' }, bulbs.pre, bulbs.stage, bulbs.ambers, bulbs.green, bulbs.red);
      const num = (label) => {
        const out = el('output', { text: '0' });
        const unit = el('span', { text: label });
        return { node: el('div', { class: 'mo-num' }, out, unit), out, unit };
      };
      const et = num('ET s');
      const speed = num('km/h');
      const dist = num('m');
      const fill = el('div', { class: 'mo-track-fill' });
      const track = el('div', { class: 'mo-track', 'aria-hidden': 'true' }, fill,
        DRAG_MARKS.slice(0, -1).map((m) => el('span', { class: 'mo-track-tick', style: { left: `${(m.m / QUARTER_M) * 100}%` } })));
      const splitNodes = DRAG_MARKS.map((m) => {
        const val = el('span', { text: '—' });
        const li = el('li', {}, el('b', { text: m.label }), val);
        return { li, val };
      });
      const msg = el('p', { class: 'mo-drag-msg', role: 'status', 'aria-live': 'polite' });
      const close = el('button', {
        class: 'icon-btn small mo-close', type: 'button', 'aria-label': 'Leave the drag strip', html: ICONS.close,
        on: { click: () => exitDrag() },
      });
      const root = el('section', { class: 'mo-card mo-drag', hidden: true, 'aria-label': 'Drag strip' },
        tree,
        el('div', { class: 'mo-drag-main' },
          el('div', { class: 'mo-drag-head' }, el('p', { class: 'mo-kicker', text: 'Drag strip · ¼ mile' }), close),
          msg,
          el('div', { class: 'mo-drag-nums' }, et.node, speed.node, dist.node),
          track,
          el('ol', { class: 'mo-splits', 'aria-label': 'Splits' }, splitNodes.map((s) => s.li))));
      return { root, bulbs, msg, et, speed, dist, fill, splitNodes, marksShown: -1 };
    }

    function buildSlipUi() {
      const title = el('h3', { text: 'FIRING ORDER DRAGWAY' });
      const sub = el('p', { class: 'mo-slip-sub' });
      const table = el('table');
      const foot = el('div', { class: 'mo-slip-foot' });
      const stamp = el('span', { class: 'mo-stamp', text: 'RED LIGHT', hidden: true });
      const again = el('button', { class: 'primary-btn', type: 'button', text: 'Run again', on: { click: () => armDrag() } });
      const exit = el('button', { class: 'text-btn', type: 'button', text: 'Exit', on: { click: () => exitDrag() } });
      const root = el('section', { class: 'mo-slip scrollable', hidden: true, role: 'dialog', 'aria-label': 'Time slip' },
        title, sub, stamp, table, foot, el('div', { class: 'mo-slip-actions' }, again, exit));
      return { root, sub, table, foot, stamp, again };
    }

    function buildDynoUi() {
      const sub = el('p', { class: 'mo-sub' });
      const close = el('button', {
        class: 'icon-btn small mo-close', type: 'button', 'aria-label': 'Leave the dyno', html: ICONS.close,
        on: { click: () => closeDyno() },
      });
      const msg = el('p', { class: 'mo-dyno-msg', role: 'status', 'aria-live': 'polite' });
      const run = el('button', { class: 'primary-btn', type: 'button', text: 'Run pull', on: { click: () => startPull() } });
      const bar = el('div');
      const tile = (label) => {
        const value = el('output', { class: 'tile-value', text: '—' });
        const unit = el('span', { class: 'tile-unit' });
        const at = el('span', { class: 'tile-at', text: ' ' });
        return { node: el('div', { class: 'tile' }, el('span', { class: 'tile-label', text: label }), value, unit, at), value, unit, at };
      };
      const hp = tile('Peak power');
      const nm = tile('Peak torque');
      hp.unit.textContent = 'hp';
      nm.unit.textContent = 'Nm';
      const head = (title, unit) => {
        const readout = el('p', { class: 'chart-readout' });
        return { node: el('div', { class: 'chart-head' }, el('h3', {}, title, ' ', el('span', { class: 'chart-unit', text: unit })), readout), readout };
      };
      const tHead = head('Torque', 'Nm');
      const pHead = head('Power', 'hp');
      const tCanvas = el('canvas', { class: 'chart mo-chart', 'aria-label': 'Measured and rated torque against engine speed' });
      const pCanvas = el('canvas', { class: 'chart mo-chart', 'aria-label': 'Measured and rated power against engine speed' });
      const legend = el('p', { class: 'mo-legend', 'aria-hidden': 'true' },
        el('span', { class: 'mo-key' }), 'measured', el('span', { class: 'mo-key is-dash' }), 'rated');
      const note = el('p', { class: 'mo-note' });
      const runs = el('ol', { class: 'mo-runs', 'aria-label': 'Last pulls' });
      const root = el('section', { class: 'mo-card panel mo-dyno scrollable', hidden: true, role: 'dialog', 'aria-label': 'Dyno' },
        el('div', { class: 'panel-head' }, el('h2', { text: 'Dyno' }), sub, close),
        el('div', { class: 'mo-dyno-bar' }, msg, run),
        el('div', { class: 'mo-progress', 'aria-hidden': 'true' }, bar),
        el('div', { class: 'mo-peaks' }, hp.node, nm.node),
        legend,
        el('div', { class: 'mo-charts' },
          el('div', { class: 'mo-chart-box' }, tHead.node, tCanvas),
          el('div', { class: 'mo-chart-box' }, pHead.node, pCanvas)),
        note, runs);
      const ui = {
        root, sub, msg, run, bar, hp, nm, tHead, pHead, note, runs,
        torque: new Plot(tCanvas), power: new Plot(pCanvas),
      };
      for (const plot of [ui.torque, ui.power]) {
        const move = (e) => {
          dyno.hoverRpm = plot.xAt(e.clientX, plot.canvas.getBoundingClientRect());
          dyno.chartsDirty = true;
        };
        plot.canvas.addEventListener('pointermove', move);
        plot.canvas.addEventListener('pointerdown', move);
        plot.canvas.addEventListener('pointerleave', () => {
          dyno.hoverRpm = null;
          dyno.chartsDirty = true;
        });
      }
      return ui;
    }

    function buildPvUi() {
      const readout = el('p', { class: 'chart-readout' });
      const now = el('p', { class: 'chart-readout' });
      const pCanvas = el('canvas', { class: 'chart mo-chart-pv', 'aria-label': 'Cylinder 1 pressure against crank angle, with the current crank angle marked' });
      const vCanvas = el('canvas', { class: 'chart mo-chart-pv', 'aria-label': 'Cylinder 1 pressure against volume (log scale), with the current point marked' });
      const root = el('section', { class: 'mo-section mo-pv chart-block', 'aria-label': 'Cylinder pressure' },
        el('div', { class: 'chart-head' }, el('h3', {}, 'Cylinder pressure ', el('span', { class: 'chart-unit', text: 'bar · cyl 1' })), readout),
        el('div', { class: 'mo-pv-row' },
          el('div', {}, pCanvas),
          el('div', {},
            el('div', { class: 'chart-head' }, el('h3', {}, 'P–V loop ', el('span', { class: 'chart-unit', text: 'log bar · cc' })), now),
            vCanvas)));
      return {
        root, readout, now,
        angle: new Plot(pCanvas, { l: 36, r: 10, t: 16, b: 18 }),
        loop: new Plot(vCanvas, { l: 36, r: 10, t: 8, b: 18 }),
        angleBuf: document.createElement('canvas'),
        loopBuf: document.createElement('canvas'),
        cycle: createCycle(),
        op: {},
        geom: null,
        fireDeg: 0,
        clock: PV_RECOMPUTE_S,
        imep: 0,
        yMax: 80,
        staticDirty: true,
        lastIndex: -1,
        piston: true,
        computed: false,
      };
    }

    function buildAchievementsUi() {
      const count = el('p', { class: 'chart-readout' });
      const items = ACHIEVEMENTS.map((a) => {
        const detail = el('span', { text: a.detail });
        const li = el('li', {},
          el('span', { class: 'mo-ach-ico', html: ICONS.trophy, 'aria-hidden': 'true' }),
          el('div', {}, el('b', { text: a.title }), detail));
        return { id: a.id, li, detail, base: a.detail, title: a.title };
      });
      const root = el('section', { class: 'mo-section', 'aria-label': 'Achievements' },
        el('div', { class: 'chart-head' }, el('h3', { text: 'Achievements' }), count),
        el('ul', { class: 'mo-ach-list' }, items.map((i) => i.li)));
      return { root, count, items, dirty: true, layouts: -1, units: null };
    }

    // ── Drag flow ──────────────────────────────────────────────────────────
    function openDrag() {
      if (dyno.open) closeDyno();
      armDrag();
      dragBtn.setAttribute('aria-pressed', 'true');
      dragUi.root.hidden = false;
    }

    function armDrag() {
      race.arm();
      msgKey = '';
      slipUi.root.hidden = true;
      dragUi.root.hidden = false;
      placeOverlays();
    }

    function exitDrag() {
      race.stop();
      dragBtn.setAttribute('aria-pressed', 'false');
      dragUi.root.hidden = true;
      slipUi.root.hidden = true;
    }

    function onDragEvent(e) {
      if (e.type === 'stage') bus.emit('drag:stage', {});
      else if (e.type === 'green') bus.emit('drag:green', {});
      else if (e.type === 'foul') {
        bus.emit('drag:foul', { reaction: e.reaction });
        navigator.vibrate?.([30, 30, 30]);
      } else if (e.type === 'finish') {
        const at = Date.now();
        const improved = dragRecords.record(engineKey(), e.result, { name: engineLabel(), at });
        const result = { ...e.result, engine: engineLabel(), engineKey: engineKey(), units: app.settings.units, at, improved };
        bus.emit('drag:finish', { result });
        showSlip(result);
      } else if (e.type === 'abort') {
        bus.emit('drag:abort', { reason: e.reason });
        app.toast(`${e.reason}. Stage again when ready.`, 'warn', 2600);
        armDrag();
      }
    }

    function showSlip(r) {
      const units = app.settings.units;
      const pb = dragRecords.best(r.engineKey);
      const time = new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      setText(slipUi.sub, `Lane 1 · ${r.engine} · ${time}`);
      const row = (label, value, extra = '', final = false) => el('tr', { class: final ? 'is-final' : null },
        el('td', { text: label }), el('td', { text: value }), el('td', { text: extra }));
      const sp = (kmh) => (kmh == null ? '' : speedFixed(kmh, units));
      slipUi.table.replaceChildren(
        row('R/T', r.reaction.toFixed(3)),
        ...r.splits.map((s, i) => row(DRAG_MARKS[i].label, s.t.toFixed(3), DRAG_MARKS[i].trap ? sp(s.trapKmh) : '', i === r.splits.length - 1)),
      );
      slipUi.stamp.hidden = !r.foul;
      const improvedEt = r.improved?.et;
      slipUi.foot.replaceChildren(
        el('span', {}, 'PB ', el('b', { text: pb?.et != null ? pb.et.toFixed(3) : '—' }), pb?.trapKmh != null ? ` · ${sp(pb.trapKmh)}` : ''),
        r.foul
          ? el('span', { text: 'Red light: not a record' })
          : improvedEt ? el('span', { class: 'mo-pb', text: 'New personal best' }) : el('span', { text: `${r.et.toFixed(3)} s` }),
      );
      slipUi.root.hidden = false;
      dragUi.root.hidden = true;
      placeOverlays();
    }

    // Status line for the drag card, rebuilt only when what it says changes.
    function dragMessage() {
      const p = race.phase;
      let key = p;
      if (p === 'pre') key = sim.blown ? 'blown' : !sim.running ? 'off' : sim.speedKmh > 0.6 ? 'moving' : 'still';
      else if (p === 'run' && race.foul) key = 'foul';
      if (key === msgKey) return;
      msgKey = key;
      let text = '';
      let tone = '';
      if (key === 'blown') [text, tone] = ['Engine blown. Rebuild it to race.', 'is-bad'];
      else if (key === 'off') text = 'Start the engine to stage';
      else if (key === 'moving') text = 'Stop the car to stage';
      else if (key === 'still') text = 'Staging…';
      else if (key === 'staged') text = 'Staged. Watch the tree.';
      else if (key === 'tree') text = 'Go on the green';
      else if (key === 'green') [text, tone] = ['GO!', 'is-go'];
      else if (key === 'foul') [text, tone] = ['Red light. Still timing.', 'is-bad'];
      else if (key === 'run') text = `Reaction ${race.reaction.toFixed(3)} s`;
      else if (key === 'done') [text, tone] = ['Finished', 'is-go'];
      setText(dragUi.msg, text);
      setClass(dragUi.msg, 'is-go', tone === 'is-go');
      setClass(dragUi.msg, 'is-bad', tone === 'is-bad');
    }

    function renderDrag() {
      if (!race.active || dragUi.root.hidden) return;
      const units = app.settings.units;
      const p = race.phase;
      const b = dragUi.bulbs;
      const running = p === 'run' || p === 'done';
      setClass(b.pre, 'is-on', !running && (p !== 'pre' || race.stillFor > 0));
      setClass(b.stage, 'is-on', p === 'staged' || p === 'tree' || p === 'green');
      // Sportsman tree: the ambers light one after another, 0.5 s apart.
      const amber = race.ambers;
      for (let i = 0; i < 3; i++) setClass(b.ambers[i], 'is-on', amber === i + 1);
      setClass(b.green, 'is-on', race.greenLit && (p === 'green' || (running && race.clock - race.greenAt < 2.5)));
      setClass(b.red, 'is-on', race.foul);
      dragMessage();

      setText(dragUi.et.out, (running ? race.et : 0).toFixed(3));
      setText(dragUi.speed.out, String(formatSpeed(running ? race.speedKmh : sim.speedKmh, units)));
      setText(dragUi.speed.unit, speedUnit(units));
      const metres = running ? race.distance : 0;
      setText(dragUi.dist.out, String(Math.round(units === 'mph' ? metres / 0.3048 : metres)));
      setText(dragUi.dist.unit, units === 'mph' ? 'ft' : 'm');
      const w = `${((Math.min(1, metres / QUARTER_M)) * 100).toFixed(1)}%`;
      if (w !== dragUi.fillWidth) {
        dragUi.fillWidth = w;
        dragUi.fill.style.width = w;
      }
      // Splits change only when the car passes a mark (or the strip re-arms).
      if (race.nextMark !== dragUi.marksShown) {
        dragUi.marksShown = race.nextMark;
        for (let i = 0; i < race.splits.length; i++) {
          const t = race.splits[i].t;
          const n = dragUi.splitNodes[i];
          setText(n.val, t === null ? '—' : t.toFixed(2));
          setClass(n.li, 'is-hit', t !== null);
        }
      }
    }

    // ── Dyno flow ──────────────────────────────────────────────────────────
    function openDyno() {
      if (sim.speedKmh > 3) {
        app.toast('Stop the car before driving onto the dyno', 'warn');
        return;
      }
      if (race.active) exitDrag();
      dyno.snapshot = {
        distance: sim.distance,
        topSpeedKmh: app.stats.topSpeedKmh,
        bestZeroToHundred: app.stats.bestZeroToHundred,
        lastZeroToHundred: app.stats.lastZeroToHundred,
      };
      mountRollers();
      dyno.open = true;
      dyno.phase = 'ready';
      dyno.dirty = true;
      dyno.chartsDirty = true;
      dynoBtn.setAttribute('aria-pressed', 'true');
      dynoUi.root.hidden = false;
      scrim.hidden = false;
      placeDyno();
    }

    function mountRollers() {
      const drive = rollerDrive(app.drive, peakFigures(app.profile).nm);
      sim.setDrive(drive);
      dyno.rollerMass = drive.vehicleMass;
      dyno.config = dynoConfig(drive, app.profile);
      dyno.startRpm = pullStartRpm(app.profile);
      dyno.endRpm = pullEndRpm(app.profile);
      putInNeutral();
      app.gearbox.setMode('manual'); // the dyno works the clutch and gear itself
    }

    function putInNeutral() {
      sim.setGear('N');
      sim.v = 0;
      sim.locked = false;
      app.shifter.show?.('N');
    }

    function closeDyno() {
      if (!dyno.open) return;
      dyno.open = false;
      dyno.phase = 'off';
      // Back on the road exactly as before: road drive, neutral, standing still.
      sim.setDrive(app.drive);
      putInNeutral();
      sim.inputOmega = 0;
      app.gearbox.setMode(app.settings.mode);
      const s = dyno.snapshot;
      if (s) {
        sim.distance = s.distance;
        // A session reset on the rollers re-based the trip on roller metres.
        if (app.stats.startDistance != null) app.stats.startDistance = Math.min(app.stats.startDistance, s.distance);
        app.stats.topSpeedKmh = s.topSpeedKmh;
        app.stats.bestZeroToHundred = s.bestZeroToHundred;
        app.stats.lastZeroToHundred = s.lastZeroToHundred;
        app.stats.runStart = null;
      }
      dyno.snapshot = null;
      dynoBtn.setAttribute('aria-pressed', 'false');
      dynoUi.root.hidden = true;
      scrim.hidden = true;
    }

    function startPull() {
      if (!dyno.open || (dyno.phase !== 'ready')) return;
      if (sim.blown) {
        app.toast('The engine is blown. Rebuild it first.', 'bad');
        return;
      }
      if (!sim.running) {
        app.toast('Start the engine first', 'warn');
        return;
      }
      dyno.phase = 'spinup';
      dyno.t = 0;
      dyno.spinFrom = sim.rpm;
      dyno.lastResult = null;
      recorder.reset(dyno.config);
      sim.setGear(DYNO_GEAR);
      holdAt(dyno.spinFrom); // locked to the rollers from the first step: no clutch dump
      app.shifter.show?.(DYNO_GEAR);
      bus.emit('dyno:start', { gear: DYNO_GEAR, startRpm: dyno.startRpm, endRpm: dyno.endRpm });
      dyno.dirty = true;
      dyno.chartsDirty = true;
    }

    function abortPull(reason) {
      dyno.phase = 'coast';
      dyno.dirty = true;
      app.toast(reason, 'warn', 2600);
    }

    function finishPull() {
      const res = recorder.finish({ fromRpm: dyno.startRpm + 150, toRpm: dyno.endRpm });
      dyno.phase = 'coast';
      dyno.dirty = true;
      dyno.chartsDirty = true;
      if (res.points.length < 5) {
        app.toast('The pull was too short to measure. Try again.', 'warn');
        return;
      }
      const run = {
        key: engineKey(),
        name: engineLabel(),
        points: res.points.map((p) => ({ rpm: p.rpm, nm: Math.round(p.nm * 10) / 10 })),
        peakNm: res.peakNm, peakNmRpm: res.peakNmRpm, peakHp: res.peakHp, peakHpRpm: res.peakHpRpm,
        at: Date.now(),
      };
      dyno.lastResult = run;
      dyno.runs.unshift(run);
      dyno.runs.length = Math.min(dyno.runs.length, RUNS_KEPT);
      storageFor(KEYS.dyno).save(dyno.runs);
      bus.emit('dyno:done', { peakHp: res.peakHp, peakNm: res.peakNm, peakHpRpm: res.peakHpRpm, peakNmRpm: res.peakNmRpm });
    }

    /** Hold the engine and rollers at an rpm (the dyno's brake absorbs whatever the engine makes). */
    function holdAt(rpm) {
      const c = dyno.config;
      sim.omega = rpm * RPM_TO_RAD;
      sim.v = (sim.omega / c.ratio) * c.wheelRadius;
      sim.inputOmega = sim.omega;
      sim.locked = true;
    }

    function dynoBeforeStep(input) {
      const ph = dyno.phase;
      if (ph === 'spinup') {
        input.gas = 0.22;
        input.clutch = 0;
        input.brake = 0;
      } else if (ph === 'pull') {
        input.gas = 1;
        input.clutch = 0;
        input.brake = 0;
      } else if (ph === 'coast') {
        input.gas = 0;
        input.clutch = 1;
        input.brake = 1;
      } else {
        input.clutch = 1; // in neutral on the rollers: only the throttle does anything
        input.brake = 1;
      }
    }

    function dynoAfterStep(dt) {
      const ph = dyno.phase;
      if (ph === 'spinup') {
        dyno.t += dt;
        if (sim.blown || !sim.running) {
          abortPull('The engine stopped. Pull aborted.');
          return;
        }
        holdAt(dyno.spinFrom + (dyno.startRpm - dyno.spinFrom) * smooth01(dyno.t / SPINUP_S));
        if (dyno.t >= SPINUP_S + HOLD_S) {
          dyno.phase = 'pull';
          dyno.t = 0;
          dyno.dirty = true;
        }
      } else if (ph === 'pull') {
        dyno.t += dt;
        recorder.push(sim.time, sim.v, sim.rpm);
        if (sim.blown || !sim.running) abortPull('The engine stopped. Pull aborted.');
        else if (sim.rpm >= dyno.endRpm || sim.fuelCut || dyno.t > PULL_MAX_S) finishPull();
      } else if (ph === 'coast') {
        if (Math.abs(sim.v) < 0.25) {
          putInNeutral();
          dyno.phase = 'ready';
          dyno.dirty = true;
        }
      }
    }

    function renderDyno() {
      if (!dyno.open) return;
      const ph = dyno.phase;
      if (dyno.dirty) {
        dyno.dirty = false;
        dyno.msgKey = null;
        const busy = ph !== 'ready';
        dynoUi.run.disabled = busy;
        setText(dynoUi.run, dyno.runs.length ? 'Run again' : 'Run pull');
        setText(dynoUi.sub, `${DYNO_GEAR}th gear · rollers ${fmtInt(dyno.rollerMass)} kg`);
        const turbo = app.profile.induction?.kind === 'turbo' || app.profile.induction?.kind === 'twin-turbo';
        setText(dynoUi.note, `Rated is the engine's spec curve. The rollers read what reaches the crank after friction, so measured sits under it, further at high rpm where friction climbs${turbo ? ', and a turbo reads low until it spools' : ''}.`);
        renderRuns();
        const latest = currentRuns()[0] ?? null;
        setText(dynoUi.hp.value, latest ? fmtInt(latest.peakHp) : '—');
        setText(dynoUi.hp.at, latest ? `@ ${fmtRpm(latest.peakHpRpm)} rpm` : ' ');
        setText(dynoUi.nm.value, latest ? fmtInt(latest.peakNm) : '—');
        setText(dynoUi.nm.at, latest ? `@ ${fmtRpm(latest.peakNmRpm)} rpm` : ' ');
      }
      // Status line: rebuilt only when what it says changes.
      const key = ph === 'ready' ? (sim.blown ? -3 : sim.running ? -2 : -1) : ph === 'pull' ? Math.round(sim.rpm / 50) : ph === 'spinup' ? -4 : -5;
      if (key !== dyno.msgKey) {
        dyno.msgKey = key;
        let msg;
        if (key === -3) msg = 'The engine is blown. Rebuild it to run a pull.';
        else if (key === -2) msg = `Ready. Full throttle in ${DYNO_GEAR}th from ${fmtRpm(dyno.startRpm)} to ${fmtRpm(dyno.endRpm)} rpm.`;
        else if (key === -1) msg = 'Start the engine to run a pull.';
        else if (key === -4) msg = `Rollers bringing it to ${fmtRpm(dyno.startRpm)} rpm…`;
        else if (key === -5) msg = 'Braking the rollers…';
        else msg = `Pulling · ${fmtRpm(sim.rpm)} rpm`;
        setText(dynoUi.msg, msg);
      }
      const prog = ph === 'pull' ? (sim.rpm - dyno.startRpm) / (dyno.endRpm - dyno.startRpm) : ph === 'coast' || (ph === 'ready' && dyno.lastResult) ? 1 : 0;
      const w = `${(Math.max(0, Math.min(1, prog)) * 100).toFixed(1)}%`;
      if (w !== dyno.barWidth) {
        dyno.barWidth = w;
        dynoUi.bar.style.width = w;
      }

      if (ph === 'pull' && recorder.updateLive(dyno.startRpm + 150)) dyno.chartsDirty = true;
      if (dyno.chartsDirty || dynoUi.torque.sizeDirty || dynoUi.power.sizeDirty) {
        const a = drawDynoChart(dynoUi.torque, 'torque');
        const b = drawDynoChart(dynoUi.power, 'power');
        if (a && b) dyno.chartsDirty = false;
        renderDynoReadouts();
      }
    }

    const currentRuns = () => dyno.runs.filter((r) => r.key === engineKey());

    function renderRuns() {
      const items = dyno.runs.map((r, i) => el('li', { class: i === 0 ? 'is-latest' : null },
        el('span', { class: 'mo-run-n', text: `#${dyno.runs.length - i}` }),
        el('span', { class: 'mo-run-name', text: r.name }),
        el('span', { class: 'mo-run-figs', text: `${fmtInt(r.peakHp)} hp · ${fmtInt(r.peakNm)} Nm` })));
      dynoUi.runs.replaceChildren(...items);
      dynoUi.runs.hidden = !items.length;
    }

    function curveAt(points, rpm) {
      if (!points.length || rpm < points[0].rpm || rpm > points[points.length - 1].rpm) return null;
      for (let i = 1; i < points.length; i++) {
        if (rpm <= points[i].rpm) {
          const a = points[i - 1];
          const b = points[i];
          return a.nm + ((b.nm - a.nm) * (rpm - a.rpm)) / (b.rpm - a.rpm || 1);
        }
      }
      return null;
    }

    function renderDynoReadouts() {
      const rpm = dyno.hoverRpm;
      const p = app.profile;
      if (rpm !== null && rpm >= 500 && rpm <= p.redlineRpm) {
        const r = Math.round(rpm / 50) * 50;
        const run = currentRuns()[0];
        const nm = run ? curveAt(run.points, r) : null;
        const rated = wotTorque(p, r);
        setText(dynoUi.tHead.readout, `${fmtRpm(r)} rpm · ${nm === null ? '—' : fmtInt(nm)} Nm · rated ${fmtInt(rated)}`);
        setText(dynoUi.pHead.readout, `${fmtRpm(r)} rpm · ${nm === null ? '—' : fmtInt(hpFrom(nm, r))} hp · rated ${fmtInt(powerHp(rated, r))}`);
      } else if (dyno.phase === 'pull' && recorder.liveN) {
        const i = recorder.liveN - 1;
        const r = recorder.liveRpm[i];
        const nm = recorder.liveNm[i];
        setText(dynoUi.tHead.readout, `${fmtInt(nm)} Nm now`);
        setText(dynoUi.pHead.readout, `${fmtInt(hpFrom(nm, r))} hp now`);
      } else {
        setText(dynoUi.tHead.readout, '');
        setText(dynoUi.pHead.readout, '');
      }
    }

    function drawDynoChart(plot, kind) {
      if (!plot.fit()) return false;
      const p = app.profile;
      const color = token(kind === 'torque' ? '--series-torque' : '--series-power');
      const valueOf = kind === 'torque' ? (nm) => nm : (nm, rpm) => hpFrom(nm, rpm);
      const x0 = Math.max(0, Math.floor((dyno.startRpm - 500) / 1000) * 1000);
      const x1 = Math.ceil(p.redlineRpm / 1000) * 1000;
      const runs = currentRuns();
      let yMax = 0;
      for (let rpm = x0 || 500; rpm <= p.redlineRpm; rpm += 100) yMax = Math.max(yMax, valueOf(wotTorque(p, rpm), rpm));
      for (const r of runs) for (const pt of r.points) yMax = Math.max(yMax, valueOf(pt.nm, pt.rpm));
      for (let i = 0; i < recorder.liveN; i++) yMax = Math.max(yMax, valueOf(recorder.liveNm[i], recorder.liveRpm[i]));
      const step = niceStep(yMax * 1.1, 4);
      const top = Math.ceil((yMax * 1.08) / step) * step;
      plot.setRange(x0, x1, 0, top);
      const ctx = plot.begin();
      const xTicks = [];
      // 1k ticks while the labels have room (~28 px each), else 2k.
      const xStep = ((plot.w - plot.pad.l - plot.pad.r) * 1000) / (x1 - x0) < 28 ? 2000 : 1000;
      for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1; v += xStep) xTicks.push({ v, label: `${v / 1000}k` });
      const yTicks = [];
      for (let v = 0; v <= top + 1e-6; v += step) yTicks.push(v);
      plot.axes(ctx, xTicks, yTicks, (v) => String(Math.round(v)));
      plot.vline(ctx, p.redlineRpm, token('--red'), 0.6);

      // Rated curve, dashed.
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let first = true;
      for (let rpm = Math.max(x0, 800); rpm <= p.redlineRpm; rpm += 50) {
        const x = plot.x(rpm);
        const y = plot.y(valueOf(wotTorque(p, rpm), rpm));
        if (first) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        first = false;
      }
      ctx.stroke();
      ctx.restore();

      const line = (pts, alpha, width) => {
        if (pts.length < 2) return;
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((pt, i) => (i ? ctx.lineTo(plot.x(pt.rpm), plot.y(valueOf(pt.nm, pt.rpm))) : ctx.moveTo(plot.x(pt.rpm), plot.y(valueOf(pt.nm, pt.rpm)))));
        ctx.stroke();
        ctx.globalAlpha = 1;
      };
      const pulling = dyno.phase === 'spinup' || dyno.phase === 'pull';
      // Older pulls of this engine, faded; the newest solid (or the live trace mid-pull).
      runs.forEach((r, i) => {
        if (pulling || i > 0) line(r.points, 0.3, 1.5);
      });
      if (pulling) {
        if (recorder.liveN > 1) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.2;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          for (let i = 0; i < recorder.liveN; i++) {
            const x = plot.x(recorder.liveRpm[i]);
            const y = plot.y(valueOf(recorder.liveNm[i], recorder.liveRpm[i]));
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          ctx.stroke();
          const i = recorder.liveN - 1;
          plot.dot(ctx, recorder.liveRpm[i], valueOf(recorder.liveNm[i], recorder.liveRpm[i]), color);
        }
      } else if (runs[0]) {
        line(runs[0].points, 1, 2.2);
        const peakRpm = kind === 'torque' ? runs[0].peakNmRpm : runs[0].peakHpRpm;
        const peakNm = curveAt(runs[0].points, peakRpm) ?? (kind === 'torque' ? runs[0].peakNm : 0);
        plot.dot(ctx, peakRpm, valueOf(peakNm, peakRpm), color);
      }
      if (dyno.hoverRpm !== null && dyno.hoverRpm >= x0 && dyno.hoverRpm <= x1) plot.vline(ctx, dyno.hoverRpm, token('--fg'), 0.35);
      return true;
    }

    // ── Cylinder pressure ─────────────────────────────────────────────────
    function setPvProfile(profile) {
      pvUi.piston = profile.kind !== 'rotary';
      pvUi.root.hidden = !pvUi.piston;
      if (!pvUi.piston) return;
      pvUi.geom = pvGeometry(profile);
      const c1 = profile.cylinders.find((c) => c.num === 1) ?? profile.cylinders[0];
      pvUi.fireDeg = c1?.fireDeg ?? 0;
      pvUi.clock = PV_RECOMPUTE_S;
      pvUi.imep = 0;
      pvUi.computed = false;
      pvUi.staticDirty = true;
    }

    const STROKES = ['Intake', 'Compression', 'Power', 'Exhaust'];
    const strokeAt = (deg) => STROKES[Math.min(3, Math.floor((deg + 360) / 180))];

    /** Recompute the cycle from the simulator now. k: how far the smoothed heat input follows (0..1). */
    function refreshPressure(k = 1) {
      if (!pvUi.piston) return null;
      pvUi.clock = 0;
      pvUi.computed = true;
      const op = operatingPoint(sim, app.profile, pvUi.op);
      // Smooth the heat input so limiter cuts and shifts read as a trend.
      pvUi.imep += (op.imepTarget - pvUi.imep) * k;
      op.imepTarget = pvUi.imep;
      const c = computeCycle(pvUi.geom, op, pvUi.cycle);
      const peak = Math.max(c.peakBar, 10);
      if (peak > pvUi.yMax * 0.95 || peak < pvUi.yMax * 0.45) pvUi.yMax = Math.max(20, Math.ceil((peak * 1.25) / 10) * 10);
      pvUi.staticDirty = true;
      setText(pvUi.readout, `IMEP ${c.imep.toFixed(1)} bar · peak ${Math.round(c.peakBar)} bar @ ${c.peakDeg > 0 ? `${c.peakDeg}° ATDC` : 'TDC'}`);
      return c;
    }

    function updatePv(dt) {
      if (!pvUi.piston || !app.telemetry?.isOpen) return;
      pvUi.clock += dt;
      // A frozen or scrubbed crank holds the last cycle still for inspection.
      const held = app.viewState.frozen || app.viewState.scrubDeg !== null;
      if (!pvUi.computed || (!held && pvUi.clock >= PV_RECOMPUTE_S)) refreshPressure(Math.min(1, pvUi.clock / 0.25));
      const resized = pvUi.angle.sizeDirty || pvUi.loop.sizeDirty;
      if (!pvUi.angle.fit() || !pvUi.loop.fit()) return;
      if (pvUi.staticDirty || resized) {
        pvUi.staticDirty = false;
        drawPvStatic();
        pvUi.lastIndex = -1;
      }
      const local = app.viewState.crankDeg - pvUi.fireDeg;
      const idx = cycleIndex(local);
      if (idx === pvUi.lastIndex) return;
      pvUi.lastIndex = idx;
      drawPvMarker(idx);
    }

    function prepBuffer(buf, plot) {
      if (buf.width !== plot.canvas.width || buf.height !== plot.canvas.height) {
        buf.width = plot.canvas.width;
        buf.height = plot.canvas.height;
      }
      return buf.getContext('2d');
    }

    function drawPvStatic() {
      const c = pvUi.cycle;
      const yMax = pvUi.yMax;
      const heat = token('--throttle');
      const muted = token('--muted');

      // Pressure against crank angle.
      const A = pvUi.angle;
      A.setRange(-360, 360, 0, yMax);
      let ctx = prepBuffer(pvUi.angleBuf, A);
      A.begin(ctx);
      const step = niceStep(yMax, 4);
      const yTicks = [];
      for (let v = 0; v <= yMax + 1e-6; v += step) yTicks.push(v);
      A.axes(ctx, [
        { v: -360, label: 'TDC' }, { v: -180, label: 'BDC' }, { v: 0, label: 'TDC' }, { v: 180, label: 'BDC' }, { v: 360, label: 'TDC' },
      ], yTicks);
      ctx.fillStyle = token('--faint');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `9px ${token('--font-data')}`;
      ['intake', 'compression', 'power', 'exhaust'].forEach((s, i) => ctx.fillText(s, A.x(-270 + i * 180), 2));
      for (const v of [-180, 0, 180]) A.vline(ctx, v, token('--line'), 1);
      // Motoring trace for reference, then the firing trace.
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < PV_POINTS; i += 2) {
        const x = A.x(c.deg[i]);
        const y = A.y(Math.min(c.pMotored[i], yMax));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = heat;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < PV_POINTS; i++) {
        const x = A.x(c.deg[i]);
        const y = A.y(Math.min(c.p[i], yMax));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();

      // P–V loop, log pressure.
      const L = pvUi.loop;
      const vMaxCc = c.vMax * 1e6;
      const xStep = niceStep(vMaxCc, 4);
      const xTop = Math.ceil((vMaxCc * 1.04) / xStep) * xStep;
      L.setRange(0, xTop, 0.2, yMax * 1.3, true);
      ctx = prepBuffer(pvUi.loopBuf, L);
      L.begin(ctx);
      const xTicks = [];
      for (let v = 0; v <= xTop + 1e-6; v += xStep) xTicks.push({ v, label: String(Math.round(v)) });
      L.axes(ctx, xTicks, [0.2, 1, 5, 20, 100].filter((v) => v <= yMax * 1.3), (v) => (v < 1 ? String(v).replace('0.', '.') : String(v)));
      ctx.beginPath();
      for (let i = 0; i < PV_POINTS; i++) {
        const x = L.x(c.v[i] * 1e6);
        const y = L.y(c.p[i]);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = heat;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = heat;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    function drawPvMarker(idx) {
      const c = pvUi.cycle;
      const fg = token('--fg');
      const deg = c.deg[idx];
      const p = c.p[idx];
      const A = pvUi.angle;
      let ctx = A.begin();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(pvUi.angleBuf, 0, 0);
      ctx.setTransform(A.dpr, 0, 0, A.dpr, 0, 0);
      A.vline(ctx, deg, fg, 0.4);
      A.dot(ctx, deg, Math.min(p, pvUi.yMax), fg);
      const L = pvUi.loop;
      ctx = L.begin();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(pvUi.loopBuf, 0, 0);
      ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
      L.dot(ctx, c.v[idx] * 1e6, p, fg);
      setText(pvUi.now, `${strokeAt(deg)} · ${p < 10 ? p.toFixed(1) : Math.round(p)} bar`);
    }

    // ── Achievements UI ────────────────────────────────────────────────────
    function renderAchievements() {
      if (achUi.layouts !== achievements.layouts.length || achUi.units !== app.settings.units) achUi.dirty = true;
      if (!achUi.dirty) return;
      achUi.dirty = false;
      achUi.layouts = achievements.layouts.length;
      achUi.units = app.settings.units;
      setText(achUi.count, `${achievements.count} / ${achievements.total}`);
      for (const item of achUi.items) {
        const on = achievements.has(item.id);
        setClass(item.li, 'is-on', on);
        // Speeds in the user's units; the collector shows what is still missing.
        let detail = item.base;
        const kmh = SPEED_ACHIEVEMENTS[item.id];
        if (kmh) {
          const mph = Math.round(kmh * KMH_TO_MPH);
          detail = app.settings.units === 'mph' ? `Reach ${mph} mph (${kmh} km/h).` : `Reach ${kmh} km/h (${mph} mph).`;
        } else if (item.id === 'all-layouts') {
          const missing = achievements.missingLayouts();
          if (!on && missing.length < 5) detail = `${item.base} Still to drive: ${missing.join(', ')}.`;
        }
        setText(item.detail, detail);
        // The label replaces the item's text for screen readers, so it carries the title too.
        item.li.setAttribute('aria-label', `${on ? 'Unlocked' : 'Locked'}: ${item.title}. ${detail}`);
      }
    }

    // ── Wiring ─────────────────────────────────────────────────────────────
    setPvProfile(app.profile);

    bus.on('*', (type, payload) => {
      if (type === 'achievement') return;
      achievements.handleEvent(type, payload);
    });
    bus.on('profile', ({ profile }) => {
      observed.layout = layoutOf(profile);
      setPvProfile(profile);
      if (dyno.open) {
        // A different engine (or gearing) on the rollers: re-strap it.
        const wasBusy = dyno.phase !== 'ready';
        mountRollers();
        dyno.phase = 'ready';
        dyno.lastResult = null;
        dyno.dirty = true;
        dyno.chartsDirty = true;
        if (wasBusy) app.toast('Engine changed: pull cancelled', 'warn');
      }
      if (race.active && race.phase !== 'pre' && race.phase !== 'done') {
        armDrag();
        app.toast('Engine changed: stage again', 'warn');
      }
    });
    bus.on('settings', ({ kind }) => {
      if (dyno.open && (kind === 'mode' || kind === 'all')) app.gearbox.setMode('manual');
    });
    bus.on('layout', queuePlacement);
    bus.on('escape', () => {
      if (dyno.open) closeDyno();
      else if (race.active) exitDrag();
    });
    bus.on('session-reset', () => {
      lastRecord = null;
      const snap = dyno.snapshot;
      if (snap) {
        // Reset while on the rollers: the road figures restored on exit start fresh too.
        snap.topSpeedKmh = 0;
        snap.bestZeroToHundred = null;
        snap.lastZeroToHundred = null;
      }
    });

    // Gear changes belong to the dyno while the car is on the rollers.
    for (const name of ['selectGear', 'shiftUp', 'shiftDown']) {
      const original = app.actions[name];
      if (typeof original !== 'function') continue;
      app.actions[name] = (...args) => {
        if (dyno.open) {
          app.toast('Leave the dyno to change gear', 'warn');
          app.shifter.show?.(sim.gear);
          return { ok: false, reason: 'Leave the dyno to change gear' };
        }
        return original(...args);
      };
    }

    app.actions.openDrag = openDrag;
    app.actions.exitDrag = exitDrag;
    app.actions.openDyno = openDyno;
    app.actions.closeDyno = closeDyno;
    app.actions.runDynoPull = startPull;
    app.actions.refreshPressure = refreshPressure;
    app.modes = { race, dragRecords, dyno, recorder, achievements, pv: pvUi };

    return {
      beforeStep(dt, a) {
        if (dyno.open) dynoBeforeStep(a.input);
      },
      afterStep(dt) {
        if (dyno.open) dynoAfterStep(dt);
        if (race.active) {
          race.step(dt, sim.v, sim.running); // forward travel only: reversing never runs the strip
          for (const e of race.drainEvents()) onDragEvent(e);
        }
        // Finished shift records, oldest first.
        const recs = app.tracker.records;
        if (recs[0] !== lastRecord) {
          let i = 0;
          while (i < recs.length && recs[i] !== lastRecord) i++;
          for (let k = i - 1; k >= 0; k--) achievements.handleShift(recs[k]);
          lastRecord = recs[0] ?? null;
        }
        observed.dt = dt;
        observed.kmh = sim.speedKmh;
        observed.running = sim.running;
        observed.launchActive = sim.launchActive;
        observed.onRollers = dyno.open;
        achievements.observe(observed);
        flushAchievements();
      },
      frame(dt) {
        renderDrag();
        renderDyno();
        updatePv(dt);
        renderAchievements();
        toastCooldown -= dt;
        if (toastQueue.length && toastCooldown <= 0) {
          const a = toastQueue.shift();
          app.toast(`Achievement: ${a.title}`, 'good', 2400);
          toastCooldown = TOAST_GAP_S;
        }
      },
    };
  },
};

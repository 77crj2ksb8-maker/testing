// Settings sheet, garage sheet and telemetry panel (stat tiles, torque/power
// charts, shift log).

import { PRESETS, PRESET_ORDER, GEAR_RATIO_PRESETS, DEFAULT_SETTINGS, wotTorque, powerHp, firingOrderLabel } from './config.js';
import { formatSpeed, speedUnit } from './dom.js';
import { cylinderLabel, groupThousands } from './hud.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const KM_TO_MI = 0.621371;

export const VISUAL_SPEEDS = [
  { value: 1, label: 'Real time' },
  { value: 1 / 5, label: '1/5' },
  { value: 1 / 10, label: '1/10' },
  { value: 1 / 25, label: '1/25' },
  { value: 1 / 100, label: '1/100' },
];

const INDUCTION_NOTES = {
  na: 'Natural aspiration: instant throttle response, no boost.',
  turbo: 'One turbo: lag below about a third of the redline, then a surge. Blow-off valve on lift.',
  'twin-turbo': 'Two smaller turbos spool sooner, with less lag.',
  supercharger: 'Belt-driven: boost rises with rpm, no lag, some drive loss.',
};

const MODE_NOTES = {
  manual: 'H-pattern: you work the clutch and drag the lever through the gate.',
  sequential: 'Sequential: tap the paddles (or E / Q). Flat-shift upshifts, automated clutch.',
  auto: 'Automatic shifts up near the redline and down around 2,000 rpm. The clutch is automated.',
};

function chips(container, items, selected, onPick) {
  container.replaceChildren(
    ...items.map(({ value, label }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(value === selected));
      b.textContent = label;
      b.addEventListener('click', () => onPick(value));
      return b;
    }),
  );
}

/** Default high-cam switch point for an engine: about two thirds of the redline. */
export function defaultVvlRpm(profile) {
  const lo = profile.idleRpm + 1000;
  const hi = profile.redlineRpm - 200;
  return clamp(Math.round((profile.redlineRpm * 0.66) / 100) * 100, lo, hi);
}

/**
 * Settings patch for picking a layout (preset chip) by hand, or a cylinder
 * count while a garage build is fitted. The new engine starts from its own
 * defaults: displacement, redline, bore/stroke, idle and cam switching reset
 * and the garage build is no longer fitted. Forced induction the user chose
 * in its own section stays; a garage build's turbo or blower leaves with it.
 */
export function layoutPatch(settings, preset, cylinders) {
  const patch = {
    preset, cylinders, redlineRpm: null, displacementL: null, vvlRpm: null, garage: null,
    boreStroke: DEFAULT_SETTINGS.boreStroke, idleRpm: DEFAULT_SETTINGS.idleRpm,
  };
  if (settings.garage) Object.assign(patch, { induction: DEFAULT_SETTINGS.induction, boostBar: DEFAULT_SETTINGS.boostBar });
  return patch;
}

/** Settings patch for a cylinder chip: a hand-built engine keeps its tuning, a garage build starts over. */
export function cylinderPatch(settings, cylinders) {
  return settings.garage ? layoutPatch(settings, settings.preset, cylinders) : { cylinders, redlineRpm: null, displacementL: null, garage: null };
}

/** Displacement slider range (litres) for a layout: the per-cylinder limits the profile builder accepts. */
export function displacementRange(profile) {
  const n = profile.kind === 'rotary' ? profile.rotors : profile.cylinders.length;
  const [lo, hi] = profile.kind === 'rotary' ? [0.3, 1.0] : [0.12, 1.0];
  return { min: Math.ceil(n * lo * 10) / 10, max: Math.floor(n * hi * 10) / 10 };
}

export class SettingsPanel {
  constructor(onChange) {
    this.onChange = onChange;
    this.backdrop = $('settings');
    this.sheet = this.backdrop.querySelector('.sheet');
    this.dragging = null;
    this.inputs = {
      idle: $('opt-idle'),
      redline: $('opt-redline'),
      bore: $('opt-bore'),
      displacement: $('opt-displacement'),
      vvlRpm: $('opt-vvl-rpm'),
      boost: $('opt-boost'),
      launchRpm: $('opt-launch-rpm'),
      ratios: [...document.querySelectorAll('.ratio-grid input[data-gear]')],
      fd: $('opt-fd'),
      tire: $('opt-tire'),
    };
    const { idle, redline, bore, displacement, vvlRpm, boost, launchRpm } = this.inputs;
    this.range(idle, 'opt-idle-out', String, (v) => ({ idleRpm: v }), 'engine');
    this.range(redline, 'opt-redline-out', String, (v) => ({ redlineRpm: v }), 'engine');
    // These two rebuild the 3D model, so a drag applies at most a few times a second.
    this.range(bore, 'opt-bore-out', (v) => v.toFixed(2), (v) => ({ boreStroke: v }), 'engine', 160);
    this.range(displacement, 'opt-displacement-out', (v) => v.toFixed(1), (v) => ({ displacementL: v }), 'engine', 160);
    this.range(vvlRpm, 'opt-vvl-rpm-out', String, (v) => ({ vvlRpm: v }), 'engine');
    this.range(boost, 'opt-boost-out', (v) => v.toFixed(2), (v) => ({ boostBar: v }), 'engine');
    this.range(launchRpm, 'opt-launch-rpm-out', String, (v) => ({ launchRpm: v }), 'assist');

    for (const input of this.inputs.ratios) {
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (!(v >= 0.4 && v <= 6)) return this.render(this.settings, this.profile, this.drivetrain);
        if (input.dataset.gear === 'R') this.emit({ reverseRatio: v }, 'drive');
        else {
          const gearRatios = [...this.settings.gearRatios];
          gearRatios[Number(input.dataset.gear)] = v;
          this.emit({ gearRatios }, 'drive');
        }
      });
    }
    this.inputs.fd.addEventListener('change', () => {
      const v = Number(this.inputs.fd.value);
      if (v >= 1.5 && v <= 6) this.emit({ finalDrive: v }, 'drive');
      else this.render(this.settings, this.profile, this.drivetrain);
    });
    this.inputs.tire.addEventListener('change', () => {
      const v = Number(this.inputs.tire.value);
      if (v >= 40 && v <= 100) this.emit({ tireDiameter: v / 100 }, 'drive');
      else this.render(this.settings, this.profile, this.drivetrain);
    });

    // Switches.
    this.switches = {
      autoBlip: [$('opt-autoblip'), 'assist'],
      launchControl: [$('opt-launch'), 'assist'],
      tractionControl: [$('opt-tc'), 'assist'],
      strokeGases: [$('opt-strokes'), 'view'],
      valvetrain: [$('opt-valvetrain'), 'view'],
      xray: [$('opt-xray'), 'view'],
      cutaway: [$('opt-cutaway'), 'view'],
    };
    for (const [key, [btn, kind]] of Object.entries(this.switches)) {
      btn.addEventListener('click', () => this.emit({ [key]: !this.settings[key] }, kind));
    }
    $('opt-vvl').addEventListener('click', () => {
      this.emit({ vvlRpm: this.profile.vvlRpm ? null : defaultVvlRpm(this.profile) }, 'engine');
    });

    // Fixed chip groups.
    this.choices = {
      induction: [$('opt-induction'), 'engine'],
      mode: [$('opt-mode'), 'mode'],
      cluster: [$('opt-cluster'), 'hud'],
      units: [$('opt-units'), 'hud'],
      quality: [$('opt-quality'), 'view'],
    };
    for (const [key, [group, kind]] of Object.entries(this.choices)) {
      for (const b of group.querySelectorAll('.chip')) b.addEventListener('click', () => this.emit({ [key]: b.dataset.value }, kind));
    }

    // Section shortcuts scroll the sheet; the chip for the section in view lights up.
    this.navChips = [...this.backdrop.querySelectorAll('.nav-chip')];
    for (const chip of this.navChips) {
      chip.addEventListener('click', () => {
        const target = $(chip.dataset.target);
        if (target) this.sheet.scrollTo({ top: this.sectionTop(target) - 8, behavior: 'smooth' });
      });
    }
    this.sheet.addEventListener('scroll', () => this.markSection(), { passive: true });

    $('opt-garage').addEventListener('click', () => this.onGarage?.());
    this.backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }

  /** Bind a range input: live label on input, apply immediately or throttled (ms), and on release. */
  range(input, outId, format, toPatch, kind, throttle = 0) {
    const out = $(outId);
    let timer = 0;
    const push = () => {
      timer = 0;
      this.emit(toPatch(Number(input.value)), kind);
    };
    input.addEventListener('pointerdown', () => (this.dragging = input));
    input.addEventListener('pointerup', () => (this.dragging = null));
    input.addEventListener('input', () => {
      out.textContent = format(Number(input.value));
      if (!throttle) push();
      else if (!timer) timer = setTimeout(push, throttle);
    });
    input.addEventListener('change', () => {
      this.dragging = null;
      if (!throttle) return;
      clearTimeout(timer);
      push();
    });
  }

  /** Set a slider without fighting a thumb that is being dragged. */
  setRange(input, outId, value, text) {
    if (this.dragging !== input) input.value = value;
    if (this.dragging !== input) $(outId).textContent = text;
  }

  /** Scroll offset that puts a section just under the sticky sheet header. */
  sectionTop(section) {
    const header = this.backdrop.querySelector('.sheet-top');
    const sheetTop = this.sheet.getBoundingClientRect().top;
    return section.getBoundingClientRect().top - sheetTop + this.sheet.scrollTop - (header?.offsetHeight ?? 0);
  }

  markSection() {
    if (this.backdrop.hidden) return;
    const atEnd = this.sheet.scrollTop + this.sheet.clientHeight >= this.sheet.scrollHeight - 4;
    let active = this.navChips[0];
    for (const chip of this.navChips) {
      const sec = $(chip.dataset.target);
      if (sec && (atEnd || this.sectionTop(sec) <= this.sheet.scrollTop + 40)) active = chip;
    }
    if (active === this.activeChip) return;
    this.activeChip = active;
    for (const chip of this.navChips) chip.classList.toggle('is-active', chip === active);
  }

  emit(patch, kind) {
    // Any hand edit to the engine means it is no longer the garage build as listed.
    if (kind === 'engine' && !('garage' in patch)) patch = { ...patch, garage: null };
    this.onChange(patch, kind);
  }

  get isOpen() {
    return !this.backdrop.hidden;
  }

  open() {
    this.backdrop.hidden = false;
    $('btn-settings').setAttribute('aria-expanded', 'true');
    this.markSection();
  }

  close() {
    this.backdrop.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
  }

  render(settings, profile, drivetrain) {
    this.settings = settings;
    this.profile = profile;
    if (drivetrain) this.drivetrain = drivetrain;
    const units = settings.units;

    // Garage shortcut.
    const fitted = this.garageName?.(settings) ?? '';
    $('opt-garage-note').textContent = fitted ? `Loaded: ${fitted}` : 'Ready-made engine builds';

    // Engine.
    chips($('opt-preset'), PRESET_ORDER.map((id) => ({ value: id, label: PRESETS[id].label })), settings.preset, (id) => {
      this.emit(layoutPatch(this.settings, id, PRESETS[id].count), 'engine');
    });
    $('opt-preset-note').textContent = `${profile.name} · ${profile.layoutNote} · firing ${firingOrderLabel(profile)}`;

    const def = PRESETS[settings.preset] ?? PRESETS['v8-cross'];
    const count = profile.kind === 'rotary' ? profile.rotors : profile.cylinders.length;
    chips($('opt-cylinders'), def.counts.map((n) => ({ value: n, label: cylinderLabel(def.family, n) })), count,
      (n) => this.emit(cylinderPatch(this.settings, n), 'engine'));

    const { idle, redline, bore, displacement, vvlRpm, boost, launchRpm } = this.inputs;
    const dr = displacementRange(profile);
    displacement.min = dr.min;
    displacement.max = dr.max;
    this.setRange(displacement, 'opt-displacement-out', profile.displacementL.toFixed(1), profile.displacementL.toFixed(1));
    this.setRange(idle, 'opt-idle-out', profile.idleRpm, String(profile.idleRpm));
    this.setRange(redline, 'opt-redline-out', profile.redlineRpm, String(profile.redlineRpm));
    this.setRange(bore, 'opt-bore-out', profile.boreStroke, profile.boreStroke.toFixed(2));
    const shape = profile.boreStroke > 1.03 ? 'Oversquare' : profile.boreStroke < 0.97 ? 'Undersquare' : 'Square';
    const pistonSpeed = (2 * (profile.strokeMm / 1000) * profile.redlineRpm) / 60;
    $('opt-bore-note').textContent = profile.kind === 'rotary'
      ? 'Rotaries have no bore or stroke; this only shifts the torque curve.'
      : `${shape} · ${profile.boreMm.toFixed(1)} × ${profile.strokeMm.toFixed(1)} mm · ${pistonSpeed.toFixed(1)} m/s piston speed at redline`;

    // Variable valve lift (piston engines only).
    $('opt-vvl-block').hidden = profile.kind === 'rotary';
    const vvlOn = !!profile.vvlRpm;
    $('opt-vvl').setAttribute('aria-checked', String(vvlOn));
    $('opt-vvl-field').hidden = !vvlOn;
    vvlRpm.min = profile.idleRpm + 1000;
    vvlRpm.max = profile.redlineRpm - 200;
    if (vvlOn) this.setRange(vvlRpm, 'opt-vvl-rpm-out', profile.vvlRpm, String(profile.vvlRpm));

    // Forced induction.
    const induction = profile.induction?.kind ?? settings.induction;
    $('opt-induction-note').textContent = INDUCTION_NOTES[induction] ?? '';
    $('opt-boost-field').hidden = induction === 'na';
    this.setRange(boost, 'opt-boost-out', settings.boostBar, Number(settings.boostBar).toFixed(2));

    // Transmission and assists.
    $('opt-mode-note').textContent = MODE_NOTES[settings.mode] ?? '';
    $('opt-autoblip-row').hidden = settings.mode === 'auto';
    $('opt-launch-field').hidden = !settings.launchControl;
    this.setRange(launchRpm, 'opt-launch-rpm-out', settings.launchRpm, String(settings.launchRpm));

    for (const [key, [btn]] of Object.entries(this.switches)) btn.setAttribute('aria-checked', String(!!settings[key]));
    for (const [key, [group]] of Object.entries(this.choices)) {
      const value = key === 'induction' ? induction : settings[key];
      for (const b of group.querySelectorAll('.chip')) b.setAttribute('aria-checked', String(b.dataset.value === value));
    }
    chips($('opt-visual'), VISUAL_SPEEDS, settings.visualSpeed, (v) => this.emit({ visualSpeed: v }, 'view'));

    // Gearing.
    chips($('opt-ratio-presets'), Object.entries(GEAR_RATIO_PRESETS).map(([k, v]) => ({ value: k, label: v.label })), this.matchPreset(settings), (k) => {
      const p = GEAR_RATIO_PRESETS[k];
      this.emit({ gearRatios: [...p.gearRatios], reverseRatio: p.reverseRatio, finalDrive: p.finalDrive }, 'drive');
    });
    this.inputs.ratios.forEach((input) => {
      input.value = (input.dataset.gear === 'R' ? settings.reverseRatio : settings.gearRatios[Number(input.dataset.gear)]).toFixed(2);
    });
    this.inputs.fd.value = settings.finalDrive.toFixed(2);
    this.inputs.tire.value = (settings.tireDiameter * 100).toFixed(1);
    const dt = this.drivetrain;
    if (dt) {
      const top = formatSpeed(dt.speedForRpm(profile.redlineRpm, settings.gearRatios.length), units);
      const first = formatSpeed(dt.speedForRpm(profile.redlineRpm, 1), units);
      const unit = speedUnit(units);
      $('opt-gearing-note').textContent = `Tyre circumference ${(Math.PI * settings.tireDiameter).toFixed(2)} m · at redline 1st tops out at ${first} ${unit}, 5th at ${top} ${unit}.`;
    }
  }

  matchPreset(s) {
    for (const [k, p] of Object.entries(GEAR_RATIO_PRESETS)) {
      if (p.finalDrive === s.finalDrive && p.reverseRatio === s.reverseRatio && p.gearRatios.every((r, i) => r === s.gearRatios[i])) return k;
    }
    return null;
  }
}

// ── Garage sheet ────────────────────────────────────────────────────────────

const span = (cls, text) => {
  const n = document.createElement('span');
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Cards for the ready-made builds. specsOf(entry) → garageSpecs(); onPick(id) loads one. */
export class GarageSheet {
  constructor({ entries, specsOf, onPick }) {
    this.entries = entries;
    this.specsOf = specsOf;
    this.onPick = onPick;
    this.backdrop = $('garage');
    this.list = $('garage-list');
    this.cards = null;
    $('btn-garage-close').addEventListener('click', () => this.close());
    this.backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }

  get isOpen() {
    return !this.backdrop.hidden;
  }

  build() {
    this.cards = this.entries.map((entry) => {
      const s = this.specsOf(entry);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'garage-card';
      card.dataset.id = entry.id;
      const boost = s.induction === 'na' ? 'NA' : `${s.inductionLabel} ${s.boostBar.toFixed(1)} bar`;
      const head = span('gc-head');
      head.append(span('gc-name', entry.name), span('gc-current', 'Fitted'));
      const tags = span('gc-tags');
      tags.append(span('gc-tag', s.layout), span('gc-tag', `${s.displacementL.toFixed(1)} L`), span(`gc-tag${s.induction === 'na' ? '' : ' is-boost'}`, boost));
      if (s.vvl) tags.append(span('gc-tag', 'VVL'));
      const stat = (value, unit, sub) => {
        const n = span('gc-stat');
        const v = span('gc-value');
        v.append(document.createTextNode(value), span('gc-unit', unit));
        n.append(v, span('gc-sub', sub));
        return n;
      };
      const stats = span('gc-stats');
      stats.append(
        stat(String(s.peakHp), 'hp', `@ ${groupThousands(s.peakHpRpm)}`),
        stat(String(s.peakNm), 'Nm', `@ ${groupThousands(s.peakNmRpm)}`),
        stat(groupThousands(s.redlineRpm), 'rpm', 'redline'),
      );
      card.append(head, tags, span('gc-blurb', entry.blurb), stats);
      card.setAttribute('aria-label', `${entry.name}: ${s.layout}, ${s.displacementL.toFixed(1)} litres, ${s.peakHp} hp, ${s.peakNm} Nm, redline ${s.redlineRpm} rpm, ${s.inductionLabel}`);
      card.addEventListener('click', () => this.onPick(entry.id));
      return card;
    });
    this.list.replaceChildren(...this.cards);
  }

  open(currentId) {
    if (!this.cards) this.build();
    for (const c of this.cards) c.setAttribute('aria-current', String(c.dataset.id === currentId));
    this.backdrop.hidden = false;
    this.list.parentElement.scrollTop = 0;
  }

  close() {
    this.backdrop.hidden = true;
  }
}

// ── Charts ──────────────────────────────────────────────────────────────────

class CurveChart {
  constructor(canvas, { color, value, unit, label }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.value = value; // (profile, rpm) => number
    this.unit = unit;
    this.label = label;
    this.hoverRpm = null;
  }

  layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.pad = { l: 34, r: 8, t: 8, b: 18 };
  }

  setProfile(profile) {
    this.profile = profile;
    const maxRpm = Math.ceil(profile.redlineRpm / 1000) * 1000;
    this.maxRpm = maxRpm;
    this.points = [];
    let peak = { v: 0, rpm: 0 };
    for (let rpm = 500; rpm <= profile.redlineRpm; rpm += 50) {
      const v = this.value(profile, rpm);
      this.points.push([rpm, v]);
      if (v > peak.v) peak = { v, rpm };
    }
    this.peak = peak;
    const step = peak.v > 400 ? 200 : peak.v > 200 ? 100 : 50;
    this.maxV = Math.ceil((peak.v * 1.08) / step) * step;
    this.stepV = step;
  }

  x(rpm) {
    const { l, r } = this.pad;
    return l + (rpm / this.maxRpm) * (this.w - l - r);
  }

  y(v) {
    const { t, b } = this.pad;
    return t + (1 - v / this.maxV) * (this.h - t - b);
  }

  rpmAt(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const { l, r } = this.pad;
    const rpm = ((clientX - rect.left - l) / (rect.width - l - r)) * this.maxRpm;
    return Math.max(500, Math.min(this.profile.redlineRpm, Math.round(rpm / 50) * 50));
  }

  draw(liveRpm, liveValue) {
    this.layout();
    const { ctx, dpr, w, h, pad } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const muted = css('--muted');
    const line = css('--line');
    const fg = css('--fg');
    ctx.font = `10px ${css('--font-data')}`;
    ctx.lineWidth = 1;

    // Grid and axis labels.
    ctx.strokeStyle = line;
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= this.maxV; v += this.stepV) {
      const y = Math.round(this.y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(String(v), pad.l - 5, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tickStep = this.maxRpm > 8000 && w < 360 ? 2000 : 1000;
    for (let rpm = 0; rpm <= this.maxRpm; rpm += tickStep) {
      ctx.fillText(rpm === 0 ? '0' : `${rpm / 1000}k`, this.x(rpm), h - pad.b + 5);
    }

    // Redline.
    ctx.strokeStyle = css('--red');
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(Math.round(this.x(this.profile.redlineRpm)) + 0.5, pad.t);
    ctx.lineTo(Math.round(this.x(this.profile.redlineRpm)) + 0.5, h - pad.b);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Curve with a soft area fill.
    ctx.beginPath();
    this.points.forEach(([rpm, v], i) => (i ? ctx.lineTo(this.x(rpm), this.y(v)) : ctx.moveTo(this.x(rpm), this.y(v))));
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    const last = this.points[this.points.length - 1];
    ctx.lineTo(this.x(last[0]), this.y(0));
    ctx.lineTo(this.x(this.points[0][0]), this.y(0));
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Live marker: hairline at current rpm and a dot at what the engine makes now.
    if (liveRpm > 0) {
      const x = Math.round(this.x(Math.min(liveRpm, this.maxRpm))) + 0.5;
      ctx.strokeStyle = fg;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, h - pad.b);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const y = this.y(Math.max(0, Math.min(this.maxV, liveValue)));
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = css('--panel-solid');
      ctx.stroke();
    }

    // Hover crosshair.
    if (this.hoverRpm) {
      const x = Math.round(this.x(this.hoverRpm)) + 0.5;
      ctx.strokeStyle = muted;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, h - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, this.y(this.value(this.profile, this.hoverRpm)), 4, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    }
  }
}

export class TelemetryPanel {
  constructor() {
    this.el = $('telemetry');
    this.tip = $('chart-tip');
    this.torque = new CurveChart($('chart-torque'), {
      color: css('--series-torque'), unit: 'Nm', label: 'Torque', value: (p, rpm) => wotTorque(p, rpm),
    });
    this.power = new CurveChart($('chart-power'), {
      color: css('--series-power'), unit: 'hp', label: 'Power', value: (p, rpm) => powerHp(wotTorque(p, rpm), rpm),
    });
    for (const chart of [this.torque, this.power]) {
      const move = (e) => this.hover(chart, e);
      chart.canvas.addEventListener('pointermove', move);
      chart.canvas.addEventListener('pointerdown', move);
      chart.canvas.addEventListener('pointerleave', () => this.hover(null));
      chart.canvas.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'mouse') this.hover(null);
      });
    }
    this.lastListKey = '';
    this.units = 'kmh';
    this.shown = Object.create(null);
  }

  /** Write a readout only when its text changes, so an open panel does not touch the DOM every frame. */
  put(id, value) {
    const text = String(value);
    if (this.shown[id] === text) return;
    this.shown[id] = text;
    $(id).textContent = text;
  }

  /** Speed and distance units for the tiles: 'kmh' | 'mph'. */
  setUnits(units) {
    this.units = units === 'mph' ? 'mph' : 'kmh';
    const mph = this.units === 'mph';
    $('t-top-speed-unit').textContent = speedUnit(this.units);
    $('t-distance-unit').textContent = mph ? 'mi' : 'km';
    // The session timer measures 0–100 km/h, which is 0–62 mph.
    $('t-zero-label').textContent = mph ? '0–62 mph' : '0–100 km/h';
  }

  get isOpen() {
    return !this.el.hidden;
  }

  toggle(force) {
    const open = force ?? this.el.hidden;
    this.el.hidden = !open;
    $('btn-telemetry').setAttribute('aria-expanded', String(open));
    if (open) this.lastListKey = '';
  }

  setProfile(profile) {
    this.torque.setProfile(profile);
    this.power.setProfile(profile);
    $('t-torque-peak').textContent = Math.round(this.torque.peak.v);
    $('t-torque-peak-rpm').textContent = this.torque.peak.rpm;
    $('t-power-peak').textContent = Math.round(this.power.peak.v);
    $('t-power-peak-rpm').textContent = this.power.peak.rpm;
  }

  hover(chart, e) {
    if (!chart) {
      this.torque.hoverRpm = this.power.hoverRpm = null;
      this.tip.hidden = true;
      return;
    }
    const rpm = chart.rpmAt(e.clientX);
    this.torque.hoverRpm = this.power.hoverRpm = rpm;
    const p = chart.profile;
    const t = wotTorque(p, rpm);
    const tip = this.tip;
    tip.replaceChildren();
    const row = (label, value, color) => {
      const div = document.createElement('div');
      if (color) {
        const k = document.createElement('span');
        k.className = 'key';
        k.style.background = color;
        div.append(k);
      }
      const b = document.createElement('b');
      b.textContent = value;
      const i = document.createElement('i');
      i.textContent = ` ${label}`;
      div.append(b, i);
      tip.append(div);
    };
    row('rpm', rpm.toLocaleString('en-US'));
    row('Nm', Math.round(t), this.torque.color);
    row('hp', Math.round(powerHp(t, rpm)), this.power.color);
    tip.hidden = false;
    const block = this.tip.parentElement.getBoundingClientRect();
    const canvasRect = chart.canvas.getBoundingClientRect();
    let left = e.clientX - block.left + 12;
    if (left + 110 > block.width) left = e.clientX - block.left - 120;
    tip.style.left = `${left}px`;
    tip.style.top = `${canvasRect.top - block.top + 4}px`;
  }

  update(sim, stats, tracker) {
    if (!this.isOpen) return;
    const rpm = sim.rpm;
    const torqueNow = Math.max(0, sim.combustionTorque);
    const powerNow = powerHp(torqueNow, rpm);
    this.torque.draw(rpm, torqueNow);
    this.power.draw(rpm, powerNow);
    this.put('t-torque-now', Math.round(torqueNow));
    this.put('t-power-now', Math.round(powerNow));
    this.put('t-peak-rpm', groupThousands(stats.peakRpm));
    this.put('t-top-speed', formatSpeed(stats.topSpeedKmh, this.units));
    this.put('t-zero-100', stats.bestZeroToHundred ? stats.bestZeroToHundred.toFixed(2) : '—');
    this.put('t-distance', ((stats.distanceM / 1000) * (this.units === 'mph' ? KM_TO_MI : 1)).toFixed(2));

    const avg = tracker.averageScore;
    this.put('t-shift-avg', avg === null ? '—' : avg);
    this.put('t-shift-count', tracker.shiftRecords.length);
    this.put('t-grinds', tracker.grinds);
    this.put('t-stalls', tracker.stalls);

    const key = `${tracker.records.length}:${tracker.records[0]?.time ?? ''}`;
    if (key !== this.lastListKey) {
      this.lastListKey = key;
      this.renderShifts(tracker.records);
    }
  }

  renderShifts(records) {
    const list = $('shift-list');
    $('shift-empty').hidden = records.length > 0;
    list.replaceChildren(
      ...records.slice(0, 12).map((r) => {
        const li = document.createElement('li');
        const gears = document.createElement('span');
        gears.className = 's-gears';
        gears.textContent = r.stall ? 'Stall' : `${r.from}→${r.to}`;
        const detail = document.createElement('span');
        detail.className = 's-detail';
        if (r.grind) detail.textContent = r.note;
        else if (r.stall) detail.textContent = 'Clutch released too fast for the revs';
        else {
          const bits = [`${r.duration.toFixed(2)} s`, `${r.mismatchRpm} rpm off`, `${r.slipKj.toFixed(1)} kJ`];
          if (r.note) bits.unshift(r.note);
          detail.textContent = bits.join(' · ');
        }
        const score = document.createElement('span');
        score.className = 's-score';
        const grade = document.createElement('span');
        grade.className = `grade grade-${r.grade}`;
        grade.textContent = r.grade;
        score.append(grade, document.createTextNode(String(r.score)));
        li.append(gears, detail, score);
        return li;
      }),
    );
  }
}

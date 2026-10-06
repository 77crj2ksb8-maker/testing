// Settings sheet and telemetry panel (stat tiles, torque/power charts, shift log).

import { PRESETS, PRESET_ORDER, GEAR_RATIO_PRESETS, wotTorque, powerHp, firingOrderLabel } from './config.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const $ = (id) => document.getElementById(id);

export const VISUAL_SPEEDS = [
  { value: 1, label: 'Real time' },
  { value: 1 / 5, label: '1/5' },
  { value: 1 / 10, label: '1/10' },
  { value: 1 / 25, label: '1/25' },
  { value: 1 / 100, label: '1/100' },
];

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

export class SettingsPanel {
  constructor(onChange) {
    this.onChange = onChange;
    this.backdrop = $('settings');
    this.inputs = {
      idle: $('opt-idle'),
      redline: $('opt-redline'),
      bore: $('opt-bore'),
      ratios: [...document.querySelectorAll('.ratio-grid input[data-gear]')],
      fd: $('opt-fd'),
      tire: $('opt-tire'),
    };
    const { idle, redline, bore } = this.inputs;
    idle.addEventListener('input', () => this.emit({ idleRpm: Number(idle.value) }, 'engine'));
    redline.addEventListener('input', () => this.emit({ redlineRpm: Number(redline.value) }, 'engine'));
    bore.addEventListener('input', () => this.emit({ boreStroke: Number(bore.value) }, 'engine'));
    for (const input of this.inputs.ratios) {
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (!(v >= 0.4 && v <= 6)) return this.render(this.settings, this.profile);
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
      else this.render(this.settings, this.profile);
    });
    this.inputs.tire.addEventListener('change', () => {
      const v = Number(this.inputs.tire.value);
      if (v >= 40 && v <= 100) this.emit({ tireDiameter: v / 100 }, 'drive');
      else this.render(this.settings, this.profile);
    });
    this.backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }

  emit(patch, kind) {
    this.onChange(patch, kind);
  }

  get isOpen() {
    return !this.backdrop.hidden;
  }

  open() {
    this.backdrop.hidden = false;
    $('btn-settings').setAttribute('aria-expanded', 'true');
  }

  close() {
    this.backdrop.hidden = true;
    $('btn-settings').setAttribute('aria-expanded', 'false');
  }

  render(settings, profile, drivetrain) {
    this.settings = settings;
    this.profile = profile;
    chips($('opt-preset'), PRESET_ORDER.map((id) => ({ value: id, label: PRESETS[id].label })), settings.preset, (id) => {
      const def = PRESETS[id];
      const cylinders = def.family === 'v' ? (id === 'v6' ? 6 : 8) : def.count;
      this.emit({ preset: id, cylinders, redlineRpm: null }, 'engine');
    });
    $('opt-preset-note').textContent = `${profile.name} · ${profile.layoutNote} · firing ${firingOrderLabel(profile)}`;

    const def = PRESETS[settings.preset];
    const count = profile.kind === 'rotary' ? profile.rotors : profile.cylinders.length;
    const unit = def.family === 'rotary' ? 'rotor' : '';
    chips($('opt-cylinders'), def.counts.map((n) => ({
      value: n,
      label: def.family === 'rotary' ? `${n} ${unit}${n > 1 ? 's' : ''}` : def.family === 'v' ? `V${n}` : `I${n}`,
    })), count, (n) => this.emit({ cylinders: n, redlineRpm: null }, 'engine'));

    const { idle, redline, bore } = this.inputs;
    idle.value = profile.idleRpm;
    $('opt-idle-out').textContent = profile.idleRpm;
    redline.value = profile.redlineRpm;
    $('opt-redline-out').textContent = profile.redlineRpm;
    bore.value = profile.boreStroke;
    $('opt-bore-out').textContent = profile.boreStroke.toFixed(2);
    const shape = profile.boreStroke > 1.03 ? 'Oversquare' : profile.boreStroke < 0.97 ? 'Undersquare' : 'Square';
    const pistonSpeed = (2 * (profile.strokeMm / 1000) * profile.redlineRpm) / 60;
    $('opt-bore-note').textContent = profile.kind === 'rotary'
      ? 'Rotaries have no bore or stroke; this only shifts the torque curve.'
      : `${shape} · ${profile.boreMm.toFixed(1)} × ${profile.strokeMm.toFixed(1)} mm · ${profile.displacementL.toFixed(1)} L · ${pistonSpeed.toFixed(1)} m/s piston speed at redline`;

    chips($('opt-visual'), VISUAL_SPEEDS, settings.visualSpeed, (v) => this.emit({ visualSpeed: v }, 'view'));
    for (const b of $('opt-mode').querySelectorAll('.chip')) {
      b.setAttribute('aria-checked', String(b.dataset.value === settings.mode));
      b.onclick = () => this.emit({ mode: b.dataset.value }, 'mode');
    }

    chips($('opt-ratio-presets'), Object.entries(GEAR_RATIO_PRESETS).map(([k, v]) => ({ value: k, label: v.label })), this.matchPreset(settings), (k) => {
      const p = GEAR_RATIO_PRESETS[k];
      this.emit({ gearRatios: [...p.gearRatios], reverseRatio: p.reverseRatio, finalDrive: p.finalDrive }, 'drive');
    });
    this.inputs.ratios.forEach((input) => {
      input.value = (input.dataset.gear === 'R' ? settings.reverseRatio : settings.gearRatios[Number(input.dataset.gear)]).toFixed(2);
    });
    this.inputs.fd.value = settings.finalDrive.toFixed(2);
    this.inputs.tire.value = (settings.tireDiameter * 100).toFixed(1);
    if (drivetrain) {
      const top = drivetrain.speedForRpm(profile.redlineRpm, settings.gearRatios.length);
      const first = drivetrain.speedForRpm(profile.redlineRpm, 1);
      $('opt-gearing-note').textContent = `Tyre circumference ${(Math.PI * settings.tireDiameter).toFixed(2)} m · at redline 1st tops out at ${first.toFixed(0)} km/h, 5th at ${top.toFixed(0)} km/h.`;
    }
  }

  matchPreset(s) {
    for (const [k, p] of Object.entries(GEAR_RATIO_PRESETS)) {
      if (p.finalDrive === s.finalDrive && p.reverseRatio === s.reverseRatio && p.gearRatios.every((r, i) => r === s.gearRatios[i])) return k;
    }
    return null;
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
    $('t-torque-now').textContent = Math.round(torqueNow);
    $('t-power-now').textContent = Math.round(powerNow);
    $('t-peak-rpm').textContent = Math.round(stats.peakRpm).toLocaleString('en-US');
    $('t-top-speed').textContent = Math.round(stats.topSpeedKmh);
    $('t-zero-100').textContent = stats.bestZeroToHundred ? stats.bestZeroToHundred.toFixed(2) : '—';
    $('t-distance').textContent = (stats.distanceM / 1000).toFixed(2);

    const avg = tracker.averageScore;
    $('t-shift-avg').textContent = avg === null ? '—' : String(avg);
    $('t-shift-count').textContent = tracker.shiftRecords.length;
    $('t-grinds').textContent = tracker.grinds;
    $('t-stalls').textContent = tracker.stalls;

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

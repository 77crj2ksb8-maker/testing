// Core HUD: tach card, gear and speed, status pills and the stall card.
// Owned by the HUD track; main.js calls update(dt) once per frame.

import { formatSpeed, speedUnit } from './dom.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(app) {
    this.app = app;
    this.el = {
      rpm: $('rpm'), fill: $('rpm-fill'), redline: $('rpm-redline'), gear: $('gear'), speed: $('speed'),
      speedUnit: $('speed-unit'), limiter: $('limiter'), traction: $('traction'), stall: $('stall'),
      stallTitle: $('stall-title'), stallHelp: $('stall-help'), start: $('btn-start'),
    };
    this.shown = {};
    this.spinTime = 0;
    this.spinHold = 0;
  }

  setText(key, value) {
    if (this.shown[key] !== value) {
      this.shown[key] = value;
      this.el[key].textContent = value;
    }
  }

  update(dt) {
    const { sim, profile, settings } = this.app;
    const el = this.el;
    const rpm = sim.rpm;
    const scale = profile.redlineRpm * 1.06;
    this.setText('rpm', String(Math.round(rpm / 10) * 10));
    el.fill.style.width = `${Math.min(100, (rpm / scale) * 100).toFixed(1)}%`;
    el.redline.style.left = `${((profile.redlineRpm / scale) * 100).toFixed(1)}%`;
    el.fill.classList.toggle('is-red', rpm > profile.redlineRpm * 0.92);
    this.setText('gear', String(sim.gear));
    el.gear.classList.toggle('is-reverse', sim.gear === 'R');
    this.setText('speed', String(formatSpeed(sim.speedKmh, settings.units)));
    this.setText('speedUnit', speedUnit(settings.units));
    el.limiter.hidden = !sim.fuelCut;
    // Only flag sustained wheelspin, not the blip of a clutch catching.
    this.spinTime = sim.wheelspin && sim.throttleEffective > 0.3 ? this.spinTime + dt : 0;
    this.spinHold = this.spinTime > 0.2 ? 0.35 : Math.max(0, this.spinHold - dt);
    el.traction.hidden = this.spinHold <= 0;

    const off = !sim.running && !sim.cranking;
    el.stall.hidden = !off;
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

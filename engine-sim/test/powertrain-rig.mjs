// Shared test rig for the powertrain tests: a simulator + gearbox stepped at a
// fixed rate with scripted pedals, collecting every simulator event.

import { buildProfile, DEFAULT_SETTINGS, DRIVETRAIN_DEFAULTS } from '../src/config.js';
import { Drivetrain } from '../src/physics.js';
import { Gearbox, ShiftTracker } from '../src/gearbox.js';
import { SessionStats } from '../src/session.js';

export const DT = 1 / 120;

export function rig(patch = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...patch };
  const profile = buildProfile(settings);
  const sim = new Drivetrain(profile, { ...DRIVETRAIN_DEFAULTS });
  sim.configure(settings);
  const tracker = new ShiftTracker();
  const box = new Gearbox(sim, tracker);
  box.configure(settings);
  box.setMode(settings.mode);
  const stats = new SessionStats();
  const events = [];
  const run = (seconds, input = {}, each) => {
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) {
      const inp = typeof input === 'function' ? input(i * DT) : input;
      box.update(DT, { gas: 0, clutch: 0, brake: 0, ...inp });
      sim.step(DT);
      tracker.update(DT, sim);
      stats.update(DT, sim);
      for (const e of sim.drainEvents()) events.push({ ...e, t: sim.time });
      each?.(sim);
    }
  };
  const of = (type) => events.filter((e) => e.type === type);
  /** Manual box: clutch in, first gear, rev and dump the clutch. */
  const launch = (rpmGas = 1, seconds = 3) => {
    run(0.3, { clutch: 1 });
    box.request(1);
    run(0.4, { clutch: 1, gas: rpmGas });
    run(seconds, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  };
  return { settings, profile, sim, box, tracker, stats, events, run, of, launch };
}

export const rpmOf = (sim, gear) => Math.abs(sim.inputOmegaFor(gear)) / (Math.PI / 30);

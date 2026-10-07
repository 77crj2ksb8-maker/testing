// The powertrain feature module against a minimal stand-in for the app
// context (docs/CONTRACT.md): the real bus, simulator and gearbox, a toast
// recorder and the actions it relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/bus.js';
import { buildProfile, DEFAULT_SETTINGS } from '../src/config.js';
import { garagePatch } from '../src/presets.js';
import powertrain from '../src/features/powertrain.js';
import { rig } from './powertrain-rig.mjs';

function fakeApp(patch = {}) {
  const r = rig(patch);
  const bus = new Bus();
  const toasts = [];
  let settings = { ...r.settings };
  let profile = r.profile;
  const app = {
    bus,
    sim: r.sim,
    gearbox: r.box,
    get settings() { return settings; },
    get profile() { return profile; },
    toast: (msg, kind) => toasts.push({ msg, kind }),
    apply(p, kind) {
      settings = { ...settings, ...p };
      if (kind === 'engine' || kind === 'all') {
        profile = buildProfile(settings);
        r.sim.setProfile(profile);
        bus.emit('profile', { profile });
      }
      r.sim.configure(settings);
      bus.emit('settings', { settings, kind, patch: p });
    },
    actions: {
      selectGear: (gear) => r.box.request(gear),
      repair() {
        r.sim.repair();
        bus.emit('repair', {});
      },
    },
  };
  const hooks = powertrain.install(app);
  // Mirror main.js tick(): step, re-emit simulator events, run afterStep.
  const run = (seconds, input = {}) => {
    for (let i = 0; i < Math.round(seconds * 120); i++) {
      const inp = typeof input === 'function' ? input(i / 120) : input;
      r.box.update(1 / 120, { gas: 0, clutch: 0, brake: 0, ...inp });
      r.sim.step(1 / 120);
      for (const e of r.sim.drainEvents()) bus.emit(e.type, e);
      hooks.afterStep?.(1 / 120, app);
    }
  };
  return { app, r, toasts, run };
}

test('feature: loadGarage applies a build and rejects unknown ids', () => {
  const { app, toasts } = fakeApp();
  assert.equal(app.actions.loadGarage('rally-boxer'), true);
  assert.equal(app.profile.layout, 'boxer');
  assert.equal(app.settings.garage, 'rally-boxer');
  assert.equal(app.sim.inductionKind, 'turbo');
  assert.equal(toasts.at(-1).msg, 'Turbo boxer-4 2.5');
  assert.equal(app.actions.loadGarage('nope'), false);
});

test('feature: two-step armed toast, once per arming', () => {
  const { app, r, toasts, run } = fakeApp({ launchControl: true, launchRpm: 4000 });
  run(0.3, { clutch: 1 });
  r.box.request(1);
  run(1.5, { clutch: 1, gas: 1 });
  const armed = toasts.filter((t) => /Launch control armed/.test(t.msg));
  assert.equal(armed.length, 1);
  assert.match(armed[0].msg, /4,000 rpm/);
  assert.ok(app.sim.launchActive);
});

test('feature: a survivable over-rev is reported once it is over; a fatal one is left to the stall card', () => {
  const survive = fakeApp();
  const { r, run, toasts } = survive;
  run(0.3, { clutch: 1 });
  r.box.request(1);
  run(0.4, { clutch: 1, gas: 1 });
  run(1.3, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  run(0.15, { clutch: 1 });
  r.box.request(2);
  run(1.2, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.2) }));
  const rpm1 = () => Math.abs(r.sim.inputOmegaFor(1)) / (Math.PI / 30);
  for (let i = 0; i < 600 && rpm1() < 1.24 * r.profile.redlineRpm; i++) run(1 / 120, { gas: 1 });
  run(0.1, { clutch: 1 });
  r.box.request(1);
  run(0.3, {});
  assert.equal(toasts.filter((t) => /Over-revved/.test(t.msg)).length, 0, 'not while still over');
  run(2, { brake: 0.6 });
  const over = toasts.filter((t) => /Over-revved/.test(t.msg));
  assert.equal(over.length, 1);
  assert.match(over[0].msg, /Engine health \d+ %/);
  assert.equal(over[0].kind, 'bad');

  const fatal = fakeApp();
  fatal.run(0.3, { clutch: 1 });
  fatal.r.box.request(1);
  fatal.run(0.4, { clutch: 1, gas: 1 });
  fatal.run(1.5, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  for (const g of [2, 3]) {
    fatal.run(0.15, { clutch: 1 });
    fatal.r.box.request(g);
    fatal.run(2, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  }
  fatal.run(0.1, { clutch: 1 });
  fatal.r.box.request(1);
  fatal.run(5, { brake: 1 });
  assert.ok(fatal.r.sim.blown);
  assert.equal(fatal.toasts.filter((t) => /Over-revved/.test(t.msg)).length, 0);
});

test('feature: fitting a different engine to a blown car rebuilds it; tweaking the same one does not', () => {
  const { app, r } = fakeApp();
  r.sim.blowUp('over-rev');
  app.bus.emit('blown', { cause: 'over-rev' });
  app.apply({ idleRpm: 850 }, 'engine');
  assert.equal(app.sim.blown, true, 'same engine, still blown');
  app.apply(garagePatch('vtwin-cruiser'), 'engine');
  assert.equal(app.sim.blown, false, 'new engine fitted');
  assert.equal(app.sim.damage, 0);
});

test('feature: refused sequential lever selections explain themselves', () => {
  const { app, toasts, run } = fakeApp({ mode: 'sequential' });
  app.actions.selectGear(1);
  run(4, { gas: 1 });
  app.actions.selectGear(2);
  run(3, { gas: 1 });
  const res = app.actions.selectGear(1);
  assert.equal(res.ok, false);
  assert.equal(toasts.at(-1).kind, 'warn');
  assert.match(toasts.at(-1).msg, /Too fast for 1st/);
  assert.equal(DEFAULT_SETTINGS.mode, 'manual');
});

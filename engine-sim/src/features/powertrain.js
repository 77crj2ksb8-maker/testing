// Powertrain feature: light-touch feedback for notable engine events (blown,
// overheating, high cam, two-step armed), a fresh engine when a different
// build is fitted to a blown car, and app.actions.loadGarage(id).
// The physics itself lives in src/physics.js, src/induction.js and src/thermal.js.

import { GARAGE, garagePatch } from '../presets.js';

const VVL_TOAST_GAP = 30; // s of sim time between "high cam" toasts
const OVERREV_TOAST_GAP = 2;
const LAUNCH_TOAST_GAP = 6;

const fmtRpm = (rpm) => Math.round(rpm / 50) * 50;

export default {
  id: 'powertrain',
  install(app) {
    const { bus } = app;
    const sim = app.sim;
    let lastVvlToast = -Infinity;
    let lastOverrevToast = -Infinity;
    let lastLaunchToast = -Infinity;
    let launchWasArmed = false;
    let blownProfileId = null;

    bus.on('blown', (e) => {
      blownProfileId = app.profile.id;
      const why = e.cause === 'overheat' ? 'it overheated' : 'it over-revved';
      app.toast(`Engine blown: ${why}. Tap Start to rebuild it.`, 'bad', 4200);
      navigator.vibrate?.([80, 40, 160]);
    });
    bus.on('overheat', (e) => {
      if (!sim.blown) app.toast(`Overheating at ${Math.round(e.coolantC)} °C. Ease off to let it cool.`, 'warn', 3200);
    });
    bus.on('overrev', (e) => {
      if (sim.blown || e.severity < 0.15 || sim.time - lastOverrevToast < OVERREV_TOAST_GAP) return;
      lastOverrevToast = sim.time;
      app.toast(`Over-rev: ${fmtRpm(e.rpm).toLocaleString('en-US')} rpm. That hurt the engine.`, 'bad', 2400);
    });
    bus.on('vvl', (e) => {
      if (!e.on || sim.time - lastVvlToast < VVL_TOAST_GAP) return;
      lastVvlToast = sim.time;
      app.toast('High-lift cam engaged', 'good', 1400);
    });
    bus.on('repair', () => {
      blownProfileId = null;
    });
    // Fitting a different engine to a blown car gives it a fresh one.
    bus.on('profile', ({ profile }) => {
      lastVvlToast = -Infinity;
      if (sim.blown && blownProfileId && profile.id !== blownProfileId) app.actions.repair();
    });

    /** Load a garage build by id. Returns false for an unknown id. */
    app.actions.loadGarage = (id) => {
      const entry = GARAGE.find((g) => g.id === id);
      if (!entry) return false;
      app.apply(garagePatch(id), 'engine');
      app.toast(entry.name, 'good', 1600);
      return true;
    };

    return {
      afterStep() {
        const armed = sim.launchArmed && sim.throttleInput > 0.3;
        if (armed && !launchWasArmed && sim.time - lastLaunchToast > LAUNCH_TOAST_GAP) {
          lastLaunchToast = sim.time;
          app.toast(`Launch control armed: holding ${fmtRpm(sim.limiterRpm).toLocaleString('en-US')} rpm`, 'good', 1600);
        }
        launchWasArmed = armed;
      },
    };
  },
};

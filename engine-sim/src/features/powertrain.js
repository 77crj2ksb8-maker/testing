// Powertrain feature: light-touch feedback for notable engine events (blown,
// overheating, over-rev, high cam, two-step armed, refused sequential shifts),
// a fresh engine when a different build is fitted to a blown car, and
// app.actions.loadGarage(id).
// The physics itself lives in src/physics.js, src/induction.js and src/thermal.js.

import { GARAGE, garagePatch } from '../presets.js';

const VVL_TOAST_GAP = 30; // s of sim time between "high cam" toasts
const OVERREV_TOAST_GAP = 2;
const LAUNCH_TOAST_GAP = 6;

const fmtRpm = (rpm) => (Math.round(rpm / 50) * 50).toLocaleString('en-US');

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
    let peakRpm = 0; // highest rpm of the current over-rev episode

    // The core stall card already says the engine is destroyed and offers the
    // rebuild; the toast adds what killed it.
    bus.on('blown', (e) => {
      blownProfileId = app.profile.id;
      const why = e.cause === 'overheat'
        ? `Blown: coolant hit ${Math.round(sim.coolantC)} °C`
        : `Blown at ${fmtRpm(Math.max(peakRpm, sim.rpm))} rpm`;
      app.toast(why, 'bad', 3600);
      navigator.vibrate?.([80, 40, 160]);
    });
    bus.on('overheat', (e) => {
      if (!sim.blown) app.toast(`Overheating at ${Math.round(e.coolantC)} °C. Ease off to let it cool.`, 'warn', 3200);
    });
    bus.on('overrev', (e) => {
      peakRpm = Math.max(peakRpm, e.rpm);
      if (sim.blown || e.severity < 0.15 || sim.time - lastOverrevToast < OVERREV_TOAST_GAP) return;
      lastOverrevToast = sim.time;
      app.toast(`Over-rev: ${fmtRpm(e.rpm)} rpm. That hurt the engine.`, 'bad', 2400);
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

    // The sequential box refuses some lever/keyboard selections without a
    // grind (e.g. a downshift that would over-rev): say why.
    const selectGear = app.actions.selectGear;
    app.actions.selectGear = (gear, source) => {
      const res = selectGear(gear, source);
      if (res && !res.ok && !res.grind && res.reason) app.toast(res.reason, 'warn', 2600);
      return res;
    };

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
        if (sim.rpm > peakRpm && peakRpm > 0) peakRpm = sim.rpm;
        else if (sim.rpm < app.profile.redlineRpm) peakRpm = 0;
        const armed = sim.launchArmed && sim.throttleInput > 0.3;
        if (armed && !launchWasArmed && sim.time - lastLaunchToast > LAUNCH_TOAST_GAP) {
          lastLaunchToast = sim.time;
          app.toast(`Launch control armed: holding ${fmtRpm(sim.limiterRpm)} rpm`, 'good', 1600);
        }
        launchWasArmed = armed;
      },
    };
  },
};

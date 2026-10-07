// Powertrain feature: light-touch feedback for notable engine events
// (overheating, over-rev, high cam, two-step armed, refused sequential shifts),
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
    let overrevPeak = 0; // highest rpm of the over-rev episode in progress (0 = none)

    // No toast: the core stall card already covers a blown engine (and a
    // toast would sit on top of it in landscape). sim.blownCause says why.
    bus.on('blown', () => {
      blownProfileId = app.profile.id;
      navigator.vibrate?.([80, 40, 160]);
    });
    bus.on('overheat', (e) => {
      if (!sim.blown) app.toast(`Overheating at ${Math.round(e.coolantC)} °C. Ease off to let it cool.`, 'warn', 3200);
    });
    // Over-rev is reported once the episode is over (peak rpm and the damage
    // it did), and not at all when it ended in a blow-up.
    bus.on('overrev', (e) => {
      overrevPeak = Math.max(overrevPeak, e.rpm);
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
        if (overrevPeak > 0) {
          overrevPeak = Math.max(overrevPeak, sim.rpm);
          if (sim.blown) overrevPeak = 0;
          else if (sim.rpm < app.profile.redlineRpm) {
            if (sim.time - lastOverrevToast > OVERREV_TOAST_GAP) {
              lastOverrevToast = sim.time;
              app.toast(`Over-revved to ${fmtRpm(overrevPeak)} rpm. Engine health ${Math.round(100 * (1 - sim.damage))} %.`, 'bad', 2800);
            }
            overrevPeak = 0;
          }
        }
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

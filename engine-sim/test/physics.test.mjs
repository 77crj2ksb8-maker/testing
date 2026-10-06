import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS, DRIVETRAIN_DEFAULTS, PRESETS, wotTorque, powerHp } from '../src/config.js';
import { Drivetrain, clutchEngagement } from '../src/physics.js';
import { Gearbox, ShiftTracker } from '../src/gearbox.js';
import { SessionStats } from '../src/session.js';

const DT = 1 / 60;

function rig(preset = 'v8-cross', cylinders = 8) {
  const profile = buildProfile({ ...DEFAULT_SETTINGS, preset, cylinders });
  const sim = new Drivetrain(profile, { ...DRIVETRAIN_DEFAULTS });
  const tracker = new ShiftTracker();
  const box = new Gearbox(sim, tracker);
  const stats = new SessionStats();
  const events = [];
  const run = (seconds, input) => {
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) {
      const t = i * DT;
      const inp = typeof input === 'function' ? input(t) : input;
      box.update(DT, { gas: 0, clutch: 0, brake: 0, ...inp });
      sim.step(DT);
      tracker.update(DT, sim);
      stats.update(DT, sim);
      for (const e of sim.drainEvents()) events.push({ ...e, t: sim.time });
    }
  };
  return { profile, sim, box, tracker, stats, events, run };
}

const stalled = (events) => events.some((e) => e.type === 'stall');

test('clutch: fully open beyond 80 % pedal, fully closed when released', () => {
  assert.equal(clutchEngagement(1), 0);
  assert.equal(clutchEngagement(0.8), 0);
  assert.equal(clutchEngagement(0), 1);
  assert.ok(clutchEngagement(0.5) > 0 && clutchEngagement(0.5) < 1);
});

test('engine holds a steady idle in every layout', () => {
  for (const [preset, def] of Object.entries(PRESETS)) {
    for (const n of def.counts) {
      const r = rig(preset, n);
      r.run(5, {});
      assert.ok(Math.abs(r.sim.rpm - r.profile.idleRpm) < 40, `${r.profile.name}: ${r.sim.rpm}`);
      assert.ok(r.sim.running);
    }
  }
});

test('engine revs freely in neutral and the limiter holds it at redline', () => {
  const r = rig();
  let peak = 0;
  let reachedAt = null;
  for (let i = 0; i < 180; i++) {
    r.run(DT, { gas: 1 });
    peak = Math.max(peak, r.sim.rpm);
    if (reachedAt === null && r.sim.rpm > r.profile.redlineRpm - 50) reachedAt = i * DT;
  }
  assert.ok(reachedAt !== null && reachedAt < 1, `took ${reachedAt}s`);
  assert.ok(peak < r.profile.redlineRpm + 150, `peak ${peak}`);
  assert.ok(r.events.some((e) => e.type === 'limiter'));
  // Rev decay back towards idle when the throttle closes.
  r.run(3.5, {});
  assert.ok(r.sim.rpm < r.profile.idleRpm + 200, `rpm ${r.sim.rpm}`);
});

test('pressing the clutch lets the engine rev freely while in gear', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  assert.equal(r.box.request(1).ok, true);
  r.run(1, { clutch: 1, gas: 1 });
  assert.ok(r.sim.rpm > 6000, `rpm ${r.sim.rpm}`);
  assert.ok(r.sim.speedKmh < 0.5, 'car must not move with the clutch floored');
});

test('dumping the clutch at idle in first stalls the engine', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  r.box.request(1);
  r.run(1.5, { clutch: 0 });
  assert.ok(stalled(r.events), 'expected a stall');
  assert.equal(r.sim.running, false);
  assert.equal(r.tracker.stalls, 0, 'tracker counts stalls only when told by the app');
});

test('slipping the clutch out slowly pulls away at idle without stalling', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  r.box.request(1);
  r.run(4, (t) => ({ clutch: Math.max(0, 1 - t / 3) }));
  assert.ok(!stalled(r.events));
  assert.ok(r.sim.locked && r.sim.speedKmh > 5, `speed ${r.sim.speedKmh}`);
});

test('a launch with revs and a quick release gets the car moving', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  r.box.request(1);
  r.run(0.6, { clutch: 1, gas: 1 });
  r.run(3, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  assert.ok(!stalled(r.events));
  assert.ok(r.sim.speedKmh > 40, `speed ${r.sim.speedKmh}`);
});

test('a stalled engine restarts only with the clutch down or in neutral', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  r.box.request(1);
  r.run(1.5, {});
  assert.equal(r.sim.running, false);
  assert.equal(r.sim.startEngine(), false, 'clutch-safety switch should block the starter');
  r.run(0.2, { clutch: 1 });
  assert.equal(r.sim.startEngine(), true);
  r.run(2.5, { clutch: 1 });
  assert.ok(r.sim.running);
  assert.ok(Math.abs(r.sim.rpm - r.profile.idleRpm) < 120, `rpm ${r.sim.rpm}`);
});

test('road speed follows rpm, gear ratio, final drive and tyre circumference', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  r.box.request(1);
  r.run(3, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  for (const g of [2, 3]) {
    r.run(0.2, { clutch: 1 });
    r.box.request(g);
    r.run(2, (t) => ({ gas: 0.6, clutch: Math.max(0, 1 - t / 0.5) }));
  }
  assert.equal(r.sim.gear, 3);
  assert.ok(r.sim.locked);
  const d = DRIVETRAIN_DEFAULTS;
  const expected = ((r.sim.rpm / (d.gearRatios[2] * d.finalDrive)) * Math.PI * d.tireDiameter * 60) / 1000;
  assert.ok(Math.abs(r.sim.speedKmh - expected) / expected < 0.005, `${r.sim.speedKmh} vs ${expected}`);
  assert.ok(Math.abs(r.sim.speedForRpm(r.sim.rpm, 3) - expected) < 1e-6);
});

test('shifting without the clutch grinds and stays out of gear', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  r.box.request(1);
  r.run(3, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  r.box.request('N');
  const res = r.box.request(2);
  assert.equal(res.ok, false);
  assert.equal(res.grind, true);
  assert.equal(r.sim.gear, 'N');
  assert.equal(r.tracker.grinds, 1);
  assert.equal(r.tracker.records[0].grade, 'Grind');
});

test('a rev-matched clutchless shift is allowed', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  r.box.request(1);
  r.run(3, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  r.box.request('N');
  // Let the engine fall to the 2nd-gear speed, then slot it in.
  const target = r.sim.inputOmegaFor(2) / (Math.PI / 30);
  for (let i = 0; i < 300 && r.sim.rpm > target + 100; i++) r.run(DT, {});
  const res = r.box.request(2);
  assert.equal(res.ok, true);
  assert.equal(res.clutchless, true);
});

test('reverse cannot be selected while rolling forward', () => {
  const r = rig();
  r.run(0.5, { clutch: 1 });
  r.box.request(1);
  r.run(2, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  r.run(0.2, { clutch: 1 });
  r.box.request('N');
  const res = r.box.request('R');
  assert.equal(res.grind, true);
  assert.equal(r.sim.gear, 'N');
});

test('manual shifts are scored and a smooth shift beats a sloppy one', () => {
  const smooth = rig();
  smooth.run(0.5, { clutch: 1 });
  smooth.box.request(1);
  smooth.run(2.4, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  // Clutch in, select 2nd, let the revs fall to road speed, then feed it in.
  smooth.run(0.1, { clutch: 1 });
  smooth.box.request(2);
  const target = () => smooth.sim.inputOmegaFor(2) / (Math.PI / 30);
  for (let i = 0; i < 120 && smooth.sim.rpm > target() + 250; i++) smooth.run(DT, { clutch: 1 });
  smooth.run(1.5, (t) => ({ gas: Math.min(1, t * 3), clutch: Math.max(0, 1 - t / 0.3) }));

  const sloppy = rig();
  sloppy.run(0.5, { clutch: 1 });
  sloppy.box.request(1);
  sloppy.run(2.4, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  sloppy.run(0.12, { clutch: 1, gas: 1 });
  sloppy.box.request(2);
  // Keeps the engine screaming at the limiter while the clutch comes up slowly.
  sloppy.run(3, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 1.6) }));

  const a = smooth.tracker.shiftRecords[0];
  const b = sloppy.tracker.shiftRecords[0];
  assert.ok(a && b, 'both shifts recorded');
  assert.equal(a.from, 1);
  assert.equal(a.to, 2);
  assert.ok(a.score > b.score, `smooth ${a.score} vs sloppy ${b.score}`);
});

test('automatic mode upshifts near 6200 rpm and reaches 100 km/h without stalling', () => {
  const r = rig();
  r.box.setMode('auto');
  r.box.request(1);
  const ups = [];
  let gear = r.sim.gear;
  for (let i = 0; i < 25 / DT; i++) {
    const before = r.sim.rpm;
    r.run(DT, { gas: 1 });
    if (r.sim.gear !== gear) {
      if (typeof gear === 'number' && r.sim.gear === gear + 1) ups.push(before);
      gear = r.sim.gear;
    }
  }
  assert.ok(!stalled(r.events));
  assert.ok(ups.length >= 3, `upshifts: ${ups.length}`);
  for (const rpm of ups) assert.ok(rpm > 5800 && rpm < r.profile.redlineRpm, `upshift at ${rpm}`);
  assert.ok(r.stats.bestZeroToHundred > 3 && r.stats.bestZeroToHundred < 7, `0–100 ${r.stats.bestZeroToHundred}`);
  assert.ok(r.stats.peakRpm < r.profile.redlineRpm + 150);
  assert.ok(r.stats.topSpeedKmh > 200);
});

test('automatic mode downshifts below 2000 rpm and idles at a stop', () => {
  const r = rig();
  r.box.setMode('auto');
  r.box.request(1);
  r.run(14, { gas: 1 });
  assert.ok(r.sim.gear >= 4);
  const downs = [];
  let gear = r.sim.gear;
  for (let i = 0; i < 70 / DT; i++) {
    const inRpm = Math.abs(r.sim.inputOmegaFor(gear)) / (Math.PI / 30);
    r.run(DT, { brake: i * DT > 25 ? 0.5 : 0 });
    if (r.sim.gear !== gear) {
      // Lifting off can trigger an economy upshift first; only downshifts are checked here.
      if (r.sim.gear < gear) downs.push(inRpm);
      gear = r.sim.gear;
    }
  }
  assert.ok(!stalled(r.events));
  assert.equal(r.sim.gear, 1);
  assert.ok(r.sim.speedKmh < 0.5);
  assert.ok(Math.abs(r.sim.rpm - r.profile.idleRpm) < 60);
  assert.ok(downs.length >= 3, `downshifts: ${downs.length}`);
  for (const rpm of downs) assert.ok(rpm < 2050, `downshift at ${rpm}`);
});

test('torque and power curves peak where expected', () => {
  const p = buildProfile(DEFAULT_SETTINGS);
  let best = { t: 0, rpm: 0 };
  let bestP = { hp: 0, rpm: 0 };
  for (let rpm = 1000; rpm <= p.redlineRpm; rpm += 50) {
    const t = wotTorque(p, rpm);
    if (t > best.t) best = { t, rpm };
    const hp = powerHp(t, rpm);
    if (hp > bestP.hp) bestP = { hp, rpm };
  }
  assert.ok(Math.abs(best.t - p.peakTorqueNm) < 1);
  assert.ok(bestP.rpm > best.rpm, 'peak power comes after peak torque');
  // An oversquare engine makes its peak torque higher in the rev range.
  const over = buildProfile({ ...DEFAULT_SETTINGS, boreStroke: 1.35 });
  let overPeak = { t: 0, rpm: 0 };
  for (let rpm = 1000; rpm <= over.redlineRpm; rpm += 50) {
    const t = wotTorque(over, rpm);
    if (t > overPeak.t) overPeak = { t, rpm };
  }
  assert.ok(overPeak.rpm > best.rpm);
});

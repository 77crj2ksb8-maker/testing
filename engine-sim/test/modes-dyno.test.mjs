// Dyno maths against a full-throttle pull on the real simulator: the torque
// rebuilt from roller acceleration must match the crank torque the
// simulator actually produced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS, DRIVETRAIN_DEFAULTS, peakFigures, wotTorque, powerHp } from '../src/config.js';
import { Drivetrain, RPM_TO_RAD } from '../src/physics.js';
import { garagePatch } from '../src/presets.js';
import {
  rollerDrive, dynoConfig, crankTorqueFromRoller, DynoRecorder, DYNO_GEAR, pullStartRpm, pullEndRpm,
  smoothSeries, curvePeaks, rpmFromRoller,
} from '../src/modes/dyno.js';

const DT = 1 / 120;

/** Full-throttle 4th-gear pull on the rollers from the start rpm to just short of the limiter. */
function pull(patch = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...patch };
  const profile = buildProfile(settings);
  const drive = rollerDrive({ ...DRIVETRAIN_DEFAULTS, gearRatios: [...DRIVETRAIN_DEFAULTS.gearRatios] }, peakFigures(profile).nm);
  const sim = new Drivetrain(profile, drive);
  sim.configure(settings);
  const cfg = dynoConfig(drive, profile);
  const start = pullStartRpm(profile);
  sim.setGear(DYNO_GEAR);
  sim.omega = start * RPM_TO_RAD;
  sim.v = (sim.omega / cfg.ratio) * cfg.wheelRadius;
  sim.locked = true;
  sim.clutchPedal = 0;
  sim.throttleInput = 1;
  const rec = new DynoRecorder();
  rec.reset(cfg);
  const engineTorque = [];
  let unlocked = 0;
  const end = pullEndRpm(profile);
  while (sim.rpm < end && sim.time < 60) {
    sim.step(DT);
    if (!sim.locked) unlocked++;
    rec.push(sim.time, sim.v, sim.rpm);
    engineTorque.push(sim.engineTorque);
  }
  return { profile, drive, sim, cfg, rec, engineTorque, start, end, unlocked };
}

test('dyno: roller drive has no road losses and sizes the rollers to the engine', () => {
  const big = buildProfile(garagePatch('v12-65'));
  const small = buildProfile(garagePatch('vtwin-cruiser'));
  const d = { ...DRIVETRAIN_DEFAULTS };
  const rb = rollerDrive(d, peakFigures(big).nm);
  const rs = rollerDrive(d, peakFigures(small).nm);
  for (const r of [rb, rs]) {
    assert.equal(r.dragArea, 0);
    assert.equal(r.rollingCoeff, 0);
    assert.ok(r.tractionLimit > 1e6);
    assert.deepEqual(r.gearRatios, d.gearRatios);
    assert.equal(r.finalDrive, d.finalDrive);
    assert.equal(r.tireDiameter, d.tireDiameter);
  }
  assert.ok(rb.vehicleMass > rs.vehicleMass, 'more torque, heavier rollers');
  assert.notEqual(rb.gearRatios, d.gearRatios, 'gear array is copied');
});

test('dyno: crank torque formula inverts the locked drivetrain equation', () => {
  const profile = buildProfile(DEFAULT_SETTINGS);
  const drive = rollerDrive({ ...DRIVETRAIN_DEFAULTS }, 600);
  const c = dynoConfig(drive, profile);
  const Te = 450;
  // physics.js, locked: a = (Te·G·η/r) / (m + I·G²·η/r²)
  const a = ((Te * c.ratio * c.efficiency) / c.wheelRadius) / (c.rollerMass + (c.engineInertia * c.ratio * c.ratio * c.efficiency) / (c.wheelRadius ** 2));
  assert.ok(Math.abs(crankTorqueFromRoller(a, c) - Te) < 1e-9);
  assert.ok(Math.abs(rpmFromRoller((3000 * RPM_TO_RAD / c.ratio) * c.wheelRadius, c) - 3000) < 1e-9);
});

test('dyno: measured torque tracks the simulator across a naturally aspirated pull', () => {
  const { rec, engineTorque, start, end, unlocked, sim, profile } = pull();
  assert.equal(unlocked, 0, 'clutch stays locked through the pull');
  assert.ok(sim.time > 4 && sim.time < 20, `pull takes a sensible time (${sim.time.toFixed(1)} s)`);
  let worst = 0;
  let checked = 0;
  for (let i = 0; i < rec.n; i++) {
    if (rec.t[i] - rec.t[0] < 0.35 || rec.t[rec.n - 1] - rec.t[i] < 0.15) continue; // throttle opening / end of record
    const nm = rec.torqueAt(i);
    const err = Math.abs(nm - engineTorque[i]) / engineTorque[i];
    worst = Math.max(worst, err);
    checked++;
  }
  assert.ok(checked > 300, 'checked the sweep');
  assert.ok(worst < 0.05, `worst error ${(worst * 100).toFixed(2)} %`);

  const result = rec.finish({ fromRpm: start + 200, toRpm: end });
  assert.ok(result.points.length > 20, 'binned curve');
  assert.ok(result.points[0].rpm >= start + 200 && result.points.at(-1).rpm <= end + 50);
  // Peaks of the binned curve sit near the simulator's own net torque peak.
  let simPeak = 0;
  for (let rpm = start + 200; rpm <= end; rpm += 50) {
    const net = wotTorque(profile, rpm) - sim.lossTorque(rpm, 1);
    simPeak = Math.max(simPeak, net);
  }
  assert.ok(Math.abs(result.peakNm - simPeak) / simPeak < 0.05, `peak ${result.peakNm.toFixed(0)} vs ${simPeak.toFixed(0)} Nm`);
  // Power uses the same horsepower as the rest of the app, and the peak is the curve's maximum.
  for (const p of result.points) assert.ok(Math.abs(p.hp - powerHp(p.nm, p.rpm)) < 1e-9, `hp at ${p.rpm}`);
  const best = result.points.reduce((a, p) => (p.hp > a.hp ? p : a));
  assert.equal(result.peakHp, best.hp);
  assert.equal(result.peakHpRpm, best.rpm);
  assert.ok(result.peakHpRpm > result.peakNmRpm, 'peak power comes above peak torque');
});

test('dyno: live curve grows during the pull without exceeding its buffers', () => {
  const { rec } = pull({ preset: 'i4', cylinders: 4 });
  const n = rec.n;
  // Replay the samples into a fresh recorder the way the feature does, frame by frame.
  const live = new DynoRecorder();
  live.reset(rec.config);
  let added = 0;
  for (let i = 0; i < n; i++) {
    live.push(rec.t[i], rec.v[i], rec.rpm[i]);
    if (i % 2 === 0 && live.updateLive()) added++;
  }
  assert.ok(added > 10);
  assert.ok(live.liveN > 50 && live.liveN < live.liveRpm.length);
  for (let i = 1; i < live.liveN; i++) assert.ok(live.liveRpm[i] > live.liveRpm[i - 1], 'rpm rises along the live curve');
});

test('dyno: a turbo pull reads below the steady-state spec until it spools', () => {
  const { rec, start, end, profile, sim } = pull(garagePatch('turbo-i6'));
  const result = rec.finish({ fromRpm: start + 200, toRpm: end });
  // Compare with the steady-state net crank torque (spec minus friction).
  const ratio = (p) => p.nm / (wotTorque(profile, p.rpm) - sim.lossTorque(p.rpm, 1));
  const ratios = result.points.map(ratio);
  assert.ok(Math.max(...ratios) < 1.03, 'never reads above steady state');
  assert.ok(Math.min(...ratios.slice(0, 15)) < 0.95, `spool lag shows low down (min ${Math.min(...ratios).toFixed(2)})`);
  assert.ok(Math.abs(ratios.at(-1) - 1) < 0.03, 'on full boost it reads the steady-state figure');
});

test('dyno: smoothing and peaks', () => {
  assert.deepEqual(smoothSeries([0, 3, 0, 3], 1), [1.5, 1, 2, 1.5]);
  const peaks = curvePeaks([{ rpm: 3000, nm: 400, hp: 171 }, { rpm: 5000, nm: 380, hp: 270 }, { rpm: 6000, nm: 300, hp: 256 }]);
  assert.deepEqual(peaks, { peakNm: 400, peakNmRpm: 3000, peakHp: 270, peakHpRpm: 5000 });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfile, DEFAULT_SETTINGS, DRIVETRAIN_DEFAULTS, PRESETS, PRESET_ORDER, layoutOf, firingOrderLabel, naTorque, wotTorque,
} from '../src/config.js';
import { cylinderPose, firingsBetween } from '../src/kinematics.js';
import { Drivetrain } from '../src/physics.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const profile = (preset, cylinders, extra = {}) => buildProfile({ ...DEFAULT_SETTINGS, preset, cylinders, ...extra });
const mod = (a, n) => ((a % n) + n) % n;
const angleGap = (a, b) => {
  const d = mod(a - b, 360);
  return Math.min(d, 360 - d);
};
// Order in which cylinders reach firing TDC over one 720° cycle.
const sequence = (p) => firingsBetween(-1e-6, 720 - 1e-6, p.cylinders.map((c) => c.fireDeg)).map((f) => p.cylinders[f.index].num);

test('original five presets keep their order; new layouts are appended', () => {
  assert.deepEqual(PRESET_ORDER.slice(0, 5), ['v8-cross', 'v8-flat', 'i4', 'v6', 'rotary']);
  for (const id of ['boxer', 'vtwin']) assert.ok(PRESET_ORDER.includes(id), id);
  for (const id of PRESET_ORDER) assert.ok(PRESETS[id], id);
  assert.deepEqual(PRESETS.boxer.counts, [4, 6]);
});

test('every profile reports its layout family', () => {
  const want = { v: 'v', inline: 'inline', rotary: 'rotary', boxer: 'boxer', vtwin: 'vtwin' };
  for (const [id, def] of Object.entries(PRESETS)) {
    for (const n of def.counts) {
      const p = profile(id, n);
      assert.equal(p.layout, want[def.family], `${id} ${n}`);
      assert.equal(layoutOf(p), p.layout);
    }
  }
  // Profiles without the field (older data) derive it.
  assert.equal(layoutOf({ kind: 'rotary' }), 'rotary');
  assert.equal(layoutOf({ kind: 'piston', banks: 2 }), 'v');
  assert.equal(layoutOf({ kind: 'piston', banks: 1 }), 'inline');
});

function checkBoxer(p, order) {
  assert.equal(p.layout, 'boxer');
  assert.equal(p.banks, 2);
  assert.deepEqual(p.firingOrder, order);
  assert.deepEqual(sequence(p), order);
  const n = order.length;
  // Even firing: one cylinder every 720/n degrees.
  const fires = p.cylinders.map((c) => c.fireDeg).sort((a, b) => a - b);
  fires.forEach((f, i) => assert.ok(near(f, (i * 720) / n), `${p.name}: fire ${f}`));
  // Every cylinder has its own throw; banks lie flat, 180° apart.
  assert.equal(new Set(p.cylinders.map((c) => c.throwIndex)).size, n);
  for (const c of p.cylinders) assert.equal(Math.abs(c.bankDeg), 90);
  // Opposed pairs sit on neighbouring throws 180° apart, so the pistons move in and out together.
  const byThrow = [...p.cylinders].sort((a, b) => a.throwIndex - b.throwIndex);
  for (let t = 0; t < n; t += 2) {
    const [a, b] = [byThrow[t], byThrow[t + 1]];
    assert.notEqual(a.bank, b.bank, `${p.name}: throws ${t}/${t + 1} share a bank`);
    assert.ok(near(angleGap(a.pinDeg, b.pinDeg), 180), `${p.name}: pins ${a.pinDeg} / ${b.pinDeg}`);
    for (let theta = 0; theta < 720; theta += 15) {
      const pa = cylinderPose(a, theta, 1, 3.4).pY;
      const pb = cylinderPose(b, theta, 1, 3.4).pY;
      assert.ok(near(pa, pb, 1e-9), `${p.name} cyl ${a.num}/${b.num} at ${theta}°`);
    }
  }
  // Each piston is at the top exactly at its firing angle.
  for (const c of p.cylinders) assert.ok(near(cylinderPose(c, c.fireDeg, 1, 3.4).pY, 4.4));
}

test('boxer-4: firing order 1-3-2-4, 180° even fire, opposed pairs 180° apart', () => {
  const p = profile('boxer', 4);
  checkBoxer(p, [1, 3, 2, 4]);
  assert.equal(p.name, 'Boxer-4');
  assert.equal(firingOrderLabel(p), '1-3-2-4');
});

test('flat-6: firing order 1-6-2-4-3-5, 120° even fire, opposed pairs 180° apart', () => {
  const p = profile('boxer', 6);
  checkBoxer(p, [1, 6, 2, 4, 3, 5]);
  assert.equal(p.name, 'Flat-6');
  // Bank A holds 1-2-3, bank B 4-5-6.
  assert.deepEqual(p.cylinders.filter((c) => c.bank === 0).map((c) => c.num), [1, 2, 3]);
});

test('45° V-twin: rods share one crank pin and fire 315° then 405° apart', () => {
  const p = profile('vtwin', 2);
  assert.equal(p.layout, 'vtwin');
  assert.equal(p.vAngle, 45);
  assert.equal(p.cylinders.length, 2);
  const [a, b] = p.cylinders;
  assert.equal(a.throwIndex, b.throwIndex, 'one throw');
  assert.ok(near(mod(a.pinDeg, 360), mod(b.pinDeg, 360)), 'shared pin');
  assert.ok(near(Math.abs(a.bankDeg - b.bankDeg), 45));
  assert.deepEqual([a.fireDeg, b.fireDeg], [0, 315]);
  const fires = firingsBetween(-1e-6, 1440 - 1e-6, [a.fireDeg, b.fireDeg]).map((f) => f.at);
  const gaps = fires.slice(1).map((f, i) => f - fires[i]);
  assert.deepEqual(gaps, [315, 405, 315]);
  // Both pistons hit TDC at their firing angle, and both rods ride the same pin position.
  for (const c of p.cylinders) assert.ok(near(cylinderPose(c, c.fireDeg, 1, 3.4).pY, 4.4));
  for (let theta = 0; theta < 720; theta += 20) {
    const pa = cylinderPose(a, theta, 1, 3.4).pin;
    const pb = cylinderPose(b, theta, 1, 3.4).pin;
    assert.ok(near(pa[0], pb[0]) && near(pa[1], pb[1]));
  }
  assert.match(firingOrderLabel(p), /315°\/405°/);
  // One shared collector for both pipes.
  assert.equal(p.exhaust.banks.length, 1);
});

test('displacementL override scales torque, geometry, friction and inertia', () => {
  const base = profile('v8-cross', 8);
  const big = profile('v8-cross', 8, { displacementL: 7.5 });
  assert.ok(near(big.displacementL, 7.5, 1e-9));
  assert.ok(near(big.peakTorqueNm / base.peakTorqueNm, 7.5 / base.displacementL, 1e-9));
  assert.ok(big.inertia > base.inertia);
  assert.ok(big.boreMm > base.boreMm && big.strokeMm > base.strokeMm);
  const swept = (big.cylinders.length * Math.PI * (big.boreMm / 2) ** 2 * big.strokeMm) / 1e6;
  assert.ok(near(swept, 7.5, 1e-6), `swept ${swept}`);
  const simBase = new Drivetrain(base, { ...DRIVETRAIN_DEFAULTS });
  const simBig = new Drivetrain(big, { ...DRIVETRAIN_DEFAULTS });
  assert.ok(simBig.lossTorque(3000, 0.2) > simBase.lossTorque(3000, 0.2));
  // Rotaries scale per rotor; null and nonsense fall back to the layout default.
  assert.ok(near(profile('rotary', 2, { displacementL: 1.6 }).displacementL, 1.6, 1e-9));
  assert.equal(profile('v8-cross', 8, { displacementL: null }).displacementL, base.displacementL);
  assert.equal(profile('v8-cross', 8, { displacementL: -2 }).displacementL, base.displacementL);
});

test('wotTorque includes steady boost; naTorque does not', () => {
  const na = profile('v8-cross', 8);
  const turbo = profile('v8-cross', 8, { induction: 'turbo', boostBar: 1 });
  const sc = profile('v8-cross', 8, { induction: 'supercharger', boostBar: 1 });
  assert.equal(na.induction.kind, 'na');
  assert.deepEqual(turbo.induction, { kind: 'turbo', targetBar: 1 });
  for (const rpm of [1500, 3000, 5000, 6500]) assert.ok(near(wotTorque(na, rpm), naTorque(na, rpm)));
  // Fully spooled: torque × (1 + 0.85 · boost).
  assert.ok(near(wotTorque(turbo, 5000) / naTorque(turbo, 5000), 1.85, 1e-6));
  // Below the boost threshold a turbo makes little more than the NA engine.
  assert.ok(wotTorque(turbo, 1000) / naTorque(turbo, 1000) < 1.1);
  // The blower pulls from low rpm but costs drive torque.
  assert.ok(wotTorque(sc, 2000) > wotTorque(turbo, 2000));
  assert.ok(wotTorque(sc, 6500) < naTorque(sc, 6500) * 1.85);
  // Boosted engines run lower compression.
  assert.ok(turbo.compressionRatio < na.compressionRatio);
  // Invalid induction falls back to NA; boost is clamped.
  assert.equal(profile('i4', 4, { induction: 'nitrous' }).induction.kind, 'na');
  assert.equal(profile('i4', 4, { induction: 'turbo', boostBar: 9 }).induction.targetBar, 2);
});

test('variable valve lift: low cam fills early, high cam pulls on top', () => {
  const p = profile('i4', 4, { vvlRpm: 5500, redlineRpm: 8500 });
  assert.equal(p.vvlRpm, 5500);
  assert.ok(naTorque(p, 3000, false) > naTorque(p, 3000, true));
  assert.ok(naTorque(p, 8000, true) > naTorque(p, 8000, false));
  // Steady-state curve uses the high cam from vvlRpm up.
  assert.ok(near(wotTorque(p, 7000), naTorque(p, 7000, true)));
  assert.ok(near(wotTorque(p, 4000), naTorque(p, 4000, false)));
  // Rotaries have no poppet valves; a switch point outside the rev range is clamped.
  assert.equal(profile('rotary', 2, { vvlRpm: 5000 }).vvlRpm, null);
  assert.ok(profile('i4', 4, { vvlRpm: 20000 }).vvlRpm < p.redlineRpm);
});

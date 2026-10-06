import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS, PRESETS } from '../src/config.js';
import {
  pistonPosition, cylinderPose, epitrochoid, rotorPose, firingsBetween, degreesSinceFiring, DEG,
} from '../src/kinematics.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const profile = (preset, cylinders) => buildProfile({ ...DEFAULT_SETTINGS, preset, cylinders });

test('slider-crank formula: TDC, BDC and stroke', () => {
  const r = 0.045;
  const L = 0.153;
  assert.ok(near(pistonPosition(0, r, L), r + L));
  assert.ok(near(pistonPosition(Math.PI, r, L), L - r));
  // Stroke is exactly twice the crank radius.
  assert.ok(near(pistonPosition(0, r, L) - pistonPosition(Math.PI, r, L), 2 * r));
  // Matches pY = r·cos θ + sqrt(L² − (r·sin θ)²) at an arbitrary angle.
  const t = 1.234;
  assert.ok(near(pistonPosition(t, r, L), r * Math.cos(t) + Math.sqrt(L * L - (r * Math.sin(t)) ** 2)));
});

test('connecting rod length stays constant for every cylinder of every layout', () => {
  for (const [preset, def] of Object.entries(PRESETS)) {
    if (def.family === 'rotary') continue;
    for (const n of def.counts) {
      const p = profile(preset, n);
      const r = 1;
      const L = 1.7 * 2 * r;
      for (const cyl of p.cylinders) {
        for (let theta = 0; theta < 720; theta += 7) {
          const { pin, piston } = cylinderPose(cyl, theta, r, L);
          const len = Math.hypot(piston[0] - pin[0], piston[1] - pin[1]);
          assert.ok(near(len, L, 1e-9), `${p.name} cyl ${cyl.num} at ${theta}°: rod ${len}`);
        }
      }
    }
  }
});

test('each cylinder reaches TDC exactly at its firing angle', () => {
  for (const preset of ['v8-cross', 'v8-flat', 'i4', 'v6']) {
    const p = profile(preset, PRESETS[preset].family === 'inline' ? 4 : preset === 'v6' ? 6 : 8);
    for (const cyl of p.cylinders) {
      const { pY } = cylinderPose(cyl, cyl.fireDeg, 1, 3.4);
      assert.ok(near(pY, 1 + 3.4, 1e-9), `${p.name} cyl ${cyl.num}`);
    }
  }
});

test('firing sequence follows the configured firing order with even spacing', () => {
  const cases = {
    'v8-cross': [1, 8, 4, 3, 6, 5, 7, 2],
    'v8-flat': [1, 8, 3, 6, 4, 5, 2, 7],
    i4: [1, 3, 4, 2],
    v6: [1, 2, 3, 4, 5, 6],
  };
  for (const [preset, order] of Object.entries(cases)) {
    const p = profile(preset, order.length);
    const fires = p.cylinders.map((c) => c.fireDeg);
    const events = firingsBetween(-0.5, 719.5, fires);
    assert.deepEqual(events.map((e) => p.cylinders[e.index].num), order, p.name);
    events.forEach((e, i) => assert.ok(near(e.at, (i * 720) / order.length, 1e-9)));
  }
});

test('V engines that share crank pins get the same pin angle for each pair', () => {
  for (const [preset, n] of [['v8-cross', 8], ['v8-flat', 8], ['v8-cross', 10], ['v8-cross', 12]]) {
    const p = profile(preset, n);
    const byThrow = new Map();
    for (const c of p.cylinders) {
      if (!byThrow.has(c.throwIndex)) byThrow.set(c.throwIndex, []);
      byThrow.get(c.throwIndex).push(c.pinDeg);
    }
    for (const [t, pins] of byThrow) assert.equal(pins[0], pins[1], `${p.name} throw ${t}: ${pins}`);
  }
});

test('crank throw layouts match the real crankshafts', () => {
  const throwAngles = (p) => {
    const seen = new Map();
    for (const c of p.cylinders) if (!seen.has(c.throwIndex)) seen.set(c.throwIndex, c.pinDeg);
    const base = seen.get(0);
    return [...seen.values()].map((a) => (((a - base) % 360) + 360) % 360);
  };
  assert.deepEqual(throwAngles(profile('v8-cross', 8)).sort((a, b) => a - b), [0, 90, 180, 270]);
  assert.deepEqual(throwAngles(profile('v8-flat', 8)), [0, 180, 180, 0]);
  assert.deepEqual(throwAngles(profile('i4', 4)), [0, 180, 180, 0]);
  assert.deepEqual(throwAngles(profile('i4', 6)), [0, 240, 120, 120, 240, 0]);
  // 60° V6: split pins 60° apart within each throw.
  const v6 = profile('v6', 6);
  for (let t = 0; t < 3; t++) {
    const [a, b] = v6.cylinders.filter((c) => c.throwIndex === t).map((c) => c.pinDeg);
    assert.equal(Math.min(Math.abs(a - b), 360 - Math.abs(a - b)), 60);
  }
});

test('firingsBetween handles wrap-around and multiple cycles', () => {
  const ev = firingsBetween(700, 1460, [0, 360]);
  assert.deepEqual(ev.map((e) => e.at), [720, 1080, 1440]);
  assert.equal(firingsBetween(10, 10, [0]).length, 0);
  assert.ok(near(degreesSinceFiring(90, 80), 710));
});

test('Wankel rotor apexes always ride on the epitrochoid bore', () => {
  const R = 1;
  const e = 0.15;
  for (let shaft = 0; shaft < 1080; shaft += 13) {
    const { apexes, rotation } = rotorPose(shaft, 0, R, e);
    apexes.forEach(([x, y], k) => {
      const [ex, ey] = epitrochoid(rotation + (k * 2 * Math.PI) / 3, R, e);
      assert.ok(near(x, ex, 1e-9) && near(y, ey, 1e-9));
    });
  }
  // The rotor turns once for every three turns of the eccentric shaft.
  assert.ok(near(rotorPose(1080, 0, R, e).rotation, 2 * Math.PI));
  assert.ok(near(rotorPose(360, 0, R, e).rotation, (360 * DEG) / 3));
});

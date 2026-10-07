import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS } from '../src/config.js';
import {
  VALVE_EVENTS, INTAKE_PEAK, EXHAUST_PEAK, INTAKE_DURATION, EXHAUST_DURATION, valveLift, intakeLift, exhaustLift,
  camRotationDeg, camLobeAngle, lobeOffsetDeg, lobeLift, strokeIndex, strokeProgress, STROKES, gasColor, heatColor,
  egtHeat, easeInOutCubic, lerpOrbit, shakeNoise, rotaryPortFlow, wrapSigned,
} from '../src/scene/timing.js';
import {
  layoutOf, bankList, exhaustSide, bankToEngine, cylinderPlacement, explodeOffset, chainPath, pointOnPath,
} from '../src/scene/layout.js';
import { initialQuality, adaptQuality, SLOW_MS, FAST_MS } from '../src/scene/quality.js';
import { acesFilmic, untoneMapped } from '../src/scene/tonemap.js';
import { headDims } from '../src/scene/layout.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const profile = (preset, cylinders) => buildProfile({ ...DEFAULT_SETTINGS, preset, cylinders });

// A boxer-4 built by hand (bank A on +X, bank B on −X, one throw per cylinder,
// opposed pairs 180° apart), without a `layout` field, as the renderer may get it.
function syntheticBoxer() {
  const order = [1, 3, 2, 4];
  const cylinders = [1, 2, 3, 4].map((num) => {
    const bank = num % 2 ? 0 : 1;
    const bankDeg = bank ? -90 : 90;
    const fireDeg = order.indexOf(num) * 180;
    return { num, bank, bankDeg, throwIndex: num - 1, slot: 0, fireDeg, pinDeg: (((bankDeg - fireDeg) % 360) + 360) % 360 };
  });
  return { kind: 'piston', banks: 2, cylinders, firingOrder: order };
}

test('valve events follow the four-stroke timing and lift peaks mid-event', () => {
  assert.deepEqual({ ...VALVE_EVENTS }, { evo: 130, evc: 375, ivo: 345, ivc: 590 });
  assert.equal(intakeLift(VALVE_EVENTS.ivo), 0);
  assert.ok(near(intakeLift(INTAKE_PEAK), 1));
  assert.ok(near(exhaustLift(EXHAUST_PEAK), 1));
  assert.equal(intakeLift(100), 0, 'intake shut on the power stroke');
  assert.equal(exhaustLift(450), 0, 'exhaust shut on the intake stroke');
  // Overlap around exhaust TDC (360): both valves slightly open.
  assert.ok(intakeLift(360) > 0 && exhaustLift(360) > 0);
  assert.ok(intakeLift(360) < 0.1 && exhaustLift(360) < 0.1);
  // Wraps across 720.
  assert.ok(near(valveLift(700, 650, 770), valveLift(-20, 650, 770)));
});

test('cams turn at half crank speed in the crank direction', () => {
  assert.equal(camRotationDeg(0), -0);
  assert.equal(camRotationDeg(720), -360);
  assert.equal(camRotationDeg(90), -45);
});

test('every cam lobe points at its follower exactly at peak lift, for every cylinder', () => {
  for (const p of [profile('v8-cross', 8), profile('i4', 4), profile('v8-flat', 12), syntheticBoxer()]) {
    for (const c of p.cylinders) {
      for (const [peak, dur, lift] of [[INTAKE_PEAK, INTAKE_DURATION, intakeLift], [EXHAUST_PEAK, EXHAUST_DURATION, exhaustLift]]) {
        for (const follower of [-90, -78, -102]) {
          const lobe = camLobeAngle(c.fireDeg, peak, follower);
          assert.ok(near(lobeOffsetDeg(lobe, c.fireDeg + peak, follower), 0, 1e-9), `cyl ${c.num} nose on follower`);
          // The lobe profile the follower rides matches the valve curve at every crank angle.
          for (let crank = 0; crank < 1440; crank += 7) {
            const fromCam = lobeLift(lobeOffsetDeg(lobe, crank, follower), dur);
            const fromValve = lift(crank - c.fireDeg);
            assert.ok(near(fromCam, fromValve, 1e-9), `cyl ${c.num} crank ${crank}: cam ${fromCam} vs valve ${fromValve}`);
          }
        }
      }
    }
  }
});

test('stroke index and progress walk power → exhaust → intake → compression', () => {
  assert.equal(STROKES[strokeIndex(10)].id, 'power');
  assert.equal(STROKES[strokeIndex(200)].id, 'exhaust');
  assert.equal(STROKES[strokeIndex(400)].id, 'intake');
  assert.equal(STROKES[strokeIndex(700)].id, 'compression');
  assert.equal(STROKES[strokeIndex(-10)].id, 'compression');
  assert.ok(near(strokeProgress(270), 0.5));
});

test('gas colours: flame on power, blue intake, thinner charge at closed throttle', () => {
  const out = [0, 0, 0, 0, 0];
  gasColor(10, 1, true, out);
  assert.ok(out[0] > 0.9 && out[4] > 0.8 && out[0] > out[2], 'power stroke glows orange');
  gasColor(10, 1, false, out);
  assert.ok(out[4] < 0.1, 'no flame without combustion');
  gasColor(450, 1, true, out);
  assert.ok(out[2] > out[0], 'intake is blue');
  const full = gasColor(450, 1, true, [0, 0, 0, 0, 0])[3];
  const closed = gasColor(450, 0, true, [0, 0, 0, 0, 0])[3];
  assert.ok(closed < full);
  for (let d = 0; d < 720; d += 5) {
    gasColor(d, 0.5, true, out);
    for (const v of out) assert.ok(v >= 0 && v <= 1.0001, `channel in range at ${d}`);
  }
  // Continuous across the 720 → 0 wrap.
  const a = gasColor(719.9, 1, false, [0, 0, 0, 0, 0]);
  const b = gasColor(0, 1, false, [0, 0, 0, 0, 0]);
  for (let i = 0; i < 5; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.02);
});

test('exhaust heat ramps from dark to white-hot with EGT', () => {
  assert.equal(egtHeat(350), 0);
  assert.equal(egtHeat(undefined), 0);
  assert.equal(egtHeat(2000), 1);
  const cool = heatColor(0, [0, 0, 0]);
  const hot = heatColor(1, [0, 0, 0]);
  assert.deepEqual(cool, [0, 0, 0]);
  assert.ok(hot[0] === 1 && hot[1] > 0.5 && hot[2] > 0.2);
  const mid = heatColor(0.55, [0, 0, 0]);
  assert.ok(mid[0] > mid[1] && mid[1] > mid[2], 'orange in the middle');
});

test('rotary ports: intake and exhaust flow never exceed full and both phases occur', () => {
  const out = [0, 0];
  let sawIntake = false;
  let sawExhaust = false;
  for (let d = 0; d < 360; d += 3) {
    rotaryPortFlow(d, out);
    assert.ok(out[0] >= 0 && out[0] <= 1.0001 && out[1] >= 0 && out[1] <= 1.0001);
    if (out[0] > 0.5) sawIntake = true;
    if (out[1] > 0.5) sawExhaust = true;
  }
  assert.ok(sawIntake && sawExhaust);
});

test('motion helpers: easing, shortest-way orbit, bounded shake', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.ok(near(easeInOutCubic(0.5), 0.5));
  const o = lerpOrbit({ radius: 1, theta: 3, phi: 1 }, { radius: 3, theta: -3, phi: 0.5 }, 0.5, {});
  // 3 → −3 rad goes the short way through π, not back through 0.
  assert.ok(Math.abs(Math.abs(o.theta) - Math.PI) < 0.01, `theta ${o.theta}`);
  assert.equal(o.radius, 2);
  for (let t = 0; t < 5; t += 0.013) assert.ok(Math.abs(shakeNoise(t, 3)) <= 1);
  assert.equal(wrapSigned(190), -170);
});

test('layout is derived when the profile does not name it', () => {
  assert.equal(layoutOf(profile('v8-cross', 8)), 'v');
  assert.equal(layoutOf(profile('i4', 4)), 'inline');
  assert.equal(layoutOf(profile('rotary', 2)), 'rotary');
  assert.equal(layoutOf(syntheticBoxer()), 'boxer');
  assert.equal(layoutOf({ ...syntheticBoxer(), layout: 'boxer' }), 'boxer');
  const twin = { kind: 'piston', banks: 2, cylinders: [{ bank: 0, bankDeg: 22.5 }, { bank: 1, bankDeg: -22.5 }] };
  assert.equal(layoutOf(twin), 'vtwin');
});

test('bank frames: cylinder axis, exhaust side outside the V and under a boxer', () => {
  const out = [0, 0];
  bankToEngine(45, 0, 1, out);
  assert.ok(near(out[0], Math.SQRT1_2) && near(out[1], Math.SQRT1_2), 'local +Y is the bank axis');
  // Bank leaning to +X: exhaust side is outward (+X world, below the axis).
  bankToEngine(45, exhaustSide(45), 0, out);
  assert.ok(out[0] > 0);
  bankToEngine(-45, exhaustSide(-45), 0, out);
  assert.ok(out[0] < 0);
  for (const deg of [90, -90]) {
    bankToEngine(deg, exhaustSide(deg), 0, out);
    assert.ok(near(out[1], -1), `boxer bank ${deg}: exhaust points down`);
  }
  const banks = bankList(syntheticBoxer());
  assert.deepEqual(banks.map((b) => [b.bank, b.bankDeg, b.members]), [[0, 90, [0, 2]], [1, -90, [1, 3]]]);
});

test('cylinder placement: neighbours in a bank never overlap, opposed boxer pistons interleave', () => {
  const B = 1;
  const rodW = 0.24;
  for (const p of [profile('v8-cross', 8), profile('i4', 4), profile('v8-cross', 12), syntheticBoxer()]) {
    const { z, half } = cylinderPlacement(p, B, rodW);
    for (const bank of bankList(p)) {
      const zs = bank.members.map((i) => z[i]).sort((a, b) => a - b);
      for (let k = 1; k < zs.length; k++) assert.ok(zs[k] - zs[k - 1] >= B * 1.15, 'bores clear each other');
    }
    for (const v of z) assert.ok(Math.abs(v) + B * 0.5 < half, 'block covers every bore');
  }
  const boxer = cylinderPlacement(syntheticBoxer(), B, rodW);
  assert.ok(boxer.pitch < 1, 'boxer throws sit closer than one bore');
  assert.ok(new Set(boxer.z).size === 4, 'each boxer cylinder has its own throw');
});

test('exploded view moves heads along the bank axis and the gearbox back', () => {
  const out = [0, 0, 0];
  explodeOffset('head', 90, 1, 1, out);
  assert.ok(out[0] > 1 && near(out[1], 0, 1e-9));
  explodeOffset('head', 0, 0, 1, out);
  assert.deepEqual(out, [0, 0, 0]);
  explodeOffset('gearbox', 0, 1, 1, out);
  assert.ok(out[2] < -1);
  explodeOffset('intake', 30, 0.5, 1, out);
  assert.ok(out[1] > 0 && out[0] === 0);
});

test('timing chain path wraps the sprockets', () => {
  // Two equal sprockets 4 apart: belt length = 2·4 + 2πr.
  const r = 1;
  const path = chainPath([{ x: 0, y: 0, r }, { x: 4, y: 0, r }], 720);
  assert.ok(Math.abs(path.total - (8 + 2 * Math.PI * r)) < 0.01, `length ${path.total}`);
  const p = [0, 0, 0];
  for (let s = 0; s < path.total; s += 0.37) {
    pointOnPath(path, s, p);
    const d = Math.min(Math.hypot(p[0], p[1]), Math.hypot(p[0] - 4, p[1]));
    const onStraight = p[0] >= 0 && p[0] <= 4 && near(Math.abs(p[1]), r, 0.01);
    assert.ok(onStraight || near(d, r, 0.01), `point ${p} on the chain`);
  }
  // Counter-clockwise: the signed area is positive.
  let area = 0;
  for (let i = 0; i < path.n; i++) {
    const j = (i + 1) % path.n;
    area += path.x[i] * path.y[j] - path.x[j] * path.y[i];
  }
  assert.ok(area > 0);
});

test('quality policy: auto drops bloom before resolution and recovers in reverse', () => {
  const q = initialQuality('auto', { dpr: 3, cores: 6, coarse: true });
  assert.equal(q.bloom, true);
  assert.equal(q.pixelRatio, 2);
  assert.equal(adaptQuality(q, SLOW_MS + 10), 'bloom-off');
  assert.equal(q.pixelRatio, 2, 'resolution untouched while bloom can go');
  assert.equal(adaptQuality(q, SLOW_MS + 10), 'resolution');
  assert.equal(q.pixelRatio, 1.75);
  assert.equal(adaptQuality(q, 16), null, 'steady between thresholds');
  assert.equal(adaptQuality(q, FAST_MS - 5), 'resolution');
  assert.equal(adaptQuality(q, FAST_MS - 5), 'bloom-on');
  // A device that keeps failing loses bloom for good after two drops.
  adaptQuality(q, 40);
  adaptQuality(q, 5);
  adaptQuality(q, 5);
  assert.equal(q.bloom, false);
  assert.equal(q.bloomDrops, 2);

  const high = initialQuality('high', { dpr: 2 });
  adaptQuality(high, 60);
  assert.equal(high.bloom, true, 'high keeps bloom');
  assert.equal(high.pixelRatio, 1.75);
  const low = initialQuality('low', { dpr: 3 });
  assert.equal(low.bloom, false);
  assert.equal(low.maxPixelRatio, 1.5);
  adaptQuality(low, 5);
  assert.equal(low.bloom, false, 'low never blooms');
});

test('head layout: each cam sits on its valve axis above the bucket, with clearances', () => {
  const B = 0.93;
  const deck = 2.6;
  const H = headDims(B, deck);
  // Cam centre = valve seat + (stem + bucket + base circle) along the tilted valve axis.
  const reach = H.stemLen + H.bucketH + H.baseR;
  assert.ok(near(H.camX, H.valveX + reach * Math.sin(H.tilt), 1e-12));
  assert.ok(near(H.camY, deck + reach * Math.cos(H.tilt), 1e-12));
  // The two cam sprockets of a bank clear each other; the lobes clear the plug in the middle.
  assert.ok(2 * H.camX > 2 * H.sprocketR, 'sprockets do not overlap');
  assert.ok(H.camX - H.baseR - H.lift > 0.05 * B, 'lobes clear the spark plug');
  // Valve heads fit the bore and do not touch each other.
  assert.ok(Math.hypot(H.valveX, H.valveZ) + 0.17 * B < 0.5 * B);
  assert.ok(2 * H.valveZ > 2 * 0.17 * B);
  // Cam cover encloses the lobes; the ports are on the head wall.
  assert.ok(H.top > H.camY + H.baseR + H.lift);
  assert.ok(near(H.portX, H.width / 2, 1e-12));
  // Springs never fully compress at full lift.
  assert.ok(H.stemLen - H.lift - H.springSeat > 0.2 * B);
});

test('tone-map compensation: the composer background matches the direct path', () => {
  const target = [0.0027, 0.0033, 0.0052]; // #090b10 in linear
  const x = untoneMapped(target, 1.05);
  const y = acesFilmic(x, 1.05, [0, 0, 0]);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(y[c] - target[c]) < 1e-6, `channel ${c}: ${y[c]} vs ${target[c]}`);
  assert.ok(x.every((v) => v >= target[0]), 'ACES darkens shadows, so the input is brighter');
  const white = acesFilmic([20, 20, 20], 1, [0, 0, 0]);
  assert.ok(white.every((v) => v > 0.95), 'highlights roll off to white');
});

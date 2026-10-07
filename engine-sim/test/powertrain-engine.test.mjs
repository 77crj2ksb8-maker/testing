import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Induction, steadyBoostBar, BOV_MIN_BAR } from '../src/induction.js';
import { Thermal, COOLANT_WARN_C } from '../src/thermal.js';
import { rig, rpmOf } from './powertrain-rig.mjs';

const H = 0.002;

// Spin an Induction unit at a fixed rpm and throttle; returns boost samples.
function spin(kind, { rpm = 5000, redline = 7000, plate = 1, seconds = 2, targetBar = 1, from } = {}) {
  const ind = from ?? new Induction({ kind, targetBar });
  const out = [];
  for (let i = 0; i < seconds / H; i++) {
    ind.update(H, rpm, redline, plate, true, 400);
    out.push(ind.boostBar);
  }
  return { ind, out, at: (s) => out[Math.min(out.length - 1, Math.round(s / H) - 1)] };
}

test('a closed throttle pulls manifold vacuum on every engine', () => {
  for (const kind of ['na', 'turbo', 'twin-turbo', 'supercharger']) {
    const { ind } = spin(kind, { rpm: 800, plate: 0.04, seconds: 3 });
    assert.ok(ind.boostBar < -0.45 && ind.boostBar > -0.75, `${kind}: ${ind.boostBar}`);
    if (kind === 'na') assert.equal(ind.turboRpm, 0);
  }
  const r = rig();
  r.run(2);
  assert.ok(r.sim.boostBar < -0.4, `idle manifold ${r.sim.boostBar}`);
  assert.equal(r.sim.inductionKind, 'na');
});

test('turbo: spool lag, then the wastegate holds the target', () => {
  const t = spin('turbo', { seconds: 3 });
  assert.ok(t.at(0.2) < 0.5, `boost after 0.2 s: ${t.at(0.2)}`);
  assert.ok(t.at(1.2) > 0.85, `boost after 1.2 s: ${t.at(1.2)}`);
  assert.ok(Math.max(...t.out) <= 1.0 + 1e-6, 'never overshoots the wastegate');
  assert.ok(Math.abs(t.ind.boostBar - 1) < 0.02);
  assert.ok(t.ind.turboRpm > 150000 && t.ind.turboRpm < 230000, `shaft ${t.ind.turboRpm}`);
  // Twin small turbos spool faster than one big one.
  const tw = spin('twin-turbo', { seconds: 3 });
  assert.ok(tw.at(0.4) > t.at(0.4) + 0.1, `twin ${tw.at(0.4)} vs single ${t.at(0.4)}`);
  // A supercharger is on boost almost at once.
  const sc = spin('supercharger', { seconds: 1 });
  assert.ok(sc.at(0.15) > 0.9, `blower after 0.15 s: ${sc.at(0.15)}`);
  assert.equal(sc.ind.turboRpm, 0);
  assert.ok(sc.ind.parasitic > 0, 'the blower costs crank torque');
});

test('turbo boost threshold: little boost low in the rev range, twin-turbo comes in sooner', () => {
  const lowRpm = 0.25 * 7000;
  const single = spin('turbo', { rpm: lowRpm, seconds: 4 });
  const twin = spin('twin-turbo', { rpm: lowRpm, seconds: 4 });
  assert.ok(single.ind.boostBar < 0.25, `single at 25 %: ${single.ind.boostBar}`);
  assert.ok(twin.ind.boostBar > single.ind.boostBar + 0.15, `twin ${twin.ind.boostBar}`);
  // Steady-state curve agrees with the live model once settled.
  const ind = { kind: 'turbo', targetBar: 1 };
  assert.ok(Math.abs(steadyBoostBar(ind, 5000, 7000) - spin('turbo', { seconds: 4 }).ind.boostBar) < 0.03);
  // Supercharger boost rises with rpm.
  const scInd = { kind: 'supercharger', targetBar: 1 };
  assert.ok(steadyBoostBar(scInd, 1500, 7000) < steadyBoostBar(scInd, 3000, 7000));
});

test('the blow-off valve vents when the throttle snaps shut on boost', () => {
  const t = spin('turbo', { seconds: 2 });
  let vented = 0;
  for (let i = 0; i < 100; i++) vented = Math.max(vented, t.ind.update(H, 5000, 7000, 0, true, 400));
  assert.ok(vented > BOV_MIN_BAR, `vented ${vented}`);
  // Below the threshold nothing vents.
  const soft = spin('turbo', { seconds: 2, targetBar: 0.3, plate: 1 });
  soft.ind.chargeBar = 0.2;
  let none = 0;
  for (let i = 0; i < 100; i++) none = Math.max(none, soft.ind.update(H, 5000, 7000, 0, true, 400));
  assert.equal(none, 0);
  // A blower has a bypass valve instead: no blow-off.
  const sc = spin('supercharger', { seconds: 1 });
  let scVent = 0;
  for (let i = 0; i < 100; i++) scVent = Math.max(scVent, sc.ind.update(H, 5000, 7000, 0, true, 400));
  assert.equal(scVent, 0);
});

test('in the car: boost builds under load, physics uses the live boost, lifting emits bov', () => {
  const r = rig({ induction: 'turbo', boostBar: 1 });
  r.launch(1, 2);
  // Third gear around 3000 rpm, part throttle, then floor it.
  r.run(0.15, { clutch: 1 });
  r.box.request(3);
  r.run(1.5, (t) => ({ gas: 0.2, clutch: Math.max(0, 1 - t / 0.5) }));
  assert.equal(r.sim.gear, 3);
  const early = [];
  r.run(2.5, { gas: 1 }, (sim) => early.push({ boost: sim.boostBar, mult: sim.induction.multiplier, t: sim.time }));
  assert.ok(early[12].boost < 0.5, `boost right after flooring: ${early[12].boost}`);
  assert.ok(early.at(-1).boost > 0.85, `boost after 2.5 s: ${early.at(-1).boost}`);
  assert.ok(early.at(-1).mult > early[12].mult + 0.3, 'torque multiplier follows the live boost');
  assert.ok(r.sim.turboRpm > 100000);
  assert.equal(r.sim.boostTarget, 1);
  r.run(0.4, {});
  const bov = r.of('bov');
  assert.equal(bov.length, 1);
  assert.ok(bov[0].boostBar > 0.6, `bov at ${bov[0].boostBar}`);
});

test('backfires: overrun crackle and limiter pops, reproducible run to run', () => {
  const runOnce = () => {
    const r = rig();
    r.run(1, { gas: 1 });
    r.run(1.5, {});
    return r.of('backfire');
  };
  const a = runOnce();
  const b = runOnce();
  assert.ok(a.some((e) => e.source === 'overrun'), 'overrun pops after lifting');
  assert.ok(a.some((e) => e.source === 'limiter'), 'limiter pops');
  for (const e of a) assert.ok(e.strength >= 0 && e.strength <= 1);
  assert.deepEqual(a, b, 'seeded PRNG gives identical runs');
  // Rate limited.
  for (let i = 1; i < a.length; i++) assert.ok(a[i].t - a[i - 1].t >= 0.03);
});

test('temperatures: steady at idle and driving hard; overheat needs sustained abuse', () => {
  const idle = rig();
  idle.run(240);
  assert.ok(idle.sim.coolantC > 82 && idle.sim.coolantC < 100, `idle coolant ${idle.sim.coolantC}`);
  assert.ok(idle.sim.egtC > 250 && idle.sim.egtC < 500, `idle EGT ${idle.sim.egtC}`);
  assert.ok(idle.sim.oilC > idle.sim.coolantC - 5);
  assert.equal(idle.of('overheat').length, 0);

  // Flat out in 4th for a minute: hot exhaust, but the radiator copes.
  const hard = rig();
  hard.launch(1, 2);
  for (const g of [2, 3, 4]) {
    hard.run(0.15, { clutch: 1 });
    hard.box.request(g);
    hard.run(2, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.3) }));
  }
  let egtPeak = 0;
  hard.run(60, { gas: 1 }, (sim) => (egtPeak = Math.max(egtPeak, sim.egtC)));
  assert.ok(egtPeak > 750 && egtPeak < 1050, `EGT ${egtPeak}`);
  assert.ok(hard.sim.coolantC < COOLANT_WARN_C - 5, `coolant ${hard.sim.coolantC}`);
  assert.equal(hard.of('overheat').length, 0);

  // Parked on the limiter: 30 s is fine, a few minutes boils it.
  const abuse = rig();
  abuse.run(30, { gas: 1 });
  assert.equal(abuse.of('overheat').length, 0, `coolant after 30 s ${abuse.sim.coolantC}`);
  abuse.run(150, { gas: 1 });
  const hot = abuse.of('overheat');
  assert.equal(hot.length, 1, 'warns once');
  assert.ok(hot[0].coolantC >= COOLANT_WARN_C);
});

test('an engine cooked long enough blows with cause overheat', () => {
  const th = new Thermal();
  let flags = 0;
  for (let i = 0; i < 600 / H && th.damage < 1; i++) {
    flags |= th.update(H, { running: true, powerFrac: 0.6, load: 1, rpm: 6000, redlineRpm: 7000, kmh: 0, boostBar: 0, fuelCut: false });
  }
  assert.ok(flags & 1, 'warned first');
  assert.equal(th.damage, 1);
  assert.equal(th.cause, 'overheat');

  const r = rig();
  r.sim.thermal.coolantC = 150;
  r.run(30, { gas: 1 });
  const blown = r.of('blown');
  assert.equal(blown.length, 1);
  assert.equal(blown[0].cause, 'overheat');
  assert.equal(r.sim.blown, true);
});

test('money shift: the wheels drag the engine past redline and damage it', () => {
  const r = rig();
  r.launch(1, 1.3);
  // Pull 2nd until 1st would be ~24 % over redline, then dump the clutch in
  // 1st. Dragging the engine up costs road speed, so it peaks ~17 % over.
  r.run(0.15, { clutch: 1 });
  r.box.request(2);
  r.run(1.2, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.2) }));
  const target = 1.24 * r.profile.redlineRpm;
  for (let i = 0; i < 600 && rpmOf(r.sim, 1) < target; i++) r.run(1 / 120, { gas: 1 });
  r.run(0.1, { clutch: 1 });
  assert.ok(r.box.request(1).ok, 'manual box lets you do it');
  let peak = 0;
  r.run(0.6, {}, (sim) => (peak = Math.max(peak, sim.rpm)));
  assert.ok(peak > r.profile.redlineRpm * 1.1, `peak ${peak}`);
  const over = r.of('overrev');
  assert.ok(over.length >= 1, 'overrev event');
  assert.ok(over[0].rpm > r.profile.redlineRpm * 1.05);
  assert.ok(over[0].severity >= 0 && over[0].severity < 1);
  assert.ok(r.sim.damage > 0.05 && r.sim.damage < 1, `damage ${r.sim.damage}`);
  assert.equal(r.sim.blown, false);
});

test('a big money shift blows the engine; it will not crank until repaired', () => {
  const r = rig();
  r.launch(1, 1.3);
  for (const g of [2, 3]) {
    r.run(0.15, { clutch: 1 });
    r.box.request(g);
    r.run(2, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.25) }));
  }
  assert.ok(rpmOf(r.sim, 1) > r.profile.redlineRpm * 1.4, 'first gear is far past redline at this speed');
  r.run(0.1, { clutch: 1 });
  r.box.request(1);
  r.run(0.5, {});
  const blown = r.of('blown');
  assert.equal(blown.length, 1);
  assert.equal(blown[0].cause, 'over-rev');
  assert.ok(r.of('overrev').length >= 1);
  assert.equal(r.sim.blown, true);
  assert.equal(r.sim.running, false);
  assert.equal(r.sim.damage, 1);
  assert.ok(r.sim.rpm > r.profile.redlineRpm, 'the wheels still drag the dead engine round');
  assert.equal(r.sim.fuelCut, false, 'a dead engine is not on the limiter');

  // Stop, neutral: still dead, starter refuses, no bump start.
  r.run(10, { brake: 1, clutch: 1 });
  r.box.request('N');
  assert.equal(r.sim.canCrank(), false);
  assert.equal(r.sim.startEngine(), false);
  r.run(2);
  assert.equal(r.sim.running, false);
  assert.equal(r.of('blown').length, 1, 'blown is emitted once');

  r.sim.repair();
  assert.equal(r.sim.blown, false);
  assert.equal(r.sim.damage, 0);
  assert.equal(r.sim.startEngine(), true);
  r.run(3);
  assert.ok(r.sim.running);
  assert.ok(Math.abs(r.sim.rpm - r.profile.idleRpm) < 60, `idle after rebuild ${r.sim.rpm}`);
});

test('damage costs power and roughens the idle', () => {
  const idleSpread = (damage) => {
    const r = rig();
    r.run(3);
    r.sim.thermal.damage = damage;
    const rpms = [];
    r.run(4, {}, (sim) => rpms.push(sim.rpm));
    const mean = rpms.reduce((a, b) => a + b, 0) / rpms.length;
    const sd = Math.sqrt(rpms.reduce((a, b) => a + (b - mean) ** 2, 0) / rpms.length);
    return { sd, running: r.sim.running, mean };
  };
  const healthy = idleSpread(0);
  const hurt = idleSpread(0.6);
  assert.ok(hurt.running, 'a damaged engine still idles');
  assert.ok(hurt.sd > healthy.sd * 2 + 1, `idle spread healthy ${healthy.sd.toFixed(1)} vs damaged ${hurt.sd.toFixed(1)}`);

  const torqueAt = (damage) => {
    const r = rig();
    r.sim.thermal.damage = damage;
    let peak = 0;
    r.run(0.4, { gas: 1 }, (sim) => (peak = Math.max(peak, sim.combustionTorque)));
    return peak;
  };
  assert.ok(torqueAt(0.6) < torqueAt(0) * 0.85);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS, peakFigures, naTorque as naTorqueAt } from '../src/config.js';
import { GARAGE, garagePatch } from '../src/presets.js';
import { rig, rpmOf, DT } from './powertrain-rig.mjs';

const stalled = (r) => r.of('stall').length > 0;

// ── Launch control and traction control ─────────────────────────────────────

test('launch control holds the launch rpm with the clutch in, then hands back the redline', () => {
  const r = rig({ launchControl: true, launchRpm: 4500 });
  r.run(0.3, { clutch: 1 });
  r.box.request(1);
  const held = [];
  r.run(2, { clutch: 1, gas: 1 }, (sim) => sim.time > 1.5 && held.push(sim.rpm));
  assert.ok(Math.min(...held) > 4100 && Math.max(...held) < 4700, `held ${Math.min(...held)}–${Math.max(...held)}`);
  assert.equal(r.sim.launchActive, true);
  assert.equal(r.sim.limiterRpm, 4500);
  assert.ok(r.of('twostep').length > 5);
  assert.ok(r.of('backfire').some((e) => e.source === 'twostep'));
  assert.equal(r.of('limiter').length, 0, 'the two-step is not the main limiter');
  r.run(3, (t) => ({ gas: 1, clutch: Math.max(0, 1 - t / 0.2) }));
  assert.ok(!stalled(r));
  assert.ok(r.sim.speedKmh > 40);
  assert.equal(r.sim.launchActive, false);
  assert.equal(r.sim.limiterRpm, r.profile.redlineRpm);

  // Without it the same input runs into the redline limiter.
  const off = rig();
  off.run(0.3, { clutch: 1 });
  off.box.request(1);
  let peak = 0;
  off.run(2, { clutch: 1, gas: 1 }, (sim) => (peak = Math.max(peak, sim.rpm)));
  assert.ok(peak > off.profile.redlineRpm - 100);
  assert.equal(off.of('twostep').length, 0);
});

test('traction control cuts torque when the tyres spin', () => {
  const spin = (tc) => {
    const r = rig({ ...garagePatch('supercharged-v8'), tractionControl: tc });
    r.run(0.3, { clutch: 1 });
    r.box.request(1);
    r.run(0.6, { clutch: 1, gas: 1 });
    let spinning = 0;
    let minCut = 1;
    r.run(2.5, (t) => ({ gas: 1, clutch: t < 0.05 ? 1 : 0 }), (sim) => {
      if (sim.wheelspin) spinning += DT;
      minCut = Math.min(minCut, sim.tcFactor);
    });
    return { r, spinning, minCut };
  };
  const off = spin(false);
  const on = spin(true);
  assert.ok(off.spinning > 0.5, `no-TC wheelspin ${off.spinning.toFixed(2)} s`);
  assert.ok(on.spinning < off.spinning * 0.6, `TC wheelspin ${on.spinning.toFixed(2)} s vs ${off.spinning.toFixed(2)} s`);
  assert.ok(on.minCut < 0.9, 'torque was cut');
  assert.ok(on.r.of('tc').length >= 1);
  assert.equal(off.r.of('tc').length, 0);
  assert.ok(!stalled(on.r));
  assert.ok(on.r.sim.speedKmh > 40);
});

// ── Sequential gearbox ──────────────────────────────────────────────────────

const seq = (patch) => rig({ mode: 'sequential', ...patch });

test('sequential: pulls away on the automated clutch and flat-shifts upward', () => {
  const r = seq();
  assert.equal(r.box.shiftUp().ok, true);
  assert.equal(r.sim.gear, 1);
  let cut = false;
  r.run(2.2, { gas: 1 }, (sim) => (cut ||= sim.torqueCut));
  assert.ok(!stalled(r));
  assert.ok(r.sim.speedKmh > 25, `speed ${r.sim.speedKmh}`);
  assert.equal(cut, false, 'no ignition cut before a shift');

  const before = r.sim.rpm;
  const res = r.box.shiftUp();
  assert.equal(res.ok, true);
  r.run(0.3, { gas: 1 }, (sim) => (cut ||= sim.torqueCut));
  assert.equal(r.sim.gear, 2);
  assert.ok(cut, 'ignition cut during the flat shift');
  assert.equal(r.sim.torqueCut, false, 'cut released afterwards');
  assert.ok(r.sim.rpm < before - 1000, `revs fell from ${before.toFixed(0)} to ${r.sim.rpm.toFixed(0)}`);
  const shift = r.of('shift').at(-1);
  assert.deepEqual({ ...shift, t: 0 }, { type: 'shift', from: 1, to: 2, kind: 'up', source: 'sequential', flat: true, t: 0 });
  assert.ok(r.of('backfire').some((e) => e.source === 'shift'));
  const n = r.of('shift').length;
  r.run(1, { gas: 1 });
  assert.equal(r.of('shift').length, n, 'one event per shift');
  const rec = r.tracker.shiftRecords[0];
  assert.equal(rec.note, 'Flat shift');
  assert.ok(rec.from === 1 && rec.to === 2 && rec.score >= 85, `flat shift scored ${rec.score}`);
});

test('sequential: lifted upshift is not flat; two quick taps queue', () => {
  const r = seq();
  r.box.shiftUp();
  r.run(2, { gas: 1 });
  r.run(0.05, { gas: 0 });
  r.box.shiftUp();
  r.run(0.4, { gas: 0 });
  assert.equal(r.sim.gear, 2);
  assert.equal(r.of('shift').at(-1).flat, undefined);
  r.run(1.5, { gas: 1 });
  r.box.shiftUp();
  const q = r.box.shiftUp();
  assert.equal(q.queued, true);
  r.run(0.8, { gas: 1 });
  assert.equal(r.sim.gear, 4);
  assert.ok(!stalled(r));
});

test('sequential: downshifts blip to match revs and refuse ones that would over-rev', () => {
  const r = seq();
  r.box.shiftUp();
  r.run(2.2, { gas: 1 });
  r.box.shiftUp();
  r.run(2.2, { gas: 1 });
  r.box.shiftUp();
  r.run(2.5, { gas: 1 });
  assert.equal(r.sim.gear, 3);
  // Near redline in 3rd, 2nd would blow past it: refused with a clear reason.
  assert.ok(rpmOf(r.sim, 2) > r.profile.redlineRpm);
  const no = r.box.shiftDown();
  assert.equal(no.ok, false);
  assert.match(no.reason, /over-rev/);
  assert.match(no.reason, /2nd/);
  assert.equal(r.sim.gear, 3);

  // Slow down, then the downshift goes in with a rev-matching blip.
  r.run(6, { brake: 0.4 });
  const target = rpmOf(r.sim, 2);
  assert.ok(target < r.profile.redlineRpm - 500 && target > r.sim.rpm + 500, `target ${target}`);
  const ok = r.box.shiftDown();
  assert.equal(ok.ok, true);
  let peak = 0;
  let blip = 0;
  r.run(0.5, {}, (sim) => {
    peak = Math.max(peak, sim.rpm);
    blip = Math.max(blip, sim.throttleInput);
  });
  assert.equal(r.sim.gear, 2);
  assert.ok(blip > 0.5, 'throttle blipped');
  assert.ok(peak > target - 400 && peak < r.profile.redlineRpm, `peak ${peak} vs target ${target}`);
  assert.equal(r.of('overrev').length, 0);
  const e = r.of('shift').at(-1);
  assert.equal(e.kind, 'down');
  assert.equal(e.from, 3);
  assert.equal(e.to, 2);
  assert.ok(!stalled(r));
});

test('sequential: N sits between 1 and R, and R only goes in at a standstill', () => {
  const r = seq();
  r.run(0.5);
  assert.equal(r.box.shiftDown().ok, true);
  assert.equal(r.sim.gear, 'R');
  assert.equal(r.box.shiftDown().ok, false, 'nothing below reverse');
  r.box.shiftUp();
  assert.equal(r.sim.gear, 'N');
  r.box.shiftUp();
  assert.equal(r.sim.gear, 1);
  r.run(2, { gas: 1 });
  r.box.shiftDown();
  assert.equal(r.sim.gear, 'N');
  const rev = r.box.shiftDown();
  assert.equal(rev.ok, false);
  assert.match(rev.reason, /Stop the car/);
  assert.equal(r.sim.gear, 'N');
  r.run(8, { brake: 1 });
  assert.equal(r.box.shiftDown().ok, true);
  assert.equal(r.sim.gear, 'R');
  // Reverse pulls away backwards on the automated clutch.
  r.run(2, { gas: 0.5 });
  assert.ok(r.sim.v < -1 && !stalled(r));
  // Top gear is the top.
  const top = seq();
  for (let i = 0; i < 7; i++) top.box.requestSequential(Math.min(5, i));
  assert.equal(top.sim.gear, 5);
  assert.equal(top.box.shiftUp().ok, false);
  assert.ok(top.of('shift').every((e) => e.source === 'sequential'));
});

test('sequential: shifting at walking pace never stalls', () => {
  for (const gas of [0, 0.4, 1]) {
    const r = seq();
    r.box.shiftUp();
    r.run(0.3, { gas: 0.4 });
    for (let i = 0; i < 300 && r.sim.speedKmh < 3; i++) r.run(DT, { gas: 0.4 });
    r.box.shiftUp();
    r.run(0.1, { gas });
    r.box.shiftUp();
    r.run(1.5, { gas });
    assert.equal(r.sim.gear, 3);
    assert.ok(!stalled(r) && r.sim.running, `gas ${gas}`);
  }
});

test('sequential: stopping in gear opens the clutch instead of stalling', () => {
  const r = seq();
  r.box.shiftUp();
  r.run(2, { gas: 1 });
  r.run(10, { brake: 1 });
  assert.ok(r.sim.speedKmh < 0.5);
  assert.ok(r.sim.running && !stalled(r));
  assert.equal(r.sim.gear, 1);
});

test('sequential + launch control: brake held stages on the two-step, release launches', () => {
  const r = seq({ launchControl: true, launchRpm: 5000 });
  r.box.shiftUp();
  const held = [];
  r.run(2, { gas: 1, brake: 1 }, (sim) => sim.time > 1.5 && held.push(sim.rpm));
  assert.ok(Math.min(...held) > 4600 && Math.max(...held) < 5200, `held ${Math.min(...held)}–${Math.max(...held)}`);
  assert.ok(r.sim.speedKmh < 0.5);
  assert.ok(r.of('twostep').length > 0);
  r.run(2, { gas: 1 });
  assert.ok(r.sim.speedKmh > 30 && !stalled(r));
});

test('automatic mode emits shift events', () => {
  const r = rig({ mode: 'auto' });
  r.box.request(1);
  r.run(12, { gas: 1 });
  const ups = r.of('shift').filter((e) => e.kind === 'up' && e.from !== 'N');
  assert.ok(ups.length >= 3);
  for (const e of ups) {
    assert.equal(e.source, 'auto');
    assert.equal(e.to, e.from + 1);
  }
});

// ── Auto-blip on the H-pattern ──────────────────────────────────────────────

test('auto-blip rev-matches an H-pattern downshift', () => {
  const downshift = (autoBlip) => {
    const r = rig({ autoBlip });
    r.launch(1, 1.5);
    for (const g of [2, 3]) {
      r.run(0.15, { clutch: 1 });
      r.box.request(g);
      r.run(1.2, (t) => ({ gas: 0.7, clutch: Math.max(0, 1 - t / 0.3) }));
    }
    r.run(1.5, {});
    // Clutch in, 2nd, clutch out over 0.4 s with the driver's foot off the gas.
    r.run(0.1, { clutch: 1 });
    r.box.request(2);
    const target = rpmOf(r.sim, 2);
    let bite = null;
    r.run(1.4, (t) => ({ clutch: t < 0.2 ? 1 : Math.max(0, 1 - (t - 0.2) / 0.4) }), (sim) => {
      if (bite === null && sim.clutchCapacity > 0) bite = sim.rpm;
    });
    return { r, target, bite, rec: r.tracker.shiftRecords[0] };
  };
  const plain = downshift(false);
  const blip = downshift(true);
  assert.ok(Math.abs(blip.bite - blip.target) < 400, `blip bite ${blip.bite} vs ${blip.target}`);
  assert.ok(Math.abs(plain.bite - plain.target) > 1000, `unassisted bite ${plain.bite} vs ${plain.target}`);
  assert.ok(blip.rec.score > plain.rec.score, `score ${blip.rec.score} vs ${plain.rec.score}`);
  assert.equal(blip.r.box.blip, null, 'assist hands back once the clutch is home');
  assert.ok(!stalled(blip.r));
});

// ── Variable valve lift ─────────────────────────────────────────────────────

test('VVL: high cam switches on above vvlRpm under load, off below it with hysteresis', () => {
  const r = rig(garagePatch('vvl-i4'));
  assert.equal(r.profile.vvlRpm, 5800);
  r.run(1);
  assert.equal(r.sim.vvlActive, false);
  let on = null;
  let off = null;
  r.run(3, (t) => ({ gas: t < 0.6 ? 1 : 0 }), (sim) => {
    if (on === null && sim.vvlActive) on = sim.rpm;
    if (on !== null && off === null && !sim.vvlActive) off = sim.rpm;
  });
  assert.ok(on >= 5800 && on < 6100, `engaged at ${on}`);
  assert.ok(off < 5800 - 250 && off > 5800 - 450, `released at ${off}`);
  assert.deepEqual(r.of('vvl').map((e) => e.on), [true, false]);
  // Combustion uses the high-cam curve while it is engaged.
  const p = r.profile;
  r.run(0.25, { gas: 1 }, (sim) => {
    if (sim.vvlActive && !sim.fuelCut && sim.rpm > 7000) {
      assert.ok(sim.combustionTorque > 0.98 * naTorqueAt(p, sim.rpm, false) * sim.throttleEffective);
    }
  });
});

// ── Garage ──────────────────────────────────────────────────────────────────

test('garage: 10–12 archetype builds with unique ids and no trademarks', () => {
  assert.ok(GARAGE.length >= 10 && GARAGE.length <= 12);
  assert.equal(new Set(GARAGE.map((g) => g.id)).size, GARAGE.length);
  const banned = /vtec|hemi|hellcat|ferrari|porsche|subaru|toyota|honda|mazda|chevrolet|chevy|ford|lambo|bmw|harley|nissan|\bls\d|coyote|2jz|13b|rb26|ej2/i;
  for (const g of GARAGE) {
    assert.ok(g.name && g.blurb && g.tags.length, g.id);
    assert.ok(!banned.test(`${g.name} ${g.blurb} ${g.tags.join(' ')}`), `${g.id} mentions a trademark`);
    for (const k of ['preset', 'cylinders', 'idleRpm', 'redlineRpm', 'displacementL', 'induction', 'boostBar', 'vvlRpm', 'boreStroke']) {
      assert.ok(k in g.settings, `${g.id} sets ${k}`);
    }
  }
  assert.deepEqual(garagePatch('nope'), {});
  assert.equal(garagePatch('smallblock').garage, 'smallblock');
  const kinds = new Set(GARAGE.map((g) => g.settings.induction));
  for (const k of ['na', 'turbo', 'twin-turbo', 'supercharger']) assert.ok(kinds.has(k), k);
  const layouts = new Set(GARAGE.map((g) => buildProfile({ ...DEFAULT_SETTINGS, ...g.settings }).layout));
  for (const l of ['v', 'inline', 'boxer', 'vtwin', 'rotary']) assert.ok(layouts.has(l), l);
});

test('garage: every build matches its spec, idles, revs to its limiter and pulls away', () => {
  for (const g of GARAGE) {
    const profile = buildProfile({ ...DEFAULT_SETTINGS, ...g.settings });
    assert.equal(profile.redlineRpm, g.settings.redlineRpm, g.id);
    assert.ok(Math.abs(profile.displacementL - g.settings.displacementL) < 1e-9, g.id);
    const f = peakFigures(profile);
    assert.ok(f.hp > 70 && f.hp < 900, `${g.id}: ${f.hp.toFixed(0)} hp`);
    assert.ok(f.hpRpm > f.nmRpm, `${g.id}: power peaks after torque`);

    const r = rig(garagePatch(g.id));
    r.run(5);
    assert.ok(r.sim.running, g.id);
    assert.ok(Math.abs(r.sim.rpm - profile.idleRpm) < 60, `${g.id} idles at ${r.sim.rpm.toFixed(0)}`);
    let peak = 0;
    r.run(2.5, { gas: 1 }, (sim) => (peak = Math.max(peak, sim.rpm)));
    assert.ok(peak > profile.redlineRpm - 150 && peak < profile.redlineRpm + 200, `${g.id} peak ${peak.toFixed(0)}`);
    r.run(4);
    r.launch(0.5, 3);
    assert.ok(!stalled(r), `${g.id} stalled on launch`);
    assert.ok(r.sim.speedKmh > 25, `${g.id} launch ${r.sim.speedKmh.toFixed(1)} km/h`);
    assert.ok(!r.sim.blown && r.sim.damage === 0, g.id);
  }
});

test('sequential: picking a gear while rolling fast in neutral is refused when it would over-rev', () => {
  const r = seq();
  r.box.shiftUp();
  r.run(2.2, { gas: 1 });
  r.box.shiftUp();
  r.run(2.2, { gas: 1 });
  r.box.shiftUp();
  r.run(2.5, { gas: 1 });
  assert.equal(r.sim.gear, 3);
  assert.ok(rpmOf(r.sim, 1) > r.profile.redlineRpm * 1.2);
  // 3 → N through the lever, then tap up for 1st at speed.
  assert.equal(r.box.request('N').ok, true);
  assert.equal(r.sim.gear, 'N');
  const no = r.box.shiftUp();
  assert.equal(no.ok, false);
  assert.match(no.reason, /Too fast for 1st/);
  assert.equal(r.sim.gear, 'N');
  const lever = r.box.request(1);
  assert.equal(lever.ok, false);
  // A gear that fits is fine and rev-matched on the way in.
  assert.ok(rpmOf(r.sim, 3) < r.profile.redlineRpm - 500);
  assert.equal(r.box.request(3).ok, true);
  r.run(1, {});
  assert.equal(r.sim.gear, 3);
  assert.equal(r.of('overrev').length, 0);
  assert.ok(!r.sim.blown && !stalled(r));
});

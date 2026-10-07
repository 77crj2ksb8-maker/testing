// Achievements: each rule unlocks once, progress persists through the
// storage adapter, and rides on the dyno rollers never count as driving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AchievementTracker, ACHIEVEMENTS, CORE_LAYOUTS } from '../src/achievements.js';
import { rig } from './powertrain-rig.mjs';

const memory = () => ({ data: null, load() { return this.data; }, save(d) { this.data = JSON.parse(JSON.stringify(d)); } });
const ids = (list) => list.map((a) => a.id);
const state = (o = {}) => ({ dt: 1 / 120, kmh: 0, running: true, launchActive: false, layout: 'v', onRollers: false, ...o });

test('achievements: definitions are unique and about sixteen', () => {
  const set = new Set(ids(ACHIEVEMENTS));
  assert.equal(set.size, ACHIEVEMENTS.length);
  assert.ok(ACHIEVEMENTS.length >= 16 && ACHIEVEMENTS.length <= 20);
  for (const a of ACHIEVEMENTS) assert.ok(a.title && a.detail.endsWith('.'), a.id);
});

test('achievements: bus events unlock once and persist', () => {
  const store = memory();
  let clock = 1000;
  const t = new AchievementTracker(store, { now: () => clock++ });
  t.handleEvent('stall', {});
  t.handleEvent('stall', {});
  t.handleEvent('start', { bump: false });
  t.handleEvent('start', { bump: true });
  t.handleEvent('vvl', { on: false });
  t.handleEvent('vvl', { on: true });
  t.handleEvent('repair', {}); // nothing was blown: no rebuild credit
  t.handleEvent('blown', { cause: 'over-rev' });
  t.handleEvent('repair', {});
  t.handleEvent('dyno:done', { peakHp: 400 });
  t.handleEvent('drag:foul', { reaction: -0.1 });
  t.handleEvent('drag:finish', { result: { et: 9.5, foul: true } });
  assert.deepEqual(ids(t.drain()), ['first-stall', 'bump-start', 'vvl', 'blown', 'rebuild', 'dyno', 'red-light']);
  assert.deepEqual(t.drain(), []);
  t.handleEvent('drag:finish', { result: { et: 11.2, foul: false } });
  assert.deepEqual(ids(t.drain()), ['quarter-12']);
  t.handleEvent('drag:finish', { result: { et: 9.9, foul: false } });
  assert.deepEqual(ids(t.drain()), ['quarter-10']);

  const again = new AchievementTracker(store);
  assert.equal(again.count, 9);
  assert.ok(again.has('rebuild'));
  assert.equal(again.unlocked['first-stall'], 1000);
  again.handleEvent('stall', {});
  assert.deepEqual(again.drain(), [], 'already unlocked');
});

test('achievements: shift records (perfect, streak of five, clutchless)', () => {
  const t = new AchievementTracker(null);
  const shift = (score, grade, note = '') => t.handleShift({ score, grade, note, launch: false });
  t.handleShift({ score: 99, grade: 'Smooth', note: 'Launch', launch: true });
  t.handleShift({ score: 99, grade: 'Smooth', note: 'Auto' });
  t.handleShift({ score: 99, grade: 'Smooth', note: 'Flat shift' });
  assert.deepEqual(t.drain(), [], 'launches and automated shifts do not count');
  for (let i = 0; i < 4; i++) shift(90, 'Smooth');
  t.handleShift({ grind: true, score: 0, grade: 'Grind', note: 'Press the clutch before shifting' });
  shift(88, 'Smooth');
  assert.deepEqual(t.drain(), [], 'a grind breaks the streak');
  for (let i = 0; i < 4; i++) shift(90, 'Smooth');
  assert.deepEqual(ids(t.drain()), ['smooth-five']);
  shift(96, 'Smooth');
  assert.deepEqual(ids(t.drain()), ['perfect-shift']);
  shift(70, 'OK', 'Clutchless');
  assert.deepEqual(ids(t.drain()), ['clutchless']);
});

test('achievements: speeds count on the road, not on the rollers', () => {
  const t = new AchievementTracker(null);
  t.observe(state({ kmh: 320, onRollers: true }));
  assert.deepEqual(t.drain(), []);
  t.observe(state({ kmh: 150 }));
  assert.deepEqual(ids(t.drain()), ['speed-100']);
  t.observe(state({ kmh: 305 }));
  assert.deepEqual(ids(t.drain()), ['speed-200', 'speed-300']);
});

test('achievements: launch control start', () => {
  const t = new AchievementTracker(null);
  for (let i = 0; i < 60; i++) t.observe(state({ launchActive: true, kmh: 0 }));
  // A slow roll-away that takes too long does not count…
  for (let i = 0; i < 480; i++) t.observe(state({ kmh: i * 0.05 }));
  assert.deepEqual(t.drain(), []);
  for (let i = 0; i < 60; i++) t.observe(state({ launchActive: true, kmh: 0 }));
  // …a hard launch does.
  for (let i = 0; i < 240; i++) t.observe(state({ kmh: i * 0.3 }));
  assert.deepEqual(ids(t.drain()), ['launch-control']);
});

test('achievements: collector needs every core layout driven', () => {
  const store = memory();
  const t = new AchievementTracker(store);
  const drive = (layout, seconds, kmh = 72) => {
    for (let i = 0; i < seconds * 120; i++) t.observe(state({ layout, kmh }));
  };
  drive('v', 5); // 100 m: not enough
  assert.deepEqual(t.layouts, []);
  drive('v', 6);
  assert.deepEqual(t.layouts, ['v']);
  drive('inline', 11, 72);
  drive('boxer', 11, 72);
  drive('vtwin', 11, 72);
  assert.deepEqual(t.drain(), []);
  assert.deepEqual(t.missingLayouts(), ['rotary']);
  const reloaded = new AchievementTracker(store);
  assert.deepEqual(reloaded.layouts, ['v', 'inline', 'boxer', 'vtwin']);
  for (let i = 0; i < 11 * 120; i++) reloaded.observe(state({ layout: 'rotary', kmh: 72, onRollers: true }));
  assert.deepEqual(reloaded.drain(), [], 'dyno miles do not count');
  for (let i = 0; i < 11 * 120; i++) reloaded.observe(state({ layout: 'rotary', kmh: 72 }));
  assert.deepEqual(ids(reloaded.drain()), ['all-layouts']);
  assert.equal(CORE_LAYOUTS.length, 5);
});

test('achievements: real stall and bump start from the simulator', () => {
  const r = rig({});
  const t = new AchievementTracker(null);
  r.run(0.3, { clutch: 1 });
  r.box.request(1);
  r.run(1.5, {}); // dump the clutch at idle: stall
  for (const e of r.events) t.handleEvent(e.type, e);
  assert.ok(ids(t.drain()).includes('first-stall'));
  assert.ok(!r.sim.running);
  // Roll the dead car in gear fast enough and the engine catches.
  r.events.length = 0;
  r.run(0.2, { clutch: 1 });
  r.sim.v = 8;
  r.run(1, {});
  for (const e of r.events) t.handleEvent(e.type, e);
  assert.ok(ids(t.drain()).includes('bump-start'), 'bump start');
  // Storage that throws is tolerated.
  const broken = new AchievementTracker({ load() { throw new Error('no'); }, save() { throw new Error('full'); } });
  assert.doesNotThrow(() => broken.handleEvent('stall', {}));
  assert.equal(broken.count, 1);
});

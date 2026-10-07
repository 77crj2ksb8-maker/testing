// Drag strip timing against a synthetic constant-acceleration run, where
// every ET and speed is known in closed form, plus fouls, aborts and records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DragRace, DragRecords, DRAG_MARKS, ROLLOUT_M, TRAP_M, QUARTER_M, AMBER_STEP } from '../src/modes/drag.js';

const DT = 1 / 120;
const ACCEL = 7.5; // m/s²

/**
 * Drive a race with a car that sits still until `launchOffset` s after the
 * green (negative = before it), then accelerates at ACCEL. Returns the race,
 * every event with its clock time and the clock time the car started moving.
 */
function runRace({ launchOffset = 0.25, accel = ACCEL, maxTime = 40, stopAt = Infinity } = {}) {
  const race = new DragRace();
  race.arm();
  const events = [];
  let moveAt = null;
  let greenAt = null;
  // The tree timing is fixed: find when the green will light by watching the stage event.
  for (let step = 0; step < maxTime / DT && race.phase !== 'done'; step++) {
    const t = race.clock + DT; // clock at the end of this step
    if (moveAt === null && greenAt !== null) moveAt = greenAt + launchOffset;
    let x = 0;
    let v = 0;
    if (moveAt !== null && t > moveAt) {
      const tau = Math.min(t, stopAt) - moveAt;
      x = 0.5 * accel * tau * tau;
      v = t >= stopAt ? 0 : accel * tau;
    }
    race.update(DT, 100 + x, v, true);
    for (const e of race.drainEvents()) {
      events.push({ ...e, at: race.clock });
      // Staged: the tree starts after a fixed delay and the green follows three ambers.
      if (e.type === 'stage') greenAt = race.treeAt + 3 * AMBER_STEP;
    }
  }
  return { race, events, moveAt, greenAt };
}

const etTo = (d, a = ACCEL) => Math.sqrt((2 * (ROLLOUT_M + d)) / a) - Math.sqrt((2 * ROLLOUT_M) / a);

test('drag: staging, sportsman tree and green', () => {
  const race = new DragRace();
  assert.equal(race.phase, 'idle');
  race.arm();
  assert.equal(race.phase, 'pre');
  // A moving car or a dead engine never stages.
  for (let i = 0; i < 240; i++) race.update(DT, 50 + i * 0.1, 12, true);
  assert.equal(race.phase, 'pre');
  for (let i = 0; i < 240; i++) race.update(DT, 80, 0, false);
  assert.equal(race.phase, 'pre');
  // Stopped with the engine running: staged, then three ambers 0.5 s apart, then green.
  let stagedAt = null;
  const lit = [];
  for (let i = 0; i < 600 && race.phase !== 'green'; i++) {
    race.update(DT, 80, 0, true);
    for (const e of race.drainEvents()) if (e.type === 'stage') stagedAt = race.clock;
    if (race.phase === 'tree' && lit[race.ambers] === undefined) lit[race.ambers] = race.clock;
  }
  assert.ok(stagedAt !== null, 'stages');
  assert.equal(race.phase, 'green');
  assert.ok(race.greenLit);
  assert.ok(Math.abs(lit[2] - lit[1] - AMBER_STEP) < DT * 1.5, 'second amber 0.5 s after the first');
  assert.ok(Math.abs(lit[3] - lit[2] - AMBER_STEP) < DT * 1.5, 'third amber 0.5 s after the second');
  assert.ok(Math.abs(race.greenAt - (lit[3] + AMBER_STEP)) < DT * 1.5, 'green 0.5 s after the third amber');
});

test('drag: ETs, speeds and trap speed match a constant-acceleration run', () => {
  const { race, events } = runRace({ launchOffset: 0.25 });
  assert.equal(race.phase, 'done');
  const finish = events.find((e) => e.type === 'finish');
  assert.ok(finish, 'finishes');
  const r = finish.result;
  assert.equal(r.foul, false);
  // Reaction: green to leaving the stage beam.
  const reaction = 0.25 + Math.sqrt((2 * ROLLOUT_M) / ACCEL);
  assert.ok(Math.abs(r.reaction - reaction) < 0.002, `reaction ${r.reaction} vs ${reaction}`);
  for (const [i, mark] of DRAG_MARKS.entries()) {
    const split = r.splits[i];
    const want = etTo(mark.m);
    assert.ok(Math.abs(split.t - want) < 0.002, `${mark.id} ET ${split.t.toFixed(4)} vs ${want.toFixed(4)}`);
    const speed = Math.sqrt(2 * ACCEL * (ROLLOUT_M + mark.m)) * 3.6;
    assert.ok(Math.abs(split.speedKmh - speed) < 0.2, `${mark.id} speed ${split.speedKmh.toFixed(2)} vs ${speed.toFixed(2)}`);
  }
  assert.ok(Math.abs(r.et - etTo(QUARTER_M)) < 0.002, 'ET is the quarter-mile time');
  const trap = (TRAP_M / (etTo(QUARTER_M) - etTo(QUARTER_M - TRAP_M))) * 3.6;
  assert.ok(Math.abs(r.trapKmh - trap) < 0.3, `trap ${r.trapKmh.toFixed(2)} vs ${trap.toFixed(2)}`);
  assert.equal(events.filter((e) => e.type === 'split').length, DRAG_MARKS.length);
  assert.ok(events.some((e) => e.type === 'green'));
  assert.equal(race.distance, QUARTER_M);
});

test('drag: leaving before the green is a red light, and the run is still timed', () => {
  const { race, events } = runRace({ launchOffset: -0.3 });
  const foul = events.find((e) => e.type === 'foul');
  assert.ok(foul, 'foul event');
  assert.ok(foul.reaction < 0, `negative reaction (${foul.reaction})`);
  assert.ok(!events.some((e) => e.type === 'green'), 'the green never shows');
  const finish = events.find((e) => e.type === 'finish');
  assert.ok(finish.result.foul);
  assert.ok(Math.abs(finish.result.et - etTo(QUARTER_M)) < 0.002, 'ET still measured');
  assert.equal(race.greenLit, false);
});

test('drag: a car that stops mid-run is aborted', () => {
  const { race, events } = runRace({ launchOffset: 0.3, stopAt: 9.5 });
  assert.equal(race.phase, 'done');
  assert.ok(events.some((e) => e.type === 'abort'));
  assert.equal(race.result, null);
});

test('drag: personal bests per engine, persisted, fouls excluded', () => {
  const store = { data: null, load() { return this.data; }, save(d) { this.data = JSON.parse(JSON.stringify(d)); } };
  const recs = new DragRecords(store);
  const run = (et, trapKmh, reaction, foul = false) => ({ et, trapKmh, reaction, foul, splits: [{ t: et / 6 }] });
  let imp = recs.record('v-v8-cross', run(12.4, 180, 0.3), { name: 'V8' });
  assert.deepEqual(imp, { et: true, trap: true, reaction: true, sixty: true });
  imp = recs.record('v-v8-cross', run(12.9, 182, 0.2));
  assert.equal(imp.et, false);
  assert.equal(imp.trap, true);
  assert.equal(imp.reaction, true);
  imp = recs.record('v-v8-cross', run(10.0, 250, -0.1, true));
  assert.deepEqual(imp, { et: false, trap: false, reaction: false, sixty: false });
  const again = new DragRecords(store);
  const best = again.best('v-v8-cross');
  assert.equal(best.et, 12.4);
  assert.equal(best.trapKmh, 182);
  assert.equal(best.runs, 2);
  assert.equal(again.best('inline-4'), null);
  // Broken storage never throws.
  const broken = new DragRecords({ load() { throw new Error('x'); }, save() { throw new Error('y'); } });
  assert.doesNotThrow(() => broken.record('k', run(11, 200, 0.4)));
});

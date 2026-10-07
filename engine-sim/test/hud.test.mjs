// Pure HUD helpers: shift lights, gauge levels, dial maths, crank scrubbing,
// display-mode cycle, labels, garage specs and settings ranges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS, peakFigures } from '../src/config.js';
import { GARAGE } from '../src/presets.js';
import {
  SHIFT_LEDS, SHIFT_FLASH, shiftPointRpm, shiftLightLevel, tempLevel, healthLevel, formatBoost, stallCopy,
  DIAL_START, DIAL_SWEEP, dialMaxRpm, dialAngle, scrubPeriod, firingAngles, stepFiring, lastFired,
  DISPLAY_MODES, displayModeOf, nextDisplayMode, cylinderLabel, layoutLabel, garageSpecs, groupThousands, paddleReadout,
} from '../src/hud.js';
import { defaultVvlRpm, displacementRange } from '../src/ui.js';

const profile = (patch = {}) => buildProfile({ ...DEFAULT_SETTINGS, ...patch });

test('shift lights fill green to red with rpm and flash at the shift point', () => {
  const p = profile();
  const shift = shiftPointRpm(p);
  assert.ok(shift < p.redlineRpm && shift > p.redlineRpm - 600, `shift point ${shift} sits just under the ${p.redlineRpm} redline`);
  assert.equal(shiftLightLevel(p.idleRpm, p), 0);
  let last = 0;
  for (let rpm = p.idleRpm; rpm < shift; rpm += 50) {
    const lvl = shiftLightLevel(rpm, p);
    assert.ok(lvl >= last && lvl <= SHIFT_LEDS, `monotonic at ${rpm}`);
    last = lvl;
  }
  assert.equal(last, SHIFT_LEDS, 'all ten lit just before the shift point');
  assert.equal(shiftLightLevel(shift, p), SHIFT_FLASH);
  assert.equal(shiftLightLevel(p.redlineRpm + 2000, p), SHIFT_FLASH);
  // Any limiter (rev or two-step launch) flashes them too, even at low rpm.
  assert.equal(shiftLightLevel(4500, p, true), SHIFT_FLASH);
});

test('shift point scales with the redline', () => {
  for (const redlineRpm of [5500, 7000, 9000]) {
    const p = profile({ redlineRpm });
    const s = shiftPointRpm(p);
    assert.ok(s >= redlineRpm * 0.94 && s <= redlineRpm - 250, `${redlineRpm} → ${s}`);
  }
});

test('gauge levels', () => {
  assert.equal(tempLevel(90), 1);
  assert.equal(tempLevel(50), 0);
  assert.equal(tempLevel(110), 2);
  assert.equal(tempLevel(121), 3);
  assert.equal(tempLevel(100, 'oil'), 1);
  assert.equal(tempLevel(130, 'oil'), 2);
  assert.equal(tempLevel(145, 'oil'), 3);
  assert.equal(healthLevel(0.1), 1);
  assert.equal(healthLevel(0.4), 2);
  assert.equal(healthLevel(0.8), 3);
});

test('boost reads in bar with a real minus sign for vacuum', () => {
  assert.equal(formatBoost(0.8), '0.80');
  assert.equal(formatBoost(-0.687), '−0.69');
  assert.equal(formatBoost(-0.001), '0.00');
  assert.equal(formatBoost(1.234), '1.23');
});

test('stall card says why a blown engine is dead', () => {
  const rev = stallCopy({ blown: true, blownCause: 'over-rev' });
  assert.match(rev.help, /over-revved/);
  assert.equal(rev.button, 'REBUILD');
  const hot = stallCopy({ blown: true, blownCause: 'overheat' });
  assert.match(hot.help, /overheated/);
  assert.notEqual(hot.title, rev.title);
  assert.equal(stallCopy({ blown: true, blownCause: null }).button, 'REBUILD');
  const ready = stallCopy({ blown: false, canCrank: true });
  assert.equal(ready.button, 'START');
  assert.match(ready.help, /Ready/);
  assert.match(stallCopy({ blown: false, canCrank: false }).help, /clutch or select neutral/);
});

test('analog dial: full scale, needle angle and the 240° sweep', () => {
  assert.equal(dialMaxRpm(7000), 8000);
  assert.equal(dialMaxRpm(9000), 10000);
  assert.equal(dialMaxRpm(5500), 6000);
  assert.equal(dialAngle(0, 8000), DIAL_START);
  assert.equal(dialAngle(8000, 8000), DIAL_START + DIAL_SWEEP);
  assert.equal(dialAngle(20000, 8000), DIAL_START + DIAL_SWEEP, 'clamped past full scale');
  assert.ok(Math.abs(dialAngle(4000, 8000) - 1.5 * Math.PI) < 1e-9, 'half scale points straight up');
});

test('crank scrubbing: firing angles, stepping and the stroke readout', () => {
  const v8 = profile();
  assert.equal(scrubPeriod(v8), 720);
  const angles = firingAngles(v8);
  assert.equal(angles.length, 8);
  assert.deepEqual(angles, [0, 90, 180, 270, 360, 450, 540, 630]);
  assert.equal(stepFiring(v8, 0, 1), 90);
  assert.equal(stepFiring(v8, 100, 1), 180);
  assert.equal(stepFiring(v8, 650, 1), 0, 'wraps forward');
  assert.equal(stepFiring(v8, 0, -1), 630, 'wraps backward');
  assert.equal(stepFiring(v8, 95, -1), 90);
  const f = lastFired(v8, 10);
  assert.equal(f.num, v8.firingOrder[0]);
  assert.equal(f.stroke, 'power');
  assert.equal(lastFired(v8, 90 + 5).num, v8.firingOrder[1]);

  // Uneven V-twin: 0° and 315°.
  const twin = profile({ preset: 'vtwin', cylinders: 2 });
  assert.deepEqual(firingAngles(twin), [0, 315]);
  assert.equal(stepFiring(twin, 0, 1), 315);
  assert.equal(stepFiring(twin, 400, 1), 0);
  assert.equal(lastFired(twin, 200).stroke, 'exhaust');

  // Rotary: one face fires per rotor per shaft turn; the full cycle is 1080°.
  const rot = profile({ preset: 'rotary', cylinders: 2 });
  assert.equal(scrubPeriod(rot), 1080);
  assert.equal(firingAngles(rot).length, 6);
  assert.equal(lastFired(rot, 30), null);
});

test('display mode cycles glass → x-ray → cutaway → glass', () => {
  let s = { xray: false, cutaway: false };
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const next = nextDisplayMode(s);
    s = { ...s, ...next.patch };
    seen.push(displayModeOf(s));
  }
  assert.deepEqual(seen, ['xray', 'cutaway', 'glass']);
  assert.equal(displayModeOf({ xray: true, cutaway: true }), 'cutaway');
  assert.deepEqual(DISPLAY_MODES.map((m) => m.id), ['glass', 'xray', 'cutaway']);
});

test('cylinder chips and layout names', () => {
  assert.equal(cylinderLabel('boxer', 4), 'B4');
  assert.equal(cylinderLabel('boxer', 6), 'F6');
  assert.equal(cylinderLabel('vtwin', 2), 'V2');
  assert.equal(cylinderLabel('v', 10), 'V10');
  assert.equal(cylinderLabel('inline', 5), 'I5');
  assert.equal(cylinderLabel('rotary', 1), '1 rotor');
  assert.equal(cylinderLabel('rotary', 3), '3 rotors');
  assert.equal(layoutLabel(profile({ preset: 'boxer', cylinders: 4 })), 'Boxer-4');
  assert.equal(layoutLabel(profile({ preset: 'boxer', cylinders: 6 })), 'Flat-6');
  assert.equal(layoutLabel(profile({ preset: 'vtwin', cylinders: 2 })), 'V-twin');
  assert.equal(layoutLabel(profile({ preset: 'rotary', cylinders: 2 })), '2-rotor');
  assert.equal(layoutLabel(profile({ preset: 'i4', cylinders: 4 })), 'I4');
  assert.equal(layoutLabel(profile()), 'V8');
});

test('garage specs for every build come from the real profile', () => {
  assert.equal(GARAGE.length, 12);
  for (const entry of GARAGE) {
    const s = garageSpecs(entry);
    const p = buildProfile({ ...DEFAULT_SETTINGS, ...entry.settings });
    const peak = peakFigures(p);
    assert.equal(s.peakHp, Math.round(peak.hp), entry.id);
    assert.equal(s.peakNm, Math.round(peak.nm), entry.id);
    assert.ok(s.peakHp > 50 && s.peakNm > 80, `${entry.id}: ${s.peakHp} hp ${s.peakNm} Nm`);
    assert.ok(s.peakHpRpm <= s.redlineRpm && s.peakNmRpm <= s.peakHpRpm + 1, `${entry.id} peaks in range`);
    assert.equal(s.redlineRpm, entry.settings.redlineRpm);
    assert.equal(s.displacementL, entry.settings.displacementL);
    assert.equal(s.induction, entry.settings.induction);
    assert.equal(s.vvl, !!entry.settings.vvlRpm);
  }
  const byId = Object.fromEntries(GARAGE.map((g) => [g.id, garageSpecs(g)]));
  assert.equal(byId['rally-boxer'].layout, 'Boxer-4');
  assert.equal(byId['flat6-9k'].layout, 'Flat-6');
  assert.equal(byId['vtwin-cruiser'].layout, 'V-twin');
  assert.equal(byId['tt-rotary'].layout, '2-rotor');
  assert.equal(byId['v12-65'].layout, 'V12');
  assert.ok(byId['supercharged-v8'].peakHp > byId.smallblock.peakHp, 'the blower adds power');
});

test('thousands separators', () => {
  assert.equal(groupThousands(950), '950');
  assert.equal(groupThousands(6600), '6,600');
  assert.equal(groupThousands(10450.4), '10,450');
});

test('paddle readout shows the pending gear while a sequential shift is in flight', () => {
  assert.deepEqual(paddleReadout(2, null), { gear: '2', pending: false });
  assert.deepEqual(paddleReadout(2, { source: 'sequential', from: 2, to: 3 }), { gear: '3', pending: true });
  assert.deepEqual(paddleReadout(3, { source: 'sequential', from: 2, to: 3 }), { gear: '3', pending: false }, 'landed');
  assert.deepEqual(paddleReadout(2, { source: 'auto', from: 2, to: 3 }), { gear: '2', pending: false });
  assert.deepEqual(paddleReadout('N', null), { gear: 'N', pending: false });
});

test('settings ranges: displacement per layout and the default cam switch point', () => {
  const v8 = displacementRange(profile());
  assert.ok(v8.min <= 1.0 && v8.max >= 7.9 && v8.max <= 8, JSON.stringify(v8));
  const twin = displacementRange(profile({ preset: 'vtwin', cylinders: 2 }));
  assert.ok(twin.min <= 0.3 && twin.max === 2, JSON.stringify(twin));
  const rot = displacementRange(profile({ preset: 'rotary', cylinders: 2 }));
  assert.deepEqual(rot, { min: 0.6, max: 2 });
  for (const p of [profile(), profile({ preset: 'i4', cylinders: 4, redlineRpm: 9000 })]) {
    const v = defaultVvlRpm(p);
    assert.ok(v >= p.idleRpm + 1000 && v <= p.redlineRpm - 200 && v % 100 === 0, `${v} for redline ${p.redlineRpm}`);
    // The profile builder accepts it unchanged.
    assert.equal(buildProfile({ ...DEFAULT_SETTINGS, preset: p.id.startsWith('inline') ? 'i4' : 'v8-cross', cylinders: p.cylinders.length, redlineRpm: p.redlineRpm, vvlRpm: v }).vvlRpm, v);
  }
});

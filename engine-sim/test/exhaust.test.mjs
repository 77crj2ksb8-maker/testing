import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS } from '../src/config.js';
import { exhaustSpectra, harmonicEnergy } from '../src/exhaust.js';

// Share of a bank's energy that sits below its own even-firing order. A bank
// that fires evenly has nothing there; the crossplane's uneven bank firing
// (the "burble") puts a lot there.
function subOrderShare(spectrum, firingOrderHarmonic, upTo = 64) {
  let sub = 0;
  let total = 0;
  for (let h = 1; h <= upTo; h++) {
    const e = harmonicEnergy(spectrum, h);
    total += e;
    if (h % firingOrderHarmonic !== 0) sub += e;
  }
  return sub / total;
}

const profile = (preset, cylinders) => buildProfile({ ...DEFAULT_SETTINGS, preset, cylinders });

test('flatplane V8 banks fire evenly; crossplane banks do not', () => {
  // Each V8 bank has 4 cylinders → even firing puts all energy on multiples of the 4th harmonic of the 720° cycle.
  const flat = exhaustSpectra(profile('v8-flat', 8), 64);
  const cross = exhaustSpectra(profile('v8-cross', 8), 64);
  for (const bank of flat) assert.ok(subOrderShare(bank, 4) < 0.05, 'flatplane bank should be even');
  for (const bank of cross) assert.ok(subOrderShare(bank, 4) > 0.3, 'crossplane bank should be uneven');
});

test('every layout produces one spectrum per exhaust bank', () => {
  assert.equal(exhaustSpectra(profile('v8-cross', 8), 16).length, 2);
  assert.equal(exhaustSpectra(profile('i4', 4), 16).length, 1);
  assert.equal(exhaustSpectra(profile('rotary', 2), 16).length, 1);
  const [s] = exhaustSpectra(profile('i4', 4), 16);
  assert.equal(s.real[0], 0);
  assert.ok(harmonicEnergy(s, 4) > harmonicEnergy(s, 3) * 10, 'inline-4 sound is dominated by the 2nd engine order');
});

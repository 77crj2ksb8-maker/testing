// Cylinder-pressure model: geometry, physically plausible pressures and
// IMEP at full load, a symmetric motoring loop, and the live operating point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, DEFAULT_SETTINGS, peakFigures } from '../src/config.js';
import { garagePatch } from '../src/presets.js';
import { rig } from './powertrain-rig.mjs';
import {
  pvGeometry, volumeAt, computeCycle, createCycle, imepFromTorque, operatingPoint, pressureAt, cycleIndex, wiebe, PV_POINTS,
} from '../src/pv.js';

const NA_BUILDS = [null, 'smallblock', 'flatplane-45', 'flat6-9k', 'v10-screamer', 'v12-65', 'vvl-i4', 'vtwin-cruiser'];
const profileOf = (id) => buildProfile(id ? { ...DEFAULT_SETTINGS, ...garagePatch(id) } : DEFAULT_SETTINGS);

/** Full-load cycle at the engine's torque peak. */
function wot(profile, extra = {}) {
  const g = pvGeometry(profile);
  const pk = peakFigures(profile);
  const boost = profile.induction?.targetBar ?? 0;
  const cycle = computeCycle(g, {
    pIntake: 1 + boost, pExhaust: 1.08 + boost * 0.9, rpm: pk.nmRpm, redlineRpm: profile.redlineRpm,
    imepTarget: imepFromTorque(pk.nm, profile.displacementL), ...extra,
  });
  return { g, cycle };
}

test('pv: slider-crank volume and compression ratio', () => {
  const p = profileOf(null);
  const g = pvGeometry(p);
  assert.ok(Math.abs(volumeAt(g, 0) - g.vc) < 1e-12, 'TDC volume is the clearance volume');
  assert.ok(Math.abs(volumeAt(g, 180) - (g.vc + g.vd)) < 1e-12, 'BDC volume');
  assert.ok(Math.abs(volumeAt(g, -180) - (g.vc + g.vd)) < 1e-12);
  assert.ok(Math.abs((g.vc + g.vd) / g.vc - p.compressionRatio) < 1e-9, 'compression ratio from the profile');
  assert.ok(Math.abs(g.vd * g.cylinders * 1000 - p.displacementL) < 1e-6, 'swept volume adds up to the displacement');
  // A finite rod makes the piston spend longer near BDC: at 90° it is past mid-stroke.
  assert.ok(volumeAt(g, 90) > g.vc + g.vd / 2);
  assert.equal(volumeAt(g, 37), volumeAt(g, -37));
  assert.equal(volumeAt(g, 400), volumeAt(g, 40));
});

test('pv: full-load naturally aspirated cycles are physically plausible', () => {
  for (const id of NA_BUILDS) {
    const p = profileOf(id);
    const { cycle } = wot(p);
    assert.ok(cycle.peakBar >= 40 && cycle.peakBar <= 120, `${id ?? 'default'} peak ${cycle.peakBar.toFixed(1)} bar`);
    assert.ok(cycle.peakDeg > 2 && cycle.peakDeg < 25, `${id ?? 'default'} peak ${cycle.peakDeg}° after TDC`);
    assert.ok(cycle.imep >= 8 && cycle.imep <= 15, `${id ?? 'default'} IMEP ${cycle.imep.toFixed(2)} bar`);
    assert.ok(cycle.imepNet > 0, 'the loop does positive work');
    assert.ok(cycle.pmep < 0 && cycle.pmep > -0.5, `pumping loop costs a little at WOT (${cycle.pmep.toFixed(2)})`);
    assert.ok(Math.abs(cycle.imep - imepFromTorque(peakFigures(p).nm, p.displacementL)) < 0.01, 'IMEP calibrated to torque');
    // Pressures stay physical everywhere.
    for (let i = 0; i < PV_POINTS; i++) assert.ok(cycle.p[i] > 0.1 && Number.isFinite(cycle.p[i]));
  }
});

test('pv: boost raises the cylinder pressure; part throttle pulls a pumping loss', () => {
  const p = profileOf('turbo-i6');
  const { cycle } = wot(p);
  assert.ok(cycle.peakBar > 90 && cycle.peakBar < 190, `boosted peak ${cycle.peakBar.toFixed(0)} bar`);
  assert.ok(cycle.imep > 18, 'boosted IMEP');
  const na = profileOf(null);
  const g = pvGeometry(na);
  const part = computeCycle(g, { pIntake: 0.45, pExhaust: 1.04, rpm: 2500, redlineRpm: 7000, imepTarget: 4 });
  assert.ok(part.pmep < -0.4, `throttled pumping loss (${part.pmep.toFixed(2)} bar)`);
  assert.ok(part.peakBar < wot(na).cycle.peakBar, 'lower peak at part load');
});

test('pv: the motoring loop is symmetric about TDC and does no net work', () => {
  const g = pvGeometry(profileOf(null));
  const c = computeCycle(g, { pIntake: 1, pExhaust: 1.05, rpm: 3000, redlineRpm: 7000, imepTarget: 0 });
  for (let a = 0; a <= 125; a += 5) {
    const l = pressureAt(c, -a);
    const r = pressureAt(c, a);
    assert.ok(Math.abs(l - r) / l < 1e-6, `p(−${a}) = p(${a}) (${l.toFixed(4)} vs ${r.toFixed(4)})`);
  }
  assert.ok(Math.abs(c.imep) < 0.05, `no work in the closed part (${c.imep.toFixed(3)} bar)`);
  assert.ok(c.peakDeg === 0, 'motored peak sits at TDC');
  assert.ok(Math.abs(c.peakBar - Math.pow((g.vc + volumeAt(g, -160) - g.vc) / g.vc, 1.3)) < 0.05, 'polytropic compression from IVC');
  assert.equal(c.heatJ, 0);
});

test('pv: Wiebe burn fraction and angle helpers', () => {
  assert.equal(wiebe(-30, -20, 50), 0);
  assert.ok(wiebe(5, -20, 50) > 0.3 && wiebe(5, -20, 50) < 0.7);
  assert.ok(wiebe(30, -20, 50) > 0.99);
  assert.equal(cycleIndex(0), 360);
  assert.equal(cycleIndex(720), 360);
  assert.equal(cycleIndex(-360), 720, 'both ends are the same TDC');
  assert.equal(cycleIndex(-359), 1);
  assert.equal(cycleIndex(720 + 90), 450);
  assert.equal(cycleIndex(450), 90, '450° after firing is 270° before the next one');
  const c = createCycle();
  assert.equal(c.p.length, PV_POINTS);
});

test('pv: operating point from the live simulator', () => {
  const r = rig({});
  r.run(1.5, {});
  const idle = operatingPoint(r.sim, r.profile);
  assert.ok(idle.pIntake < 0.6, `vacuum at idle (${idle.pIntake.toFixed(2)} bar abs)`);
  r.run(0.3, { gas: 1 }); // still climbing, not yet on the limiter
  const wide = operatingPoint(r.sim, r.profile);
  assert.ok(wide.pIntake > 0.9, 'atmospheric at wide-open throttle');
  assert.ok(wide.imepTarget > idle.imepTarget * 4, 'more work at full load');
  const cycle = computeCycle(pvGeometry(r.profile), wide);
  assert.ok(cycle.peakBar > 30);
  r.sim.fuelCut = true;
  assert.equal(operatingPoint(r.sim, r.profile).imepTarget, 0, 'no combustion on a fuel cut');
});

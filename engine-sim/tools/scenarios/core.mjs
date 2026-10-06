// Core regression scenario: boot, idle, rev, launch, grind, stall + restart,
// panels. Every track must keep this passing.

export default async function core({ evaluate, advance, shot, expect, tap }) {
  const state = () => evaluate(() => {
    const a = window.__app;
    return { rpm: a.sim.rpm, kmh: a.sim.speedKmh, gear: a.sim.gear, running: a.sim.running, mode: a.settings.mode };
  });

  let s = await advance(2, {});
  expect(Math.abs(s.rpm - 800) < 60, `idles near 800 rpm (got ${s.rpm.toFixed(0)})`);
  await shot('core-idle');

  s = await advance(1, { gas: 1 });
  expect(s.rpm > 6000, `free-revs past 6000 in neutral (got ${s.rpm.toFixed(0)})`);
  await advance(3, {});

  // Clutch in, first gear, launch.
  await advance(0.3, { clutch: 1 });
  const sel = await evaluate(() => window.__app.actions.selectGear(1, 'test'));
  expect(sel.ok, 'first gear engages with the clutch down');
  await advance(0.5, { clutch: 1, gas: 1 });
  for (let i = 0; i < 10; i++) await advance(0.03, { gas: 1, clutch: 1 - (i + 1) / 10 });
  s = await advance(2.5, { gas: 1 });
  expect(s.running && s.kmh > 30, `launch pulls away (got ${s.kmh.toFixed(1)} km/h)`);
  await shot('core-launch');

  // Grind: second without the clutch.
  await evaluate(() => window.__app.actions.selectGear('N', 'test'));
  const grind = await evaluate(() => window.__app.actions.selectGear(2, 'test'));
  expect(grind.grind === true, 'clutchless 2nd at a big rev gap grinds');

  // Stall: stop, first gear, dump the clutch at idle.
  await advance(12, { brake: 1 });
  await advance(0.3, { clutch: 1 });
  await evaluate(() => window.__app.actions.selectGear(1, 'test'));
  s = await advance(1.5, {});
  expect(!s.running, 'dumping the clutch at idle stalls');
  await shot('core-stalled');
  await advance(0.2, { clutch: 1 });
  await evaluate(() => window.__app.actions.startEngine());
  s = await advance(2.5, { clutch: 1 });
  expect(s.running, 'restarts with the clutch down');
  // Hand back to the live frame loop in neutral (its pedals are all up).
  await evaluate(() => window.__app.actions.selectGear('N', 'test'));

  // Panels open and close without errors.
  await tap('#btn-telemetry');
  await shot('core-telemetry');
  await tap('#btn-telemetry');
  await tap('#btn-settings');
  await shot('core-settings');
  await evaluate(() => window.__app.actions.closeSettings());
  const final = await state();
  expect(final.running, 'engine still running at the end');
}

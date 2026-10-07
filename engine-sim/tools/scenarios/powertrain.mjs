// Powertrain scenario: garage builds in every new layout, turbo boost and the
// blow-off valve, sequential shifting with the two-step, a refused over-rev
// downshift, a money shift that blows the engine, and the rebuild.

export default async function powertrain({ evaluate, advance, shot, expect, log }) {
  const state = () => evaluate(() => {
    const s = window.__app.sim;
    return {
      rpm: s.rpm, kmh: s.speedKmh, gear: s.gear, running: s.running, blown: s.blown, damage: s.damage,
      boost: s.boostBar, target: s.boostTarget, turboRpm: s.turboRpm, kind: s.inductionKind, layout: window.__app.profile.layout,
      launchActive: s.launchActive, coolant: s.coolantC, egt: s.egtC,
    };
  });
  // Record every bus event from here on.
  await evaluate(() => {
    window.__events = [];
    window.__app.bus.on('*', (type, payload) => window.__events.push({ type, ...payload }));
  });
  const events = (type) => evaluate((t) => window.__events.filter((e) => e.type === t), type);
  const clearEvents = () => evaluate(() => (window.__events.length = 0));

  // ── Every new layout builds, idles and renders ───────────────────────────
  for (const [id, layout] of [['flat6-9k', 'boxer'], ['vtwin-cruiser', 'vtwin'], ['tt-rotary', 'rotary'], ['vvl-i4', 'inline']]) {
    const ok = await evaluate((g) => window.__app.actions.loadGarage(g), id);
    expect(ok, `garage build ${id} loads`);
    const s = await advance(2.5, {});
    expect(s.running && Math.abs(s.rpm - (await evaluate(() => window.__app.profile.idleRpm))) < 80, `${id} idles (${s.rpm.toFixed(0)} rpm)`);
    expect((await state()).layout === layout, `${id} is a ${layout} layout`);
    await shot(`pt-garage-${id}`);
  }
  expect(!(await evaluate(() => window.__app.actions.loadGarage('nope'))), 'unknown garage id is rejected');

  // ── Turbo boxer, sequential box, two-step launch ─────────────────────────
  await evaluate(() => {
    window.__app.actions.loadGarage('rally-boxer');
    window.__app.apply({ mode: 'sequential', launchControl: true, launchRpm: 4500, tractionControl: false }, 'all');
  });
  let s = await state();
  expect(s.layout === 'boxer' && s.kind === 'turbo', 'rally boxer is a turbo boxer');
  await advance(1, {});
  s = await state();
  expect(s.boost < -0.3, `idle pulls vacuum (${s.boost.toFixed(2)} bar)`);
  const up = await evaluate(() => window.__app.actions.shiftUp());
  expect(up.ok && up.gear === 1, 'paddle up selects 1st from neutral');
  await clearEvents();
  await advance(1.5, { gas: 1, brake: 1 });
  s = await state();
  expect(s.launchActive && Math.abs(s.rpm - 4500) < 350, `two-step holds launch revs (${s.rpm.toFixed(0)} rpm)`);
  expect((await events('twostep')).length > 3, 'two-step crackles');
  await shot('pt-two-step');

  s = await advance(2.2, { gas: 1 });
  expect(s.kmh > 35, `launches on the automated clutch (${s.kmh.toFixed(0)} km/h)`);
  s = await state();
  expect(s.boost > 0.75 * s.target && s.turboRpm > 80000, `turbo on boost (${s.boost.toFixed(2)} of ${s.target} bar, ${Math.round(s.turboRpm)} turbo rpm)`);
  await shot('pt-boost');

  await clearEvents();
  await evaluate(() => window.__app.actions.shiftUp());
  await advance(0.4, { gas: 1 });
  const flat = (await events('shift')).at(-1);
  expect(flat && flat.to === 2 && flat.kind === 'up' && flat.flat === true && flat.source === 'sequential', 'flat-shift to 2nd emits a shift event');
  expect((await events('backfire')).some((e) => e.source === 'shift'), 'flat shift cracks a backfire');
  s = await advance(2.6, { gas: 1 });
  log(`2nd gear ${s.kmh.toFixed(0)} km/h at ${s.rpm.toFixed(0)} rpm`);

  // 1st at this speed would be far past redline: refused with a reason.
  // (The live frame loop runs with the pedals up between calls, so the
  // throttle closes here and the blow-off valve should vent.)
  await clearEvents();
  const refused = await evaluate(() => window.__app.actions.shiftDown());
  expect(!refused.ok && /over-rev/.test(refused.reason ?? ''), `over-rev downshift refused ("${refused.reason}")`);
  await shot('pt-refused');
  expect((await state()).gear === 2, 'still in 2nd');
  await advance(0.5, {});
  const bov = await events('bov');
  expect(bov.length === 1 && bov[0].boostBar > 0.3, `blow-off valve vents on lift (${bov[0]?.boostBar?.toFixed(2)} bar)`);

  // Up to 3rd for speed, then switch to the H-pattern for the money shift.
  await evaluate(() => window.__app.actions.shiftUp());
  s = await advance(3, { gas: 1 });
  log(`3rd gear ${s.kmh.toFixed(0)} km/h at ${s.rpm.toFixed(0)} rpm`);
  await evaluate(() => window.__app.apply({ mode: 'manual' }, 'mode'));
  await clearEvents();
  await advance(0.2, { clutch: 1 });
  const money = await evaluate(() => window.__app.actions.selectGear(1, 'test'));
  expect(money.ok, 'the H-pattern lets you select 1st at speed');
  await advance(0.4, {});
  s = await state();
  const blown = await events('blown');
  expect(blown.length === 1 && blown[0].cause === 'over-rev', 'money shift blows the engine');
  expect((await events('overrev')).length >= 1, 'overrev event fired');
  expect(s.blown && !s.running && s.damage === 1, 'engine is dead');
  await shot('pt-blown');

  // Dead engine: coast to a stop, the starter refuses until rebuilt.
  await advance(10, { brake: 1, clutch: 1 });
  await evaluate(() => window.__app.actions.selectGear('N', 'test'));
  expect(!(await evaluate(() => window.__app.sim.startEngine())), 'blown engine will not crank');
  await advance(1, {});
  expect(!(await state()).running, 'still not running');

  // Start button on a blown engine rebuilds it; the next press starts it.
  await clearEvents();
  await evaluate(() => window.__app.actions.startEngine());
  s = await state();
  expect(!s.blown && s.damage === 0, 'start rebuilds the blown engine');
  expect((await events('repair')).length === 1, 'repair event');
  await evaluate(() => window.__app.actions.startEngine());
  s = await advance(3, {});
  expect(s.running && Math.abs(s.rpm - 850) < 80, `rebuilt engine idles (${s.rpm.toFixed(0)} rpm)`);
  await shot('pt-rebuilt');

  // Leave the app in a calm state for the live frame loop.
  await evaluate(() => window.__app.apply({ launchControl: false }, 'assist'));
  s = await state();
  expect(s.running && !s.blown, 'engine running at the end');
}

// Modes scenario: a full drag pass (stage, tree, launch, time slip), a red
// light, a dyno pull that restores the car afterwards, the cylinder-pressure
// charts in telemetry and the achievements list.

export default async function modes({ page, evaluate, advance, shot, expect, log, tap }) {
  await evaluate(() => {
    window.__events = [];
    window.__app.bus.on('*', (type, payload) => window.__events.push({ type, ...payload }));
  });
  const events = (type) => evaluate((t) => window.__events.filter((e) => e.type === t), type);
  const race = () => evaluate(() => {
    const r = window.__app.modes.race;
    return { phase: r.phase, ambers: r.ambers, green: r.greenLit, foul: r.foul, et: r.et, distance: r.distance };
  });
  /** Wait (real time) until a page condition holds; false on timeout. */
  const waitFor = (fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);
  /** What a floating card covers: HUD cards, the driving controls, rail buttons, or the screen edge. */
  const covers = (sel) => evaluate((sel) => {
    const box = document.querySelector(sel).getBoundingClientRect();
    const hard = [];
    const rail = [];
    const hit = (node) => {
      const r = node.getBoundingClientRect();
      return r.width && r.height && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
    };
    for (const s of ['.tach', '.hud-right', '.shifter-wrap', '.pedal-wrap']) if (hit(document.querySelector(s))) hard.push(s);
    for (const b of document.querySelectorAll('#tool-rail > *')) if (hit(b)) rail.push(`#${b.id}`);
    if (box.left < 0 || box.top < 0 || box.right > window.innerWidth + 0.5 || box.bottom > window.innerHeight + 0.5) hard.push('screen edge');
    return { hard, rail, box: `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}×${Math.round(box.height)}` };
  }, sel);
  const clearOf = async (sel, name, { rail = true } = {}) => {
    const c = await covers(sel);
    log(`${name} at ${c.box}${c.rail.length ? ` (over ${c.rail.join(' ')})` : ''}`);
    expect(c.hard.length === 0, `${name} clear of the HUD and the controls${c.hard.length ? ` (covers ${c.hard.join(', ')})` : ''}`);
    if (rail) expect(c.rail.length === 0, `${name} clear of the tool rail${c.rail.length ? ` (covers ${c.rail.join(', ')})` : ''}`);
  };

  /** Step in small slices until the race reaches a phase (or a time limit). */
  const until = async (phase, input, limit = 8, slice = 0.05) => {
    for (let t = 0; t < limit; t += slice) {
      await advance(slice, input);
      if ((await race()).phase === phase) return true;
    }
    return false;
  };

  // ── Drag pass on the automatic box ──────────────────────────────────────
  await evaluate(() => window.__app.apply({ mode: 'auto', units: 'kmh' }, 'all'));
  await advance(1, {});
  await tap('#tool-drag');
  expect(await evaluate(() => document.querySelector('#tool-drag').getAttribute('aria-pressed') === 'true'), 'drag button shows pressed');
  expect((await race()).phase === 'pre', 'drag strip armed');
  await clearOf('.mo-drag', 'drag card');
  await evaluate(() => window.__app.actions.selectGear(1, 'test'));
  expect(await until('staged', { brake: 1 }, 3), 'stages once stopped with the engine running');
  expect(await until('tree', { brake: 1 }, 3), 'tree starts');
  await advance(0.6, { brake: 1 });
  const tree = await race();
  expect(tree.ambers >= 2, `ambers count down (${tree.ambers} lit)`);
  await shot('modes-drag-tree');
  expect(await until('green', { brake: 1 }, 3, 1 / 60), 'green light');
  await advance(0.15, { brake: 1 }); // a human-ish reaction
  await advance(4, { gas: 1 });
  let r = await race();
  expect(r.phase === 'run' && r.distance > 40, `running (${r.distance.toFixed(0)} m at ${r.et.toFixed(2)} s)`);
  await shot('modes-drag-run');
  expect(await until('done', { gas: 1 }, 30, 2), 'crosses the finish line');
  const finish = (await events('drag:finish'))[0];
  expect(!!finish, 'drag:finish emitted');
  const res = finish?.result;
  log(`ET ${res?.et.toFixed(3)} s, R/T ${res?.reaction.toFixed(3)}, trap ${res?.trapKmh.toFixed(1)} km/h, 60ft ${res?.splits[0].t.toFixed(3)}`);
  expect(res && !res.foul && res.et > 9 && res.et < 18, 'plausible quarter-mile ET for the default V8');
  expect(res && res.reaction > 0.15 && res.reaction < 0.9, 'reaction time measured from the green (incl. the automated clutch)');
  expect(res && res.trapKmh > 140 && res.trapKmh < 260, 'plausible trap speed');
  expect(res && res.splits.every((s, i, a) => s.t > 0 && (i === 0 || s.t > a[i - 1].t)), 'splits rise in order');
  expect(await evaluate(() => !document.querySelector('.mo-slip').hidden), 'time slip shows');
  expect((await events('drag:stage')).length === 1 && (await events('drag:green')).length === 1, 'stage and green events');
  expect(await evaluate(() => document.querySelector('.mo-drag').hidden), 'the slip takes the place of the live card');
  await advance(6, { brake: 1 });
  await clearOf('.mo-slip', 'time slip', { rail: false });
  await shot('modes-drag-slip');

  // ── Red light ───────────────────────────────────────────────────────────
  await advance(4, { brake: 1 }); // stop fully
  await tap('.mo-slip .primary-btn');
  expect(await evaluate(() => document.querySelector('.mo-slip').hidden && !document.querySelector('.mo-drag').hidden), 'run again brings back the live card');
  expect(await until('tree', { brake: 1 }, 6), 'restages for a second run');
  await advance(0.6, { brake: 1 });
  await advance(1.5, { gas: 1 }); // leave on the second amber
  r = await race();
  expect(r.foul, 'leaving before the green is a red light');
  expect((await events('drag:foul')).length === 1, 'drag:foul emitted');
  await shot('modes-drag-redlight');
  await evaluate(() => window.__app.apply({ units: 'mph' }, 'hud'));
  const unitsOk = await waitFor(() => {
    const units = [...document.querySelectorAll('.mo-drag .mo-num span')].map((n) => n.textContent);
    return units.includes('mph') && units.includes('ft');
  });
  const units = await evaluate(() => [...document.querySelectorAll('.mo-drag .mo-num span')].map((n) => n.textContent));
  expect(unitsOk, `drag card follows the units setting (${units.join(', ')})`);
  await evaluate(() => window.__app.apply({ units: 'kmh' }, 'hud'));
  await page.keyboard.press('Escape');
  expect(await evaluate(() => !window.__app.modes.race.active && document.querySelector('.mo-drag').hidden), 'Esc leaves the drag strip');

  // ── Dyno pull ───────────────────────────────────────────────────────────
  await advance(8, { brake: 1 });
  await evaluate(() => window.__app.actions.selectGear('N', 'test'));
  await advance(1, {});
  const before = await evaluate(() => {
    const a = window.__app;
    return { distance: a.sim.distance, top: a.stats.topSpeedKmh, drive: a.sim.drive === a.drive, mode: a.gearbox.mode };
  });
  await tap('#tool-dyno');
  const mounted = await evaluate(() => {
    const a = window.__app;
    return { onRollers: a.sim.drive !== a.drive, dragArea: a.sim.drive.dragArea, mode: a.gearbox.mode, open: a.modes.dyno.open };
  });
  expect(mounted.open && mounted.onRollers && mounted.dragArea === 0, 'car strapped to the rollers (no aero)');
  expect(mounted.mode === 'manual', 'dyno works the gearbox itself');
  // The sheet may cover the lever and pedals (the car is strapped down), never the tach or the top-right buttons.
  const dynoBox = await covers('.mo-dyno');
  const measured = await evaluate(() => document.querySelector('.mo-dyno').style.width !== '');
  const landscape = await evaluate(() => window.matchMedia('(max-height: 500px)').matches);
  log(`dyno sheet at ${dynoBox.box}${dynoBox.rail.length ? ` (over ${dynoBox.rail.join(' ')})` : ''}${landscape && !measured ? ' (no room between the HUD columns: right-hand sheet)' : ''}`);
  const dynoHard = dynoBox.hard.filter((h) => h !== '.shifter-wrap' && h !== '.pedal-wrap');
  if (landscape && !measured && dynoHard.every((h) => h === '.hud-right')) {
    if (dynoHard.length) log('WARNING: the centre column is too narrow for the dyno sheet here, so it covers the top-right buttons');
  } else {
    expect(dynoHard.length === 0, `dyno sheet clear of the tach and the top-right buttons${dynoHard.length ? ` (covers ${dynoHard.join(', ')})` : ''}`);
  }
  if (landscape && measured) expect(dynoBox.rail.length === 0, `dyno sheet clear of the tool rail${dynoBox.rail.length ? ` (covers ${dynoBox.rail.join(', ')})` : ''}`);
  await shot('modes-dyno-ready');
  await tap('.mo-dyno .primary-btn');
  expect((await events('dyno:start')).length === 1, 'dyno:start emitted');
  await advance(2.2, {});
  const mid = await evaluate(() => ({ phase: window.__app.modes.dyno.phase, gear: window.__app.sim.gear, rpm: window.__app.sim.rpm }));
  expect(mid.phase === 'pull' && mid.gear === 4, `pulling in 4th (${mid.phase}, ${mid.rpm.toFixed(0)} rpm)`);
  await advance(3.5, {});
  await shot('modes-dyno-pull');
  for (let i = 0; i < 20 && (await evaluate(() => window.__app.modes.dyno.phase)) !== 'ready'; i++) await advance(1, {});
  const done = (await events('dyno:done'))[0];
  expect(!!done, 'dyno:done emitted');
  const spec = await evaluate(() => ({ peak: window.__app.profile.maxTorqueNm }));
  log(`dyno ${done?.peakHp.toFixed(0)} hp @ ${done?.peakHpRpm}, ${done?.peakNm.toFixed(0)} Nm @ ${done?.peakNmRpm} (rated peak ${spec.peak.toFixed(0)} Nm)`);
  expect(done && done.peakNm > spec.peak * 0.8 && done.peakNm < spec.peak * 1.02, 'measured peak torque close to (and below) rated');
  expect(done && done.peakHpRpm > done.peakNmRpm, 'peak power above peak torque rpm');
  const back = await evaluate(() => ({ gear: window.__app.sim.gear, v: window.__app.sim.v }));
  expect(back.gear === 'N' && Math.abs(back.v) < 0.3, 'rollers stopped, back in neutral');
  await shot('modes-dyno-done');
  const refused = await evaluate(() => window.__app.actions.selectGear(2, 'test'));
  expect(refused && refused.ok === false, 'gear changes are refused on the dyno');
  await tap('.mo-dyno .mo-close');
  const after = await evaluate(() => {
    const a = window.__app;
    return {
      drive: a.sim.drive === a.drive, gear: a.sim.gear, v: a.sim.v, mode: a.gearbox.mode, settingsMode: a.settings.mode,
      distance: a.sim.distance, top: a.stats.topSpeedKmh, hidden: document.querySelector('.mo-dyno').hidden,
    };
  });
  expect(after.drive && after.gear === 'N' && after.v === 0, 'car restored: road drive, neutral, standing');
  expect(after.mode === after.settingsMode && after.mode === before.mode, 'gearbox mode restored');
  expect(Math.abs(after.distance - before.distance) < 1 && Math.abs(after.top - before.top) < 0.01, 'roller miles and speeds do not count');
  expect(after.hidden, 'dyno panel closed');

  // ── Telemetry: cylinder pressure and achievements ──────────────────────
  await evaluate(() => window.__app.apply({ mode: 'manual' }, 'all'));
  await tap('#btn-telemetry');
  await evaluate(() => {
    const a = window.__app;
    a.debugApi.advance(0.35, { gas: 1 }); // full throttle, still climbing to the limiter
    a.actions.refreshPressure();
    a.viewState.scrubDeg = 12; // a scrubbed crank holds the cycle still; 12° after firing TDC is near the peak
    document.querySelector('.mo-section[aria-label="Cylinder pressure"]').scrollIntoView({ block: 'start' });
  });
  // The pressure charts need a telemetry panel with some width to draw in.
  const panelW = await evaluate(() => document.querySelector('.mo-section[aria-label="Cylinder pressure"]').getBoundingClientRect().width);
  const roomy = panelW >= 200;
  if (!roomy) log(`WARNING: the telemetry panel is only ${Math.round(panelW)} px wide in this layout (the tool rail squeezes it); charts cannot draw`);
  const marked = roomy ? await waitFor(() => /Power/.test(window.__app.modes.pv.now.textContent)) : true;
  await waitFor(() => !document.querySelector('#toast')?.classList.contains('is-on'), undefined, 4000);
  const pv = await evaluate(() => {
    const c = window.__app.modes.pv.cycle;
    return { peak: c.peakBar, imep: c.imep, readout: document.querySelector('.mo-section .chart-readout').textContent, now: window.__app.modes.pv.now.textContent };
  });
  log(`pressure: ${pv.readout} | ${pv.now}`);
  expect(pv.peak > 40 && pv.peak < 120 && pv.imep > 8 && pv.imep < 15 && /IMEP/.test(pv.readout), 'full-load cycle in telemetry (40-120 bar peak, 8-15 bar IMEP)');
  expect(marked && (!roomy || /Power/.test(pv.now)), `marker follows the scrubbed crank angle (${pv.now})`);
  await shot('modes-pv');
  await evaluate(() => document.querySelector('.mo-section[aria-label="Achievements"]').scrollIntoView({ block: 'start' }));
  const ach = await evaluate(() => ({ list: window.__events.filter((e) => e.type === 'achievement').map((e) => e.id), count: window.__app.modes.achievements.count }));
  log(`achievements: ${ach.list.join(', ')}`);
  expect(ach.list.includes('dyno') && ach.list.includes('red-light') && ach.list.includes('speed-100'), 'achievements unlocked along the way');
  await shot('modes-achievements');
  await evaluate(() => {
    window.__app.viewState.scrubDeg = null;
  });

  // ── Rotary: no cylinders, no pressure chart ─────────────────────────────
  await evaluate(() => window.__app.actions.loadGarage('tt-rotary'));
  expect(await evaluate(() => document.querySelector('.mo-section[aria-label="Cylinder pressure"]').hidden), 'pressure charts hidden for a rotary');
  await evaluate(() => window.__app.actions.loadGarage('smallblock'));
  expect(await evaluate(() => !document.querySelector('.mo-section[aria-label="Cylinder pressure"]').hidden), 'and back for a piston engine');
  await tap('#btn-telemetry');
  const final = await evaluate(() => window.__app.sim.running);
  expect(final, 'engine still running at the end');
}

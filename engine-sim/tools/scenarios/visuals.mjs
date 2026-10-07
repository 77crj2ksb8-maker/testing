// Visuals scenario: every display mode, induction kit and layout renders,
// the event wiring reaches the view, kinematics keep running while exploded,
// and a V12 with everything on stays inside the draw-call budget.
//
//   node tools/smoke.mjs --port 5320 --scenario tools/scenarios/visuals.mjs --out dist/smoke

const DRAW_CALL_BUDGET = 350;

export default async function visuals({ page, evaluate, advance, shot, expect, log }) {
  // Frames are slow in software rendering: wait on state and on frames, not on time.
  const until = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
  const frames = (n) => evaluate((k) => new Promise((resolve) => {
    let left = k;
    const step = () => (--left <= 0 ? resolve(true) : window.requestAnimationFrame(step));
    window.requestAnimationFrame(step);
  }), n);
  // Jump the camera to a preset without the fly-in (the software renderer runs at a few fps).
  const snapTo = (id) => evaluate((name) => {
    const v = window.__app.view;
    v.rig.active = name;
    const p = v.presetPose(name);
    v.rig.flyTo(p.target, p.position, true);
  }, id);
  const apply = (patch, kind = 'engine') => evaluate(([p, k]) => window.__app.apply(p, k), [patch, kind]);
  const calls = () => evaluate(() => {
    const v = window.__app.view;
    v.renderer.render(v.scene, v.camera); // direct pass: count scene draws, not post passes
    return v.renderer.info.render.calls;
  });

  // The software renderer manages a few fps without bloom and far less with it,
  // so the timing checks run on 'low'; bloom gets its own shots at the end.
  await apply({ quality: 'low' }, 'view');

  // ── Default V8 ─────────────────────────────────────────────────────────────
  await advance(1.5, {});
  await advance(0.6, { gas: 0.6 });
  let s = await evaluate(() => ({
    presets: window.__app.view.cameraPresets,
    layout: window.__app.view.layout,
    bloom: window.__app.view.bloomActive,
  }));
  expect(s.layout === 'v', `default engine is laid out as a V (got ${s.layout})`);
  expect(['hero', 'front', 'side', 'top', 'valvetrain', 'gearbox', 'under'].every((p) => s.presets.includes(p)), 'camera presets cover hero…under');
  await shot('vis-v8-default');

  // Camera preset flies there with an eased move.
  const label = await evaluate(() => window.__app.view.setCameraPreset('side'));
  expect(label === 'Side', `setCameraPreset returns a label (got ${label})`);
  await page.waitForFunction(() => !window.__app.view.rig.flight, null, { timeout: 20000 });
  const flown = await evaluate(() => {
    const v = window.__app.view;
    const pose = v.presetPose('side');
    return { d: v.camera.position.distanceTo(pose.position), flying: !!v.rig.flight };
  });
  expect(!flown.flying && flown.d < 0.05, `fly-to lands on the preset (off by ${flown.d.toFixed(3)})`);

  // Cinematic orbit moves the camera; a user drag stops it.
  await evaluate(() => {
    const v = window.__app.view;
    v.setCinematic(true);
    window.__camStart = v.camera.position.clone();
  });
  await frames(3);
  const orbit = await evaluate(() => {
    const v = window.__app.view;
    const moved = v.camera.position.distanceTo(window.__camStart);
    v.controls.dispatchEvent({ type: 'start' });
    return { moved, on: v.cinematic };
  });
  expect(orbit.moved > 0.01 && orbit.on === false, `cinematic orbit moves (${orbit.moved.toFixed(3)}) and user input stops it`);

  // ── Valvetrain close-up, frozen with stroke labels ──────────────────────────
  await snapTo('valvetrain');
  await evaluate(() => { window.__app.viewState.scrubDeg = 100; });
  await frames(2);
  const vt = await evaluate(() => {
    const v = window.__app.view;
    const chips = [...document.querySelectorAll('.stroke-chip')];
    const cam = v.valvetrain.objects.find((o) => o.isMesh && !o.isInstancedMesh);
    return {
      chips: chips.length,
      visible: !document.querySelector('.stroke-labels').hidden,
      words: chips.map((c) => c.textContent),
      camRot: cam.rotation.z,
      crank: window.__app.viewState.crankDeg,
    };
  });
  expect(vt.visible && vt.chips === 8, `frozen view shows a stroke label per cylinder (${vt.chips})`);
  expect(vt.words.some((w) => /Power/.test(w)) && vt.words.some((w) => /Intake/.test(w)), `labels name the strokes (${vt.words.join(', ')})`);
  expect(Math.abs(vt.camRot - (-vt.crank / 2) * Math.PI / 180) < 1e-6, 'cams turn at half crank speed');
  await shot('vis-valvetrain-labels');
  await evaluate(() => { window.__app.viewState.scrubDeg = null; });
  const hidden = await until(() => document.querySelector('.stroke-labels').hidden);
  expect(hidden, 'labels hide when the animation runs again');

  // ── X-ray and cutaway ───────────────────────────────────────────────────────
  await snapTo('hero');
  await apply({ xray: true }, 'view');
  await advance(0.3, { gas: 0.5 });
  const xr = await evaluate(() => window.__app.view.metal.every((m) => m.material === window.__app.view.xrayMat || m.userData.baseMaterial === m.material));
  expect(xr, 'x-ray swaps moving parts to the x-ray material');
  await shot('vis-xray');
  await apply({ xray: false, cutaway: true }, 'view');
  const cut = await evaluate(() => {
    const M = window.__app.view.M;
    return { housings: !!M.glass.clippingPlanes?.length && !!M.glassDark.clippingPlanes?.length, metal: !M.chrome.clippingPlanes?.length };
  });
  expect(cut.housings && cut.metal, 'cutaway clips housings only');
  await shot('vis-cutaway');
  await apply({ cutaway: false }, 'view');

  // ── Exploded view: animated, and kinematics keep running ────────────────────
  await evaluate(() => window.__app.view.setExplode(1));
  await frames(2);
  const mid = await evaluate(() => window.__app.view.explodeT);
  expect(mid > 0.02 && mid < 1, `explode animates (t=${mid.toFixed(2)} two frames in)`);
  await until(() => window.__app.view.explodeT === 1);
  await advance(0.3, { gas: 0.4 });
  await evaluate(() => {
    const v = window.__app.view;
    const m = new v.m4.constructor();
    v.pistons.getMatrixAt(0, m);
    window.__pistonY = m.elements[13];
  });
  await frames(3);
  const ex = await evaluate(() => {
    const v = window.__app.view;
    const m = new v.m4.constructor();
    v.pistons.getMatrixAt(0, m);
    return { t: v.explodeT, moved: Math.abs(m.elements[13] - window.__pistonY) };
  });
  expect(ex.t > 0.97, `explode reaches fully exploded (t=${ex.t.toFixed(2)})`);
  expect(ex.moved > 1e-4, 'pistons keep moving in the exploded view');
  await shot('vis-exploded');
  await evaluate(() => {
    const v = window.__app.view;
    v.setExplode(0);
    v.explodeT = 0;
    v.applyExplode(0);
  });

  // ── Induction kits ──────────────────────────────────────────────────────────
  await apply({ induction: 'turbo' });
  await advance(1.5, { gas: 1 });
  await evaluate(() => { window.__wheel = window.__app.view.inductionHw.turbos[0].wheel.rotation.z; });
  await frames(2);
  const spin = await evaluate(() => {
    const t = window.__app.view.inductionHw.turbos[0];
    return { n: window.__app.view.inductionHw.turbos.length, moved: Math.abs(t.wheel.rotation.z - window.__wheel) };
  });
  expect(spin.n === 1 && spin.moved > 0, `single turbo with a spinning compressor wheel (Δ${spin.moved.toFixed(3)} rad)`);
  await shot('vis-turbo');
  await apply({ induction: 'twin-turbo' });
  const twin = await evaluate(() => window.__app.view.inductionHw.turbos.length);
  expect(twin === 2, 'twin-turbo builds two turbos');
  await shot('vis-twin-turbo');
  await apply({ induction: 'supercharger' });
  await advance(0.5, { gas: 0.4 });
  const sc = await evaluate(() => {
    const ind = window.__app.view.inductionHw;
    return { rotors: ind.spinners.length, belt: !!ind.belt };
  });
  expect(sc.rotors >= 3 && sc.belt, 'supercharger has rotors, a pulley and a belt');
  await shot('vis-supercharger');

  // ── Draw-call budget: V12, everything on ─────────────────────────────────────
  await apply({ preset: 'v8-cross', cylinders: 12, induction: 'twin-turbo', strokeGases: true, valvetrain: true }, 'all');
  await advance(0.5, { gas: 0.6 });
  await evaluate(() => {
    const v = window.__app.view;
    v.burst('flame', { strength: 1 });
    v.burst('bov', { strength: 1 });
    v.blowUp();
  });
  await frames(2);
  const v12 = await calls();
  log(`V12 twin-turbo, all effects: ${v12} draw calls`);
  expect(v12 > 0 && v12 < DRAW_CALL_BUDGET, `V12 with everything on stays under ${DRAW_CALL_BUDGET} draw calls (${v12})`);
  await apply({ induction: 'supercharger', xray: true, cutaway: true }, 'all');
  const v12b = await calls();
  expect(v12b < DRAW_CALL_BUDGET, `V12 supercharged in x-ray + cutaway under budget (${v12b})`);
  await apply({ xray: false, cutaway: false }, 'view');
  await evaluate(() => window.__app.actions.repair());

  // ── Rotary ──────────────────────────────────────────────────────────────────
  await apply({ preset: 'rotary', cylinders: 2, induction: 'turbo' }, 'all');
  await advance(1, { gas: 0.5 });
  const rot = await evaluate(() => ({ layout: window.__app.view.layout, ports: window.__app.view.portMarks?.count }));
  expect(rot.layout === 'rotary' && rot.ports === 4, `rotary shows ports instead of valves (${rot.ports})`);
  await shot('vis-rotary');

  // ── Synthetic boxer (no profile.layout: derived from bankDeg ±90) ───────────
  const boxer = await evaluate(async () => {
    const { buildProfile } = await import('/src/config.js');
    const app = window.__app;
    const base = buildProfile({ ...app.settings, preset: 'i4', cylinders: 4 });
    const order = [1, 3, 2, 4];
    const cylinders = [1, 2, 3, 4].map((num) => {
      const bank = num % 2 ? 0 : 1;
      const bankDeg = bank ? -90 : 90;
      const fireDeg = order.indexOf(num) * 180;
      return { num, bank, bankDeg, throwIndex: num - 1, slot: 0, fireDeg, pinDeg: (((bankDeg - fireDeg) % 360) + 360) % 360 };
    });
    const profile = { ...base, id: 'boxer-test', name: 'Boxer test', banks: 2, vAngle: 180, firingOrder: order, cylinders };
    delete profile.layout;
    app.view.setProfile(profile, app.drive, { ...app.settings, induction: 'turbo' });
    const v = app.view;
    v.rig.active = 'front';
    const p = v.presetPose('front');
    v.rig.flyTo(p.target, p.position, true);
    return { layout: v.layout, banks: v.banks.length, valves: v.valvetrain.objects.length };
  });
  expect(boxer.layout === 'boxer' && boxer.banks === 2, `synthetic boxer is laid out flat (${boxer.layout}, ${boxer.banks} banks)`);
  await shot('vis-boxer');
  await snapTo('hero');
  await shot('vis-boxer-hero');

  // ── Event wiring: bus → view ────────────────────────────────────────────────
  await apply({ preset: 'v8-cross', cylinders: 8, induction: 'na' }, 'all');
  const wiring = await evaluate(() => {
    const app = window.__app;
    const v = app.view;
    app.bus.emit('backfire', { strength: 1, source: 'overrun' });
    const flame = v.exhaust.flameNow;
    app.bus.emit('limiter', {});
    const shake = v.rig.shakeAmp;
    app.bus.emit('blown', { cause: 'over-rev' });
    const blown = v.isBlown;
    app.bus.emit('repair', {});
    return { flame, shake, blown, restored: !v.isBlown };
  });
  expect(wiring.flame > 0.5, 'backfire lights the tailpipe flames');
  expect(wiring.shake > 0, 'limiter shakes the camera');
  expect(wiring.blown && wiring.restored, 'blown → blowUp and repair → restore');

  // ── Blow-up sequence ────────────────────────────────────────────────────────
  await snapTo('hero');
  await evaluate(() => window.__app.view.blowUp());
  await until(() => window.__app.view.blown?.t > 1.2);
  const bl = await evaluate(() => {
    const v = window.__app.view;
    return { rod: v.thrown.visible, smoke: v.effects.smoke.alive, y: v.thrown.position.y };
  });
  expect(bl.rod && bl.smoke > 0, `blow-up throws a rod and pours smoke (${bl.smoke} particles)`);
  await shot('vis-blowup');
  await evaluate(() => window.__app.view.restore());
  const back = await evaluate(() => ({ rod: window.__app.view.thrown.visible, hidden: window.__app.view.hiddenRod }));
  expect(!back.rod && back.hidden === -1, 'restore puts the engine back together');

  // ── Bloom (quality high) ────────────────────────────────────────────────────
  await apply({ quality: 'high' }, 'view');
  const hi = await evaluate(() => window.__app.view.bloomActive);
  await evaluate(() => { window.__app.viewState.scrubDeg = 30; });
  await advance(0.5, { gas: 0.5 });
  await frames(2);
  await evaluate(() => window.__app.view.burst('flame', { strength: 1 }));
  await frames(1);
  await shot('vis-bloom');
  await evaluate(() => { window.__app.viewState.scrubDeg = null; });
  await apply({ quality: 'low' }, 'view');
  const lo = await evaluate(() => window.__app.view.bloomActive);
  expect(hi === true && lo === false, 'bloom on for high, off for low');
  await apply({ quality: 'auto' }, 'view');
}

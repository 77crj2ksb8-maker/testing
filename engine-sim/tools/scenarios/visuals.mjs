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
  const clash = await evaluate(() => {
    const hud = [...document.querySelectorAll('.tach, .hud-right, .tool-rail, .hud-bottom > *')].map((n) => n.getBoundingClientRect());
    const shown = [...document.querySelectorAll('.stroke-chip')].filter((c) => c.style.opacity !== '0');
    const hits = shown.filter((c) => {
      const r = c.getBoundingClientRect();
      return hud.some((h) => h.width && r.right > h.left && r.left < h.right && r.bottom > h.top && r.top < h.bottom);
    });
    return { shown: shown.length, hits: hits.map((c) => c.textContent) };
  });
  expect(clash.shown > 0 && clash.hits.length === 0, `stroke labels stay off the HUD (${clash.shown} shown, overlapping: ${clash.hits.join(', ') || 'none'})`);
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

  // ── Garage builds: real layouts and induction kits ──────────────────────────
  const garage = async (id) => {
    const ok = await evaluate((g) => window.__app.actions.loadGarage?.(g) ?? false, id);
    expect(ok, `garage build ${id} loads`);
    await advance(0.8, {});
    await advance(0.5, { gas: 0.5 });
    await frames(2); // pose the new model
  };

  // Turbo straight-six: one turbo on the exhaust side, wheel spinning from sim.turboRpm.
  await garage('turbo-i6');
  await advance(1.2, { gas: 1 });
  const i6 = await evaluate(() => {
    const v = window.__app.view;
    return { layout: v.layout, turbos: v.inductionHw.turbos.length, turboRpm: window.__app.sim.turboRpm, banks: v.banks.length };
  });
  expect(i6.layout === 'inline' && i6.banks === 1 && i6.turbos === 1, `turbo inline-6: one bank, one turbo (${i6.layout}, ${i6.turbos})`);
  expect(i6.turboRpm > 20000, `turbo shaft spools up under load (${Math.round(i6.turboRpm)} rpm)`);
  await shot('vis-turbo-i6');

  // Supercharged V8: blower rotors and pulley turn with the crank.
  await garage('supercharged-v8');
  await evaluate(() => { window.__rotor = window.__app.view.inductionHw.spinners[0].obj.rotation.z; });
  await frames(2);
  const blower = await evaluate(() => {
    const ind = window.__app.view.inductionHw;
    return { kind: ind.kind, belt: !!ind.belt?.visible, moved: Math.abs(ind.spinners[0].obj.rotation.z - window.__rotor) };
  });
  expect(blower.kind === 'supercharger' && blower.belt && blower.moved > 0, `supercharger rotors turn on a visible belt (Δ${blower.moved.toFixed(3)})`);
  await shot('vis-supercharger');

  // Twin-turbo rotary: ports instead of valves, two turbos that do not collide.
  await garage('tt-rotary');
  const rot = await evaluate(() => {
    const v = window.__app.view;
    const t = v.inductionHw.turbos.map((k) => k.wheel.position);
    return {
      layout: v.layout, ports: v.portMarks?.count, turbos: t.length, valves: !!v.valvetrain,
      gap: t.length === 2 ? Math.abs(t[0].z - t[1].z) / v.geom.B : 0,
    };
  });
  expect(rot.layout === 'rotary' && rot.ports === 4 && !rot.valves, `rotary shows ports instead of valves (${rot.ports})`);
  expect(rot.turbos === 2 && rot.gap >= 1.45, `twin turbos sit apart (${rot.gap.toFixed(2)} bores)`);
  await shot('vis-rotary');

  // Turbo boxer-4: flat, opposed pistons, a head on each side.
  await garage('rally-boxer');
  const flat = await evaluate(() => {
    const v = window.__app.view;
    const m = new v.m4.constructor();
    const xs = [];
    for (let i = 0; i < v.pistons.count; i++) {
      v.pistons.getMatrixAt(i, m);
      xs.push(m.elements[12]);
    }
    const heads = v.banks.map((b) => b.headGroup.localToWorld(new v.tmp.constructor(0, v.geom.H.camY, b.zc)));
    return {
      layout: v.layout, banks: v.banks.length, pistons: xs.length,
      left: xs.filter((x) => x < -0.3).length, right: xs.filter((x) => x > 0.3).length,
      heads: heads.map((h) => Math.sign(Math.round(h.x * 100))), headY: Math.max(...heads.map((h) => Math.abs(h.y))),
      span: Math.abs(heads[0].x - heads[1].x), deck: v.geom.deck,
    };
  });
  expect(flat.layout === 'boxer' && flat.banks === 2, `boxer-4 is laid out flat (${flat.layout})`);
  expect(flat.left === 2 && flat.right === 2, `opposed pistons, two each side (${flat.left}/${flat.right})`);
  expect(flat.heads.includes(1) && flat.heads.includes(-1) && flat.headY < flat.span * 0.2, 'a cylinder head on each side, level with the crank');
  await snapTo('front');
  await shot('vis-boxer');
  await snapTo('hero');
  await shot('vis-boxer-hero');

  // Flat-6.
  await garage('flat6-9k');
  const six = await evaluate(() => ({ layout: window.__app.view.layout, pistons: window.__app.view.pistons.count }));
  expect(six.layout === 'boxer' && six.pistons === 6, `flat-6 renders flat with six pistons (${six.layout}, ${six.pistons})`);
  await shot('vis-flat6');

  // 45° V-twin: both rods on one crank pin.
  await garage('vtwin-cruiser');
  const twinPin = await evaluate(() => {
    const v = window.__app.view;
    const a = new v.m4.constructor();
    const b = new v.m4.constructor();
    v.rods.getMatrixAt(0, a);
    v.rods.getMatrixAt(1, b);
    return {
      layout: v.layout, pistons: v.pistons.count,
      d: Math.hypot(a.elements[12] - b.elements[12], a.elements[13] - b.elements[13]),
      dz: Math.abs(a.elements[14] - b.elements[14]) / v.geom.B,
    };
  });
  expect(twinPin.layout === 'vtwin' && twinPin.pistons === 2, `V-twin renders (${twinPin.layout})`);
  expect(twinPin.d < 1e-6 && twinPin.dz > 0.1 && twinPin.dz < 0.5, `V-twin rods share one pin, side by side (Δ${twinPin.d.toExponential(1)}, ${twinPin.dz.toFixed(2)} bores apart)`);
  await snapTo('front');
  await shot('vis-vtwin');
  await snapTo('hero');


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

// HUD & controls scenario: layout at four phone viewports with the busiest HUD
// (boost, health, every assist pill), shift lights, five-digit revs, the
// analog cluster, sequential paddles (multi-touch with the gas), settings
// sections and switches, the garage sheet, freeze + scrub, the tool rail,
// speed units, and the stall card for a blown engine next to a toast.

const VIEWPORTS = [
  { name: 'se', width: 375, height: 667 },
  { name: 'p14', width: 390, height: 844 },
  { name: 'max', width: 430, height: 932 },
  { name: 'land', width: 844, height: 390 },
];

const CHROME = ['.tach', '.hud-right', '#tool-rail', '.shifter-wrap', '.pedal-wrap'];

export default async function hud({ page, evaluate, advance, shot, expect, tap, log }) {
  const settle = () => page.waitForTimeout(450);

  // Bounding boxes of the visible HUD chrome (plus anything else asked for).
  const rects = (extra = []) => evaluate((sels) => {
    const out = {};
    for (const sel of sels) {
      const n = document.querySelector(sel);
      if (!n || n.hidden || n.offsetParent === null) continue;
      const r = n.getBoundingClientRect();
      if (r.width && r.height) out[sel] = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    }
    return { boxes: out, w: window.innerWidth, h: window.innerHeight };
  }, [...CHROME, ...extra]);
  const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
  // Let CSS transitions (the toast's 8 px slide-in) finish: headless frames are slow enough to catch them mid-way.
  const rest = () => evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a instanceof window.CSSTransition).map((a) => a.finished)).then(() => true));
  async function checkLayout(label, extra = []) {
    await rest();
    const { boxes, w, h } = await rects(extra);
    const keys = Object.keys(boxes);
    const clashes = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) if (hit(boxes[keys[i]], boxes[keys[j]])) clashes.push(`${keys[i]} × ${keys[j]}`);
    }
    expect(clashes.length === 0, `${label}: no overlaps among ${keys.join(', ')}${clashes.length ? ` (${clashes.join('; ')})` : ''}`);
    const out = keys.filter((k) => boxes[k].l < -0.5 || boxes[k].t < -0.5 || boxes[k].r > w + 0.5 || boxes[k].b > h + 0.5);
    expect(out.length === 0, `${label}: nothing clipped by the viewport${out.length ? ` (${out.join(', ')})` : ''}`);
  }

  // ── Busiest HUD: turbo boxer, VVL, launch + TC, a damaged engine ─────────
  await evaluate(() => {
    const a = window.__app;
    a.actions.loadGarage('rally-boxer');
    a.apply({ vvlRpm: 5200, launchControl: true, tractionControl: true }, 'all');
  });
  await advance(1.5, {});
  await evaluate(() => {
    const s = window.__app.sim;
    s.thermal.damage = 0.42;
    s.damage = 0.42;
  });
  await advance(0.2, {});
  const extras = await evaluate(() => (window.__app.hud.update(0), {
    gauges: [...document.querySelectorAll('.gauge')].filter((g) => !g.hidden).map((g) => g.dataset.kind),
    pills: [...document.querySelectorAll('.pill-assist')].filter((p) => !p.hidden).map((p) => p.textContent),
    boost: document.querySelector('.gauge[data-kind="boost"] .gauge-value').textContent,
  }));
  expect(['water', 'oil', 'boost', 'health'].every((k) => extras.gauges.includes(k)), `turbo + damage shows water, oil, boost and health gauges (${extras.gauges})`);
  expect(extras.pills.join() === 'LAUNCH,TC,VVL', `assist pills for launch, TC and VVL (${extras.pills})`);
  expect(/^−0\.\d\d$/.test(extras.boost), `boost gauge reads vacuum at idle (${extras.boost})`);

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settle();
    await checkLayout(`${vp.width}×${vp.height}`);
    await shot(`hud-${vp.name}-${vp.width}x${vp.height}`);
  }
  // A plain NA engine hides the boost gauge again.
  await evaluate(() => window.__app.actions.loadGarage('smallblock'));
  await advance(0.3, {});
  const naGauges = await evaluate(() => window.__app.hud.update(0) ?? [...document.querySelectorAll('.gauge')].filter((g) => !g.hidden).map((g) => g.dataset.kind));
  expect(!naGauges.includes('boost'), `NA build hides the boost gauge (${naGauges})`);
  await evaluate(() => window.__app.apply({ vvlRpm: null, launchControl: false, tractionControl: false }, 'all'));
  await evaluate(() => window.__app.actions.repair());
  await advance(0.2, {});
  const pillsHidden = await evaluate(() => window.__app.hud.update(0) ?? (document.querySelector('.assist-pills').hidden && document.querySelector('.gauge[data-kind="health"]').hidden));
  expect(pillsHidden, 'assist pills and the health gauge hide when nothing needs them');

  await page.setViewportSize({ width: 390, height: 844 });
  await settle();

  // ── Shift lights ─────────────────────────────────────────────────────────
  // The live frame loop keeps running between calls, so state is read in the
  // same evaluate that updates the HUD; the screenshot holds the gas key.
  const leds = (rpm) => evaluate((r) => {
    const a = window.__app;
    const s = a.sim;
    const saved = s.omega;
    s.omega = (r * Math.PI) / 30;
    a.hud.update(0);
    const out = {
      lit: document.querySelectorAll('#shift-lights .led.is-on').length,
      flash: document.getElementById('shift-lights').classList.contains('is-flash'),
      anim: window.getComputedStyle(document.querySelector('#shift-lights .led')).animationName,
    };
    s.omega = saved;
    return out;
  }, rpm);
  const shiftAt = await evaluate(() => window.__app.profile.redlineRpm - Math.max(250, window.__app.profile.redlineRpm * 0.05));
  let l = await leds(800);
  expect(l.lit === 0 && !l.flash, `LEDs dark at idle (${l.lit} lit)`);
  l = await leds(shiftAt - 600);
  expect(l.lit > 3 && l.lit < 10 && !l.flash, `LEDs fill as revs climb (${l.lit} lit at ${shiftAt - 600} rpm)`);
  l = await leds(shiftAt + 10);
  expect(l.flash && l.lit === 10 && l.anim === 'led-flash', `all ten LEDs flash blue at the shift point (${shiftAt} rpm, ${l.anim})`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  l = await leds(shiftAt + 10);
  expect(l.flash && l.anim === 'none', `reduced motion: steady blue, no strobe (${l.anim})`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Screenshots: pose the HUD at an rpm and hold it (headless frames are too
  // rare to catch a live rev, and would land mid-transition).
  const pose = (rpm) => evaluate((r) => {
    const a = window.__app;
    const s = a.sim;
    a.hud.update = a.hud.constructor.prototype.update;
    const saved = s.omega;
    s.omega = (r * Math.PI) / 30;
    a.hud.update(0);
    s.omega = saved;
    a.hud.update = () => {};
  }, rpm);
  const release = () => evaluate(() => delete window.__app.hud.update);
  await pose(shiftAt - 700);
  await shot('hud-shift-lights-climb');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pose(shiftAt + 20);
  await shot('hud-shift-lights-flash');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await release();
  await advance(1, {});

  // ── Five-digit revs with the limiter pill never overflow the tach ────────
  for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settle();
    const fit = await evaluate(() => {
      const a = window.__app;
      const s = a.sim;
      const saved = { omega: s.omega, fuelCut: s.fuelCut };
      Object.assign(s, { omega: (10480 * Math.PI) / 30, fuelCut: true });
      a.hud.spinHold = 1;
      a.hud.update(0);
      const tach = document.querySelector('.tach').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.tach-row')].map((r) => {
        const kids = [...r.children].filter((k) => !k.hidden).map((k) => k.getBoundingClientRect().right);
        return { right: Math.max(...kids), overflow: r.scrollWidth > r.clientWidth + 1 };
      });
      const text = document.getElementById('rpm').textContent;
      Object.assign(s, saved);
      a.hud.spinHold = 0;
      return { text, tachRight: tach.right - 8, rows };
    });
    expect(fit.text === '10480' && fit.rows.every((r) => !r.overflow && r.right <= fit.tachRight + 0.5),
      `${vp.width}px: "${fit.text} RPM" + LIMITER and WHEELSPIN fit inside the tach (${fit.rows.map((r) => Math.round(r.right)).join(', ')} ≤ ${Math.round(fit.tachRight)})`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();

  // ── Analog cluster ───────────────────────────────────────────────────────
  await evaluate(() => window.__app.apply({ cluster: 'analog' }, 'hud'));
  await advance(0.6, { gas: 0.6 });
  await settle();
  const dial = await evaluate(() => {
    const c = document.getElementById('tach-dial');
    return { hidden: c.hidden, w: c.width, cw: c.clientWidth, dpr: window.devicePixelRatio, digitalHidden: document.getElementById('tach-digital').hidden };
  });
  expect(!dial.hidden && dial.digitalHidden, 'analog cluster replaces the digital readout');
  expect(dial.w === Math.round(dial.cw * Math.min(3, dial.dpr)), `dial canvas matches device pixels (${dial.w} = ${dial.cw} × ${dial.dpr})`);
  const redraws = await evaluate(() => {
    const d = window.__app.hud.dial;
    const a = d.update(3000, 7000, '3', 88, 'kmh', 0, '');
    const b = d.update(3001, 7000, '3', 88, 'kmh', 0, '');
    return [a, b];
  });
  expect(redraws[0] === true && redraws[1] === false, 'dial redraws only when what it shows changes');
  await shot('hud-analog');
  await checkLayout('analog cluster');
  await page.setViewportSize({ width: 844, height: 390 });
  await settle();
  await checkLayout('analog cluster landscape');
  await shot('hud-analog-landscape');
  await page.setViewportSize({ width: 390, height: 844 });
  await evaluate(() => window.__app.apply({ cluster: 'digital' }, 'hud'));
  await advance(2, {});

  // ── Sequential paddles ───────────────────────────────────────────────────
  await evaluate(() => window.__app.apply({ mode: 'sequential' }, 'mode'));
  await settle();
  const seqUi = await evaluate(() => ({ lever: document.getElementById('shifter').hidden, paddles: document.getElementById('paddles').hidden }));
  expect(seqUi.lever && !seqUi.paddles, 'sequential mode swaps the H-gate for paddles');
  const paddleSize = await evaluate(() => [...document.querySelectorAll('.paddle')].map((p) => p.getBoundingClientRect().height));
  expect(paddleSize.every((h) => h >= 44), `paddles are at least 44 px tall (${paddleSize.map(Math.round)})`);
  await tap('#paddle-up');
  await advance(0.4, {});
  expect((await evaluate(() => window.__app.sim.gear)) === 1, 'paddle up from neutral selects 1st');
  // Hold the gas with one finger and shift with another.
  await advance(2.2, { gas: 1 });
  const multi = await evaluate(() => {
    const a = window.__app;
    const fire = (el, type, id) => el.dispatchEvent(new window.PointerEvent(type, { pointerId: id, bubbles: true, cancelable: true, isPrimary: id === 11, pointerType: 'touch', clientX: el.getBoundingClientRect().x + 10, clientY: el.getBoundingClientRect().y + 10 }));
    const gas = document.getElementById('pedal-gas');
    const up = document.getElementById('paddle-up');
    fire(gas, 'pointerdown', 11);
    fire(up, 'pointerdown', 12);
    const res = { gasTarget: a.pedals.gas.target, shift: a.gearbox.shift ? { from: a.gearbox.shift.from, to: a.gearbox.shift.to } : null };
    a.hud.update(0);
    const g = document.getElementById('paddle-gear');
    res.readout = g.textContent;
    res.pending = g.classList.contains('is-pending');
    fire(up, 'pointerup', 12);
    fire(gas, 'pointerup', 11);
    return res;
  });
  expect(multi.gasTarget === 1 && multi.shift && multi.shift.to === 2, `paddle shifts while another finger holds the gas (${JSON.stringify(multi.shift)})`);
  expect(multi.readout === '2' && multi.pending, `paddle readout shows the pending gear (${multi.readout}, pending ${multi.pending})`);
  await shot('hud-sequential');
  await advance(0.6, { gas: 1 });
  const after = await evaluate(() => ({ gear: window.__app.sim.gear, text: document.getElementById('paddle-gear').textContent }));
  expect(after.gear === 2, `the shift lands in 2nd (${after.gear})`);
  await checkLayout('sequential');
  await page.setViewportSize({ width: 844, height: 390 });
  await settle();
  await checkLayout('sequential landscape');
  await shot('hud-sequential-landscape');
  await page.setViewportSize({ width: 390, height: 844 });
  await advance(10, { brake: 1 });
  await evaluate(() => {
    const a = window.__app;
    a.apply({ mode: 'manual' }, 'mode');
    a.actions.selectGear('N', 'test');
  });
  await settle();
  expect(!(await evaluate(() => document.getElementById('shifter').hidden)), 'H-pattern brings the lever back');

  // ── Telemetry panel stays clear of the HUD chrome in landscape ────────────
  await page.setViewportSize({ width: 844, height: 390 });
  await settle();
  await tap('#btn-telemetry');
  await settle();
  await checkLayout('telemetry landscape', ['#telemetry']);
  await shot('hud-telemetry-landscape');
  await tap('#btn-telemetry');
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();

  // ── Units ────────────────────────────────────────────────────────────────
  await evaluate(() => window.__app.apply({ units: 'mph' }, 'hud'));
  await advance(0.1, {});
  const units = await evaluate(() => (window.__app.hud.update(0), {
    hud: document.getElementById('speed-unit').textContent,
    tile: document.getElementById('t-top-speed-unit').textContent,
    zero: document.getElementById('t-zero-label').textContent,
    dist: document.getElementById('t-distance-unit').textContent,
  }));
  expect(units.hud === 'mph' && units.tile === 'mph' && units.dist === 'mi' && units.zero === '0–62 mph', `mph everywhere (${JSON.stringify(units)})`);
  await evaluate(() => window.__app.apply({ units: 'kmh' }, 'hud'));

  // ── Settings sheet ───────────────────────────────────────────────────────
  await tap('#btn-settings');
  await settle();
  await shot('hud-settings-top');
  const toggles = await evaluate(() => [...document.querySelectorAll('#settings .switch')].map((b) => b.getAttribute('role')));
  expect(toggles.length >= 8 && toggles.every((r) => r === 'switch'), `${toggles.length} settings toggles are role="switch"`);
  await tap('#opt-tc');
  expect(await evaluate(() => window.__app.settings.tractionControl === true && document.getElementById('opt-tc').getAttribute('aria-checked') === 'true'), 'traction control switch toggles the setting');
  await tap('#opt-tc');
  await tap('#opt-induction .chip[data-value="turbo"]');
  await settle();
  const ind = await evaluate(() => ({ kind: window.__app.sim.inductionKind, boostField: !document.getElementById('opt-boost-field').hidden }));
  expect(ind.kind === 'turbo' && ind.boostField, 'induction chips fit a turbo and show the boost slider');
  for (const [target, name] of [['sec-induction', 'boost'], ['sec-gearbox', 'transmission'], ['sec-display', 'display']]) {
    await tap(`.nav-chip[data-target="${target}"]`);
    await page.waitForTimeout(700);
    await shot(`hud-settings-${name}`);
  }
  await tap('#opt-launch');
  await settle();
  expect(await evaluate(() => !document.getElementById('opt-launch-field').hidden), 'launch control reveals the launch-rpm slider');
  await tap('#opt-launch');
  await tap('#opt-induction .chip[data-value="na"]');
  // A layout picked by hand after a garage build starts from its own defaults
  // (not the rotary's 1.3 L, idle, turbos and garage tag).
  await evaluate(() => window.__app.actions.loadGarage('tt-rotary'));
  await settle();
  expect(/Twin-turbo 2-rotor/.test(await evaluate(() => document.getElementById('opt-garage-note').textContent)), 'settings name the fitted garage build');
  await page.locator('#opt-preset .chip').filter({ hasText: /^V8 Flatplane$/ }).click();
  await page.locator('#opt-cylinders .chip').filter({ hasText: /^V12$/ }).click();
  const v12 = await evaluate(() => {
    const a = window.__app;
    return {
      cyl: a.profile.cylinders?.length, l: a.profile.displacementL, garage: a.settings.garage, induction: a.settings.induction,
      idle: a.settings.idleRpm, bore: a.settings.boreStroke, note: document.getElementById('opt-garage-note').textContent,
    };
  });
  expect(v12.cyl === 12 && v12.l > 4 && v12.garage === null && v12.induction === 'na' && v12.idle === 800 && v12.bore === 1 && !/Loaded/.test(v12.note),
    `V12 picked after the rotary build gets V12 defaults (${JSON.stringify(v12)})`);
  // Hand-editing a garage build's engine untags it.
  await evaluate(() => window.__app.actions.loadGarage('smallblock'));
  await evaluate(() => {
    const r = document.getElementById('opt-idle');
    r.value = '750';
    r.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const edited = await evaluate(() => ({ garage: window.__app.settings.garage, idle: window.__app.settings.idleRpm }));
  expect(edited.garage === null && edited.idle === 750, `editing the idle clears the garage tag (${JSON.stringify(edited)})`);
  // Cylinder chips name boxers and the V-twin properly.
  await evaluate(() => window.__app.apply({ preset: 'boxer', cylinders: 4, displacementL: null, redlineRpm: null }, 'engine'));
  const boxer = await evaluate(() => [...document.querySelectorAll('#opt-cylinders .chip')].map((c) => c.textContent));
  expect(boxer.join() === 'B4,F6', `boxer cylinder chips read B4, F6 (${boxer})`);
  await evaluate(() => window.__app.apply({ preset: 'vtwin', cylinders: 2, displacementL: null, redlineRpm: null }, 'engine'));
  const twin = await evaluate(() => [...document.querySelectorAll('#opt-cylinders .chip')].map((c) => c.textContent));
  expect(twin.join() === 'V2', `V-twin cylinder chip reads V2 (${twin})`);
  await page.setViewportSize({ width: 844, height: 390 });
  await settle();
  await shot('hud-settings-landscape');
  await page.setViewportSize({ width: 390, height: 844 });

  // ── Garage sheet (from the settings shortcut) ────────────────────────────
  await tap('#opt-garage');
  await settle();
  const cards = await evaluate(() => [...document.querySelectorAll('.garage-card')].map((c) => c.textContent));
  expect(cards.length === 12, `garage lists all 12 builds (${cards.length})`);
  const fittedCards = await evaluate(() => document.querySelectorAll('.garage-card[aria-current="true"]').length);
  expect(fittedCards === 0, `no build is marked fitted on a hand-built V-twin (${fittedCards})`);
  expect(cards.every((t) => /\d+hp/.test(t.replace(/\s/g, '')) && /Nm/.test(t) && /redline/.test(t)), 'every card shows hp, Nm and redline');
  await shot('hud-garage');
  await page.locator('.garage-card[data-id="flat6-9k"]').click();
  await settle();
  const loaded = await evaluate(() => ({
    garage: window.__app.settings.garage, layout: window.__app.profile.layout,
    sheet: document.getElementById('garage').hidden, settings: document.getElementById('settings').hidden,
  }));
  expect(loaded.garage === 'flat6-9k' && loaded.layout === 'boxer' && loaded.sheet && loaded.settings, `tapping a card loads it and closes the sheets (${JSON.stringify(loaded)})`);
  await page.setViewportSize({ width: 844, height: 390 });
  await settle();
  await tap('#tool-garage');
  await settle();
  await shot('hud-garage-landscape');
  await evaluate(() => window.__app.actions.closeGarage());
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();

  // ── Tool rail: camera, display cycle, explode, cinematic ─────────────────
  const order = await evaluate(() => [...document.querySelectorAll('#tool-rail .tool-btn')].map((b) => [b.id, Number(b.style.order)]));
  expect(['camera', 'cinematic', 'explode', 'display', 'freeze', 'garage'].every((id) => order.some(([b, o]) => b === `tool-${id}` && o >= 10 && o <= 40)), `rail buttons at orders 10–40 (${order.map((o) => o.join(':'))})`);
  // Camera: one tap per preset walks the whole cycle and wraps; a reset view starts it over.
  const presets = await evaluate(() => [...(window.__app.view.cameraPresets ?? ['hero'])]);
  const toastText = () => evaluate(() => document.getElementById('toast').textContent);
  const seenLabels = [];
  for (let i = 0; i < presets.length; i++) {
    await tap('#tool-camera');
    seenLabels.push(await toastText());
  }
  expect(seenLabels.every((t) => /^Camera: \S/.test(t)) && new Set(seenLabels).size === presets.length,
    `camera button names each of the ${presets.length} presets once per cycle (${seenLabels.join(', ')})`);
  await evaluate(() => window.__app.view.resetView());
  await tap('#tool-camera');
  const afterReset = await toastText();
  expect(afterReset === seenLabels[0], `after a view reset the camera cycle starts again (${afterReset})`);
  await settle();
  await shot('hud-camera-preset');
  await evaluate(() => window.__app.view.resetView());
  // Cinematic: the button follows the view, which drops the orbit on a reset or a user drag.
  await tap('#tool-cinematic');
  const cine = await evaluate(() => ({ view: window.__app.view.cinematic, pressed: document.getElementById('tool-cinematic').getAttribute('aria-pressed') }));
  expect(cine.view === true && cine.pressed === 'true', `cinematic orbit on (${JSON.stringify(cine)})`);
  await evaluate(() => window.__app.view.resetView());
  await page.waitForTimeout(900);
  const cineOff = await evaluate(() => ({ view: window.__app.view.cinematic, pressed: document.getElementById('tool-cinematic').getAttribute('aria-pressed') }));
  expect(cineOff.view === false && cineOff.pressed === 'false', `the cinematic button releases when the view drops the orbit (${JSON.stringify(cineOff)})`);
  await tap('#tool-display');
  expect(await evaluate(() => window.__app.settings.xray && !window.__app.settings.cutaway), 'display cycle: glass → x-ray');
  await tap('#tool-display');
  expect(await evaluate(() => !window.__app.settings.xray && window.__app.settings.cutaway), 'display cycle: x-ray → cutaway');
  await tap('#tool-display');
  expect(await evaluate(() => !window.__app.settings.xray && !window.__app.settings.cutaway), 'display cycle: cutaway → glass');
  await tap('#tool-display');
  await tap('#tool-explode');
  expect(await evaluate(() => document.getElementById('tool-explode').getAttribute('aria-pressed') === 'true' && window.__app.view.explodeTarget === 1), 'explode toggles on');
  // A different engine keeps the exploded view (and the button state with it).
  await evaluate(() => window.__app.actions.loadGarage('v12-65'));
  await page.waitForTimeout(1500);
  expect(await evaluate(() => window.__app.view.explodeTarget === 1), 'the exploded view survives an engine change');
  await shot('hud-exploded-xray');
  await tap('#tool-explode');
  await tap('#tool-display');
  await tap('#tool-display');
  const back = await evaluate(() => ({ explode: window.__app.view.explodeTarget, x: window.__app.settings.xray, c: window.__app.settings.cutaway }));
  expect(back.explode === 0 && !back.x && !back.c, `explode off and glass display again (${JSON.stringify(back)})`);
  await evaluate(() => window.__app.actions.loadGarage('flat6-9k'));

  // ── Freeze + scrub ───────────────────────────────────────────────────────
  for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settle();
    await tap('#tool-freeze');
    await settle();
    const fr = await evaluate(() => ({ frozen: window.__app.viewState.frozen, scrub: window.__app.viewState.scrubDeg, shown: !document.getElementById('scrub').hidden }));
    expect(fr.frozen && fr.shown && typeof fr.scrub === 'number', `${vp.width}px: freeze stops the crank and shows the scrubber`);
    await evaluate(() => {
      const r = document.getElementById('scrub-range');
      r.value = '200';
      r.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    let deg = await evaluate(() => window.__app.viewState.scrubDeg);
    expect(deg === 200, `slider drives viewState.scrubDeg (${deg})`);
    await tap('#scrub-next');
    deg = await evaluate(() => window.__app.viewState.scrubDeg);
    expect(deg > 200 && deg <= 720, `next firing steps forward (${deg})`);
    await settle();
    await checkLayout(`${vp.width}px frozen`, ['#scrub']);
    await shot(`hud-freeze-${vp.name}`);
    await tap('#tool-freeze');
    const un = await evaluate(() => ({ frozen: window.__app.viewState.frozen, scrub: window.__app.viewState.scrubDeg }));
    expect(!un.frozen && un.scrub === null, 'unfreeze releases the crank');
  }

  // ── Blown engine: the stall card says why, and clears the toast ──────────
  for (const vp of [VIEWPORTS[3], VIEWPORTS[0]]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settle();
    await evaluate(() => {
      const a = window.__app;
      a.sim.blowUp('over-rev');
      a.toast('Over-revved to 10,450 rpm. Engine health 0 %.', 'bad', 6000);
    });
    await advance(0.2, {});
    await settle();
    const card = await evaluate(() => (window.__app.hud.update(0), {
      title: document.getElementById('stall-title').textContent,
      help: document.getElementById('stall-help').textContent,
      button: document.getElementById('btn-start').textContent,
    }));
    expect(card.title === 'Engine blown' && /over-revved/.test(card.help) && card.button === 'REBUILD', `blown card explains an over-rev (${card.title}: ${card.help})`);
    await checkLayout(`${vp.width}px blown`, ['#stall', '#toast']);
    await shot(`hud-blown-${vp.name}`);
    await evaluate(() => window.__app.actions.startEngine());
    await advance(0.1, {});
    await evaluate(() => {
      const s = window.__app.sim;
      s.blowUp('overheat');
    });
    await advance(0.1, {});
    const hot = await evaluate(() => window.__app.hud.update(0) ?? document.getElementById('stall-title').textContent + ' / ' + document.getElementById('stall-help').textContent);
    expect(/overheated/.test(hot), `blown card explains an overheat (${hot})`);
    await evaluate(() => window.__app.actions.startEngine());
    await advance(0.2, {});
    await evaluate(() => window.__app.actions.startEngine());
    await advance(2, {});
  }
  expect(await evaluate(() => window.__app.sim.running), 'engine running again after the rebuild');

  // ── A full rail (the modes track adds two more buttons) ──────────────────
  await evaluate(() => {
    const a = window.__app;
    const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>';
    a.ui.addToolButton({ id: 'extra-a', label: 'Extra A', icon, order: 60, onClick() {} });
    a.ui.addToolButton({ id: 'extra-b', label: 'Extra B', icon, order: 65, onClick() {} });
  });
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settle();
    await checkLayout(`${vp.width}×${vp.height} with 8 rail buttons`);
    await evaluate(() => {
      window.__app.sim.blowUp('over-rev');
      window.__app.toast('Over-revved to 10,450 rpm. Engine health 0 %.', 'bad', 6000);
      window.__app.hud.update(0);
    });
    await settle();
    await rest();
    const clear = await evaluate(() => {
      const r = (n) => n.getBoundingClientRect();
      const stall = r(document.getElementById('stall'));
      const toast = r(document.getElementById('toast'));
      const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const buttons = [...document.querySelectorAll('#tool-rail .tool-btn')].map(r);
      return {
        stallW: Math.round(stall.width),
        stallHits: buttons.filter((b) => hits(b, stall)).length,
        toastHits: buttons.filter((b) => hits(b, toast)).length,
        toastStall: hits(toast, stall),
        stallOnControls: ['.shifter-wrap', '.pedal-wrap', '.tach'].some((s) => hits(r(document.querySelector(s)), stall)),
      };
    });
    expect(clear.stallW >= 230 && !clear.stallHits && !clear.toastHits && !clear.toastStall && !clear.stallOnControls,
      `${vp.width}×${vp.height}: stall card (${clear.stallW} px) and toast clear of the rail, each other and the controls (${JSON.stringify(clear)})`);
    await shot(`hud-fullrail-${vp.name}`);
    await evaluate(() => window.__app.actions.startEngine());
  }
  await evaluate(() => {
    document.getElementById('tool-extra-a').remove();
    document.getElementById('tool-extra-b').remove();
    window.__app.actions.startEngine();
  });
  await advance(2, {});
}

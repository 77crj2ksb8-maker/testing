# Firing Order: integration contract

This is the single source of truth that five feature tracks build against in
parallel. If something you need is not here, **code defensively** (feature-detect,
`?.`, `??`) and list it under "Integration requests" in your final report.
Do not edit files you do not own.

## 0. Ground rules (all tracks)

- **Ownership is strict.** Edit only the files your track owns (section 7). New files
  go under the paths your track owns. `src/main.js`, `src/bus.js`, `src/dom.js`,
  `src/features/index.js`, `tools/smoke.mjs`, `tools/scenarios/core.mjs` and this
  file belong to the integrator: do not edit them.
- **Plain ES modules, no build step, no new runtime dependencies.** The only external
  code is three.js 0.186.1 via the import map: `import * as THREE from 'three'` and
  `import { … } from 'three/addons/…'` (examples/jsm). Nothing else from any CDN.
- **Targets:** iOS Safari 16.4+ (iPhone 12 and newer at 60 fps), current Chrome,
  Firefox and desktop Safari. ES2020. Pointer Events for input. No `alert`/`confirm`.
- **Performance:** no per-frame allocations in hot paths (reuse vectors/arrays), no
  per-frame DOM writes unless the value changed, no layout reads in the frame loop.
  The whole scene with every feature on must stay under ~350 draw calls (use
  `InstancedMesh` and merged geometry).
- **Pure modules stay pure:** `config, kinematics, physics, gearbox, session,
  induction, thermal, presets, exhaust, pv, achievements, modes/*` must not touch
  the DOM or three.js and must not use `Math.random()` (use a seeded PRNG) so the
  Node tests are deterministic.
- **No manufacturer names or trademarks** anywhere user-visible (no "VTEC", "LS3",
  "Hellcat", brand names). Describe archetypes ("Small-block 6.2", "variable valve
  lift").
- **Copy:** short, plain, active voice. Errors say what happened and what to do.
- **Theme:** the app is a single deliberate dark theme (see `styles.css` tokens:
  `--bg --panel --panel-solid --raise --line --fg --muted --throttle --clutch
  --red --amber --good --font-display --font-data`). Use the tokens; orange =
  throttle/heat/accent, blue = clutch/cool, red = danger, amber = warning, green = good.
- **Feature CSS/DOM:** tracks that do not own `index.html`/`styles.css` build their DOM
  in JS with `el()` and ship CSS with `injectStyles(id, css)` from `src/dom.js`.
- **Quality bar:** `npm test` passes, `node tools/smoke.mjs` (core scenario) passes,
  your own `tools/scenarios/<track>.mjs` passes, and `npm run lint` is clean. Look at your screenshots: nothing overlaps, nothing is clipped, it looks
  intentional at 390×844 portrait and 844×390 landscape.

## 1. Runtime shape

`src/main.js` builds one `app` object, installs every module in
`src/features/index.js`, then runs the frame loop:

```
frame(dt):
  pedals update → tick(dt) → lever update → visual crank angles
  → view.update(dt, {crankDeg, inputDeg, outputDeg, sim, settings, frozen, showFlashes})
  → hooks.beforeRender → view.render() → audio.update(sim, dt) → hud.update(dt)
  → telemetry.update(...) → hooks.frame

tick(dt):                      (also used by the ?debug advance() API, no rendering)
  app.input = pedal values (or the test override)
  hooks.beforeStep(dt, app)    ← may overwrite app.input (e.g. dyno holds gas)
  gearbox.update(dt, app.input)
  sim.step(dt)
  tracker.update, stats.update
  sim.events → bus.emit(type, payload)   (each event re-emitted on the bus)
  'gear' event if sim.gear changed
  hooks.afterStep(dt, app)
```

### Feature modules

Each track owns one entry file in `src/features/` (`powertrain.js`, `visuals.js`,
`audiofx.js`, `hud.js`, `modes.js`) that default-exports:

```js
export default {
  id: 'modes',
  install(app) {            // runs once at boot, before the first app.apply()
    // subscribe to app.bus, add tool buttons, build DOM, etc.
    return {                // every hook optional; exceptions are caught and logged
      beforeStep(dt, app) {},   // physics rate, before gearbox/sim
      afterStep(dt, app) {},    // physics rate, after sim + events
      beforeRender(dt, app) {}, // once per frame, after view.update
      frame(dt, app) {},        // once per frame, last
    };
  },
};
```

### The `app` object

| Member | Meaning |
| --- | --- |
| `bus` | event bus: `on(type, fn) → off`, `once`, `emit(type, payload)`; `'*'` receives `(type, payload)` |
| `sim` | `Drivetrain` (src/physics.js) |
| `gearbox` | `Gearbox` (src/gearbox.js) |
| `tracker`, `stats` | `ShiftTracker`, `SessionStats` |
| `audio` | `EngineAudio` (src/audio.js) |
| `view` | `EngineView` (src/scene.js) |
| `pedals` | `{gas, clutch, brake}` `Pedal` objects (`.value`, `.keyHeld`, `.setEnabled(bool)`) |
| `shifter` | `HShifter` (`.show(gear)`, `.setAuto(bool)`, `.zone`, `.pointer`) |
| `telemetry`, `settingsPanel`, `hud` | core UI objects |
| `settings` (getter) | current settings object (section 4). Treat as read-only. |
| `profile`, `drive` (getters) | current engine profile and drivetrain config |
| `input` | `{gas, clutch, brake}` used this tick (0..1); writable in `beforeStep` |
| `viewState` | `{frozen, scrubDeg, crankDeg, inputDeg, outputDeg}` — set `frozen=true` to stop the animation, `scrubDeg` (number, crank degrees 0..720) to pose the engine at an angle, `null` to release |
| `apply(patch, kind)` | merge + persist settings. kind: `'engine'` (rebuilds profile, 3D model, sound), `'drive'` (gearing), `'mode'` (transmission mode), `'assist'`, `'view'`, `'hud'`, `'all'`. Emits `'settings'` and, for engine/drive/all, `'profile'`. |
| `toast(msg, kind?, ms?)` | transient message. kind: `'' | 'good' | 'warn' | 'bad'` |
| `layout()` | re-measure HUD and resize the 3D view (call after your DOM changes height) |
| `ui.overlay` | full-screen overlay container (pointer-events off; your children get them on) |
| `ui.hudExtra` | column under the tach card for extra HUD rows |
| `ui.addToolButton({id, label, icon, onClick, order})` | round button in the right tool rail; `icon` is static inline SVG markup (24×24 viewBox, stroke icons). Returns the button. Toggle state: set `aria-pressed`. |
| `ui.addTelemetrySection(node, order)` / `ui.addSettingsSection(node, order)` | append a section to the telemetry panel / settings sheet |
| `actions` | `selectGear(g, source)`, `shiftUp()`, `shiftDown()`, `startEngine()` (rebuilds if blown), `repair()`, `toggleTelemetry(force?)`, `openSettings()`, `closeSettings()`, `setMuted(b)`, `resetView()`, `resetSession()`. Features may add actions (e.g. `app.actions.openDrag`). |
| `debugApi` (only with `?debug`) | `advance(seconds, input)` steps physics at 1/120 s with fixed pedals, no rendering; `tick(dt, input)` |

With `?debug` in the URL, `window.__app` is the app object.

## 2. Simulator contract (`app.sim`, src/physics.js)

Existing: `rpm`, `omega` (rad/s), `speedKmh`, `v` (m/s, signed), `gear` (`'N' | 'R' | 1..5`),
`running`, `cranking`, `locked`, `wheelspin`, `fuelCut`, `throttleInput`, `throttle`,
`throttleEffective` (0..1 incl. idle valve), `clutchPedal`, `brake`, `combustionTorque`,
`engineTorque`, `clutchTorque`, `slipPower`, `inputOmega`, `outputOmega`, `distance` (m),
`time` (s), `profile`, `drive`, `ratioFor(g)`, `inputOmegaFor(g)`, `speedForRpm(rpm, g)`,
`canCrank()`, `startEngine()`, `setGear(g)`, `setDrive(d)`, `setProfile(p)`.

Added (placeholders exist now; the powertrain track makes them real):

| Field / method | Meaning |
| --- | --- |
| `inductionKind` | `'na' | 'turbo' | 'twin-turbo' | 'supercharger'` |
| `boostBar` | manifold pressure, bar gauge (negative = vacuum, ~−0.7 at closed throttle) |
| `boostTarget` | wastegate/target boost, bar |
| `turboRpm` | turbo shaft speed (0 when not turbocharged), up to ~200 000 |
| `coolantC`, `oilC`, `egtC` | temperatures °C (EGT ~350 idle → ~900 hard load) |
| `damage` | 0 healthy … 1 destroyed |
| `blown` | catastrophic failure; engine cannot run or crank until `repair()` |
| `vvlActive` | variable-valve-lift high cam engaged |
| `launchActive` | two-step launch limiter currently holding revs |
| `tcActive` | traction control currently cutting torque |
| `limiterRpm` | rpm the active limiter cuts at (redline, or launch rpm) |
| `assists` | `{autoBlip, launchControl, launchRpm, tractionControl}` |
| `configure(settings)` | called by `app.apply` on every change |
| `repair()` | clears damage and `blown` |

## 3. Event catalogue (`app.bus`)

From the simulator (pushed to `sim.events`, re-emitted by main):

| Type | Payload | When |
| --- | --- | --- |
| `stall` | `{speedKmh, gear}` | engine died under load |
| `start` | `{bump?}` | engine caught (starter or bump start) |
| `crank` | `{}` | starter engaged |
| `limiter` | `{}` | each rev-limiter fuel-cut onset |
| `backfire` | `{strength 0..1, source: 'overrun'|'limiter'|'twostep'|'shift'}` | unburnt fuel popping in the exhaust; drives flames + pops |
| `twostep` | `{}` | each launch-limiter cut while holding launch rpm |
| `bov` | `{boostBar}` | blow-off valve vents (throttle closed under boost) |
| `overrev` | `{rpm, severity 0..1}` | mechanical over-rev past redline (e.g. money shift) |
| `overheat` | `{coolantC}` | coolant crosses the warning temperature |
| `blown` | `{cause: 'over-rev'|'overheat'}` | catastrophic failure |
| `vvl` | `{on}` | high-lift cam engaged / disengaged |
| `tc` | `{}` | traction control intervention starts |
| `shift` | `{from, to, kind: 'up'|'down', source: 'auto'|'sequential'|'manual', flat?}` | the gearbox changed gear (auto/sequential emit it; main also emits `gear`) |

From the integrator: `gear {from, to}`, `grind {gear, reason, mismatchRpm}`,
`settings {settings, kind, patch}`, `profile {profile, drive}`, `repair {}`,
`session-reset {}`, `escape {}`, `key {key, event}` (unbound keys), `layout {width, height, landscape}`.

From modes (track E): `drag:stage`, `drag:green`, `drag:foul`, `drag:finish {result}`,
`dyno:start`, `dyno:done {peakHp, peakNm, peakHpRpm, peakNmRpm}`, `achievement {id, title}`.

## 4. Settings (`app.settings`, defaults in `DEFAULT_SETTINGS`, src/config.js)

| Key | Values | Applied with kind |
| --- | --- | --- |
| `preset` | `PRESET_ORDER` ids (`'v8-cross' 'v8-flat' 'i4' 'v6' 'rotary'` + powertrain additions) | engine |
| `cylinders` | count within the preset family | engine |
| `idleRpm`, `redlineRpm` (null = layout default), `boreStroke`, `displacementL` (null = default) | numbers | engine |
| `vvlRpm` | null or rpm | engine |
| `garage` | id from `GARAGE` or null | engine |
| `induction` | `'na' 'turbo' 'twin-turbo' 'supercharger'` | engine |
| `boostBar` | 0.3 … 2.0 | engine |
| `mode` | `'manual'` (H-pattern) `'sequential'` `'auto'` | mode |
| `autoBlip`, `launchControl`, `tractionControl` | booleans | assist |
| `launchRpm` | 2500 … 8000 | assist |
| `gearRatios[5]`, `reverseRatio`, `finalDrive`, `tireDiameter` (m) | numbers | drive |
| `visualSpeed` | 1, 1/5, 1/10, 1/25, 1/100 | view |
| `strokeGases`, `valvetrain`, `xray`, `cutaway` | booleans | view |
| `quality` | `'auto' 'high' 'low'` | view |
| `cluster` | `'digital' 'analog'` | hud |
| `units` | `'kmh' 'mph'` | hud |

Every `app.apply` calls `sim.configure(settings)`, `gearbox.configure(settings)` and
`view.setDisplay(settings)`.

## 5. Profile (`app.profile`, from `buildProfile(settings)`)

Existing fields: `id kind ('piston'|'rotary') name shortName layoutNote firingOrder
vAngle banks cylinders[] {num bank bankDeg throwIndex slot fireDeg pinDeg}
displacementL peakTorqueNm curve defaultRedline pulsesPerRev exhaust {banks
pulseWidth roughness drive} inertia idleRpm redlineRpm boreStroke boreMm strokeMm
rodRatio curveShift upshiftRpm downshiftRpm stallRpm`; rotary adds `rotors
rotorPhases[]`.

Powertrain adds: `layout` (`'inline' | 'v' | 'boxer' | 'vtwin' | 'rotary'`; when
absent derive it: rotary → rotary, banks 2 → v, else inline), `induction {kind,
targetBar}`, `vvlRpm` (or null), `compressionRatio`.

`wotTorque(profile, rpm)` (config.js) returns steady-state full-throttle torque
**including steady-state boost**; charts use it. `naTorque(profile, rpm)` returns the
unboosted value.

## 6. EngineView API (`app.view`, src/scene.js)

`update(dt, {crankDeg, inputDeg, outputDeg, sim, settings, frozen, showFlashes})`,
`render()`, `resize()`, `frameModel()`, `resetView()`, `adaptQuality(ms)`,
`setProfile(profile, drive, settings)`, `controls` (OrbitControls), `camera`,
`renderer`, `scene`, plus (stubs now, real after the visuals track):

| Method | Meaning |
| --- | --- |
| `setDisplay(settings)` | apply `strokeGases valvetrain xray cutaway quality` |
| `setExplode(t)` | animate to exploded view, 0 assembled … 1 exploded |
| `cameraPresets` | array of preset ids in cycle order (e.g. `hero front side top valvetrain gearbox under`) |
| `setCameraPreset(id)` | fly there (~0.8 s ease); returns a label like "Valvetrain" |
| `setCinematic(on)` | slow auto-orbit; user camera input turns it off |
| `shake(amount)` | camera shake impulse 0..1 |
| `burst(kind, {strength})` | one-shot effect: `'flame' 'bov' 'smoke' 'sparks'` |
| `blowUp()` / `restore()` | catastrophic-failure visuals and undo |

## 7. Tracks

Ports for `node tools/smoke.mjs --port N`: A 5310, B 5320, C 5330, D 5340, E 5350.

### Track A — Powertrain
Owns: `src/config.js src/kinematics.js src/physics.js src/gearbox.js src/session.js
src/presets.js src/induction.js src/thermal.js src/features/powertrain.js`,
`test/kinematics.test.mjs test/physics.test.mjs test/powertrain*.test.mjs`,
`tools/scenarios/powertrain.mjs`.

1. **New layouts:** boxer-4 (firing 1-3-2-4) and flat-6 (1-6-2-4-3-5) under a `boxer`
   preset family (counts 4, 6), and a 45° V-twin (`vtwin`, shared crank pin, uneven
   firing 0°/315°). Explicit per-layout fire angles where firing is uneven. Opposed
   boxer pairs must sit on throws 180° apart; V-twin rods share one pin. Set
   `profile.layout`. Append new presets to `PRESET_ORDER` after the original five.
2. **`displacementL` override** (scales torque, geometry, friction, inertia).
3. **Forced induction** (`src/induction.js`): turbo (spool lag ~0.8 s, boost
   threshold ~35 % of redline), twin-turbo (faster spool, lower threshold),
   supercharger (immediate, rpm-proportional, parasitic drive loss). Wastegate holds
   `boostBar` target. Vacuum at closed throttle. Blow-off event when the throttle
   snaps shut above ~0.3 bar. `turboRpm`. Torque × (1 + ~0.85·boost). `wotTorque`
   includes steady-state boost; physics uses `naTorque` × the live boost multiplier.
4. **Thermal + damage** (`src/thermal.js`): coolant/oil/EGT, overheat, damage from
   mechanical over-rev (money shift: wheels drag the engine past redline; the
   limiter cannot stop that), severe over-rev or damage 1 → `blown`. Damage costs
   power and roughens idle. Blown engines will not crank until `repair()`.
5. **Launch control** (two-step at `launchRpm` while stationary with clutch in /
   brake held), **traction control** (cut torque on wheelspin), overrun and limiter
   **backfire** events (seeded PRNG).
6. **Sequential gearbox:** `shiftUp()`/`shiftDown()` with automated clutch for
   pull-away, flat-shift upshifts (brief ignition cut, emits `shift` + `backfire`
   source `'shift'`), auto-blip downshifts, refuse downshifts that would over-rev,
   N between 1 and R, R only at standstill. **Auto-blip assist** for the H-pattern.
   Automatic mode keeps working (tests).
7. **Variable valve lift:** `vvlRpm` switches to a high-lift torque curve with
   hysteresis; `vvlActive`; `vvl` event.
8. **Garage** (`src/presets.js`): 10–12 archetype builds (small-block V8,
   flat-plane 4.5, twin-turbo flat-plane V8, turbo boxer-4 rally, flat-6 9k,
   screaming V10, V12, turbo inline-6, twin-turbo 2-rotor, 9k VVL inline-4,
   supercharged V8, V-twin cruiser…). Plausible numbers.
9. Tests for all of it (layout geometry and firing, boost dynamics, BOV, over-rev
   damage and blow-up, launch control, TC, sequential shifts, VVL, garage presets
   build without errors). Existing tests keep passing (update them only if a
   behaviour change is intended and explained).

### Track B — Visuals
Owns: `src/scene.js`, everything under `src/scene/`, `src/features/visuals.js`,
`tools/scenarios/visuals.mjs`, `test/visuals*.test.mjs` (pure helpers only).

1. **Valvetrain:** DOHC per bank: cams at half crank speed with one lobe per valve,
   2 intake + 2 exhaust poppet valves per cylinder (instanced), springs, cam
   sprockets and a timing chain/belt loop at the front. Valve lift follows the
   4-stroke timing (degrees after firing TDC: EVO≈130, EVC≈375, IVO≈345, IVC≈590)
   and cam lobes point at their valve when it is fully open. `settings.valvetrain`.
2. **Stroke gases** (`settings.strokeGases`): per-cylinder volume between crown and
   head tinted by stroke: intake blue mist, compression denser violet, power flame,
   exhaust grey smoke.
3. **Exhaust headers** per cylinder to collectors and pipes running back past the
   gearbox; glow from `sim.egtC`. **Tailpipe flames** on `backfire`/`twostep`.
4. **Induction hardware** by `settings.induction`: turbo(s) with spinning compressor
   wheel (from `sim.turboRpm`), glowing turbine housing, intercooler piping to an
   intake plenum; supercharger with visible spinning rotors and belt drive; NA gets an
   intake plenum with runners.
5. **Display modes:** x-ray, cutaway (clipping plane through the static housings),
   exploded view (`setExplode`, animated; kinematics keep running), camera presets
   with animated fly-to, cinematic orbit, camera shake.
6. **Blow-up:** smoke, sparks, a connecting rod thrown out of the block; `restore()`.
7. **Quality:** bloom (UnrealBloomPass, subtle, emissive-only) on `high`; `auto`
   picks by device and frame time, dropping bloom before resolution; `low` none.
8. **All layouts render correctly**, including boxer (flat, wide crankcase), V-twin
   and rotary (ports instead of valves). Derive layout when `profile.layout` is absent.
9. **Frozen/scrub:** when `update(..., frozen: true)`, show per-cylinder stroke labels.
10. `src/features/visuals.js` wires bus events to `burst/shake/blowUp/restore`.

### Track C — Audio
Owns: `src/audio.js`, everything under `src/audio/`, `src/exhaust.js`,
`test/exhaust.test.mjs test/audio*.test.mjs`, `src/features/audiofx.js`,
`tools/scenarios/audio.mjs`.

1. Richer engine voice: load-dependent wave tables per bank (crossfade light/heavy
   load), exhaust pipe resonance, intake roar, valvetrain tick, a short generated
   impulse-response reverb, stereo width.
2. Forced induction: turbo spool + whistle from `sim.turboRpm`/`boostBar`, blow-off
   "pssh" on `bov`, supercharger whine.
3. Pops/bangs on `backfire` (by strength/source), harder bangs on `twostep`,
   flat-shift crack on `shift` with `flat`.
4. `vvl` changes the tone (brighter intake). Rod knock when `damage > 0.5`; an
   explosion + clatter + hiss on `blown`, then silence until `repair`.
5. Remove the old built-in pop heuristic in favour of `backfire` events.
6. iOS rules: create nothing before `unlock()`; respect mute; cap concurrent one-shot
   nodes (≤ 12 alive); no AudioWorklet unless it falls back cleanly.
7. Unit tests for the pure parts (wave tables, impulse response, scheduling caps).

### Track D — HUD & controls
Owns: `index.html styles.css src/ui.js src/controls.js src/hud.js
src/features/hud.js`, `tools/scenarios/hud.mjs`. Keep every element id that
`src/main.js` and `src/hud.js` read.

1. **Shift lights:** 10-LED strip (green→amber→red, all flash blue at the shift point
   and on the limiter), honouring `prefers-reduced-motion`.
2. **Gauges** in `ui.hudExtra`: boost (only with forced induction), coolant and oil
   temperature, engine health when damaged, pills for LAUNCH / TC / VVL.
3. **Analog cluster** option (`settings.cluster`): canvas tachometer with needle,
   redline arc, gear and speed; crisp at DPR 3; redraw only on change.
4. **Sequential paddles** replace the H-gate in sequential mode (big ▲/▼ touch
   targets; keyboard E/Q already wired to `app.actions.shiftUp/shiftDown`).
5. **Tool rail** buttons (orders 10–40): camera preset cycle, cinematic, explode,
   display mode cycle (glass → x-ray → cutaway), freeze with a crank-angle scrub
   slider (sets `app.viewState`), garage.
6. **Settings sheet** reorganised: garage shortcut; engine (+ displacement, VVL);
   forced induction (chips + boost slider); transmission (3 modes + assists, launch
   rpm); gearing; display (strokes, valvetrain, x-ray, cutaway, cluster, units,
   quality, animation speed). Switch-style toggles with `role="switch"`.
7. **Garage sheet:** cards from `GARAGE` with computed specs (displacement, layout,
   peak hp/Nm via `buildProfile` + `wotTorque`/`powerHp`, redline); tap loads it.
8. Units (`km/h`/`mph`) everywhere the HUD/telemetry shows speed.
9. No overlaps at 375×667, 390×844, 430×932 and 844×390; the rail never covers
   the pedals, lever, HUD or panels.

### Track E — Modes & analytics
Owns: `src/modes/`, `src/pv.js`, `src/achievements.js`, `src/features/modes.js`,
`test/modes*.test.mjs test/pv*.test.mjs test/achievements*.test.mjs`,
`tools/scenarios/modes.mjs`.

1. **Drag strip** (tool button order 60): staging, Christmas tree (sportsman 0.5 s
   ambers), red-light fouls, reaction time, 60 ft / 330 ft / 1/8 mile / 1000 ft /
   1/4 mile ETs and speeds, live ET and distance, a time-slip card, personal bests per
   engine in localStorage. Pure state machine in `src/modes/drag.js`.
2. **Dyno** (order 65): puts the car on rollers (temporarily swap `sim.setDrive` to a
   roller drive: no aero/rolling loss, roller inertia, no traction limit), runs a
   4th-gear wide-open pull from ~2000 rpm to redline, measures torque and power from
   roller acceleration, plots measured vs `wotTorque` spec, keeps the last 3 runs;
   restores the car exactly afterwards (drive, gear N, speed 0). Pure maths in
   `src/modes/dyno.js`.
3. **Cylinder pressure** (`src/pv.js`): crank-angle-resolved pressure for one cylinder
   (slider-crank volume, compression ratio, intake pressure from throttle/boost,
   polytropic compression/expansion, Wiebe heat release), IMEP. Telemetry section
   with a pressure-vs-crank-angle chart and a P–V loop, each with a live marker
   following `app.viewState.crankDeg`. Piston engines only.
4. **Achievements** (`src/achievements.js`): ~16 (first stall, bump start, perfect
   shift ≥95, five smooth shifts in a row, clutchless shift, 100/200/300 km/h,
   sub-12 s and sub-10 s quarter, red light, launch-control start, VVL, blown
   engine, rebuild, dyno pull, drove every core layout). Toasts, persisted, a
   telemetry section listing them.
5. Charts follow the existing telemetry style: one y-axis per chart, theme tokens,
   torque series `--series-torque`, power `--series-power`, text in text tokens,
   values in tooltips/readouts.

## 8. Finishing a track

1. `cd engine-sim && npm test && npm run lint` and `node tools/smoke.mjs --port <yours>` and
   `node tools/smoke.mjs --port <yours> --scenario tools/scenarios/<track>.mjs`
   all pass; review your screenshots.
2. `git switch -c track/<name>` (if not already on it), `git add -A engine-sim`,
   commit with a clear message. Never commit `node_modules` or `dist/`.
3. Report: branch, commit, what you built, what you verified, known gaps, and
   integration requests for other tracks.

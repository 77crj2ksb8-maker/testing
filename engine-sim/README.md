# Firing Order — engine & gearbox simulator

A 3D engine, gearbox and drag-strip simulator for the browser, built for Safari
on iPhone and installable as a home-screen web app. A see-through engine turns
over in slow motion: pistons, rods, cams and valves move to the real firing
order, each cylinder glows through its four strokes, and the headers heat up as
you lean on it. You drive it with a touch H-gate (or sequential paddles), a
clutch, a brake and a gas pedal while a procedural engine note follows the revs.

Three.js renders the scene, the Web Audio API makes the sound, and everything
else is plain ES modules: no framework and no build step.

## Run it

Any static file server works; ES modules will not load from `file://`.

```sh
cd engine-sim
npx serve .          # or: python3 -m http.server
```

Open the printed URL. To try it on a phone, serve on your LAN and open
`http://<your-computer>:3000` in Safari, then **Share → Add to Home Screen** to
run it full screen.

| Command | What it does |
| --- | --- |
| `npm install` | dev dependencies only (esbuild for the single-file build, three for offline tests) |
| `npm test` | 150+ unit tests: kinematics, physics, gearbox, boost, damage, sound, drag timing, dyno, cylinder pressure, HUD helpers |
| `npm run lint` | undefined names, unused code, unreachable code |
| `npm run smoke` | boots the app in headless Chromium at iPhone size and drives it; `--scenario tools/scenarios/<name>.mjs` for the feature scenarios |
| `npm run build` | `dist/engine-sim.html`: one self-contained file (three.js still loads from the CDN) |

## Driving it

| Control | Touch | Keyboard |
| --- | --- | --- |
| Gas | hold **GAS**; slide up to ease off | Space / ↑ / W |
| Clutch | hold **CLUTCH**; slide up to feed it in | Shift / C |
| Brake | hold **BRAKE** | B / ↓ / S |
| Gears (H-pattern) | drag the knob through the gate | 1–5, R, N |
| Gears (sequential) | **▲ / ▼** paddles | E / Q |
| Start, or rebuild a blown engine | **START / REBUILD** on the card | Enter / I |
| Camera | drag to orbit, pinch to zoom, two fingers to pan, double-tap to reset | V resets |
| Freeze the crank and scrub it | freeze tool, then the slider | F, then `[` / `]` jump between firings |
| Panels | telemetry, settings and the tool rail | T, G, M (mute), Esc closes the top layer |

The tool rail holds the camera presets, cinematic orbit, exploded view, display
mode (glass → x-ray → cutaway), freeze, the garage, the drag strip and the dyno.

## What is in it

**Engines.** Crossplane and flat-plane V8s, V6, V10 and V12, inline 3/4/5/6,
boxer-4 and flat-6, a 45° V-twin with its uneven firing, and 1–3 rotor Wankels.
Idle, redline, displacement, bore/stroke, variable valve lift and forced
induction are all adjustable. The **garage** has twelve ready builds, from a
small-block V8 to a twin-turbo rotary and a 9,000 rpm flat-six.

**Kinematics.** Each piston follows the slider-crank equation
`pY = r·cos θ + sqrt(L² − (r·sin θ)²)` with θ measured from that cylinder's TDC.
Crank throws, bank angles and firing order all come from one table, and the
tests check that paired cylinders share pins, crossplane throws sit at
0/90/180/270°, boxer pairs are opposed and the V-twin rods share one pin. Cams
turn at half crank speed and every valve opens on its own stroke.

**Drivetrain.** Engine and car are two inertias joined by a friction clutch that
slips until the speeds meet and then locks. Torque comes from a per-layout curve
scaled by throttle and live boost, minus friction and pumping losses, with an
idle controller, a rev limiter and stalls.
- **H-pattern:** grinds without the clutch unless the revs match; auto-blip assist.
- **Sequential:** automated clutch, flat-shift upshifts with an ignition cut,
  blipped downshifts, and refusal of downshifts that would over-rev.
- **Automatic:** shifts up near redline, down below 2,000 rpm, kicks down.
- **Launch control** (two-step) and **traction control**.

**Boost, heat and damage.** Turbo (with lag and a blow-off valve), twin-turbo and
supercharger models; coolant, oil and exhaust temperatures; over-revving (a
money shift) damages the engine and can blow it up, after which it needs a
rebuild.

**Visuals.** Glass block with chrome internals, DOHC valvetrain and timing chain,
stroke-coloured gas in each cylinder (intake, compression, power, exhaust),
headers that glow with exhaust temperature, tailpipe flames on overrun and
launch control, turbo, supercharger and intake hardware, x-ray and cutaway
modes, an animated exploded view, camera presets and a cinematic orbit, and a
blow-up with smoke, sparks and a thrown rod. Bloom and resolution adapt to the
device's frame rate.

**Sound.** Each exhaust bank plays a wave built from its real pulse train, so a
crossplane burbles and a flat-plane screams, crossfaded between light and heavy
load, with pipe resonance, intake roar, valvetrain tick and a short reverb.
Turbo whistle, blow-off valve, supercharger whine, pops and bangs on overrun
and two-step, flat-shift cracks, rod knock on a damaged engine and an explosion
when it lets go. Audio starts on the first touch (an iOS requirement) and plays
through the silent switch on Safari 17+.

**Drag strip.** Staging, a sportsman tree, red lights, reaction time, 60 ft /
330 ft / ⅛ mile / 1000 ft / ¼ mile splits with speeds, a time slip and personal
bests per engine.

**Dyno.** Puts the car on rollers for a 4th-gear pull and plots measured torque
and power against the rated curve, keeping the last three runs.

**Telemetry.** Peak rpm, top speed, 0–100 km/h, distance, live torque and power
curves, a score for every shift (rev match, clutch heat, time between gears),
a live cylinder-pressure trace and P–V loop with IMEP, and 17 achievements.

## Code layout

```
index.html, styles.css   HUD markup and styles, PWA meta tags, import map for three.js
src/main.js              app context, feature registry, frame loop, debug API
src/config.js            layouts, firing orders, torque curves, settings
src/kinematics.js        slider-crank, crank pins, Wankel geometry
src/physics.js           engine, clutch, car; launch control, traction control, limiter
src/induction.js         turbo / twin-turbo / supercharger
src/thermal.js           temperatures and damage
src/gearbox.js           H-pattern, sequential and automatic; shift scoring
src/presets.js           the garage
src/scene.js, scene/     Three.js: engine, valvetrain, gases, exhaust, induction, effects, camera, bloom
src/audio.js, audio/     Web Audio engine, wave tables, impulse response, voice pool
src/hud.js, ui.js        tach, gauges, shift lights, settings, garage, telemetry
src/controls.js          pedals, H-gate, paddles, keyboard
src/modes/, pv.js        drag strip, dyno, cylinder pressure
src/achievements.js      achievements
src/features/            one module per feature area, plugged in through src/features/index.js
docs/CONTRACT.md         how the pieces talk: app context, events, settings, view API
tools/smoke.mjs          headless browser harness; tools/scenarios/ has one scenario per area
test/                    node:test suites
```

The pure modules (config, kinematics, physics, induction, thermal, gearbox,
presets, modes, pv, achievements, exhaust) never touch the DOM or three.js, so
they run under Node.

## Notes

- The visuals run slowed down (1/25 by default) so single strokes stay readable;
  physics, the HUD and the sound always run in real time.
- Settings, personal bests, dyno runs and achievements are kept in
  `localStorage` for each browser.
- three.js 0.186.1 loads from jsDelivr through an import map, so the first load
  needs a connection. Import maps need Safari 16.4 or newer.

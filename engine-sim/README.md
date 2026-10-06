# Firing Order — engine & gearbox simulator

A 3D engine and manual-transmission simulator for the browser, built for
Safari on iPhone and installable as a home-screen web app. A see-through
engine turns over in slow motion, each cylinder lights up as it fires, and you
drive it with a touch H-gate, a clutch, a brake and a gas pedal while a
procedural engine note follows the revs.

Three.js renders the scene, the Web Audio API makes the sound, and everything
else is plain ES modules with no framework and no build step.

## Run it

Any static file server works; ES modules will not load from `file://`.

```sh
cd engine-sim
npx serve .          # or: python3 -m http.server
```

Open the printed URL. To try it on a phone, serve on your LAN and open
`http://<your-computer>:3000` in Safari, then **Share → Add to Home Screen**
to install it full screen, without browser chrome.

Single-file build (CSS and JS inlined; three.js still comes from the CDN):

```sh
npm install
npm run build        # → dist/engine-sim.html
```

Tests (kinematics, firing orders, exhaust spectra, clutch, stalls, shifting):

```sh
npm test
```

## Driving it

| Control | Touch | Keyboard |
| --- | --- | --- |
| Gas | hold **GAS**; slide up to ease off | Space / ↑ / W |
| Clutch | hold **CLUTCH**; slide up to feed it in | Shift / C |
| Brake | hold **BRAKE** | B / ↓ / S |
| Gears | drag the knob through the H-gate | 1–5, R, N |
| Start after a stall | **START** (clutch down or in neutral) | Enter / I |
| Camera | drag to orbit, pinch to zoom, two fingers to pan, double-tap to reset | V resets |
| Panels | telemetry and settings buttons, top right | T, G, M (mute), Esc |

- The engine revs freely with the clutch past 80 % travel or in neutral.
- Shifting without the clutch grinds unless the revs already match the new
  gear within 300 rpm. Reverse only goes in at walking pace or slower.
- Dump the clutch at idle in first and the engine stalls. Feed it in with a
  little gas, or slide up the clutch slowly, and it pulls away.
- Roll a stalled car in gear with the clutch up and it bump-starts.
- **Automatic** mode (settings) shifts up near redline (6,200 rpm on the
  7,000 rpm V8; earlier under part throttle), shifts down below 2,000 rpm,
  kicks down at full throttle and runs the clutch itself.

## What is modelled

**Slider-crank kinematics.** Each piston's distance from the crank axis is

```
pY = r·cos(θ) + sqrt(L² − (r·sin(θ))²)
```

where θ is the crank angle measured from that cylinder's top dead centre. For a
cylinder that fires at `fireDeg` the crank pin sits at `bankDeg − fireDeg`, so
the crank throws, the V angle and the firing order all come from one table
(`src/config.js`). The tests check that each pair of V8, V10 and V12 cylinders
lands on a shared pin, that the crossplane throws sit at 0/90/180/270° and the
flatplane at 0/180°, and that the firing sequence matches the configured order.

| Layout | Firing order | Crank |
| --- | --- | --- |
| V8 Crossplane | 1-8-4-3-6-5-7-2 | 90° V, crossplane |
| V8 Flatplane | 1-8-3-6-4-5-2-7 | 90° V, flat-plane |
| Inline-4 | 1-3-4-2 | flat |
| V6 | 1-2-3-4-5-6 | 60° V, split pins |
| Rotary | 1, 2 or 3 rotors | eccentric shaft, rotor at ⅓ speed |

The cylinder control switches within a family: I3/I4/I5/I6, V6/V8/V10/V12, or
1–3 rotors. In the Wankel the rotor apexes trace the epitrochoid bore exactly.

**Drivetrain.** The engine and the car are two inertias joined by a friction
clutch. The clutch slips at its capacity until the speeds meet, then locks
until the torque through it exceeds that capacity again. Engine torque comes
from a per-layout wide-open-throttle curve scaled by throttle, minus friction
and pumping losses. On top of that:

- an idle-speed PI controller holds the idle;
- a rev limiter cuts fuel at redline;
- the engine stalls below 45 % of idle.

Road speed is the wheel speed: rpm ÷ (gear × final drive) × tyre
circumference. The tyres limit the drive force, so a hard launch in first
spins them.

**Sound.** Each exhaust bank gets a `PeriodicWave` built from its own pulse
train over a 720° cycle, so the crossplane's uneven bank firing produces its
burble and the flatplane sounds smoother. The same Fourier analysis is unit
tested. Layered on top of that:

- sawtooth and triangle oscillators at the firing frequency;
- a waveshaper and a low-pass filter that open with load and rpm;
- intake noise, gear whine, a starter motor, grinding, and overrun pops when
  you lift off at high rpm.

Audio starts on the first `touchstart` because iOS requires a user gesture.
On Safari 17+ it sets `navigator.audioSession.type = 'playback'`, so sound
plays even with the silent switch on.

**Telemetry.** Live torque and power curves with the current operating point
marked; the curves follow the bore/stroke setting. The panel also shows peak
rpm, top speed, best 0–100 km/h time and distance. Every shift gets a 0–100
score from:

- the rev mismatch at the bite point;
- the energy dumped into the clutch;
- the time between gears.

The shift log also records grinds and stalls.

## Layout of the code

```
index.html            HUD markup, PWA meta tags, import map for three.js
styles.css            HUD, pedals, H-gate, panels
src/config.js         engine layouts, firing orders, torque curves, drivetrain defaults
src/kinematics.js     slider-crank, crank-pin angles, Wankel geometry
src/physics.js        engine, clutch, vehicle (slip/lock model, stall, limiter)
src/gearbox.js        manual selection and grind rules, automatic controller, shift scoring
src/session.js        peaks, 0–100, distance
src/exhaust.js        exhaust pulse trains → Fourier coefficients
src/audio.js          Web Audio graph and iOS unlock
src/scene.js          Three.js scene: engine, rotary, flywheel, clutch, gearbox, flashes
src/controls.js       pedals, H-shifter, keyboard
src/ui.js             settings sheet, telemetry charts and shift log
src/main.js           wiring and the frame loop
tools/build.mjs       single-file build with esbuild
test/                 node:test suites
```

`config.js`, `kinematics.js`, `physics.js`, `gearbox.js`, `session.js` and
`exhaust.js` touch neither the DOM nor three.js, so they run under Node.

## Notes

- The visuals run slowed down (1/25 by default, as in the reference clip) so
  single strokes stay readable. Physics, the HUD and the sound always run in
  real time. Change the slowdown under **Settings → Animation speed**.
- Settings are saved in `localStorage` for each browser.
- The renderer lowers its pixel ratio when frames run slow and raises it again
  when there is headroom.
- three.js 0.186.1 loads from jsDelivr through an import map, so the first
  load needs a network connection. Import maps need Safari 16.4 or newer.

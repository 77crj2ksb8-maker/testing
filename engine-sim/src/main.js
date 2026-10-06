// Bootstraps the simulator: builds the shared `app` context (docs/CONTRACT.md),
// installs the feature modules and runs the frame loop.

import { buildProfile, DEFAULT_SETTINGS, DRIVETRAIN_DEFAULTS, firingOrderLabel } from './config.js';
import { Drivetrain } from './physics.js';
import { Gearbox, ShiftTracker } from './gearbox.js';
import { SessionStats } from './session.js';
import { EngineAudio } from './audio.js';
import { EngineView } from './scene.js';
import { Pedal, HShifter, bindKeyboard } from './controls.js';
import { SettingsPanel, TelemetryPanel, VISUAL_SPEEDS } from './ui.js';
import { Hud } from './hud.js';
import { Bus } from './bus.js';
import { el } from './dom.js';
import { FEATURES } from './features/index.js';

const $ = (id) => document.getElementById(id);
const RAD2DEG = 180 / Math.PI;
const STORAGE_KEY = 'firing-order:settings:v1';
const DRIVE_KEYS = Object.keys(DRIVETRAIN_DEFAULTS);
const TICK = 1 / 120; // debug advance() step, seconds

// ── Settings (remembered per browser) ───────────────────────────────────────
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const merged = { ...DEFAULT_SETTINGS };
      // Only keep keys we know, with the type we expect.
      for (const [k, v] of Object.entries(saved)) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        const def = DEFAULT_SETTINGS[k];
        if (def === null || v === null || typeof v === typeof def) merged[k] = v;
      }
      if (!Array.isArray(merged.gearRatios) || merged.gearRatios.length !== 5 || !merged.gearRatios.every((r) => r > 0)) {
        merged.gearRatios = [...DEFAULT_SETTINGS.gearRatios];
      }
      return merged;
    }
  } catch {
    /* storage unavailable or corrupt: fall back to defaults */
  }
  return { ...DEFAULT_SETTINGS, gearRatios: [...DEFAULT_SETTINGS.gearRatios] };
}

function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode etc. */
  }
}

const driveFrom = (s) => Object.fromEntries(DRIVE_KEYS.map((k) => [k, Array.isArray(s[k]) ? [...s[k]] : s[k]]));
const debugMode = new URLSearchParams(location.search).has('debug');

// ── Core objects ────────────────────────────────────────────────────────────
let settings = loadSettings();
let profile = buildProfile(settings);
let drive = driveFrom(settings);

const bus = new Bus();
const sim = new Drivetrain(profile, drive);
const tracker = new ShiftTracker();
const gearbox = new Gearbox(sim, tracker);
const stats = new SessionStats();
const audio = new EngineAudio();
audio.setProfile(profile);
const view = new EngineView($('scene'));
// Rebuild the 3D model only when something that changes its geometry changes.
const geometryKeyOf = () => `${profile.id}:${profile.boreStroke}:${profile.displacementL}:${settings.induction}:${drive.gearRatios.join()}:${drive.reverseRatio}`;
view.setProfile(profile, drive, settings);
let userMovedCamera = false;
let geometryKey = geometryKeyOf();
let soundKey = profile.id;

const pedals = {
  gas: new Pedal($('pedal-gas'), { pressTime: 0.05, releaseTime: 0.07 }),
  clutch: new Pedal($('pedal-clutch'), { pressTime: 0.06, releaseTime: 0.22 }),
  brake: new Pedal($('pedal-brake'), { pressTime: 0.08, releaseTime: 0.1 }),
};
const shifter = new HShifter($('shifter'), $('knob'), (gear) => app.actions.selectGear(gear, 'lever'));
const telemetry = new TelemetryPanel();
const settingsPanel = new SettingsPanel((patch, kind) => app.apply(patch, kind));

// ── The shared app context handed to every feature ──────────────────────────
let toastTimer = 0;
const app = {
  bus, sim, gearbox, tracker, stats, audio, view, pedals, shifter, telemetry, settingsPanel,
  get settings() { return settings; },
  get profile() { return profile; },
  get drive() { return drive; },
  debug: debugMode,

  // Pedal values for this tick. Features may overwrite them in beforeStep()
  // (e.g. the dyno holds the throttle open); main passes them to the gearbox.
  input: { gas: 0, clutch: 0, brake: 0 },

  // Visual crank control. frozen: stop the animation; scrubDeg: show this crank angle.
  viewState: { frozen: false, scrubDeg: null, crankDeg: 0, inputDeg: 0, outputDeg: 0 },

  toast(message, kind = '', ms = 1900) {
    const t = $('toast');
    t.textContent = message;
    t.className = `toast is-on${kind ? ` is-${kind}` : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
  },

  /** Merge a settings patch, persist it and push it to every consumer. kind: see CONTRACT.md. */
  apply(patch = {}, kind = 'all') {
    settings = { ...settings, ...patch };
    if (settings.redlineRpm !== null && (kind === 'engine' || kind === 'all')) {
      settings.redlineRpm = Math.max(settings.redlineRpm, settings.idleRpm + 2500);
    }
    if (kind === 'engine' || kind === 'drive' || kind === 'all') {
      profile = buildProfile(settings);
      drive = driveFrom(settings);
      sim.setDrive(drive);
      sim.setProfile(profile);
      telemetry.setProfile(profile);
      const key = geometryKeyOf();
      if (key !== geometryKey) {
        geometryKey = key;
        view.setProfile(profile, drive, settings);
        layout();
      }
      if (profile.id !== soundKey) {
        soundKey = profile.id;
        audio.setProfile(profile);
      }
      bus.emit('profile', { profile, drive });
    }
    sim.configure(settings);
    gearbox.configure(settings);
    if (kind === 'mode' || kind === 'all') applyMode();
    view.setDisplay?.(settings);
    saveSettings(settings);
    settingsPanel.render(settings, profile, sim);
    renderProfileLabel();
    bus.emit('settings', { settings, kind, patch });
  },

  ui: {
    overlay: $('overlay-root'),
    hudExtra: $('hud-extra'),
    toolRail: $('tool-rail'),
    telemetryExtra: $('telemetry-extra'),
    settingsExtra: $('settings-extra'),
    /** Add a round icon button to the right-hand tool rail. icon: inline SVG markup (static, trusted). */
    addToolButton({ id, label, icon, onClick, order = 50 }) {
      const b = el('button', {
        id: `tool-${id}`, class: 'icon-btn tool-btn', type: 'button', 'aria-label': label, title: label, html: icon,
        on: { click: onClick },
      });
      b.style.order = String(order);
      app.ui.toolRail.append(b);
      return b;
    },
    /** Append a section to the telemetry panel. */
    addTelemetrySection(node, order = 50) {
      node.style.order = String(order);
      app.ui.telemetryExtra.append(node);
      return node;
    },
    /** Append a section to the settings sheet. */
    addSettingsSection(node, order = 50) {
      node.style.order = String(order);
      app.ui.settingsExtra.append(node);
      return node;
    },
  },

  actions: {
    selectGear(gear, source = 'ui') {
      const before = sim.gear;
      const res = gearbox.request(gear);
      if (res.ok) {
        if (gear !== 'N' && sim.gear !== before) audio.clunk();
        if (res.clutchless) app.toast('Clutchless shift: revs matched', 'good');
        if (source !== 'lever') shifter.show(sim.gear);
      } else if (res.grind) {
        audio.grind();
        app.toast(res.reason, 'bad');
        bus.emit('grind', { gear, reason: res.reason, mismatchRpm: res.mismatchRpm });
        navigator.vibrate?.(60);
        if (source !== 'lever') shifter.show(sim.gear);
      }
      return res;
    },
    shiftUp() {
      return app.actions.handleSequential(gearbox.shiftUp());
    },
    shiftDown() {
      return app.actions.handleSequential(gearbox.shiftDown());
    },
    handleSequential(res) {
      if (res && !res.ok && res.reason) {
        if (res.grind) {
          audio.grind();
          bus.emit('grind', { gear: res.gear, reason: res.reason });
        }
        app.toast(res.reason, res.grind ? 'bad' : 'warn');
      }
      shifter.show(sim.gear);
      return res;
    },
    startEngine() {
      audio.unlock();
      if (sim.blown) {
        app.actions.repair();
        return;
      }
      if (sim.running) return;
      if (!sim.startEngine()) app.toast('Press the clutch or select neutral to start', 'warn');
    },
    repair() {
      sim.repair();
      bus.emit('repair', {});
      app.toast('Engine rebuilt', 'good');
    },
    toggleTelemetry: (force) => telemetry.toggle(force),
    openSettings() {
      settingsPanel.render(settings, profile, sim);
      settingsPanel.open();
    },
    closeSettings: () => settingsPanel.close(),
    setMuted(muted) {
      audio.unlock();
      audio.setMuted(muted);
      const b = $('btn-sound');
      b.setAttribute('aria-pressed', String(!muted));
      b.setAttribute('aria-label', muted ? 'Sound off' : 'Sound on');
    },
    resetView: () => view.resetView(),
    resetSession() {
      stats.reset();
      tracker.reset();
      telemetry.lastListKey = '';
      bus.emit('session-reset', {});
    },
  },
};

// ── Feature modules ─────────────────────────────────────────────────────────
const hooks = [];
for (const f of FEATURES) {
  try {
    const h = f.install(app) || {};
    hooks.push({ id: f.id, ...h });
  } catch (err) {
    console.error(`[feature ${f.id}] install failed`, err);
  }
}
function runHook(name, ...args) {
  for (const h of hooks) {
    if (!h[name]) continue;
    try {
      h[name](...args);
    } catch (err) {
      console.error(`[feature ${h.id}] ${name} failed`, err);
    }
  }
}

const hud = new Hud(app);
app.hud = hud;

function applyMode() {
  gearbox.setMode(settings.mode);
  const auto = settings.mode === 'auto';
  pedals.clutch.setEnabled(settings.mode === 'manual');
  shifter.setAuto(auto);
  shifter.show(sim.gear);
  $('mode-tag').hidden = settings.mode === 'manual';
  $('mode-tag').textContent = auto ? 'AUTO' : settings.mode === 'sequential' ? 'SEQ' : '';
}

function renderProfileLabel() {
  $('profile-name').textContent = profile.name;
  $('profile-order').textContent = firingOrderLabel(profile);
  const vs = VISUAL_SPEEDS.find((v) => v.value === settings.visualSpeed);
  $('profile-speed').textContent = settings.visualSpeed === 1 ? 'Real-time visuals' : `Visuals at ${vs ? vs.label : ''} speed`;
}

// Core reactions to simulator events.
bus.on('stall', () => {
  tracker.stall(sim.time);
  app.toast('Stalled: too few revs for that clutch release', 'bad');
  navigator.vibrate?.([40, 40, 40]);
});
bus.on('start', (e) => app.toast(e.bump ? 'Bump-started!' : 'Engine running', 'good'));

// ── Buttons, keys and iOS plumbing ──────────────────────────────────────────
$('btn-sound').addEventListener('click', () => app.actions.setMuted(!audio.muted));
$('btn-telemetry').addEventListener('click', () => telemetry.toggle());
$('btn-settings').addEventListener('click', () => app.actions.openSettings());
$('btn-start').addEventListener('click', () => app.actions.startEngine());
$('btn-view').addEventListener('click', () => view.resetView());
$('btn-defaults').addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS, gearRatios: [...DEFAULT_SETTINGS.gearRatios] };
  app.apply({}, 'all');
  app.toast('Defaults restored');
});
$('btn-reset-session').addEventListener('click', () => app.actions.resetSession());
for (const b of document.querySelectorAll('[data-close]')) {
  b.addEventListener('click', () => (b.dataset.close === 'settings' ? settingsPanel.close() : telemetry.toggle(false)));
}

function toggle(key) {
  if (key === 'm') app.actions.setMuted(!audio.muted);
  else if (key === 't') telemetry.toggle();
  else if (key === 'g') (settingsPanel.isOpen ? settingsPanel.close() : app.actions.openSettings());
  else if (key === 'v') view.resetView();
  else if (key === 'escape') {
    settingsPanel.close();
    telemetry.toggle(false);
    bus.emit('escape', {});
  }
}

bindKeyboard({
  gas: pedals.gas,
  clutch: pedals.clutch,
  brake: pedals.brake,
  onGear: (g) => app.actions.selectGear(g, 'key'),
  onStart: () => app.actions.startEngine(),
  onToggle: toggle,
  onShiftUp: () => app.actions.shiftUp(),
  onShiftDown: () => app.actions.shiftDown(),
  onKey: (key, e) => bus.emit('key', { key, event: e }),
});

// Audio may only start inside a user gesture: unlock on the very first touch,
// and again after iOS interrupts the session (calls, backgrounding).
const unlockAudio = () => audio.unlock();
window.addEventListener('touchstart', unlockAudio, { passive: true });
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

// Keep the screen awake while driving; harmless if refused.
let wakeLock = null;
async function keepAwake() {
  try {
    if (!wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* not allowed here */
  }
}
window.addEventListener('pointerdown', keepAwake, { once: true });

// Block rubber-banding and pinch-zoom outside the scrollable panels.
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest?.('.telemetry, .sheet, .scrollable')) e.preventDefault();
}, { passive: false });
for (const type of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(type, (e) => e.preventDefault());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio.suspend();
  else {
    audio.resume();
    keepAwake();
    last = performance.now();
  }
});

// Double-tap the 3D view to reset the camera.
let lastTap = 0;
$('scene').addEventListener('pointerup', (e) => {
  const now = performance.now();
  if (now - lastTap < 300 && e.isPrimary) view.resetView();
  lastTap = now;
});

// ── Layout ──────────────────────────────────────────────────────────────────
function layout() {
  const root = $('app');
  const w = root.clientWidth;
  const h = root.clientHeight;
  const top = document.querySelector('.tach').getBoundingClientRect().bottom;
  const bottomBar = document.querySelector('.hud-bottom').getBoundingClientRect();
  const bottom = Math.max(0, h - bottomBar.top);
  document.documentElement.style.setProperty('--controls-h', `${Math.round(bottom + 10)}px`);
  document.documentElement.style.setProperty('--hud-top-h', `${Math.round(top)}px`);
  // In portrait the HUD bars span the width, so frame the engine between them.
  // In landscape they sit in the corners and the centre column stays clear.
  const landscape = w > h * 1.15;
  view.resize(w, h, landscape ? { top: top * 0.25, bottom: 0 } : { top, bottom: bottom * 0.75 });
  view.frameModel(!userMovedCamera);
  bus.emit('layout', { width: w, height: h, landscape });
}
app.layout = layout;
view.controls.addEventListener('start', () => (userMovedCamera = true));
window.addEventListener('resize', layout);
window.visualViewport?.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 250));

// ── Simulation tick (no rendering) ──────────────────────────────────────────
let prevGear = sim.gear;
function tick(dt, inputOverride) {
  app.input = inputOverride
    ? { gas: 0, clutch: 0, brake: 0, ...inputOverride }
    : { gas: pedals.gas.value, clutch: pedals.clutch.value, brake: pedals.brake.value };
  runHook('beforeStep', dt, app);
  gearbox.update(dt, app.input);
  sim.step(dt);
  tracker.update(dt, sim);
  stats.update(dt, sim);
  for (const e of sim.drainEvents()) bus.emit(e.type, e);
  if (sim.gear !== prevGear) {
    bus.emit('gear', { from: prevGear, to: sim.gear });
    prevGear = sim.gear;
  }
  runHook('afterStep', dt, app);
}

// ── Frame loop ──────────────────────────────────────────────────────────────
let last = performance.now();
let booted = false;

function frame(now) {
  requestAnimationFrame(frame);
  const frameMs = now - last;
  // Physics sub-steps internally, so slow frames are absorbed up to 100 ms.
  const dt = Math.min(0.1, Math.max(0, frameMs / 1000));
  last = now;

  for (const p of Object.values(pedals)) p.update(dt);
  tick(dt);

  if (gearbox.mode !== 'manual' && shifter.pointer === null && shifter.zone !== sim.gear) shifter.show(sim.gear);
  shifter.update(dt);

  // Visual angles run slowed down so individual strokes stay readable.
  const vs = app.viewState;
  if (vs.scrubDeg !== null) {
    vs.crankDeg = ((vs.scrubDeg % 2160) + 2160) % 2160;
  } else if (!vs.frozen) {
    const k = dt * RAD2DEG * settings.visualSpeed;
    vs.crankDeg = (vs.crankDeg + sim.omega * k) % 2160;
    vs.inputDeg = (vs.inputDeg + sim.inputOmega * k) % 3600;
    vs.outputDeg = (vs.outputDeg + sim.outputOmega * k) % 3600;
  }
  view.update(dt, {
    crankDeg: vs.crankDeg, inputDeg: vs.inputDeg, outputDeg: vs.outputDeg, sim, settings,
    frozen: vs.frozen || vs.scrubDeg !== null, showFlashes: true,
  });
  runHook('beforeRender', dt, app);
  view.render();
  view.adaptQuality(frameMs);

  audio.update(sim, dt);
  hud.update(dt);
  telemetry.update(sim, stats, tracker);
  runHook('frame', dt, app);

  if (!booted) {
    booted = true;
    window.__engineBooted = true;
    $('boot').hidden = true;
    if (matchMedia('(pointer: coarse)').matches) app.toast('Tap anywhere to turn the sound on');
  }
}

// ── Debug API (?debug): deterministic stepping for tests ─────────────────────
if (debugMode) {
  window.__app = app;
  Object.assign(window, { sim, view, gearbox, audio });
  app.debugApi = {
    /** Run the simulation for `seconds` at a fixed step with fixed pedal input, without rendering. */
    advance(seconds, input = {}) {
      const n = Math.round(seconds / TICK);
      for (let i = 0; i < n; i++) tick(TICK, input);
      return { rpm: sim.rpm, kmh: sim.speedKmh, gear: sim.gear, running: sim.running };
    },
    tick,
  };
}

app.apply({}, 'all');
layout();
requestAnimationFrame((t) => {
  last = t;
  frame(t);
});

// Bootstraps the simulator: state, render loop, input and HUD wiring.

import { buildProfile, DEFAULT_SETTINGS, DRIVETRAIN_DEFAULTS, firingOrderLabel } from './config.js';
import { Drivetrain } from './physics.js';
import { Gearbox, ShiftTracker } from './gearbox.js';
import { SessionStats } from './session.js';
import { EngineAudio } from './audio.js';
import { EngineView } from './scene.js';
import { Pedal, HShifter, bindKeyboard } from './controls.js';
import { SettingsPanel, TelemetryPanel, VISUAL_SPEEDS } from './ui.js';

const $ = (id) => document.getElementById(id);
const RAD2DEG = 180 / Math.PI;
const STORAGE_KEY = 'firing-order:settings:v1';
const DRIVE_KEYS = Object.keys(DRIVETRAIN_DEFAULTS);

// ── Settings (remembered per browser) ───────────────────────────────────────
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const merged = { ...DEFAULT_SETTINGS, ...saved };
      if (!Array.isArray(merged.gearRatios) || merged.gearRatios.length !== 5) merged.gearRatios = [...DEFAULT_SETTINGS.gearRatios];
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

let settings = loadSettings();
let profile = buildProfile(settings);
let drive = driveFrom(settings);

const sim = new Drivetrain(profile, drive);
const tracker = new ShiftTracker();
const gearbox = new Gearbox(sim, tracker);
const stats = new SessionStats();
const audio = new EngineAudio();
audio.setProfile(profile);

const view = new EngineView($('scene'));
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { sim, view, gearbox, audio });
view.setProfile(profile, drive);
let userMovedCamera = false;
let geometryKey = `${profile.id}:${profile.boreStroke}:${drive.gearRatios.join()}:${drive.reverseRatio}`;
let soundKey = profile.id;

// ── Controls ────────────────────────────────────────────────────────────────
const pedals = {
  gas: new Pedal($('pedal-gas'), { pressTime: 0.05, releaseTime: 0.07 }),
  clutch: new Pedal($('pedal-clutch'), { pressTime: 0.06, releaseTime: 0.22 }),
  brake: new Pedal($('pedal-brake'), { pressTime: 0.08, releaseTime: 0.1 }),
};
const shifter = new HShifter($('shifter'), $('knob'), (gear) => selectGear(gear, 'lever'));

let toastTimer = 0;
function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast is-on${kind ? ` is-${kind}` : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 1900);
}

function selectGear(gear, source) {
  const before = sim.gear;
  const res = gearbox.request(gear);
  if (res.ok) {
    if (gear !== 'N' && sim.gear !== before) audio.clunk();
    if (res.clutchless) toast('Clutchless shift: revs matched', 'good');
    if (source !== 'lever') shifter.show(sim.gear);
  } else if (res.grind) {
    audio.grind();
    toast(res.reason, 'bad');
    navigator.vibrate?.(60);
    if (source !== 'lever') shifter.show(sim.gear);
  }
  return res;
}

function startEngine() {
  audio.unlock();
  if (sim.running) return;
  if (!sim.startEngine()) toast('Press the clutch or select neutral to start', 'warn');
}

const telemetry = new TelemetryPanel();
telemetry.setProfile(profile);

const settingsPanel = new SettingsPanel(applySettings);

function applySettings(patch, kind) {
  settings = { ...settings, ...patch };
  if (kind === 'engine' && settings.redlineRpm !== null) {
    settings.redlineRpm = Math.max(settings.redlineRpm, settings.idleRpm + 2500);
  }
  if (kind === 'engine' || kind === 'drive' || kind === 'all') {
    profile = buildProfile(settings);
    drive = driveFrom(settings);
    sim.setDrive(drive);
    sim.setProfile(profile);
    telemetry.setProfile(profile);
    const key = `${profile.id}:${profile.boreStroke}:${drive.gearRatios.join()}:${drive.reverseRatio}`;
    if (key !== geometryKey) {
      geometryKey = key;
      view.setProfile(profile, drive);
      layout();
    }
    if (profile.id !== soundKey) {
      soundKey = profile.id;
      audio.setProfile(profile);
    }
  }
  if (kind === 'mode' || kind === 'all') applyMode();
  saveSettings(settings);
  settingsPanel.render(settings, profile, sim);
  renderProfileLabel();
}

function applyMode() {
  gearbox.setMode(settings.mode);
  const auto = settings.mode === 'auto';
  pedals.clutch.setEnabled(!auto);
  shifter.setAuto(auto);
  shifter.show(sim.gear);
  $('mode-tag').hidden = !auto;
}

function renderProfileLabel() {
  $('profile-name').textContent = profile.name;
  $('profile-order').textContent = firingOrderLabel(profile);
  const vs = VISUAL_SPEEDS.find((v) => v.value === settings.visualSpeed);
  $('profile-speed').textContent = settings.visualSpeed === 1 ? 'Real-time visuals' : `Visuals at ${vs ? vs.label : ''} speed`;
}

function toggle(key) {
  if (key === 'm') setMuted(!audio.muted);
  else if (key === 't') telemetry.toggle();
  else if (key === 'g') (settingsPanel.isOpen ? settingsPanel.close() : openSettings());
  else if (key === 'v') view.resetView();
  else if (key === 'escape') {
    settingsPanel.close();
    telemetry.toggle(false);
  }
}

function openSettings() {
  settingsPanel.render(settings, profile, sim);
  settingsPanel.open();
}

function setMuted(muted) {
  audio.unlock();
  audio.setMuted(muted);
  const b = $('btn-sound');
  b.setAttribute('aria-pressed', String(!muted));
  b.setAttribute('aria-label', muted ? 'Sound off' : 'Sound on');
}

$('btn-sound').addEventListener('click', () => setMuted(!audio.muted));
$('btn-telemetry').addEventListener('click', () => telemetry.toggle());
$('btn-settings').addEventListener('click', openSettings);
$('btn-start').addEventListener('click', startEngine);
$('btn-view').addEventListener('click', () => view.resetView());
$('btn-defaults').addEventListener('click', () => {
  settings = { ...DEFAULT_SETTINGS, gearRatios: [...DEFAULT_SETTINGS.gearRatios] };
  applySettings({}, 'all');
  toast('Defaults restored');
});
$('btn-reset-session').addEventListener('click', () => {
  stats.reset();
  tracker.reset();
  telemetry.lastListKey = '';
});
for (const b of document.querySelectorAll('[data-close]')) {
  b.addEventListener('click', () => (b.dataset.close === 'settings' ? settingsPanel.close() : telemetry.toggle(false)));
}

bindKeyboard({
  gas: pedals.gas,
  clutch: pedals.clutch,
  brake: pedals.brake,
  onGear: (g) => selectGear(g, 'key'),
  onStart: startEngine,
  onToggle: toggle,
});

// ── iOS / PWA plumbing ──────────────────────────────────────────────────────
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
  if (!e.target.closest?.('.telemetry, .sheet')) e.preventDefault();
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
  const app = $('app');
  const w = app.clientWidth;
  const h = app.clientHeight;
  const top = document.querySelector('.tach').getBoundingClientRect().bottom;
  const bottomBar = document.querySelector('.hud-bottom').getBoundingClientRect();
  const bottom = Math.max(0, h - bottomBar.top);
  document.documentElement.style.setProperty('--controls-h', `${Math.round(bottom + 10)}px`);
  // In portrait the HUD bars span the width, so frame the engine between them.
  // In landscape they sit in the corners and the centre column stays clear.
  const landscape = w > h * 1.15;
  view.resize(w, h, landscape ? { top: top * 0.25, bottom: 0 } : { top, bottom: bottom * 0.75 });
  view.frameModel(!userMovedCamera);
}
view.controls.addEventListener('start', () => (userMovedCamera = true));
window.addEventListener('resize', layout);
window.visualViewport?.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 250));

// ── HUD ─────────────────────────────────────────────────────────────────────
const hud = {
  rpm: $('rpm'), fill: $('rpm-fill'), redline: $('rpm-redline'), gear: $('gear'), speed: $('speed'),
  limiter: $('limiter'), traction: $('traction'), stall: $('stall'), stallHelp: $('stall-help'), start: $('btn-start'),
};
const shown = {};
const setText = (el, key, value) => {
  if (shown[key] !== value) {
    shown[key] = value;
    el.textContent = value;
  }
};
let spinTime = 0;
let spinHold = 0;

function updateHud(dt) {
  const rpm = sim.rpm;
  const scale = profile.redlineRpm * 1.06;
  setText(hud.rpm, 'rpm', String(Math.round(rpm / 10) * 10));
  hud.fill.style.width = `${Math.min(100, (rpm / scale) * 100).toFixed(1)}%`;
  hud.redline.style.left = `${((profile.redlineRpm / scale) * 100).toFixed(1)}%`;
  hud.fill.classList.toggle('is-red', rpm > profile.redlineRpm * 0.92);
  const gearText = String(sim.gear);
  setText(hud.gear, 'gear', gearText);
  hud.gear.classList.toggle('is-reverse', sim.gear === 'R');
  setText(hud.speed, 'speed', String(Math.round(sim.speedKmh)));
  hud.limiter.hidden = !sim.fuelCut;
  // Only flag sustained wheelspin, not the blip of a clutch catching.
  spinTime = sim.wheelspin && sim.throttleEffective > 0.3 ? spinTime + dt : 0;
  spinHold = spinTime > 0.2 ? 0.35 : Math.max(0, spinHold - dt);
  hud.traction.hidden = spinHold <= 0;

  const off = !sim.running && !sim.cranking;
  hud.stall.hidden = !off;
  if (off) {
    const ready = sim.canCrank();
    hud.start.disabled = !ready;
    setText(hud.stallHelp, 'stallHelp', ready ? 'Ready. Tap START to crank it over.' : 'Press the clutch or select neutral, then start.');
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────
let crankDeg = 0;
let inputDeg = 0;
let outputDeg = 0;
let last = performance.now();
let booted = false;

function frame(now) {
  requestAnimationFrame(frame);
  const frameMs = now - last;
  // Physics sub-steps internally, so slow frames are absorbed up to 100 ms.
  const dt = Math.min(0.1, Math.max(0, frameMs / 1000));
  last = now;

  const input = {
    gas: pedals.gas.update(dt),
    clutch: pedals.clutch.update(dt),
    brake: pedals.brake.update(dt),
  };
  gearbox.update(dt, input);
  sim.step(dt);
  tracker.update(dt, sim);
  stats.update(dt, sim);

  for (const e of sim.drainEvents()) {
    if (e.type === 'stall') {
      tracker.stall(sim.time);
      toast('Stalled: too few revs for that clutch release', 'bad');
      navigator.vibrate?.([40, 40, 40]);
    } else if (e.type === 'start') {
      toast(e.bump ? 'Bump-started!' : 'Engine running', 'good');
    }
  }

  if (gearbox.mode === 'auto' && shifter.pointer === null && shifter.zone !== sim.gear) shifter.show(sim.gear);
  shifter.update(dt);

  // Visual angles run slowed down so individual strokes stay readable.
  const k = dt * RAD2DEG * settings.visualSpeed;
  crankDeg = (crankDeg + sim.omega * k) % 2160;
  inputDeg = (inputDeg + sim.inputOmega * k) % 3600;
  outputDeg = (outputDeg + sim.outputOmega * k) % 3600;
  view.update(dt, { crankDeg, inputDeg, outputDeg, sim, showFlashes: true });
  view.render();
  view.adaptQuality(frameMs);

  audio.update(sim, dt);
  updateHud(dt);
  telemetry.update(sim, stats, tracker);

  if (!booted) {
    booted = true;
    window.__engineBooted = true;
    $('boot').hidden = true;
    if (matchMedia('(pointer: coarse)').matches) toast('Tap anywhere to turn the sound on');
  }
}

applySettings({}, 'all');
layout();
requestAnimationFrame((t) => {
  last = t;
  frame(t);
});

// HUD & controls feature: tool-rail buttons (camera presets, cinematic,
// explode, display mode, freeze + crank-angle scrubber, garage), sequential
// paddles in place of the H-gate, the garage sheet, speed units for the
// telemetry tiles, and placement of the floating chrome so the rail, toast,
// stall card and scrubber never sit on the pedals, lever or HUD.

import { Paddles } from '../controls.js';
import { GarageSheet } from '../ui.js';
import { GARAGE, garagePatch } from '../presets.js';
import { scrubPeriod, stepFiring, lastFired, nextDisplayMode, displayModeOf, DISPLAY_MODES, garageSpecs } from '../hud.js';

const $ = (id) => document.getElementById(id);
const mod = (a, n) => ((a % n) + n) % n;

const RAIL_BTN = 44; // px, matches .tool-rail .tool-btn
const RAIL_GAP = 8;
const TOAST_SLOT = 64; // px kept clear under the toast's top edge (two lines)

const ICONS = {
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5h3.2l1.8-3h8l1.8 3H21V19H3z"/><circle cx="12" cy="13.5" r="3.4"/></svg>',
  cinematic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20.5 3.5v4h-4"/><circle cx="12" cy="12" r="2.4"/></svg>',
  explode: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M7 7L3.5 3.5M17 7l3.5-3.5M7 17l-3.5 3.5M17 17l3.5 3.5M3.5 7.5v-4h4M20.5 7.5v-4h-4M3.5 16.5v4h4M20.5 16.5v4h-4"/></svg>',
  display: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l9 4.8-9 4.8-9-4.8z"/><path d="M3 12.2l9 4.8 9-4.8M3 16l9 4.8 9-4.8"/></svg>',
  freeze: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5v19M3.8 7.25l16.4 9.5M3.8 16.75l16.4-9.5M9.4 4L12 6.6 14.6 4M9.4 20L12 17.4l2.6 2.6M3.6 10.6l3.5-.9-.9-3.5M20.4 13.4l-3.5.9.9 3.5M6.2 17.8l.9-3.5-3.5-.9M17.8 6.2l-.9 3.5 3.5.9"/></svg>',
  garage: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10l9-6 9 6v10H3z"/><path d="M7 20v-6h10v6M7 17h10"/></svg>',
};

export default {
  id: 'hud',
  install(app) {
    const { bus, view } = app;
    const vs = app.viewState;
    const rail = app.ui.toolRail;
    const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

    // ── Garage ──────────────────────────────────────────────────────────────
    const specCache = new Map();
    const garage = new GarageSheet({
      entries: GARAGE,
      specsOf: (entry) => {
        if (!specCache.has(entry.id)) specCache.set(entry.id, garageSpecs(entry));
        return specCache.get(entry.id);
      },
      onPick: (id) => {
        const ok = app.actions.loadGarage ? app.actions.loadGarage(id) : (app.apply(garagePatch(id), 'engine'), true);
        if (ok !== false) {
          garage.close();
          app.actions.closeSettings();
        }
      },
    });
    app.actions.openGarage = () => garage.open(app.settings.garage);
    app.actions.closeGarage = () => garage.close();
    app.settingsPanel.onGarage = () => app.actions.openGarage();
    app.settingsPanel.garageName = (id) => GARAGE.find((g) => g.id === id)?.name ?? '';

    // ── Sequential paddles ──────────────────────────────────────────────────
    const shifter = $('shifter');
    const paddles = $('paddles');
    const hint = $('shifter-hint');
    new Paddles($('paddle-up'), $('paddle-down'), {
      onUp: () => app.actions.shiftUp(),
      onDown: () => app.actions.shiftDown(),
    });
    let shownMode = '';
    function applyMode(mode) {
      if (mode === shownMode) return;
      shownMode = mode;
      const seq = mode === 'sequential';
      shifter.hidden = seq;
      paddles.hidden = !seq;
      hint.textContent = seq
        ? (finePointer ? 'E shifts up · Q shifts down' : 'Tap to shift up or down')
        : mode === 'auto' ? 'The lever follows the gearbox' : 'Push and pull the lever';
      app.layout?.();
    }

    // ── Freeze + crank-angle scrubber ───────────────────────────────────────
    const scrub = $('scrub');
    const range = $('scrub-range');
    const degOut = $('scrub-deg');
    const info = $('scrub-info');
    let frozen = false;

    function showAngle(deg) {
      const profile = app.profile;
      const period = scrubPeriod(profile);
      const d = Math.round(mod(deg, period));
      vs.scrubDeg = d;
      range.value = String(d);
      degOut.textContent = `${d}°`;
      if (profile.kind === 'rotary') info.textContent = `rotor at ${Math.round(d / 3)}°`;
      else {
        const f = lastFired(profile, d);
        info.textContent = f ? `#${f.num} ${f.stroke}` : '';
      }
    }

    function setFrozen(on) {
      frozen = on;
      vs.frozen = on;
      freezeBtn.setAttribute('aria-pressed', String(on));
      scrub.hidden = !on;
      if (on) {
        range.max = String(scrubPeriod(app.profile));
        showAngle(vs.crankDeg);
      } else vs.scrubDeg = null;
      place();
    }

    range.addEventListener('input', () => showAngle(Number(range.value)));
    $('scrub-prev').addEventListener('click', () => showAngle(stepFiring(app.profile, vs.scrubDeg ?? 0, -1)));
    $('scrub-next').addEventListener('click', () => showAngle(stepFiring(app.profile, vs.scrubDeg ?? 0, 1)));

    // ── Tool rail ───────────────────────────────────────────────────────────
    let presetIndex = 0;
    const cameraBtn = app.ui.addToolButton({
      id: 'camera', label: 'Camera angle', icon: ICONS.camera, order: 10,
      onClick: () => {
        const presets = view.cameraPresets?.length ? view.cameraPresets : ['hero'];
        presetIndex = (presetIndex + 1) % presets.length;
        const label = view.setCameraPreset?.(presets[presetIndex]) ?? presets[presetIndex];
        cameraBtn.title = `Camera: ${label}`;
        app.toast(`Camera: ${label}`, '', 1300);
      },
    });

    let cinematic = false;
    const cinematicBtn = app.ui.addToolButton({
      id: 'cinematic', label: 'Cinematic orbit', icon: ICONS.cinematic, order: 15,
      onClick: () => {
        cinematic = !cinematic;
        view.setCinematic?.(cinematic);
        cinematicBtn.setAttribute('aria-pressed', String(cinematic));
        app.toast(cinematic ? 'Cinematic orbit on. Touch the view to take over.' : 'Cinematic orbit off', '', 1500);
      },
    });
    cinematicBtn.setAttribute('aria-pressed', 'false');

    let exploded = false;
    const explodeBtn = app.ui.addToolButton({
      id: 'explode', label: 'Exploded view', icon: ICONS.explode, order: 20,
      onClick: () => {
        exploded = !exploded;
        view.setExplode?.(exploded ? 1 : 0);
        explodeBtn.setAttribute('aria-pressed', String(exploded));
      },
    });
    explodeBtn.setAttribute('aria-pressed', 'false');

    const displayBtn = app.ui.addToolButton({
      id: 'display', label: 'Display mode', icon: ICONS.display, order: 25,
      onClick: () => {
        const next = nextDisplayMode(app.settings);
        app.apply(next.patch, 'view');
        app.toast(`Display: ${next.label}`, '', 1300);
      },
    });

    const freezeBtn = app.ui.addToolButton({
      id: 'freeze', label: 'Freeze and scrub the crank', icon: ICONS.freeze, order: 30,
      onClick: () => setFrozen(!frozen),
    });
    freezeBtn.setAttribute('aria-pressed', 'false');

    app.ui.addToolButton({
      id: 'garage', label: 'Garage', icon: ICONS.garage, order: 40,
      onClick: () => app.actions.openGarage(),
    });

    // ── Placement of the floating chrome ────────────────────────────────────
    const hudRight = document.querySelector('.hud-right');
    const tach = document.querySelector('.tach');
    const shifterWrap = document.querySelector('.shifter-wrap');
    const pedalWrap = document.querySelector('.pedal-wrap');
    const root = document.documentElement.style;

    function place() {
      const appEl = $('app');
      const w = appEl.clientWidth;
      const h = appEl.clientHeight;
      if (!w || !h) return;
      const landscape = w > h * 1.15;
      const right = hudRight.getBoundingClientRect();
      const tachRect = tach.getBoundingClientRect();
      const lever = shifterWrap.getBoundingClientRect();
      const pedals = pedalWrap.getBoundingClientRect();

      // Scrubber: between the lever and the pedals in landscape, above them in portrait.
      if (!scrub.hidden) {
        if (landscape) {
          const left = lever.right + 12;
          const room = pedals.left - 12 - left;
          const width = Math.min(440, room);
          scrub.style.left = `${Math.round(left + (room - width) / 2)}px`;
          scrub.style.width = `${Math.round(width)}px`;
          scrub.style.right = 'auto';
          scrub.style.bottom = `${Math.round(h - pedals.bottom)}px`;
        } else {
          scrub.style.left = '';
          scrub.style.width = '';
          scrub.style.right = '';
          scrub.style.bottom = `${Math.round(h - Math.min(lever.top, pedals.top) + 10)}px`;
        }
      }

      // Rail: below the top-right cluster, as many rows as fit above the pedals
      // (and the scrubber), extra buttons wrap into columns towards the centre.
      const top = right.bottom + 10;
      let limit = pedals.top - 10;
      if (!scrub.hidden && !landscape) limit = Math.min(limit, scrub.getBoundingClientRect().top - 10);
      const rows = Math.max(1, Math.floor((limit - top + RAIL_GAP) / (RAIL_BTN + RAIL_GAP)));
      const count = rail.children.length;
      const cols = Math.max(1, Math.ceil(count / rows));
      rail.style.top = `${Math.round(top)}px`;
      // Portrait: a vertical rail. Landscape: rows under the top-right buttons.
      rail.classList.toggle('is-rows', landscape);
      root.setProperty('--rail-rows', String(Math.min(rows, Math.max(1, count))));
      root.setProperty('--rail-cols', String(cols));

      // Half-width around the centre line that stays clear of the HUD cards
      // and of any rail button overlapping the vertical band [top, bottom].
      const cx = w / 2;
      const obstacles = [tachRect, right, ...[...rail.children].map((b) => b.getBoundingClientRect())];
      const clearHalf = (top, bottom) => {
        let half = cx - 14;
        for (const r of obstacles) {
          if (!r.width || r.bottom <= top || r.top >= bottom) continue;
          if (r.left >= cx) half = Math.min(half, r.left - cx - 8);
          else if (r.right <= cx) half = Math.min(half, cx - r.right - 8);
        }
        return Math.max(80, half);
      };

      // Toast: under the tach in portrait, in the top centre gap in landscape.
      // The stall card starts below a two-line toast's slot.
      const toastTop = landscape ? tachRect.top : tachRect.bottom + 8;
      root.setProperty('--toast-top', `${Math.round(toastTop)}px`);
      root.setProperty('--toast-max', `${Math.round(2 * clearHalf(toastTop, toastTop + TOAST_SLOT))}px`);
      // Landscape: centred in the free middle column. Portrait: kept clear of the lever and pedals.
      const stallTop = landscape
        ? Math.max(toastTop + TOAST_SLOT, h / 2 - 95)
        : Math.min(toastTop + TOAST_SLOT, Math.min(lever.top, pedals.top) - 210);
      root.setProperty('--stall-top', `${Math.round(stallTop)}px`);
      root.setProperty('--stall-w', `${Math.round(Math.min(300, 2 * clearHalf(stallTop, stallTop + 210)))}px`);

      // Landscape telemetry: the free centre column between the tach + lever and the rail + pedals.
      if (landscape) {
        const railRect = rail.getBoundingClientRect();
        const leftEdge = Math.max(tachRect.right, lever.right) + 12;
        const rightEdge = Math.min(right.left, railRect.width ? railRect.left : right.left, pedals.left) - 12;
        root.setProperty('--centre-l', `${Math.round(leftEdge)}px`);
        root.setProperty('--centre-r', `${Math.round(w - rightEdge)}px`);
      }
    }

    // ── Bus wiring ──────────────────────────────────────────────────────────
    let displayShown = '';
    bus.on('settings', ({ settings }) => {
      applyMode(settings.mode);
      app.telemetry.setUnits?.(settings.units);
      const mode = displayModeOf(settings);
      if (mode !== displayShown) {
        displayShown = mode;
        const label = DISPLAY_MODES.find((m) => m.id === mode).label;
        displayBtn.title = `Display: ${label}`;
        displayBtn.setAttribute('aria-label', `Display mode: ${label}`);
        displayBtn.dataset.mode = mode;
      }
    });
    bus.on('profile', () => {
      if (frozen) {
        range.max = String(scrubPeriod(app.profile));
        showAngle(vs.scrubDeg ?? 0);
      }
    });
    bus.on('layout', place);
    bus.on('escape', () => {
      if (garage.isOpen) garage.close();
      else if (frozen) setFrozen(false);
    });
    bus.on('key', ({ key }) => {
      if (key === 'f') setFrozen(!frozen);
      else if (frozen && (key === '[' || key === ']')) showAngle(stepFiring(app.profile, vs.scrubDeg ?? 0, key === ']' ? 1 : -1));
    });

    return {
      frame() {
        // The view drops cinematic mode when the user grabs the camera.
        const live = view.cinematic;
        if (typeof live === 'boolean' && live !== cinematic) {
          cinematic = live;
          cinematicBtn.setAttribute('aria-pressed', String(live));
        }
      },
    };
  },
};

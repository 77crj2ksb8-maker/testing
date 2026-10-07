// Feature module for the "visuals" track: turns simulator events into 3D
// effects (tailpipe flames, camera shake, blow-off puffs, the blown-engine
// sequence and its repair). See docs/CONTRACT.md → "Feature modules".

export default {
  id: 'visuals',
  install(app) {
    const view = app.view;
    const bus = app.bus;
    let lastShake = 0;
    // Limiter and two-step cuts fire many times a second: keep the shake gentle
    // and rate-limited so it reads as vibration, not an earthquake.
    const buzz = (amount) => {
      const now = app.sim.time ?? 0;
      if (now - lastShake < 0.08 && now >= lastShake) return;
      lastShake = now;
      view.shake?.(amount);
    };

    bus.on('backfire', (e = {}) => {
      const strength = Math.max(0, Math.min(1, e.strength ?? 0.6));
      view.burst?.('flame', { strength });
      if (strength > 0.6) buzz(0.12 * strength);
    });
    bus.on('twostep', () => {
      view.burst?.('flame', { strength: 0.8 });
      buzz(0.14);
    });
    bus.on('limiter', () => buzz(0.07));
    bus.on('bov', (e = {}) => view.burst?.('bov', { strength: Math.max(0.3, Math.min(1, (e.boostBar ?? 0.6) / 1.2)) }));
    bus.on('overrev', (e = {}) => {
      const s = Math.max(0, Math.min(1, e.severity ?? 0.5));
      buzz(0.2 + 0.5 * s);
      if (s > 0.5) view.burst?.('sparks', { strength: s * 0.5 });
    });
    bus.on('overheat', () => view.burst?.('smoke', { strength: 0.5 }));
    // The block rocks on its mounts when the engine catches, dies or a gear is forced.
    bus.on('start', () => view.shake?.(0.12));
    bus.on('stall', () => view.shake?.(0.22));
    bus.on('grind', () => buzz(0.1));
    bus.on('shift', (e = {}) => {
      if (e.flat) buzz(0.1);
    });
    bus.on('blown', () => view.blowUp?.());
    bus.on('repair', () => view.restore?.());
    // A rebuilt model (new engine) starts whole; if the engine is still blown, show it.
    bus.on('profile', () => {
      if (app.sim.blown && !view.isBlown) view.blowUp?.();
    });
    // Stroke labels stay off the HUD cards, tool rail and controls. Measured
    // only when the layout changes, never per frame.
    const BLOCKERS = '.tach, .hud-right, .tool-rail, .hud-bottom > *';
    bus.on('layout', () => {
      const canvas = view.renderer?.domElement;
      if (!canvas || !view.setLabelBlockers) return;
      const base = canvas.getBoundingClientRect();
      const rects = [];
      for (const node of document.querySelectorAll(BLOCKERS)) {
        const r = node.getBoundingClientRect();
        if (r.width && r.height) rects.push({ left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top });
      }
      view.setLabelBlockers(rects);
    });
    return {};
  },
};

// Garage: named engine builds. Each entry is a settings patch applied over the
// defaults, so anything a build sets can also be tuned by hand afterwards.
// Names describe the archetype; no manufacturer names or trademarks.
//
// Every build sets every engine key, so loading one never inherits leftovers
// (boost, cam switching, a custom redline) from the engine loaded before it.

const ENGINE_DEFAULTS = Object.freeze({
  idleRpm: 800,
  redlineRpm: null,
  boreStroke: 1.0,
  displacementL: null,
  vvlRpm: null,
  induction: 'na',
  boostBar: 0.8,
});

const build = (settings) => Object.freeze({ ...ENGINE_DEFAULTS, ...settings });

export const GARAGE = Object.freeze([
  {
    id: 'smallblock',
    name: 'Small-block 6.2',
    blurb: 'Pushrod crossplane V8. Lazy torque and that lumpy burble.',
    tags: ['V8', 'NA'],
    settings: build({ preset: 'v8-cross', cylinders: 8, displacementL: 6.2, redlineRpm: 6600, idleRpm: 700, boreStroke: 1.12 }),
  },
  {
    id: 'supercharged-v8',
    name: 'Supercharged 6.2 V8',
    blurb: 'Crossplane V8 with a positive-displacement blower. Instant shove, constant whine.',
    tags: ['V8', 'Supercharged'],
    settings: build({ preset: 'v8-cross', cylinders: 8, displacementL: 6.2, redlineRpm: 6500, idleRpm: 750, boreStroke: 1.12, induction: 'supercharger', boostBar: 0.55 }),
  },
  {
    id: 'flatplane-45',
    name: 'Flat-plane 4.5',
    blurb: 'Mid-engine flat-plane V8. Shrieks all the way to 9,000.',
    tags: ['V8', 'NA', '9k'],
    settings: build({ preset: 'v8-flat', cylinders: 8, displacementL: 4.5, redlineRpm: 9000, idleRpm: 900, boreStroke: 1.15 }),
  },
  {
    id: 'tt-flatplane',
    name: 'Twin-turbo flat-plane 3.9',
    blurb: 'Hot-vee flat-plane V8 with a turbo per bank. A wall of mid-range.',
    tags: ['V8', 'Twin-turbo'],
    settings: build({ preset: 'v8-flat', cylinders: 8, displacementL: 3.9, redlineRpm: 8000, idleRpm: 850, boreStroke: 1.1, induction: 'twin-turbo', boostBar: 0.85 }),
  },
  {
    id: 'rally-boxer',
    name: 'Turbo boxer-4 2.5',
    blurb: 'Rally-bred flat-four on one big turbo. Off-beat rumble, then a rush of boost.',
    tags: ['Boxer', 'Turbo'],
    settings: build({ preset: 'boxer', cylinders: 4, displacementL: 2.5, redlineRpm: 7000, idleRpm: 850, boreStroke: 1.1, induction: 'turbo', boostBar: 0.65 }),
  },
  {
    id: 'flat6-9k',
    name: 'Flat-6 4.0 9k',
    blurb: 'Naturally aspirated track flat-six that revs to 9,000.',
    tags: ['Flat-6', 'NA', '9k'],
    settings: build({ preset: 'boxer', cylinders: 6, displacementL: 4.0, redlineRpm: 9000, idleRpm: 900, boreStroke: 1.26 }),
  },
  {
    id: 'v10-screamer',
    name: 'Screaming V10 5.2',
    blurb: 'Even-fire 72° V10. Thin, howling top end.',
    tags: ['V10', 'NA'],
    settings: build({ preset: 'v8-flat', cylinders: 10, displacementL: 5.2, redlineRpm: 8700, idleRpm: 900, boreStroke: 1.1 }),
  },
  {
    id: 'v12-65',
    name: 'V12 6.5',
    blurb: 'Sixty-degree V12. Turbine smooth with a hard top end.',
    tags: ['V12', 'NA'],
    settings: build({ preset: 'v8-flat', cylinders: 12, displacementL: 6.5, redlineRpm: 8500, idleRpm: 850, boreStroke: 1.2 }),
  },
  {
    id: 'turbo-i6',
    name: 'Turbo straight-six 3.0',
    blurb: 'Iron-block inline-6 on a big single turbo. Lag, then everything.',
    tags: ['I6', 'Turbo'],
    settings: build({ preset: 'i6', cylinders: 6, displacementL: 3.0, redlineRpm: 7200, idleRpm: 800, boreStroke: 0.95, induction: 'turbo', boostBar: 1.4 }),
  },
  {
    id: 'tt-rotary',
    name: 'Twin-turbo 2-rotor 1.3',
    blurb: 'Sequential-style twin-turbo rotary. Smooth, buzzy and eager to rev.',
    tags: ['Rotary', 'Twin-turbo'],
    settings: build({ preset: 'rotary', cylinders: 2, displacementL: 1.3, redlineRpm: 8500, idleRpm: 850, induction: 'twin-turbo', boostBar: 0.5 }),
  },
  {
    id: 'vvl-i4',
    name: 'Inline-4 2.0 9k VVL',
    blurb: 'Oversquare four with variable valve lift. Switches to the high cam at 5,800.',
    tags: ['I4', 'NA', 'VVL'],
    settings: build({ preset: 'i4', cylinders: 4, displacementL: 2.0, redlineRpm: 9000, idleRpm: 900, boreStroke: 1.04, vvlRpm: 5800 }),
  },
  {
    id: 'vtwin-cruiser',
    name: 'V-twin cruiser 1.9',
    blurb: '45° V-twin on a shared crank pin. The potato-potato idle.',
    tags: ['V-twin', 'NA'],
    settings: build({ preset: 'vtwin', cylinders: 2, displacementL: 1.9, redlineRpm: 5500, idleRpm: 850, boreStroke: 0.9 }),
  },
]);

/** Settings patch for a garage entry (empty object for an unknown id). */
export function garagePatch(id) {
  const g = GARAGE.find((x) => x.id === id);
  return g ? { ...g.settings, garage: g.id } : {};
}

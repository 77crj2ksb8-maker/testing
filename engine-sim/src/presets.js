// Garage: named engine builds. Each entry is a settings patch applied over the
// defaults, so anything a preset sets can also be tuned by hand afterwards.
// Names describe the archetype; no manufacturer names or trademarks.

export const GARAGE = [
  {
    id: 'smallblock',
    name: 'Small-block 6.2',
    blurb: 'Pushrod crossplane V8. Lazy torque and that burble.',
    tags: ['V8', 'NA'],
    settings: { preset: 'v8-cross', cylinders: 8, displacementL: 6.2, redlineRpm: 6600, idleRpm: 700, boreStroke: 1.12, induction: 'na', vvlRpm: null },
  },
  {
    id: 'flatplane-45',
    name: 'Flat-plane 4.5',
    blurb: 'High-revving flat-plane V8. Shrieks to 9,000.',
    tags: ['V8', 'NA', '9k'],
    settings: { preset: 'v8-flat', cylinders: 8, displacementL: 4.5, redlineRpm: 9000, idleRpm: 900, boreStroke: 1.15, induction: 'na', vvlRpm: null },
  },
];

/** Settings patch for a garage entry (empty object for an unknown id). */
export function garagePatch(id) {
  const g = GARAGE.find((x) => x.id === id);
  return g ? { ...g.settings, garage: g.id } : {};
}

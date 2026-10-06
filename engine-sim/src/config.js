// Engine profiles, firing orders and drivetrain defaults.
// Pure data + builders: no DOM and no three.js, so Node tests can import it.

export const DRIVETRAIN_DEFAULTS = Object.freeze({
  gearRatios: [3.36, 2.07, 1.43, 1.0, 0.84], // gears 1–5
  reverseRatio: 3.28,
  finalDrive: 3.73,
  tireDiameter: 0.66, // metres (275/35 R19-ish), circumference ≈ 2.07 m
  vehicleMass: 1500, // kg
  dragArea: 0.62, // Cd · frontal area, m²
  rollingCoeff: 0.012,
  drivelineEfficiency: 0.9,
  tractionLimit: 16000, // N at the driven axle before the tyres spin (sticky performance tyres)
  brakeForce: 13000, // N at full brake
});

export const GEAR_RATIO_PRESETS = Object.freeze({
  standard: { label: 'Road', gearRatios: [3.36, 2.07, 1.43, 1.0, 0.84], reverseRatio: 3.28, finalDrive: 3.73 },
  close: { label: 'Close-ratio', gearRatios: [2.97, 2.07, 1.6, 1.29, 1.08], reverseRatio: 3.28, finalDrive: 3.91 },
  long: { label: 'Long cruiser', gearRatios: [3.01, 1.78, 1.21, 0.91, 0.72], reverseRatio: 3.17, finalDrive: 3.42 },
});

// Torque curve shapes: [rpm / redline, fraction of peak torque].
const CURVES = {
  muscle: [[0, 0.5], [0.1, 0.62], [0.25, 0.8], [0.45, 0.95], [0.62, 1], [0.78, 0.95], [0.92, 0.85], [1, 0.77], [1.15, 0.55]],
  peaky: [[0, 0.38], [0.1, 0.48], [0.3, 0.68], [0.5, 0.85], [0.7, 0.97], [0.8, 1], [0.92, 0.95], [1, 0.88], [1.15, 0.62]],
  compact: [[0, 0.45], [0.12, 0.6], [0.3, 0.8], [0.55, 0.97], [0.66, 1], [0.82, 0.93], [1, 0.8], [1.15, 0.58]],
  rotary: [[0, 0.4], [0.15, 0.55], [0.35, 0.78], [0.55, 0.92], [0.75, 1], [0.9, 0.97], [1, 0.9], [1.15, 0.66]],
};

// Inline engines: every cylinder sits upright on its own crank throw.
const INLINE = {
  3: { firingOrder: [1, 2, 3], curve: 'compact', redline: 6800, perCylL: 0.5 },
  4: { firingOrder: [1, 3, 4, 2], curve: 'compact', redline: 7200, perCylL: 0.5 },
  5: { firingOrder: [1, 2, 4, 5, 3], curve: 'compact', redline: 7000, perCylL: 0.5 },
  6: { firingOrder: [1, 5, 3, 6, 2, 4], curve: 'muscle', redline: 7200, perCylL: 0.5 },
};

// V engines. `bankA` holds the cylinder numbers of the first bank, listed
// front to back; `bankB` the second bank. Cylinders at the same list index
// share one crank throw, with the bank-A rod in front.
const V = {
  6: {
    name: 'V6', vAngle: 60, firingOrder: [1, 2, 3, 4, 5, 6],
    bankA: [1, 3, 5], bankB: [2, 4, 6], crankNote: '60° split-pin crank',
    curve: 'muscle', redline: 6800, perCylL: 0.6,
  },
  'v8-cross': {
    name: 'V8 Crossplane', vAngle: 90, firingOrder: [1, 8, 4, 3, 6, 5, 7, 2],
    // GM numbering: odd cylinders on one bank, even on the other. The odd bank
    // sits on the +X side so that each pair (1/2, 3/4 …) shares a crank pin.
    bankA: [1, 3, 5, 7], bankB: [2, 4, 6, 8], aSide: 1, crankNote: 'Crossplane crank',
    curve: 'muscle', redline: 7000, perCylL: 0.625,
  },
  'v8-flat': {
    name: 'V8 Flatplane', vAngle: 90, firingOrder: [1, 8, 3, 6, 4, 5, 2, 7],
    // Ferrari/Ford numbering: 1–4 on one bank, 5–8 on the other.
    bankA: [1, 2, 3, 4], bankB: [5, 6, 7, 8], crankNote: 'Flat-plane crank',
    curve: 'peaky', redline: 8500, perCylL: 0.65,
  },
  10: {
    name: 'V10', vAngle: 72, firingOrder: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9],
    bankA: [1, 2, 3, 4, 5], bankB: [6, 7, 8, 9, 10], crankNote: '72° even-fire crank',
    curve: 'peaky', redline: 8700, perCylL: 0.52,
  },
  12: {
    name: 'V12', vAngle: 60, firingOrder: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10],
    bankA: [1, 2, 3, 4, 5, 6], bankB: [7, 8, 9, 10, 11, 12], crankNote: '120° crank',
    curve: 'peaky', redline: 8500, perCylL: 0.5,
  },
};

const ROTARY = {
  1: { name: 'Single-rotor Wankel', perRotorL: 0.654 },
  2: { name: '2-Rotor Wankel', perRotorL: 0.654 },
  3: { name: '3-Rotor Wankel', perRotorL: 0.654 },
};

// The five headline presets, plus the cylinder counts each one can switch to.
export const PRESETS = Object.freeze({
  'v8-cross': { label: 'V8 Crossplane', family: 'v', variant: 'v8-cross', counts: [6, 8, 10, 12] },
  'v8-flat': { label: 'V8 Flatplane', family: 'v', variant: 'v8-flat', counts: [6, 8, 10, 12] },
  i4: { label: 'Inline-4', family: 'inline', count: 4, counts: [3, 4, 5, 6] },
  v6: { label: 'V6', family: 'v', variant: 6, counts: [6, 8, 10, 12] },
  rotary: { label: 'Rotary', family: 'rotary', count: 2, counts: [1, 2, 3] },
});

export const PRESET_ORDER = ['v8-cross', 'v8-flat', 'i4', 'v6', 'rotary'];

// Every persisted setting. See docs/CONTRACT.md for who reads each field.
export const DEFAULT_SETTINGS = Object.freeze({
  // Engine
  preset: 'v8-cross',
  cylinders: 8,
  idleRpm: 800,
  redlineRpm: null, // null → the layout's own default
  boreStroke: 1.0,
  displacementL: null, // null → the layout's own default
  vvlRpm: null, // variable valve lift switchover rpm; null → no cam switching
  garage: null, // id of the garage preset last loaded, or null
  // Forced induction
  induction: 'na', // 'na' | 'turbo' | 'twin-turbo' | 'supercharger'
  boostBar: 0.8, // target boost, bar (gauge)
  // Transmission
  mode: 'manual', // 'manual' (H-pattern) | 'sequential' | 'auto'
  autoBlip: false, // rev-match downshifts automatically (manual/sequential)
  launchControl: false, // two-step limiter while stationary with the clutch in
  launchRpm: 4500,
  tractionControl: false,
  // Display
  visualSpeed: 1 / 25,
  strokeGases: true, // tint each cylinder by stroke (intake/compression/power/exhaust)
  valvetrain: true, // show cams and valves
  xray: false,
  cutaway: false,
  quality: 'auto', // 'auto' | 'high' | 'low'
  cluster: 'digital', // 'digital' | 'analog'
  units: 'kmh', // 'kmh' | 'mph'
  ...DRIVETRAIN_DEFAULTS,
});

const mod = (a, n) => ((a % n) + n) % n;

// Resolve which layout a preset + cylinder count means.
function resolveLayout(preset, cylinders) {
  const p = PRESETS[preset] ?? PRESETS['v8-cross'];
  if (p.family === 'inline') {
    const n = INLINE[cylinders] ? cylinders : p.count;
    return { family: 'inline', key: n, count: n };
  }
  if (p.family === 'rotary') {
    const n = ROTARY[cylinders] ? cylinders : p.count;
    return { family: 'rotary', key: n, count: n };
  }
  let key = cylinders === 8 ? (p.variant === 'v8-flat' ? 'v8-flat' : 'v8-cross') : cylinders;
  if (!V[key]) key = p.variant;
  const count = key === 'v8-cross' || key === 'v8-flat' ? 8 : key;
  return { family: 'v', key, count };
}

// Build the full engine profile the simulator, renderer and audio consume.
export function buildProfile(settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const layout = resolveLayout(s.preset, s.cylinders);
  const boreStroke = Math.min(1.5, Math.max(0.65, s.boreStroke));

  let profile;
  if (layout.family === 'rotary') {
    const r = ROTARY[layout.count];
    const rotors = layout.count;
    profile = {
      id: `rotary-${rotors}`,
      kind: 'rotary',
      name: r.name,
      shortName: `${rotors}-Rotor`,
      layoutNote: 'Eccentric shaft · rotor turns at ⅓ shaft speed',
      firingOrder: Array.from({ length: rotors }, (_, i) => i + 1),
      rotors,
      // One combustion event per rotor per shaft revolution, rotors evenly phased.
      rotorPhases: Array.from({ length: rotors }, (_, i) => (i * 360) / rotors),
      displacementL: r.perRotorL * rotors,
      peakTorqueNm: 165 * r.perRotorL * rotors,
      curve: CURVES.rotary,
      defaultRedline: 9000,
      cylinders: [],
      pulsesPerRev: rotors,
      exhaust: { banks: [Array.from({ length: rotors }, (_, i) => i)], pulseWidth: 26, roughness: 0.05, drive: 2.6 },
    };
  } else {
    const isV = layout.family === 'v';
    const def = isV ? V[layout.key] : INLINE[layout.key];
    const n = layout.count;
    const firingOrder = def.firingOrder;
    const interval = 720 / n;
    const cylinders = [];
    if (isV) {
      const half = (def.vAngle / 2) * (def.aSide ?? -1);
      def.bankA.forEach((num, t) => cylinders.push({ num, bank: 0, bankDeg: half, throwIndex: t, slot: 0 }));
      def.bankB.forEach((num, t) => cylinders.push({ num, bank: 1, bankDeg: -half, throwIndex: t, slot: 1 }));
    } else {
      for (let i = 1; i <= n; i++) cylinders.push({ num: i, bank: 0, bankDeg: 0, throwIndex: i - 1, slot: 0 });
    }
    cylinders.sort((a, b) => a.num - b.num);
    for (const c of cylinders) {
      // Crank angle (0–720°) at which this cylinder reaches firing TDC.
      c.fireDeg = firingOrder.indexOf(c.num) * interval;
      // Crank-pin angle in the crank's own frame. With the crank at angle θ the
      // pin sits at (pinDeg + θ) from vertical, so TDC happens when that equals
      // the bank angle: θ = fireDeg (mod 360).
      c.pinDeg = mod(c.bankDeg - c.fireDeg, 360);
    }
    const name = isV ? def.name : `Inline-${n}`;
    const per = def.perCylL;
    profile = {
      id: isV ? `v-${layout.key}` : `inline-${n}`,
      kind: 'piston',
      name,
      shortName: isV ? def.name.replace(' Crossplane', ' Cross').replace(' Flatplane', ' Flat') : `I${n}`,
      layoutNote: isV ? `${def.vAngle}° V · ${def.crankNote}` : 'Inline · single bank',
      firingOrder,
      vAngle: isV ? def.vAngle : 0,
      banks: isV ? 2 : 1,
      cylinders,
      displacementL: per * n,
      peakTorqueNm: 106 * per * n,
      curve: CURVES[def.curve],
      defaultRedline: def.redline,
      pulsesPerRev: n / 2,
      exhaust: {
        banks: isV ? [0, 1].map((b) => cylinders.filter((c) => c.bank === b).map((c) => cylinders.indexOf(c))) : [cylinders.map((_, i) => i)],
        pulseWidth: def.curve === 'peaky' ? 34 : 46,
        roughness: layout.key === 'v8-cross' ? 0.14 : 0.07,
        drive: def.curve === 'peaky' ? 1.6 : 2.1,
      },
    };
  }

  const redlineRpm = Math.round(s.redlineRpm ?? profile.defaultRedline);
  const idleRpm = Math.round(Math.min(Math.max(s.idleRpm, 500), 1400));
  // Geometry from displacement per cylinder and bore/stroke ratio (mm).
  const unitCc = (profile.displacementL * 1000) / (profile.kind === 'rotary' ? profile.rotors : profile.cylinders.length);
  const strokeMm = Math.cbrt((4 * unitCc * 1000) / (Math.PI * boreStroke * boreStroke));
  const boreMm = strokeMm * boreStroke;
  return {
    ...profile,
    // Crank, flywheel and clutch inertia (kg·m²) grow with engine size.
    inertia: 0.03 + 0.04 * profile.displacementL,
    idleRpm,
    redlineRpm,
    boreStroke,
    boreMm,
    strokeMm,
    rodRatio: 1.7,
    // Oversquare engines breathe higher in the rev range, undersquare ones pull lower.
    curveShift: Math.pow(boreStroke, -0.3),
    upshiftRpm: Math.max(idleRpm + 1500, redlineRpm - 800),
    downshiftRpm: Math.max(2000, idleRpm * 2),
    stallRpm: Math.round(idleRpm * 0.45),
  };
}

// Peak-normalised wide-open-throttle torque at a given rpm (0..1).
export function torqueFraction(profile, rpm) {
  const u = (rpm / profile.redlineRpm) * profile.curveShift;
  const pts = profile.curve;
  if (u <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (u <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const t = (u - x0) / (x1 - x0);
      const k = t * t * (3 - 2 * t); // smoothstep between control points
      return y0 + (y1 - y0) * k;
    }
  }
  return pts[pts.length - 1][1];
}

export function wotTorque(profile, rpm) {
  return profile.peakTorqueNm * torqueFraction(profile, rpm);
}

// Metric horsepower from torque (Nm) and rpm.
export const powerHp = (torqueNm, rpm) => (torqueNm * rpm) / 7023.5;
export const powerKw = (torqueNm, rpm) => (torqueNm * rpm) / 9549.3;

export function firingOrderLabel(profile) {
  return profile.kind === 'rotary'
    ? `${profile.rotors} rotor${profile.rotors > 1 ? 's' : ''} · ${profile.rotors} pulse${profile.rotors > 1 ? 's' : ''}/rev`
    : profile.firingOrder.join('-');
}

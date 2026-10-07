// Layout-generic placement rules for the 3D model: which layout a profile is,
// how its banks are framed, where each cylinder sits along the crank, which
// side of a head breathes in or out, exploded-view offsets and the timing
// chain path. Pure maths: no three.js, no DOM.

const DEG = Math.PI / 180;

/**
 * Layout family of a profile: 'inline' | 'v' | 'boxer' | 'vtwin' | 'rotary'.
 * Uses profile.layout when present, otherwise derives it from the cylinders.
 */
export function layoutOf(profile) {
  if (profile.layout) return profile.layout;
  if (profile.kind === 'rotary') return 'rotary';
  const cyls = profile.cylinders ?? [];
  const banks = new Set(cyls.map((c) => c.bank ?? 0)).size;
  if (banks < 2 && (profile.banks ?? 1) < 2) return 'inline';
  if (cyls.length && cyls.every((c) => Math.abs(Math.abs(c.bankDeg) - 90) < 1)) return 'boxer';
  if (cyls.length === 2) return 'vtwin';
  return 'v';
}

/** Cylinders grouped by bank: [{bank, bankDeg, members: [cylinder index …]}], ordered by bank. */
export function bankList(profile) {
  const map = new Map();
  profile.cylinders.forEach((c, i) => {
    const b = c.bank ?? 0;
    if (!map.has(b)) map.set(b, { bank: b, bankDeg: c.bankDeg ?? 0, members: [] });
    map.get(b).members.push(i);
  });
  return [...map.values()].sort((a, b) => a.bank - b.bank);
}

/**
 * Exhaust side of a head in its bank frame (+1 = bank-local +X). Exhausts
 * leave on the outside of a V and underneath a boxer, so the intake side
 * (the opposite one) faces the valley or the top.
 */
export const exhaustSide = (bankDeg) => (bankDeg < -0.5 ? -1 : 1);

/**
 * Bank frame → engine frame. The bank frame has the cylinder axis on +Y and
 * the crank on Z; the engine frame leans it by bankDeg towards +X.
 */
export function bankToEngine(bankDeg, x, y, out) {
  const b = bankDeg * DEG;
  const c = Math.cos(b);
  const s = Math.sin(b);
  out[0] = x * c + y * s;
  out[1] = -x * s + y * c;
  return out;
}

/**
 * Where each cylinder sits along the crank (Z, front = +Z).
 * Rods that share a throw sit side by side; cylinders on their own throw are
 * spaced so neighbours in one bank clear each other (a boxer's banks
 * interleave, so its throws can sit closer together).
 * Returns {pitch, z: [per cylinder], half (half block length), throws}.
 */
export function cylinderPlacement(profile, B, rodW) {
  const cyls = profile.cylinders;
  const throws = Math.max(...cyls.map((c) => c.throwIndex)) + 1;
  const perThrow = new Array(throws).fill(0);
  for (const c of cyls) perThrow[c.throwIndex]++;
  const shared = perThrow.some((n) => n > 1);
  let pitch;
  if (shared) pitch = B * 1.18 + rodW * 0.4;
  else {
    // Smallest throw gap between two cylinders of the same bank.
    let gap = Infinity;
    for (const bank of bankList(profile)) {
      const t = bank.members.map((i) => cyls[i].throwIndex).sort((a, b) => a - b);
      for (let k = 1; k < t.length; k++) gap = Math.min(gap, t[k] - t[k - 1]);
    }
    if (!Number.isFinite(gap)) gap = 1;
    pitch = Math.max(B * 0.62, (B * 1.2) / gap);
  }
  const z = cyls.map((c) => {
    const base = ((throws - 1) / 2 - c.throwIndex) * pitch;
    return shared && perThrow[c.throwIndex] > 1 ? base + (c.slot === 0 ? 1 : -1) * rodW * 0.55 : base;
  });
  const half = Math.max(...z.map(Math.abs)) + B * 0.75;
  return { pitch, z, half, throws };
}

/**
 * Head dimensions shared by the head casting, the valvetrain and the ports
 * (bank frame: cylinder axis +Y, deck = top of the bore).
 */
export function headDims(B, deck) {
  const tilt = 16 * DEG;
  const valveX = 0.21 * B;
  const stemLen = 0.75 * B;
  const bucketH = 0.1 * B;
  const baseR = 0.13 * B;
  const lift = 0.1 * B;
  const reach = stemLen + bucketH + baseR; // valve seat → cam centre along the valve axis
  const camX = valveX + reach * Math.sin(tilt);
  const camY = deck + reach * Math.cos(tilt);
  return {
    deck, tilt, valveX, valveZ: 0.2 * B, stemLen, bucketH, bucketR: 0.13 * B, baseR, lift,
    springSeat: 0.3 * B, springR: 0.105 * B, camX, camY,
    lowerH: 0.45 * B,
    top: camY + baseR + lift + 0.09 * B, // inside of the cam cover
    width: 2 * (camX + baseR + lift + 0.06 * B),
    sprocketR: 0.4 * B,
    crankSprocketR: 0.2 * B,
    portY: deck + 0.24 * B,
    portX: camX + baseR + lift + 0.06 * B, // on the side wall of the head
  };
}

// Exploded-view travel at t = 1, in bore diameters.
export const EXPLODE = Object.freeze({
  head: 1.7, // heads, cams and valves, along the bank axis
  sleeve: 0.75, // cylinder liners, along the bank axis
  exhaust: 1.0, // headers: with the head, plus this much outwards
  intake: 2.4, // plenum, blower or turbos: straight up
  sump: 1.5, // down
  front: 1.3, // timing drive: forwards
  bell: 1.2, // clutch housing: backwards
  clutch: 0.7,
  flywheel: 0.35,
  gearbox: 2.2,
});

/** Engine-frame offset [x, y, z] of an exploded part at explode level t (0..1). */
export function explodeOffset(part, bankDeg, t, B, out) {
  const d = (EXPLODE[part] ?? 0) * B * t;
  const ax = Math.sin(bankDeg * DEG);
  const ay = Math.cos(bankDeg * DEG);
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  if (part === 'head' || part === 'sleeve') {
    out[0] = ax * d;
    out[1] = ay * d;
  } else if (part === 'exhaust') {
    const h = EXPLODE.head * B * t;
    out[0] = ax * h + (Math.abs(ax) > 0.05 ? Math.sign(ax) : 1) * d;
    out[1] = ay * h - (Math.abs(ax) > 0.95 ? d : 0);
  } else if (part === 'intake') out[1] = d;
  else if (part === 'sump') out[1] = -d;
  else if (part === 'front') out[2] = d;
  else out[2] = -d; // bell, clutch, flywheel, gearbox move back
  return out;
}

// ── Timing chain ────────────────────────────────────────────────────────────

/**
 * Closed path of a chain wrapped around sprockets: the convex hull of the
 * circles, counter-clockwise. circles: [{x, y, r}]. Returns
 * {x: Float64Array, y: Float64Array, cum: Float64Array (arc length at each
 * vertex, cum[n] = total), n, total}.
 */
export function chainPath(circles, samplesPerCircle = 48) {
  const pts = [];
  for (const c of circles) {
    for (let i = 0; i < samplesPerCircle; i++) {
      const a = (i / samplesPerCircle) * Math.PI * 2;
      pts.push([c.x + c.r * Math.cos(a), c.y + c.r * Math.sin(a)]);
    }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const n = hull.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    x[i] = hull[i][0];
    y[i] = hull[i][1];
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(x[j] - x[i], y[j] - y[i]);
  }
  return { x, y, cum, n, total: cum[n] };
}

/** Point and direction at arc length s along a chainPath; out = [x, y, angle]. */
export function pointOnPath(path, s, out) {
  const { x, y, cum, n, total } = path;
  const d = ((s % total) + total) % total;
  // Binary search for the segment holding d.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  const j = (lo + 1) % n;
  const len = cum[lo + 1] - cum[lo] || 1;
  const f = (d - cum[lo]) / len;
  out[0] = x[lo] + (x[j] - x[lo]) * f;
  out[1] = y[lo] + (y[j] - y[lo]) * f;
  out[2] = Math.atan2(y[j] - y[lo], x[j] - x[lo]);
  return out;
}

// Geometry builders for the engine model. Everything here is built once per
// profile; nothing allocates per frame.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lobeLift, wrapSigned } from './timing.js';

export const Z_AXIS = new THREE.Vector3(0, 0, 1);

// Write a Z-rotation + Y-scale + translation straight into a Matrix4 (no allocation).
export function setRotZ(m, angle, sy, x, y, z) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const e = m.elements;
  e[0] = c; e[1] = s; e[2] = 0; e[3] = 0;
  e[4] = -s * sy; e[5] = c * sy; e[6] = 0; e[7] = 0;
  e[8] = 0; e[9] = 0; e[10] = 1; e[11] = 0;
  e[12] = x; e[13] = y; e[14] = z; e[15] = 1;
  return m;
}

export const cylAlongZ = (radius, length, segs = 28) => {
  const g = new THREE.CylinderGeometry(radius, radius, length, segs);
  g.rotateX(Math.PI / 2);
  return g;
};

/** Merge geometries into one, normalising them to non-indexed position/normal/uv. */
export function merge(geos) {
  const list = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') n.deleteAttribute(name);
    }
    if (!n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((n.attributes.position.count) * 2), 2));
    if (!n.attributes.normal) n.computeVertexNormals();
    return n;
  });
  const out = mergeGeometries(list, false);
  for (const g of geos) g.dispose();
  for (const g of list) g.dispose();
  return out;
}

/** A geometry moved/rotated by a matrix built from position + Euler (returns the same geometry). */
export function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  geo.translate(x, y, z);
  return geo;
}

export function withEdges(mesh, material, threshold = 25) {
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, threshold), material);
  lines.userData.edges = true;
  mesh.add(lines);
  return mesh;
}

export function gearGeometry(radius, width, toothDepth = 0.06, teethOverride = 0) {
  const teeth = teethOverride || Math.max(10, Math.round(radius * 34));
  const shape = new THREE.Shape();
  const rr = radius - toothDepth;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const pts = [
      [rr, a],
      [radius, a + step * 0.18],
      [radius, a + step * 0.48],
      [rr, a + step * 0.66],
    ];
    pts.forEach(([r, ang], k) => {
      const x = r * Math.cos(ang);
      const y = r * Math.sin(ang);
      if (i === 0 && k === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, Math.min(0.09, radius * 0.4), 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -width / 2);
  return g;
}

// Crank web: a strap from the main journal to the pin (+Y) with a counterweight below.
export function crankWebGeometry(r, halfWidth, cwRadius, thickness) {
  const s = new THREE.Shape();
  const a0 = (200 * Math.PI) / 180;
  const a1 = (340 * Math.PI) / 180;
  s.moveTo(-halfWidth, r);
  s.lineTo(-halfWidth, 0);
  s.lineTo(cwRadius * Math.cos(a0), cwRadius * Math.sin(a0));
  s.absarc(0, 0, cwRadius, a0, a1, false);
  s.lineTo(halfWidth, 0);
  s.lineTo(halfWidth, r);
  s.absarc(0, r, halfWidth, 0, Math.PI, false);
  const g = new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 1, curveSegments: 10 });
  g.translate(0, 0, -thickness / 2);
  return g;
}

/** Rounded box (XY rounded corners, extruded along Z), centred. */
export function roundedBox(w, h, d, radius, segs = 4) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  const r = Math.min(radius, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: segs });
  g.translate(0, 0, -d / 2);
  return g;
}

/** Poppet valve standing on its face at the origin, stem along +Y. */
export function valveGeometry(headR, stemR, length) {
  const pts = [
    [0, 0], [headR, 0], [headR, 0.018 * length], [headR * 0.55, 0.09 * length],
    [stemR * 1.6, 0.2 * length], [stemR, 0.28 * length], [stemR, length], [0, length],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 16);
}

/** Valve spring: a helix of wire from y = 0 to y = 1 (scale Y to compress it). */
export function springGeometry(radius, wire, turns = 6) {
  class Helix extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      const a = t * turns * Math.PI * 2;
      return target.set(radius * Math.cos(a), t, radius * Math.sin(a));
    }
  }
  return new THREE.TubeGeometry(new Helix(), turns * 10, wire, 5, false);
}

/**
 * Camshaft along Z with one lobe per valve plus a sprocket at the front.
 * lobes: [{z, angleDeg}] — angleDeg is where the nose points in the cam's own
 * frame (see timing.camLobeAngle). The lobe radius follows the same lift curve
 * as the valve, so the cam and the valve it drives always agree.
 */
export function camshaftGeometry({ lobes, baseR, lift, width, durationDeg, zFront, zBack, sprocketR, sprocketTeeth }) {
  const geos = [];
  const shaft = cylAlongZ(baseR * 0.62, zFront - zBack, 14);
  shaft.translate(0, 0, (zFront + zBack) / 2);
  geos.push(shaft);
  const samples = 64;
  for (const lobe of lobes) {
    const s = new THREE.Shape();
    for (let i = 0; i <= samples; i++) {
      const a = (i / samples) * 360;
      const off = wrapSigned(a - lobe.angleDeg);
      const r = baseR + lift * lobeLift(off, durationDeg);
      const x = r * Math.cos((a * Math.PI) / 180);
      const y = r * Math.sin((a * Math.PI) / 180);
      if (i === 0) s.moveTo(x, y);
      else s.lineTo(x, y);
    }
    const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, lobe.z - width / 2);
    geos.push(g);
  }
  const sprocket = gearGeometry(sprocketR, width * 0.8, sprocketR * 0.12, sprocketTeeth);
  sprocket.translate(0, 0, zFront);
  geos.push(sprocket);
  // A web of spokes so the sprocket's rotation reads.
  for (let k = 0; k < 4; k++) {
    const spoke = new THREE.BoxGeometry(sprocketR * 1.6, sprocketR * 0.12, width * 0.9);
    spoke.rotateZ((k * Math.PI) / 4);
    spoke.translate(0, 0, zFront);
    geos.push(spoke);
  }
  return merge(geos);
}

/** Three-lobe Roots rotor, extruded along Z and twisted by `twist` radians over its length. */
export function rootsRotorGeometry(radius, length, twist) {
  const s = new THREE.Shape();
  const n = 96;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = radius * (0.62 + 0.38 * Math.abs(Math.cos(1.5 * a)) ** 0.8);
    const x = r * Math.cos(a);
    const y = r * Math.sin(a);
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false, steps: 12, curveSegments: 1 });
  g.translate(0, 0, -length / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const a = (p.getZ(i) / length) * twist;
    const x = p.getX(i);
    const y = p.getY(i);
    p.setXY(i, x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a));
  }
  g.computeVertexNormals();
  return g;
}

/** Compressor/turbine wheel: hub plus curved blades, axis along Z, facing +Z. */
export function wheelGeometry(radius, depth, blades = 11) {
  const geos = [];
  const hub = new THREE.CylinderGeometry(radius * 0.22, radius * 0.42, depth, 16);
  hub.rotateX(Math.PI / 2);
  geos.push(hub);
  for (let i = 0; i < blades; i++) {
    const blade = new THREE.BoxGeometry(radius * 0.62, depth * 0.85, radius * 0.05);
    blade.translate(radius * 0.5, 0, 0);
    blade.rotateX(Math.PI / 2);
    // Sweep each blade a little so the wheel reads as a turbine, not a fan.
    blade.rotateY(0.35);
    blade.rotateZ((i / blades) * Math.PI * 2);
    geos.push(blade);
  }
  return merge(geos);
}

/** Flat ribbon (a belt) following a closed polyline in the XY plane, width along Z. */
export function ribbonGeometry(path, width, thickness) {
  const { x, y, n } = path;
  const pos = [];
  const nor = [];
  const push = (px, py, pz, nx, ny, nz) => {
    pos.push(px, py, pz);
    nor.push(nx, ny, nz);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = x[j] - x[i];
    const dy = y[j] - y[i];
    const len = Math.hypot(dx, dy) || 1;
    // Outward normal of a counter-clockwise loop.
    const nx = dy / len;
    const ny = -dx / len;
    for (const [ox, oy] of [[0, 0], [-nx * thickness, -ny * thickness]]) {
      const ax = x[i] + ox;
      const ay = y[i] + oy;
      const bx = x[j] + ox;
      const by = y[j] + oy;
      const sgn = ox === 0 ? 1 : -1;
      push(ax, ay, -width / 2, nx * sgn, ny * sgn, 0);
      push(bx, by, -width / 2, nx * sgn, ny * sgn, 0);
      push(bx, by, width / 2, nx * sgn, ny * sgn, 0);
      push(ax, ay, -width / 2, nx * sgn, ny * sgn, 0);
      push(bx, by, width / 2, nx * sgn, ny * sgn, 0);
      push(ax, ay, width / 2, nx * sgn, ny * sgn, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Tube through points (engine frame), as a merged-friendly geometry. */
export function pipeGeometry(points, radius, segments = 40, radial = 10) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]))), false, 'centripetal');
  return new THREE.TubeGeometry(curve, segments, radius, radial, false);
}

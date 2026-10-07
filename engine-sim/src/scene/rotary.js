// Wankel core: epitrochoid housings, rotors on the eccentric shaft, plugs,
// combustion glow and port markers (rotaries have ports instead of valves).

import * as THREE from 'three';
import { DEG, epitrochoid } from '../kinematics.js';
import { cylAlongZ, gearGeometry, merge, withEdges, setRotZ } from './geometry.js';
import { explodeOffset } from './layout.js';

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Build the rotary core into view.engine and fill view.geom / view.rotors / view.ports. */
export function buildRotary(view, p) {
  const M = view.M;
  const R = 1.05;
  const e = 0.15;
  const W = 0.8;
  const gap = 0.16;
  const n = p.rotors;
  const total = n * W + (n + 1) * gap;
  const half = total / 2;
  const B = 0.9;
  const pulleyZ = half + 0.42;
  view.geom = { R, e, W, front: half, back: -half, B, pulleyZ, pulleyR: 0.4, chainZ: half };

  // Rotate the core so the bore's long axis stands vertical, plugs on −X and ports on +X.
  const core = new THREE.Group();
  core.rotation.z = -Math.PI / 2;
  view.engine.add(core);

  const bore = [];
  const outer = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const [x, y] = epitrochoid(t, R, e);
    bore.push(new THREE.Vector2(x, y));
    const [ox, oy] = epitrochoid(t, R + 0.32, e * 0.6);
    outer.push(new THREE.Vector2(ox, oy));
  }
  const housingShape = new THREE.Shape(outer);
  housingShape.holes.push(new THREE.Path(bore.slice().reverse()));
  const housingGeo = new THREE.ExtrudeGeometry(housingShape, { depth: W, bevelEnabled: false });
  housingGeo.translate(0, 0, -W / 2);
  const plateGeo = new THREE.ExtrudeGeometry(new THREE.Shape(outer), { depth: gap, bevelEnabled: false });
  plateGeo.translate(0, 0, -gap / 2);

  // Rotor: three apexes joined by convex flanks.
  const rotorShape = new THREE.Shape();
  const apex = (k) => [R * 0.985 * Math.cos((k * 2 * Math.PI) / 3), R * 0.985 * Math.sin((k * 2 * Math.PI) / 3)];
  const [x0, y0] = apex(0);
  rotorShape.moveTo(x0, y0);
  for (let k = 0; k < 3; k++) {
    const [x1, y1] = apex(k + 1);
    const mid = ((k + 0.5) * 2 * Math.PI) / 3;
    rotorShape.quadraticCurveTo(0.8 * R * Math.cos(mid), 0.8 * R * Math.sin(mid), x1, y1);
  }
  const ringHole = new THREE.Path();
  ringHole.absarc(0, 0, 0.36, 0, Math.PI * 2, true);
  rotorShape.holes.push(ringHole);
  const rotorGeo = new THREE.ExtrudeGeometry(rotorShape, { depth: W * 0.94, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2, curveSegments: 18 });
  rotorGeo.translate(0, 0, -W * 0.47);
  const internalGear = gearGeometry(0.36, W * 0.5, 0.04);
  internalGear.translate(0, 0, W * 0.2);
  const statGear = gearGeometry(0.24, W * 0.55, 0.04);

  const shaft = new THREE.Group();
  view.crank = shaft;
  view.engine.add(shaft);
  shaft.add(view.addMetal(new THREE.Mesh(cylAlongZ(0.12, pulleyZ + half + 0.3, 24).translate(0, 0, (pulleyZ - half - 0.3) / 2), M.steel)));
  const pulley = merge([cylAlongZ(view.geom.pulleyR, 0.12, 40), new THREE.BoxGeometry(0.06, 0.6, 0.13)]);
  pulley.translate(0, 0, pulleyZ);
  shaft.add(view.addMetal(new THREE.Mesh(pulley, M.darkSteel)));
  const lobeGeo = cylAlongZ(0.2, W * 0.9, 28);
  const glowGeo = new THREE.SphereGeometry(0.34, 18, 12);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  view.glows = view.instanced(glowGeo, glowMat, n, core);
  view.glows.userData.ownMaterial = true;
  view.glows.renderOrder = 3;
  const portGeo = cylAlongZ(0.11, W * 0.62, 12);
  const portMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  view.portMarks = view.instanced(portGeo, portMat, n * 2, core, false);
  view.portMarks.userData.ownMaterial = true;
  view.portMarks.frustumCulled = false;
  view.portMarks.renderOrder = 3;
  const plugGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.4, 10);
  const plugs = view.instanced(plugGeo, M.ceramic, n * 2, core, false);
  // Port positions on the bore (core frame): exhaust leads, intake trails.
  const portAt = (deg, rad) => epitrochoid(deg * DEG, R + rad, e * (rad > 0 ? 0.6 : 1));
  const PORTS = [[60, 1], [120, 0]]; // [bore angle, 0 intake | 1 exhaust]
  // Plugs and port markers of rotor i at stack position z (core frame).
  const poseStatics = (i, z) => {
    for (const [k, dx] of [[0, -0.32], [1, 0.32]]) {
      setRotZ(view.m4, 0, 1, dx, -(R - e) - 0.42, z);
      plugs.setMatrixAt(i * 2 + k, view.m4);
    }
    for (const [deg, kind] of PORTS) {
      const [bx, by] = portAt(deg, 0);
      setRotZ(view.m4, 0, 1, bx * 1.04, by * 1.04, z);
      view.portMarks.setMatrixAt(i * 2 + kind, view.m4);
    }
  };

  view.rotors = [];
  const exPorts = [];
  const inPorts = [];
  for (let i = 0; i < n; i++) {
    const z = half - gap - W / 2 - i * (W + gap);
    const housing = new THREE.Mesh(housingGeo, M.glass);
    housing.position.z = z;
    core.add(withEdges(housing, M.edge, 40));
    // The shaft turns +θ for rotaries, so the lobe that carries rotor i sits at
    // a fixed offset: the rotor centre e·(cos a, sin a) in the core frame,
    // turned −90° into the engine frame and back by −θ into the shaft frame.
    const lobe = new THREE.Mesh(lobeGeo, M.chrome);
    const phase = p.rotorPhases[i] * DEG;
    lobe.position.set(e * Math.sin(phase), -e * Math.cos(phase), z);
    shaft.add(view.addMetal(lobe));
    const stat = new THREE.Mesh(statGear, M.darkSteel);
    stat.position.z = z + W * 0.2;
    core.add(stat);

    const rotor = new THREE.Group();
    rotor.add(view.addMetal(new THREE.Mesh(rotorGeo, M.chrome)));
    rotor.add(view.addMetal(new THREE.Mesh(internalGear, M.friction)));
    rotor.position.z = z;
    core.add(rotor);
    view.glows.setColorAt(i, view.color.setRGB(0, 0, 0));
    poseStatics(i, z);
    PORTS.forEach(([deg, kind]) => {
      view.portMarks.setColorAt(i * 2 + kind, view.color.setRGB(0, 0, 0));
      // Outer housing point, turned into the engine frame (x, y) → (y, −x).
      const [ox, oy] = portAt(deg, 0.32);
      const p3 = v3(oy, -ox, z);
      const d = v3(oy, -ox, 0).normalize();
      if (kind === 1) exPorts.push(p3);
      else inPorts.push({ p: p3, d });
    });
    // zNow: where the rotor sits now, with the exploded view's stack offset.
    view.rotors.push({ rotor, housing, stat, phase: p.rotorPhases[i], z, zNow: z, label: v3() });
  }
  const plates = [];
  for (let i = 0; i <= n; i++) {
    const plate = new THREE.Mesh(plateGeo, M.glassDark);
    plate.position.z = half - gap / 2 - i * (W + gap);
    core.add(withEdges(plate, M.edge, 40));
    plates.push({ plate, z: plate.position.z });
  }
  // Exploded view: housings (with their rotors) and side plates fan out
  // forwards along the shaft from the rear plate, which stays against the
  // clutch; the eccentric shaft stays put.
  const pitch = W + gap;
  const rear = plates[n].z;
  const off = [0, 0, 0];
  view.explodeCore = (t) => {
    const step = explodeOffset('stack', 0, t, view.geom.B, off)[2] / pitch;
    const at = (z) => z + (z - rear) * step;
    view.rotors.forEach((k, i) => {
      k.zNow = at(k.z);
      k.rotor.position.z = k.zNow;
      k.housing.position.z = k.zNow;
      k.stat.position.z = k.zNow + W * 0.2;
      poseStatics(i, k.zNow);
    });
    for (const q of plates) q.plate.position.z = at(q.z);
    plugs.instanceMatrix.needsUpdate = true;
    view.portMarks.instanceMatrix.needsUpdate = true;
  };
  core.updateMatrix();
  view.core = core;
  view.geom.lowY = -(R + 0.45);
  view.geom.caseTop = R + 0.45;
  view.geom.breachNormal = v3(1, 0, 0);
  view.geom.breachAt = v3(1.3, 0, 0);
  const out = exPorts.reduce((a, q) => a.add(v3(q.x, q.y, 0)), v3()).normalize();
  view.ports = { exGroups: [{ bankDeg: 0, out, members: exPorts.map((_, i) => i), ports: exPorts }], inPorts, twoBanks: false };
  view.pointsFor(n, 1.4);
}

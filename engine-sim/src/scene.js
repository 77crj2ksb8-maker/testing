// Three.js renderer: builds the engine assembly for a profile and poses every
// moving part from the crank angle each frame.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  DEG, cylinderPose, combustionFlash, degreesSinceFiring, epitrochoid, rotorPose, rotorDegreesSinceFiring,
} from './kinematics.js';

const Z_AXIS = new THREE.Vector3(0, 0, 1);

function makeMaterials() {
  const flashBase = new THREE.MeshBasicMaterial({
    color: 0xff5a14, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return {
    chrome: new THREE.MeshStandardMaterial({ color: 0xe9edf2, metalness: 1, roughness: 0.14 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xa3abb6, metalness: 0.95, roughness: 0.3 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: 0x40464f, metalness: 0.85, roughness: 0.42 }),
    rod: new THREE.MeshStandardMaterial({ color: 0xc6ccd4, metalness: 1, roughness: 0.22 }),
    ring: new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.6, roughness: 0.5 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x2a3a52, metalness: 0, roughness: 0.1, transparent: true, opacity: 0.16,
      depthWrite: false, side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: 0.08,
    }),
    glassDark: new THREE.MeshPhysicalMaterial({
      color: 0x18202c, metalness: 0.2, roughness: 0.25, transparent: true, opacity: 0.42,
      depthWrite: false, side: THREE.DoubleSide, clearcoat: 1,
    }),
    edge: new THREE.LineBasicMaterial({ color: 0xa9bedc, transparent: true, opacity: 0.3 }),
    friction: new THREE.MeshStandardMaterial({ color: 0xd9692a, metalness: 0.2, roughness: 0.75 }),
    gear: new THREE.MeshStandardMaterial({ color: 0x9aa3ae, metalness: 0.95, roughness: 0.3 }),
    gearLive: new THREE.MeshStandardMaterial({
      color: 0xffb070, emissive: 0xff6a10, emissiveIntensity: 0.55, metalness: 0.8, roughness: 0.3,
    }),
    timing: new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 0.4 }),
    plug: new THREE.MeshStandardMaterial({ color: 0xeef2f6, emissive: 0xffc070, emissiveIntensity: 0, roughness: 0.4 }),
    flashBase,
  };
}

const cylAlongZ = (radius, length, segs = 28) => {
  const g = new THREE.CylinderGeometry(radius, radius, length, segs);
  g.rotateX(Math.PI / 2);
  return g;
};

function withEdges(mesh, material, threshold = 25) {
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, threshold), material);
  mesh.add(lines);
  return mesh;
}

function gearGeometry(radius, width, toothDepth = 0.06) {
  const teeth = Math.max(10, Math.round(radius * 34));
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
function crankWebGeometry(r, halfWidth, cwRadius, thickness) {
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

function radialGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(70,96,140,0.55)');
  grad.addColorStop(0.5, 'rgba(40,56,84,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class EngineView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090b10);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 200);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.8;

    const hemi = new THREE.HemisphereLight(0xc8d8ff, 0x0b0d12, 0.55);
    const key = new THREE.DirectionalLight(0xfff1e0, 1.6);
    key.position.set(-4, 7, 6);
    const rim = new THREE.DirectionalLight(0x6f9bff, 1.1);
    rim.position.set(6, 3, -7);
    this.scene.add(hemi, key, rim);

    // A fixed pool of two point lights for combustion flashes (a constant light
    // count avoids shader recompiles when cylinders fire).
    this.flashLights = [0, 1].map(() => {
      const l = new THREE.PointLight(0xff8a3a, 0, 6, 1.6);
      this.scene.add(l);
      return l;
    });

    this.M = makeMaterials();
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: radialGlowTexture(), transparent: true, depthWrite: false }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor);

    this.root = null;
    this.insets = { top: 0, bottom: 0 };
    this.tmp = new THREE.Vector3();
    this.reactionAngle = 0;
    this.frameTimes = [];
  }

  // ── Building ──────────────────────────────────────────────────────────────

  setProfile(profile, drive) {
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((o) => {
        o.geometry?.dispose();
        if (o.material && o.userData.ownMaterial) o.material.dispose();
      });
    }
    this.profile = profile;
    this.root = new THREE.Group();
    this.engine = new THREE.Group(); // rocks on its mounts with torque reaction
    this.root.add(this.engine);
    this.flashes = [];
    if (profile.kind === 'rotary') this.buildRotary(profile);
    else this.buildPiston(profile);
    this.buildDriveline(profile, drive);
    this.scene.add(this.root);

    const box = new THREE.Box3().setFromObject(this.root);
    this.bounds = box;
    const size = box.getSize(new THREE.Vector3());
    this.floor.scale.set(size.z * 1.9, size.z * 1.9, 1);
    this.floor.position.set(box.getCenter(this.tmp).x, box.min.y - 0.05, box.getCenter(this.tmp).z);
    this.frameModel(true);
  }

  buildPiston(p) {
    const M = this.M;
    const B = p.boreMm / 100; // scene units are decimetres
    const S = p.strokeMm / 100;
    const r = S / 2;
    const L = p.rodRatio * S;
    const compH = 0.36 * B; // wrist pin to crown
    const deck = r + L + compH + 0.06 * B;
    const isV = p.banks === 2;
    const nThrows = Math.max(...p.cylinders.map((c) => c.throwIndex)) + 1;
    const rodW = 0.24 * B;
    const pitch = isV ? B * 1.18 + rodW * 0.4 : B * 1.2;
    const zOf = (c) => ((nThrows - 1) / 2 - c.throwIndex) * pitch + (isV ? (c.slot === 0 ? 1 : -1) * rodW * 0.55 : 0);
    const half = ((nThrows - 1) / 2) * pitch + pitch * 0.62;
    this.geom = { B, S, r, L, compH, deck, front: half, back: -half };

    // Crankshaft.
    const crank = new THREE.Group();
    this.crank = crank;
    this.engine.add(crank);
    const mainR = 0.17 * B;
    crank.add(new THREE.Mesh(cylAlongZ(mainR, half * 2 + 0.25, 24), M.steel));
    const pulley = new THREE.Mesh(cylAlongZ(0.42 * B, 0.12, 40), M.darkSteel);
    pulley.position.z = half + 0.12;
    crank.add(pulley);
    const webT = 0.09 * B;
    const webGeo = crankWebGeometry(r, 0.2 * B, r + 0.16 * B, webT);
    for (let t = 0; t < nThrows; t++) {
      const cyls = p.cylinders.filter((c) => c.throwIndex === t);
      const zs = cyls.map(zOf);
      const zMin = Math.min(...zs) - rodW / 2;
      const zMax = Math.max(...zs) + rodW / 2;
      const avg = Math.atan2(
        cyls.reduce((a, c) => a + Math.sin(c.pinDeg * DEG), 0),
        cyls.reduce((a, c) => a + Math.cos(c.pinDeg * DEG), 0),
      );
      for (const z of [zMin - webT / 2, zMax + webT / 2]) {
        const web = new THREE.Mesh(webGeo, M.chrome);
        web.position.z = z;
        web.rotation.z = -avg;
        crank.add(web);
      }
      for (const c of cyls) {
        const pin = new THREE.Mesh(cylAlongZ(0.15 * B, rodW + 0.02, 20), M.chrome);
        pin.position.set(r * Math.sin(c.pinDeg * DEG), r * Math.cos(c.pinDeg * DEG), zOf(c));
        crank.add(pin);
      }
      if (cyls.length === 2 && cyls[0].pinDeg !== cyls[1].pinDeg) {
        // Split-pin crank: a thin web between the two offset pins.
        const mid = new THREE.Mesh(webGeo, M.chrome);
        mid.scale.z = 0.6;
        mid.position.z = (zs[0] + zs[1]) / 2;
        mid.rotation.z = -avg;
        crank.add(mid);
      }
    }

    // Pistons, rods, sleeves, combustion glow.
    const sleeveLen = S + 0.62 * B + 0.24 * B;
    const sleeveGeo = new THREE.CylinderGeometry(B * 0.52, B * 0.52, sleeveLen, 36, 1, true);
    const bandGeo = new THREE.TorusGeometry(B * 0.525, 0.012, 8, 48);
    bandGeo.rotateX(Math.PI / 2);
    const pistonGeo = new THREE.CylinderGeometry(B * 0.485, B * 0.485, 0.62 * B, 36);
    pistonGeo.translate(0, compH - 0.31 * B, 0);
    const ringGeo = new THREE.CylinderGeometry(B * 0.49, B * 0.49, 0.025 * B, 36, 1, true);
    const bigEnd = cylAlongZ(0.23 * B, rodW * 0.9, 24);
    const smallEnd = cylAlongZ(0.12 * B, rodW * 0.8, 18);
    const beam = new THREE.BoxGeometry(0.14 * B, L, rodW * 0.55);
    beam.translate(0, L / 2, 0);
    const glowGeo = new THREE.SphereGeometry(B * 0.44, 20, 14);
    const plugGeo = new THREE.CylinderGeometry(0.05 * B, 0.05 * B, 0.3 * B, 10);

    this.cyls = p.cylinders.map((c) => {
      const z = zOf(c);
      const axisRot = -c.bankDeg * DEG;
      const [ax, ay] = [Math.sin(c.bankDeg * DEG), Math.cos(c.bankDeg * DEG)];

      const sleeve = new THREE.Mesh(sleeveGeo, M.glass);
      const sleeveMid = deck - sleeveLen / 2;
      sleeve.position.set(ax * sleeveMid, ay * sleeveMid, z);
      sleeve.rotation.z = axisRot;
      for (const y of [sleeveLen / 2, -sleeveLen / 2, sleeveLen / 2 - 0.22 * B]) {
        const band = new THREE.Mesh(bandGeo, M.chrome);
        band.position.y = y;
        sleeve.add(band);
      }
      this.engine.add(sleeve);

      const piston = new THREE.Group();
      piston.add(new THREE.Mesh(pistonGeo, M.chrome));
      for (const k of [0, 1, 2]) {
        const ring = new THREE.Mesh(ringGeo, M.ring);
        ring.position.y = compH - 0.08 * B - k * 0.07 * B;
        piston.add(ring);
      }
      piston.rotation.z = axisRot;
      this.engine.add(piston);

      const rod = new THREE.Group();
      rod.add(new THREE.Mesh(bigEnd, M.rod), new THREE.Mesh(beam, M.rod));
      const se = new THREE.Mesh(smallEnd, M.rod);
      se.position.y = L;
      rod.add(se);
      this.engine.add(rod);

      const glowMat = M.flashBase.clone();
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.userData.ownMaterial = true;
      glow.rotation.z = axisRot;
      glow.visible = false;
      this.engine.add(glow);

      const plugMat = M.plug.clone();
      const plug = new THREE.Mesh(plugGeo, plugMat);
      plug.userData.ownMaterial = true;
      const plugD = deck + 0.5 * B;
      plug.position.set(ax * plugD, ay * plugD, z);
      plug.rotation.z = axisRot;
      this.engine.add(plug);

      return { c, z, ax, ay, piston, rod, glow, plug };
    });

    // Cylinder heads (one per bank).
    for (let bank = 0; bank < p.banks; bank++) {
      const members = this.cyls.filter((k) => k.c.bank === bank);
      const zs = members.map((k) => k.z);
      const len = Math.max(...zs) - Math.min(...zs) + B * 1.3;
      const { ax, ay, c } = members[0];
      const head = new THREE.Mesh(new THREE.BoxGeometry(B * 1.45, 0.42 * B, len), M.glassDark);
      const d = deck + 0.21 * B + 0.02;
      head.position.set(ax * d, ay * d, (Math.max(...zs) + Math.min(...zs)) / 2);
      head.rotation.z = -c.bankDeg * DEG;
      this.engine.add(withEdges(head, M.edge));
    }

    // Crankcase and sump.
    const caseW = 2 * (r + 0.3 * B) + (isV ? B * 0.6 : 0);
    const caseH = r + 0.5 * B + r * 0.8;
    const crankcase = new THREE.Mesh(new THREE.BoxGeometry(caseW, caseH, half * 2), M.glass);
    crankcase.position.y = r * 0.8 - caseH / 2;
    this.engine.add(withEdges(crankcase, M.edge));
    const sump = new THREE.Mesh(new THREE.BoxGeometry(caseW * 0.82, 0.35 * B, half * 1.7), M.glassDark);
    sump.position.y = crankcase.position.y - caseH / 2 - 0.175 * B;
    this.engine.add(withEdges(sump, M.edge));

    this.pointsFor(this.cyls.length, B);
  }

  buildRotary(p) {
    const M = this.M;
    const R = 1.05;
    const e = 0.15;
    const W = 0.8;
    const gap = 0.16;
    const n = p.rotors;
    const total = n * W + (n + 1) * gap;
    const half = total / 2;
    this.geom = { R, e, W, front: half, back: -half, B: 0.9 };

    // Rotate the whole core so the long axis of the bore stands vertical.
    const core = new THREE.Group();
    core.rotation.z = Math.PI / 2;
    this.engine.add(core);

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
    const statGear = gearGeometry(0.24, W * 0.55, 0.04);

    const shaft = new THREE.Group();
    this.crank = shaft;
    this.engine.add(shaft);
    shaft.add(new THREE.Mesh(cylAlongZ(0.12, total + 0.6, 24), M.steel));
    const lobeGeo = cylAlongZ(0.2, W * 0.9, 28);
    const glowGeo = new THREE.SphereGeometry(0.34, 18, 12);

    this.rotors = [];
    for (let i = 0; i < n; i++) {
      const z = half - gap - W / 2 - i * (W + gap);
      const housing = new THREE.Mesh(housingGeo, M.glass);
      housing.position.z = z;
      core.add(withEdges(housing, M.edge, 40));
      // The shaft turns +θ for rotaries, so the lobe that carries rotor i sits at
      // a fixed offset: the rotor centre e·(cos a, sin a) in the core frame,
      // turned +90° into the engine frame and back by −θ into the shaft frame.
      const lobe = new THREE.Mesh(lobeGeo, M.chrome);
      const phase = p.rotorPhases[i] * DEG;
      lobe.position.set(-e * Math.sin(phase), e * Math.cos(phase), z);
      shaft.add(lobe);
      const stat = new THREE.Mesh(statGear, M.darkSteel);
      stat.position.z = z + W * 0.2;
      core.add(stat);

      const rotor = new THREE.Group();
      rotor.add(new THREE.Mesh(rotorGeo, M.chrome));
      const ig = new THREE.Mesh(internalGear, M.friction);
      ig.position.z = W * 0.2;
      rotor.add(ig);
      rotor.position.z = z;
      core.add(rotor);

      const glowMat = M.flashBase.clone();
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.userData.ownMaterial = true;
      glow.position.set(0, -(R - e) * 0.72, z);
      glow.scale.set(2.2, 0.55, 1.4);
      glow.visible = false;
      core.add(glow);
      const plugMat = M.plug.clone();
      for (const dx of [-0.32, 0.32]) {
        const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 10), plugMat);
        plug.userData.ownMaterial = dx < 0;
        plug.position.set(dx, -(R - e) - 0.42, z);
        core.add(plug);
      }
      this.rotors.push({ rotor, glow, plugMat, lobe, phase: p.rotorPhases[i], z });
    }
    for (let i = 0; i <= n; i++) {
      const plate = new THREE.Mesh(plateGeo, M.glassDark);
      plate.position.z = half - gap / 2 - i * (W + gap);
      core.add(withEdges(plate, M.edge, 40));
    }
    core.updateMatrix();
    this.core = core;
    this.pointsFor(n, 1.4);
  }

  // Spark particles: a fixed buffer, positions computed from each flash.
  pointsFor(count, scale) {
    const per = 10;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * per * 3);
    const col = new Float32Array(count * per * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.05 * scale, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.userData.ownMaterial = true;
    pts.frustumCulled = false;
    this.engine.add(pts);
    const dirs = [];
    for (let i = 0; i < count * per; i++) {
      const u = Math.sin(i * 91.7) * 0.5 + 0.5;
      const v = Math.sin(i * 47.3 + 1.3) * 0.5 + 0.5;
      const th = u * Math.PI * 2;
      const ph = Math.acos(2 * v - 1);
      dirs.push([Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph), 0.4 + 0.6 * (Math.sin(i * 13.1) * 0.5 + 0.5)]);
    }
    this.sparks = { pts, pos, col, dirs, per, scale };
  }

  buildDriveline(p, drive) {
    const M = this.M;
    const back = this.geom.back;
    const g = new THREE.Group();
    this.root.add(g);

    // Flywheel with ring gear, bolted to the crank.
    const fwR = 1.45;
    const fwZ = back - 0.2;
    const flywheel = new THREE.Group();
    flywheel.add(new THREE.Mesh(cylAlongZ(fwR, 0.16, 64), M.darkSteel));
    const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.07, 0.13), M.steel, 96);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      q.setFromAxisAngle(Z_AXIS, -a);
      m4.compose(new THREE.Vector3(Math.sin(a) * (fwR + 0.03), Math.cos(a) * (fwR + 0.03), 0), q, new THREE.Vector3(1, 1, 1));
      teeth.setMatrixAt(i, m4);
    }
    flywheel.add(teeth);
    for (const a of [0, Math.PI]) {
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 0.03), M.timing);
      mark.position.set(Math.sin(a) * (fwR - 0.3), Math.cos(a) * (fwR - 0.3), 0.09);
      mark.rotation.z = -a;
      flywheel.add(mark);
    }
    flywheel.position.z = fwZ;
    this.crank.add(flywheel);

    // Clutch: pressure plate turns with the engine, disc with the gearbox input.
    const pressure = new THREE.Mesh(cylAlongZ(1.22, 0.1, 48), M.steel);
    this.crank.add(pressure);
    this.pressurePlate = pressure;
    this.pressureZ = fwZ - 0.24;
    const disc = new THREE.Group();
    disc.add(new THREE.Mesh(cylAlongZ(1.1, 0.05, 48), M.friction));
    for (let i = 0; i < 6; i++) {
      const spring = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.08), M.chrome);
      const a = (i / 6) * Math.PI * 2;
      spring.position.set(Math.sin(a) * 0.45, Math.cos(a) * 0.45, 0);
      spring.rotation.z = -a;
      disc.add(spring);
    }
    disc.position.z = fwZ - 0.13;
    this.clutchDisc = disc;
    g.add(disc);
    this.discZ = disc.position.z;

    const bell = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.7, 0.75, 40, 1, true), M.glass);
    bell.rotation.x = Math.PI / 2;
    bell.position.z = fwZ - 0.2;
    g.add(withEdges(bell, M.edge, 50));

    // Gearbox: input shaft on the axis, lay shaft below, gears sized from the ratios.
    const C = 0.82;
    const gw = 0.15;
    const ratios = [...drive.gearRatios, drive.reverseRatio];
    const z0 = fwZ - 0.75;
    const spacing = 0.3;
    const boxLen = spacing * (ratios.length + 1) + 0.5;
    const caseMesh = new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.35, boxLen), M.glass);
    caseMesh.position.set(0, -C / 2, z0 - boxLen / 2 + 0.15);
    g.add(withEdges(caseMesh, M.edge));

    const input = new THREE.Group();
    const lay = new THREE.Group();
    lay.position.y = -C;
    const output = new THREE.Group();
    g.add(input, lay, output);
    input.add(new THREE.Mesh(cylAlongZ(0.07, 0.9, 16), M.steel));
    input.position.z = z0 + 0.3;
    // Constant-mesh head pair at 1:1, so each main gear turns at input / ratio.
    const head = new THREE.Mesh(gearGeometry(C * 0.5, gw), M.gear);
    head.position.z = -0.3;
    input.add(head);
    lay.add(new THREE.Mesh(cylAlongZ(0.07, boxLen - 0.2, 16), M.steel));
    lay.position.z = z0 - boxLen / 2 + 0.15;
    const layHead = new THREE.Mesh(gearGeometry(C * 0.5, gw), M.gear);
    layHead.position.z = z0 - lay.position.z;
    lay.add(layHead);
    output.add(new THREE.Mesh(cylAlongZ(0.08, boxLen + 0.7, 16), M.steel));
    output.position.z = z0 - boxLen / 2 - 0.2;
    const flange = new THREE.Mesh(cylAlongZ(0.22, 0.08, 24), M.chrome);
    flange.position.z = -(boxLen + 0.7) / 2 + 0.1;
    output.add(flange);

    this.gearPairs = ratios.map((k, i) => {
      const z = z0 - spacing * (i + 1);
      const isReverse = i === ratios.length - 1;
      const kk = Math.max(0.5, Math.min(3.6, k));
      const rm = (C * kk) / (1 + kk);
      const rl = C / (1 + kk);
      const main = new THREE.Mesh(gearGeometry(rm, gw), M.gear);
      main.position.set(0, 0, z);
      g.add(main);
      const layGear = new THREE.Mesh(gearGeometry(rl, gw), M.gear);
      layGear.position.z = z - lay.position.z;
      lay.add(layGear);
      let idler = null;
      if (isReverse) {
        // Reverse idler beside the pair flips the output's direction.
        idler = new THREE.Mesh(gearGeometry(0.2, gw), M.gear);
        idler.position.set(0.48, -C * 0.55, z);
        g.add(idler);
      }
      return { main, layGear, idler, ratio: k, gear: isReverse ? 'R' : i + 1, z };
    });

    // Shift collars (1-2, 3-4, 5-R) slide towards the selected gear.
    this.collars = [0, 2, 4].map((i) => {
      const a = this.gearPairs[i];
      const b = this.gearPairs[i + 1];
      const collar = new THREE.Mesh(cylAlongZ(0.17, 0.08, 24), M.chrome);
      const mid = (a.z + b.z) / 2;
      collar.position.z = mid;
      g.add(collar);
      return { collar, mid, a, b, pos: mid };
    });

    this.input = input;
    this.lay = lay;
    this.output = output;
  }

  frameModel(resetView) {
    if (!this.bounds) return;
    const sphere = this.bounds.getBoundingSphere(new THREE.Sphere());
    // Aim at the engine block rather than the middle of engine + gearbox.
    const center = sphere.center.clone();
    center.z = sphere.center.z * 0.35 + this.geom.front * 0.15;
    center.y = sphere.center.y * 0.6;
    const vFov = this.camera.fov * DEG;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const usable = Math.max(0.35, 1 - (this.insets.top + this.insets.bottom) / Math.max(1, this.height));
    const fov = Math.min(vFov * usable, hFov);
    const dist = (sphere.radius * 0.74) / Math.sin(fov / 2);
    this.controls.minDistance = sphere.radius * 0.6;
    this.controls.maxDistance = dist * 3;
    if (resetView) {
      // Front-left three-quarter view: pulley end towards the viewer, gearbox behind on the right.
      const dir = new THREE.Vector3(0.95, 0.66, 1.0).normalize();
      this.camera.position.copy(center).addScaledVector(dir, dist);
      this.controls.target.copy(center);
      this.controls.update();
    }
  }

  resetView() {
    this.frameModel(true);
  }

  resize(width, height, insets = this.insets) {
    this.width = width;
    this.height = height;
    this.insets = insets;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // Shift the projection centre so the model sits in the gap between the HUD bars.
    const offsetY = (insets.bottom - insets.top) / 2;
    this.camera.setViewOffset(width, height, 0, offsetY, width, height);
    this.camera.updateProjectionMatrix();
  }

  // ── Per-frame pose ────────────────────────────────────────────────────────

  update(dt, view) {
    const { crankDeg, inputDeg, outputDeg, sim, showFlashes } = view;
    const p = this.profile;
    // Piston cranks are drawn turning −θ about +Z; the Wankel's eccentric shaft
    // turns +θ so it follows the rotor's orbit.
    this.crank.rotation.z = (p.kind === 'rotary' ? 1 : -1) * crankDeg * DEG;

    // Torque reaction: the block rolls slightly against the crank.
    const target = (-sim.engineTorque / p.peakTorqueNm) * 0.035;
    this.reactionAngle += (target - this.reactionAngle) * Math.min(1, dt * 10);
    this.engine.rotation.z = this.reactionAngle;

    const lit = [];
    const burning = sim.running && !sim.fuelCut && showFlashes;
    const strength = 0.45 + 0.55 * Math.min(1, sim.throttleEffective * 1.6);
    const sp = this.sparks;

    if (p.kind === 'rotary') {
      const { R, e } = this.geom;
      this.rotors.forEach((k, i) => {
        const pose = rotorPose(crankDeg, k.phase, R, e);
        k.rotor.position.x = pose.center[0];
        k.rotor.position.y = pose.center[1];
        k.rotor.rotation.z = pose.rotation;
        const f = burning ? combustionFlash(rotorDegreesSinceFiring(crankDeg, k.phase), 110) * strength : 0;
        this.setGlow(k.glow, f, 1);
        k.plugMat.emissiveIntensity = f * 4;
        if (f > 0.01) lit.push({ f, obj: k.glow });
        this.writeSparks(i, f, this.tmp.copy(k.glow.position).applyMatrix4(this.core.matrix), 0.5);
      });
    } else {
      const { r, L, compH, deck, B } = this.geom;
      for (let i = 0; i < this.cyls.length; i++) {
        const k = this.cyls[i];
        const pose = cylinderPose(k.c, crankDeg, r, L);
        k.piston.position.set(pose.piston[0], pose.piston[1], k.z);
        const dx = pose.piston[0] - pose.pin[0];
        const dy = pose.piston[1] - pose.pin[1];
        k.rod.position.set(pose.pin[0], pose.pin[1], k.z);
        k.rod.rotation.z = -Math.atan2(dx, dy);
        const f = burning ? combustionFlash(degreesSinceFiring(k.c.fireDeg, crankDeg), 130) * strength : 0;
        const crown = pose.pY + compH;
        const gapLen = Math.max(0.05, deck - crown);
        const mid = (deck + crown) / 2;
        k.glow.position.set(k.ax * mid, k.ay * mid, k.z);
        k.glow.scale.set(1.05, Math.max(0.25, gapLen / (B * 0.88)), 1.05);
        this.setGlow(k.glow, f, 0.85);
        k.plug.material.emissiveIntensity = f * 5;
        if (f > 0.01) lit.push({ f, obj: k.glow });
        this.writeSparks(i, f, k.glow.position, gapLen / B);
      }
    }
    sp.pts.geometry.attributes.position.needsUpdate = true;
    sp.pts.geometry.attributes.color.needsUpdate = true;

    lit.sort((a, b) => b.f - a.f);
    this.flashLights.forEach((light, i) => {
      const l = lit[i];
      if (l) {
        l.obj.getWorldPosition(light.position);
        light.intensity = l.f * 9;
      } else light.intensity = 0;
    });

    // Clutch and gearbox.
    const pedal = sim.clutchPedal;
    const sep = Math.max(0, Math.min(1, pedal / 0.8));
    this.pressurePlate.position.z = this.pressureZ - sep * 0.07;
    this.clutchDisc.position.z = this.discZ - sep * 0.035;
    this.clutchDisc.rotation.z = -inputDeg * DEG;
    const inAngle = inputDeg * DEG;
    this.input.rotation.z = -inAngle;
    this.lay.rotation.z = inAngle; // meshing gears counter-rotate
    for (const gp of this.gearPairs) {
      const live = gp.gear === sim.gear;
      const mat = live ? this.M.gearLive : this.M.gear;
      gp.main.material = mat;
      gp.layGear.material = mat;
      // Forward gears turn with the input shaft; reverse runs through the idler and turns back.
      gp.main.rotation.z = ((gp.gear === 'R' ? 1 : -1) * inAngle) / gp.ratio;
      if (gp.idler) {
        gp.idler.material = mat;
        gp.idler.rotation.z = -inAngle * 2.4;
      }
    }
    this.output.rotation.z = -outputDeg * DEG;
    for (const c of this.collars) {
      let goal = c.mid;
      if (sim.gear === c.a.gear) goal = c.mid + (c.a.z - c.mid) * 0.55;
      if (sim.gear === c.b.gear) goal = c.mid + (c.b.z - c.mid) * 0.55;
      c.pos += (goal - c.pos) * Math.min(1, dt * 14);
      c.collar.position.z = c.pos;
      c.collar.rotation.z = -outputDeg * DEG;
    }

    this.controls.update();
  }

  setGlow(mesh, f, max) {
    mesh.visible = f > 0.01;
    mesh.material.opacity = Math.min(max, f * 0.95);
  }

  writeSparks(i, f, center, spread) {
    const sp = this.sparks;
    const base = i * sp.per;
    const radius = (0.12 + (1 - f) * 0.5) * sp.scale * Math.max(0.6, Math.min(1.6, spread));
    for (let j = 0; j < sp.per; j++) {
      const d = sp.dirs[base + j];
      const o = (base + j) * 3;
      sp.pos[o] = center.x + d[0] * radius * d[3];
      sp.pos[o + 1] = center.y + d[1] * radius * d[3];
      sp.pos[o + 2] = center.z + d[2] * radius * d[3];
      const b = f * f * 1.4;
      sp.col[o] = b;
      sp.col[o + 1] = b * 0.55;
      sp.col[o + 2] = b * 0.18;
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Drop the pixel ratio if frames run slow on a phone; raise it back when there is headroom. */
  adaptQuality(frameMs) {
    const t = this.frameTimes;
    t.push(frameMs);
    if (t.length < 90) return;
    const avg = t.reduce((a, b) => a + b, 0) / t.length;
    t.length = 0;
    let next = this.pixelRatio;
    if (avg > 24 && this.pixelRatio > 1) next = Math.max(1, this.pixelRatio - 0.25);
    else if (avg < 13 && this.pixelRatio < this.maxPixelRatio) next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.resize(this.width, this.height, this.insets);
    }
  }
}

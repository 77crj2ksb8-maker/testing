// Three.js renderer: builds the engine assembly for a profile and poses every
// moving part from the crank angle each frame. Layout-generic (inline, V,
// boxer, V-twin, rotary); repeated parts are instanced so a V12 with every
// feature on stays well inside the draw-call budget.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  DEG, cylinderPose, combustionFlash, degreesSinceFiring, epitrochoid, rotorPose, rotorDegreesSinceFiring,
} from './kinematics.js';
import { makeMaterials, makeXrayMaterial, radialGlowTexture } from './scene/materials.js';
import {
  Z_AXIS, cylAlongZ, gearGeometry, crankWebGeometry, merge, withEdges, roundedBox, setRotZ,
} from './scene/geometry.js';
import { layoutOf, bankList, exhaustSide, bankToEngine, cylinderPlacement, explodeOffset } from './scene/layout.js';
import { headDims, buildValvetrain } from './scene/valvetrain.js';
import { GasVolumes } from './scene/gases.js';
import { planExhaust, ExhaustSystem } from './scene/exhaust.js';
import { Induction } from './scene/induction3d.js';
import { Effects } from './scene/effects.js';
import { CameraRig, CAMERA_PRESETS } from './scene/camera.js';
import { PostFX, markBloom } from './scene/post.js';
import { StrokeLabels } from './scene/labels.js';
import { initialQuality, adaptQuality, QUALITY_WINDOW } from './scene/quality.js';
import { strokeIndex, rotaryPortFlow } from './scene/timing.js';

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function deviceCaps() {
  return {
    dpr: window.devicePixelRatio || 1,
    cores: navigator.hardwareConcurrency || 4,
    coarse: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
  };
}

// Gearbox layout shared by the driveline and the exhaust that runs past it.
function drivelineDims(back, drive) {
  const fwZ = back - 0.2;
  const z0 = fwZ - 0.75;
  const spacing = 0.3;
  const pairs = drive.gearRatios.length + 1;
  const boxLen = spacing * (pairs + 1) + 0.5;
  const caseFront = z0 + 0.15;
  return { fwZ, z0, spacing, boxLen, caseFront, outputEnd: z0 - boxLen - 0.55, C: 0.82 };
}

export class EngineView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.localClippingEnabled = true;

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

    // Fixed light pool (a constant light count avoids shader recompiles): two
    // for combustion flashes, one for exhaust flames and failures.
    this.flashLights = [0, 1].map(() => {
      const l = new THREE.PointLight(0xff8a3a, 0, 6, 1.6);
      this.scene.add(l);
      return l;
    });
    this.fxLight = new THREE.PointLight(0xff7024, 0, 9, 1.6);
    this.scene.add(this.fxLight);
    this.fxLightLevel = 0;

    this.M = makeMaterials();
    const look = (m) => ({ color: m.color.getHex(), opacity: m.opacity, metalness: m.metalness, roughness: m.roughness });
    this.housingLook = { glass: look(this.M.glass), glassDark: look(this.M.glassDark) };
    this.xrayMat = makeXrayMaterial(0x58b4ff, 0.95);
    this.xrayLive = makeXrayMaterial(0xff9a3c, 1.4);
    // Cutaway removes the quadrant facing the default camera (x > 0 and above
    // the crank) from the static housings only.
    this.cutPlanes = [new THREE.Plane(v3(-1, 0, 0), 0), new THREE.Plane(v3(0, -1, 0), 0)];

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: radialGlowTexture(), transparent: true, depthWrite: false }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor);

    this.effects = new Effects(this.scene);
    markBloom(this.effects.sparks.points);
    this.rig = new CameraRig(this.camera, this.controls);
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    this.labels = new StrokeLabels(canvas);

    this.root = null;
    this.width = 1;
    this.height = 1;
    this.insets = { top: 0, bottom: 0 };
    this.tmp = v3();
    this.tmp2 = v3();
    this.m4 = new THREE.Matrix4();
    this.color = new THREE.Color();
    this.off = [0, 0, 0];
    this.reactionAngle = 0;
    this.frameTimes = [];
    this.display = { strokeGases: true, valvetrain: true, xray: false, cutaway: false, quality: 'auto' };
    this.quality = initialQuality('auto', deviceCaps());
    this.applyQuality();
    this.explodeT = 0;
    this.explodeTarget = 0;
    this.blown = null;
    this.smokeDebt = 0;
    this.time = 0;
  }

  // ── Building ──────────────────────────────────────────────────────────────

  setProfile(profile, drive, settings = {}) {
    if (this.root) {
      this.scene.remove(this.root);
      this.root.traverse((o) => {
        o.geometry?.dispose();
        if (o.isInstancedMesh) o.dispose();
        if (o.material && o.userData.ownMaterial) o.material.dispose();
      });
    }
    this.profile = profile;
    this.drive = drive;
    this.layout = layoutOf(profile);
    this.inductionKind = settings.induction ?? profile.induction?.kind ?? 'na';
    this.root = new THREE.Group();
    this.engine = new THREE.Group(); // rocks on its mounts with torque reaction
    this.root.add(this.engine);
    this.metal = [];
    this.explodables = [];
    this.valvetrain = null;
    this.gases = null;
    this.cyls = null;
    this.rotors = null;
    this.banks = null;
    this.portMarks = null;
    this.rodGeo = null;
    this.ports = null;
    this.dl = null;
    this.hiddenRod = -1;
    const wasBlown = !!this.blown;
    this.blown = null;
    this.effects.clear();

    if (profile.kind === 'rotary') this.buildRotary(profile);
    else this.buildPiston(profile);
    this.dl = drivelineDims(this.geom.back, drive);
    this.buildBreathing();
    this.buildDriveline(profile, drive);
    this.buildFailureProps();
    this.scene.add(this.root);

    for (const e of this.explodables) e.base = e.obj.position.clone();
    const box = new THREE.Box3().setFromObject(this.root);
    this.bounds = box;
    const size = box.getSize(v3());
    this.floor.scale.set(size.z * 1.9, size.z * 1.9, 1);
    this.floor.position.set(box.getCenter(this.tmp).x, box.min.y - 0.05, box.getCenter(this.tmp).z);
    this.labels.setCount(profile.kind === 'rotary' ? profile.firingOrder : profile.cylinders.map((c) => c.num));

    this.applyDisplay();
    this.applyExplode(this.explodeT);
    // What glows in the bloom pass.
    for (const o of [this.glows, this.gases?.mesh, this.sparks.pts, this.portMarks, this.breachGlow, this.exhaust.pipes, this.exhaust.flames]) {
      if (o) markBloom(o);
    }
    for (const g of this.exhaust.groups) markBloom(g.headers);
    for (const t of this.inductionHw.glowing) markBloom(t);
    this.root.updateMatrixWorld(true);
    this.frameModel(true);
    if (wasBlown) this.blowUp({ instant: true });
  }

  /** Remember a moving metal part so x-ray can swap its material. */
  addMetal(mesh) {
    mesh.userData.baseMaterial = mesh.material;
    this.metal.push(mesh);
    return mesh;
  }

  /** Register an object that slides out in the exploded view. */
  addExplodable(obj, part, bankDeg = 0) {
    this.explodables.push({ obj, part, bankDeg, base: null });
    return obj;
  }

  instanced(geo, mat, count, parent, dynamic = true) {
    const m = new THREE.InstancedMesh(geo, mat, count);
    if (dynamic) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    parent.add(m);
    return m;
  }

  buildPiston(p) {
    const M = this.M;
    const B = p.boreMm / 100; // scene units are decimetres
    const S = p.strokeMm / 100;
    const r = S / 2;
    const L = p.rodRatio * S;
    const compH = 0.36 * B; // wrist pin to crown
    const deck = r + L + compH + 0.06 * B;
    const rodW = 0.24 * B;
    const place = cylinderPlacement(p, B, rodW);
    const half = place.half;
    const H = headDims(B, deck);
    const banks = bankList(p);
    const chainZ = half + 0.1 * B;
    const pulleyZ = chainZ + 0.15 * B * (banks.length - 1) + 0.3 * B;
    const boxer = this.layout === 'boxer';
    this.geom = { B, S, r, L, compH, deck, front: half, back: -half, chainZ, pulleyZ, H, pulleyR: 0.42 * B };

    // Crankshaft, merged by material: steel journal + chrome webs and pins + pulley.
    const crank = new THREE.Group();
    this.crank = crank;
    this.engine.add(crank);
    const mainR = 0.17 * B;
    const shaftBack = -half - 0.125;
    const shaft = cylAlongZ(mainR, pulleyZ - shaftBack, 24);
    shaft.translate(0, 0, (pulleyZ + shaftBack) / 2);
    const chromeGeos = [];
    const webT = 0.09 * B;
    const webGeo = crankWebGeometry(r, 0.2 * B, r + 0.16 * B, webT);
    for (let t = 0; t < place.throws; t++) {
      const idx = p.cylinders.map((c, i) => (c.throwIndex === t ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) continue;
      const cyls = idx.map((i) => p.cylinders[i]);
      const zs = idx.map((i) => place.z[i]);
      const zMin = Math.min(...zs) - rodW / 2;
      const zMax = Math.max(...zs) + rodW / 2;
      const avg = Math.atan2(
        cyls.reduce((a, c) => a + Math.sin(c.pinDeg * DEG), 0),
        cyls.reduce((a, c) => a + Math.cos(c.pinDeg * DEG), 0),
      );
      for (const z of [zMin - webT / 2, zMax + webT / 2]) {
        chromeGeos.push(webGeo.clone().rotateZ(-avg).translate(0, 0, z));
      }
      cyls.forEach((c, k) => {
        const pin = cylAlongZ(0.15 * B, rodW + 0.02, 20);
        pin.translate(r * Math.sin(c.pinDeg * DEG), r * Math.cos(c.pinDeg * DEG), zs[k]);
        chromeGeos.push(pin);
      });
      if (cyls.length === 2 && cyls[0].pinDeg !== cyls[1].pinDeg) {
        // Split-pin crank: a thin web between the two offset pins.
        chromeGeos.push(webGeo.clone().scale(1, 1, 0.6).rotateZ(-avg).translate(0, 0, (zs[0] + zs[1]) / 2));
      }
    }
    webGeo.dispose();
    crank.add(this.addMetal(new THREE.Mesh(shaft, M.steel)));
    crank.add(this.addMetal(new THREE.Mesh(merge(chromeGeos), M.chrome)));
    const pulley = merge([
      cylAlongZ(this.geom.pulleyR, 0.12 * B, 40),
      new THREE.BoxGeometry(0.06 * B, this.geom.pulleyR * 1.6, 0.13 * B),
    ]);
    pulley.translate(0, 0, pulleyZ);
    crank.add(this.addMetal(new THREE.Mesh(pulley, M.darkSteel)));

    // Moving parts, instanced across every cylinder.
    const n = p.cylinders.length;
    const pistonGeo = new THREE.CylinderGeometry(B * 0.485, B * 0.485, 0.62 * B, 36);
    pistonGeo.translate(0, compH - 0.31 * B, 0);
    const ringGeo = merge([0, 1, 2].map((k) => {
      const g = new THREE.CylinderGeometry(B * 0.49, B * 0.49, 0.025 * B, 36, 1, true);
      return g.translate(0, compH - 0.08 * B - k * 0.07 * B, 0);
    }));
    const beam = new THREE.BoxGeometry(0.14 * B, L, rodW * 0.55);
    beam.translate(0, L / 2, 0);
    const smallEnd = cylAlongZ(0.12 * B, rodW * 0.8, 18);
    smallEnd.translate(0, L, 0);
    this.rodGeo = merge([cylAlongZ(0.23 * B, rodW * 0.9, 24), beam, smallEnd]);
    this.pistons = this.addMetal(this.instanced(pistonGeo, M.chrome, n, this.engine));
    this.rings = this.addMetal(this.instanced(ringGeo, M.ring, n, this.engine));
    this.rods = this.addMetal(this.instanced(this.rodGeo, M.rod, n, this.engine));
    const glowGeo = new THREE.SphereGeometry(B * 0.46, 20, 14);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.glows = this.instanced(glowGeo, glowMat, n, this.engine);
    this.glows.userData.ownMaterial = true;
    this.glows.renderOrder = 3;
    for (let i = 0; i < n; i++) this.glows.setColorAt(i, this.color.setRGB(0, 0, 0));
    this.gases = new GasVolumes(n, B * 0.47);
    this.engine.add(this.gases.mesh);

    this.cyls = p.cylinders.map((c, i) => ({
      c, z: place.z[i], ax: Math.sin(c.bankDeg * DEG), ay: Math.cos(c.bankDeg * DEG), axisRot: -c.bankDeg * DEG,
      label: v3(),
    }));

    // Per bank: liners, head casting with cam cover, plugs, and the valvetrain.
    const sleeveLen = S + 0.86 * B;
    const sleeveGeo = new THREE.CylinderGeometry(B * 0.52, B * 0.52, sleeveLen, 36, 1, true);
    const bandGeo = merge([sleeveLen / 2, -sleeveLen / 2, sleeveLen / 2 - 0.22 * B].map((y) => {
      const g = new THREE.TorusGeometry(B * 0.525, 0.012, 8, 48);
      g.rotateX(Math.PI / 2);
      return g.translate(0, y, 0);
    }));
    const plugGeo = new THREE.CylinderGeometry(0.045 * B, 0.045 * B, H.top - deck, 10);
    plugGeo.translate(0, (H.top + deck) / 2, 0);
    const coilGeo = merge([
      new THREE.CylinderGeometry(0.1 * B, 0.1 * B, 0.36 * B, 14).translate(0, H.top + 0.14 * B, 0),
      new THREE.BoxGeometry(0.34 * B, 0.08 * B, 0.2 * B).translate(0, H.top + 0.34 * B, 0),
    ]);
    const coverH = H.top - (deck + H.lowerH) + 0.04 * B;
    this.banks = banks.map((bk) => {
      const side = exhaustSide(bk.bankDeg);
      const cyls = bk.members.map((i) => this.cyls[i]);
      const zs = cyls.map((k) => k.z);
      const zc = (Math.max(...zs) + Math.min(...zs)) / 2;
      const len = Math.max(...zs) - Math.min(...zs) + B * 1.3;
      const rot = -bk.bankDeg * DEG;

      const sleeveGroup = new THREE.Group();
      sleeveGroup.rotation.z = rot;
      this.engine.add(this.addExplodable(sleeveGroup, 'sleeve', bk.bankDeg));
      const sleeves = this.instanced(sleeveGeo, M.glass, cyls.length, sleeveGroup, false);
      const bands = this.instanced(bandGeo, M.chrome, cyls.length, sleeveGroup, false);
      cyls.forEach((k, j) => {
        setRotZ(this.m4, 0, 1, 0, deck - sleeveLen / 2, k.z);
        sleeves.setMatrixAt(j, this.m4);
        bands.setMatrixAt(j, this.m4);
      });

      const headGroup = new THREE.Group();
      headGroup.rotation.z = rot;
      this.engine.add(this.addExplodable(headGroup, 'head', bk.bankDeg));
      const lower = new THREE.BoxGeometry(H.width * 0.96, H.lowerH, len);
      lower.translate(0, deck + H.lowerH / 2, zc);
      const cover = roundedBox(H.width, coverH, len, 0.22 * B);
      cover.translate(0, deck + H.lowerH + coverH / 2 - 0.02 * B, zc);
      const head = new THREE.Mesh(merge([lower, cover]), M.glassDark);
      headGroup.add(withEdges(head, M.edge));
      const plugs = this.instanced(plugGeo, M.ceramic, cyls.length, headGroup, false);
      const coils = this.instanced(coilGeo, M.coil, cyls.length, headGroup, false);
      cyls.forEach((k, j) => {
        setRotZ(this.m4, 0, 1, 0, 0, k.z);
        plugs.setMatrixAt(j, this.m4);
        coils.setMatrixAt(j, this.m4);
      });
      for (const k of cyls) k.headGroup = headGroup;
      return { ...bk, side, cyls, sleeveGroup, headGroup, zc, len };
    });

    this.valvetrain = buildValvetrain({
      B, head: H, chainZ, M, crank,
      banks: this.banks.map((bk) => ({ bankDeg: bk.bankDeg, side: bk.side, group: bk.headGroup, cyls: bk.cyls })),
    });
    this.engine.add(this.valvetrain.chain);
    for (const m of this.valvetrain.metal) this.addMetal(m);

    // Crankcase and sump: a boxer's is wide and flat around the crank.
    let caseW;
    let caseH;
    let caseY;
    if (boxer) {
      caseW = 2 * (r + 0.55 * B);
      caseH = 2 * (r + 0.5 * B);
      caseY = 0;
    } else {
      caseW = 2 * (r + 0.3 * B) + (this.banks.length > 1 ? B * 0.6 : 0);
      caseH = r + 0.5 * B + r * 0.8;
      caseY = r * 0.8 - caseH / 2;
    }
    const crankcase = new THREE.Mesh(new THREE.BoxGeometry(caseW, caseH, half * 2), M.glass);
    crankcase.position.y = caseY;
    this.engine.add(withEdges(crankcase, M.edge));
    const sump = new THREE.Mesh(roundedBox(caseW * 0.82, 0.38 * B, half * 1.7, 0.1 * B), M.glassDark);
    sump.position.y = caseY - caseH / 2 - 0.19 * B;
    this.engine.add(this.addExplodable(withEdges(sump, M.edge), 'sump'));
    this.geom.caseW = caseW;
    this.geom.caseTop = caseY + caseH / 2;
    this.geom.lowY = sump.position.y - 0.19 * B;
    // Where a failed rod breaks out: the side facing the default camera (the top of a boxer).
    this.geom.breachNormal = boxer ? v3(0, 1, 0) : v3(1, 0, 0);
    this.geom.breachAt = boxer ? v3(0, caseY + caseH / 2 + 0.01, 0) : v3(caseW / 2 + 0.01, caseY + caseH * 0.15, 0);

    // Ports in the engine frame, for headers and intake runners.
    const pt = [0, 0];
    const exGroups = this.banks.map((bk) => {
      const out = v3(...bankToEngine(bk.bankDeg, bk.side, 0, pt), 0);
      return {
        bankDeg: bk.bankDeg, out, members: bk.members,
        ports: bk.cyls.map((k) => v3(...bankToEngine(bk.bankDeg, bk.side * H.portX, H.portY, pt), k.z)),
      };
    });
    const inPorts = [];
    for (const bk of this.banks) {
      const d = v3(...bankToEngine(bk.bankDeg, -bk.side, 0, pt), 0);
      for (const k of bk.cyls) inPorts.push({ p: v3(...bankToEngine(bk.bankDeg, -bk.side * H.portX, H.portY, pt), k.z), d });
    }
    this.ports = { exGroups, inPorts, twoBanks: this.banks.length > 1 };
    this.pointsFor(n, B);
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
    const B = 0.9;
    const pulleyZ = half + 0.42;
    this.geom = { R, e, W, front: half, back: -half, B, pulleyZ, pulleyR: 0.4, chainZ: half };

    // Rotate the core so the bore's long axis stands vertical, plugs on −X and ports on +X.
    const core = new THREE.Group();
    core.rotation.z = -Math.PI / 2;
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
    internalGear.translate(0, 0, W * 0.2);
    const statGear = gearGeometry(0.24, W * 0.55, 0.04);

    const shaft = new THREE.Group();
    this.crank = shaft;
    this.engine.add(shaft);
    shaft.add(this.addMetal(new THREE.Mesh(cylAlongZ(0.12, pulleyZ + half + 0.3, 24).translate(0, 0, (pulleyZ - half - 0.3) / 2), M.steel)));
    const pulley = merge([cylAlongZ(this.geom.pulleyR, 0.12, 40), new THREE.BoxGeometry(0.06, 0.6, 0.13)]);
    pulley.translate(0, 0, pulleyZ);
    shaft.add(this.addMetal(new THREE.Mesh(pulley, M.darkSteel)));
    const lobeGeo = cylAlongZ(0.2, W * 0.9, 28);
    const glowGeo = new THREE.SphereGeometry(0.34, 18, 12);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.glows = this.instanced(glowGeo, glowMat, n, core);
    this.glows.userData.ownMaterial = true;
    this.glows.renderOrder = 3;
    const portGeo = cylAlongZ(0.11, W * 0.62, 12);
    const portMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.portMarks = this.instanced(portGeo, portMat, n * 2, core, false);
    this.portMarks.userData.ownMaterial = true;
    this.portMarks.frustumCulled = false;
    this.portMarks.renderOrder = 3;
    const plugGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.4, 10);
    const plugs = this.instanced(plugGeo, M.ceramic, n * 2, core, false);
    // Port positions on the bore (core frame): exhaust leads, intake trails.
    const portAt = (deg, rad) => epitrochoid(deg * DEG, R + rad, e * (rad > 0 ? 0.6 : 1));

    this.rotors = [];
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
      shaft.add(this.addMetal(lobe));
      const stat = new THREE.Mesh(statGear, M.darkSteel);
      stat.position.z = z + W * 0.2;
      core.add(stat);

      const rotor = new THREE.Group();
      rotor.add(this.addMetal(new THREE.Mesh(rotorGeo, M.chrome)));
      rotor.add(this.addMetal(new THREE.Mesh(internalGear, M.friction)));
      rotor.position.z = z;
      core.add(rotor);
      setRotZ(this.m4, 0, 1, 0, 0, z);
      this.glows.setColorAt(i, this.color.setRGB(0, 0, 0));
      for (const [k, dx] of [[0, -0.32], [1, 0.32]]) {
        setRotZ(this.m4, 0, 1, dx, -(R - e) - 0.42, z);
        plugs.setMatrixAt(i * 2 + k, this.m4);
      }
      [[60, 1], [120, 0]].forEach(([deg, kind]) => {
        const [bx, by] = portAt(deg, 0);
        setRotZ(this.m4, 0, 1, bx * 1.04, by * 1.04, z);
        this.portMarks.setMatrixAt(i * 2 + kind, this.m4);
        this.portMarks.setColorAt(i * 2 + kind, this.color.setRGB(0, 0, 0));
        // Outer housing point, turned into the engine frame (x, y) → (y, −x).
        const [ox, oy] = portAt(deg, 0.32);
        const p3 = v3(oy, -ox, z);
        const d = v3(oy, -ox, 0).normalize();
        if (kind === 1) exPorts.push(p3);
        else inPorts.push({ p: p3, d });
      });
      this.rotors.push({ rotor, phase: p.rotorPhases[i], z, label: v3() });
    }
    for (let i = 0; i <= n; i++) {
      const plate = new THREE.Mesh(plateGeo, M.glassDark);
      plate.position.z = half - gap / 2 - i * (W + gap);
      core.add(withEdges(plate, M.edge, 40));
    }
    core.updateMatrix();
    this.core = core;
    this.geom.lowY = -(R + 0.45);
    this.geom.caseTop = R + 0.45;
    this.geom.breachNormal = v3(1, 0, 0);
    this.geom.breachAt = v3(1.3, 0, 0);
    const out = exPorts.reduce((a, q) => a.add(v3(q.x, q.y, 0)), v3()).normalize();
    this.ports = { exGroups: [{ bankDeg: 0, out, members: exPorts.map((_, i) => i), ports: exPorts }], inPorts, twoBanks: false };
    this.pointsFor(n, 1.4);
  }

  // Exhaust headers + tailpipes and the induction hardware, which share the
  // collectors (turbos sit on them).
  buildBreathing() {
    const { B } = this.geom;
    const kind = this.inductionKind;
    const turbo = kind === 'turbo' || kind === 'twin-turbo';
    let groups = this.ports.exGroups;
    if (kind === 'twin-turbo' && groups.length === 1 && groups[0].ports.length >= 2) {
      // One bank, two turbos: the front half and the rear half get a collector each.
      const g = groups[0];
      const order = g.ports.map((p, i) => i).sort((a, b) => g.ports[b].z - g.ports[a].z);
      const h = Math.ceil(order.length / 2);
      groups = [order.slice(0, h), order.slice(h)].map((idx) => ({ ...g, ports: idx.map((i) => g.ports[i]), members: idx }));
    }
    const plan = planExhaust(groups, B, { mid: turbo });
    const ind = new Induction({
      kind, B, M: this.M, ports: this.ports.inPorts, twoBanks: this.ports.twoBanks,
      pulley: { z: this.geom.pulleyZ, r: this.geom.pulleyR }, collectors: plan,
      frontZ: this.geom.pulleyZ, lowY: this.geom.lowY,
    });
    for (const f of ind.feed ?? []) plan[f.group].feed = f;
    const starts = ind.starts ?? plan.map((g, i) => ({ group: i, from: g.collector.clone().add(v3(0, 0, -0.25 * B)) }));
    this.exhaust = new ExhaustSystem(plan, {
      B, M: this.M, starts, crossovers: ind.crossovers,
      run: { x: 1.32, y: -1.35, startZ: this.dl.caseFront, endZ: this.dl.outputEnd - 0.2 },
    });
    this.exhaust.attach(this.engine);
    this.exhaust.groups.forEach((g) => this.addExplodable(g.group, 'exhaust', g.bankDeg));
    this.inductionHw = ind;
    this.engine.add(this.addExplodable(ind.group, 'intake'));
    if (ind.belt) this.engine.add(ind.belt);
    for (const m of ind.metal) this.addMetal(m);
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
    const { fwZ, z0, spacing, boxLen, C } = this.dl;
    const g = new THREE.Group();
    this.root.add(g);

    // Flywheel with ring gear, bolted to the crank.
    const fwR = 1.45;
    const flywheel = new THREE.Group();
    flywheel.add(this.addMetal(new THREE.Mesh(cylAlongZ(fwR, 0.16, 64), M.darkSteel)));
    const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.07, 0.13), M.steel, 96);
    const q = new THREE.Quaternion();
    const one = v3(1, 1, 1);
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      q.setFromAxisAngle(Z_AXIS, -a);
      this.m4.compose(v3(Math.sin(a) * (fwR + 0.03), Math.cos(a) * (fwR + 0.03), 0), q, one);
      teeth.setMatrixAt(i, this.m4);
    }
    flywheel.add(this.addMetal(teeth));
    const marks = merge([0, Math.PI].map((a) => {
      const m = new THREE.BoxGeometry(0.1, 0.32, 0.03);
      m.rotateZ(-a);
      return m.translate(Math.sin(a) * (fwR - 0.3), Math.cos(a) * (fwR - 0.3), 0.09);
    }));
    flywheel.add(new THREE.Mesh(marks, M.timing));
    flywheel.position.z = fwZ;
    this.crank.add(flywheel);
    this.flywheel = flywheel;
    this.fwZ = fwZ;

    // Clutch: pressure plate turns with the engine, disc with the gearbox input.
    const pressure = this.addMetal(new THREE.Mesh(cylAlongZ(1.22, 0.1, 48), M.steel));
    this.crank.add(pressure);
    this.pressurePlate = pressure;
    this.pressureZ = fwZ - 0.24;
    const disc = new THREE.Group();
    disc.add(this.addMetal(new THREE.Mesh(cylAlongZ(1.1, 0.05, 48), M.friction)));
    disc.add(this.addMetal(new THREE.Mesh(merge([0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i / 6) * Math.PI * 2;
      return new THREE.BoxGeometry(0.1, 0.2, 0.08).rotateZ(-a).translate(Math.sin(a) * 0.45, Math.cos(a) * 0.45, 0);
    })), M.chrome)));
    this.clutchDisc = disc;
    g.add(disc);
    this.discZ = fwZ - 0.13;
    disc.position.z = this.discZ;

    const bell = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.7, 0.75, 40, 1, true), M.glass);
    bell.rotation.x = Math.PI / 2;
    bell.position.z = fwZ - 0.2;
    const bellGroup = new THREE.Group();
    bellGroup.add(withEdges(bell, M.edge, 50));
    g.add(this.addExplodable(bellGroup, 'bell'));

    // Gearbox: input shaft on the axis, lay shaft below, gears sized from the ratios.
    const gbx = new THREE.Group();
    g.add(this.addExplodable(gbx, 'gearbox'));
    const gw = 0.15;
    const ratios = [...drive.gearRatios, drive.reverseRatio];
    const caseMesh = new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.35, boxLen), M.glass);
    caseMesh.position.set(0, -C / 2, z0 - boxLen / 2 + 0.15);
    gbx.add(withEdges(caseMesh, M.edge));
    this.gearboxCenter = caseMesh.position.clone();

    const input = new THREE.Group();
    const lay = new THREE.Group();
    lay.position.y = -C;
    const output = new THREE.Group();
    gbx.add(input, lay, output);
    input.add(this.addMetal(new THREE.Mesh(cylAlongZ(0.07, 0.9, 16), M.steel)));
    input.position.z = z0 + 0.3;
    // Constant-mesh head pair at 1:1, so each main gear turns at input / ratio.
    const head = new THREE.Mesh(gearGeometry(C * 0.5, gw), M.gear);
    head.position.z = -0.3;
    input.add(this.addMetal(head));
    lay.add(this.addMetal(new THREE.Mesh(cylAlongZ(0.07, boxLen - 0.2, 16), M.steel)));
    lay.position.z = z0 - boxLen / 2 + 0.15;
    const layHead = new THREE.Mesh(gearGeometry(C * 0.5, gw), M.gear);
    layHead.position.z = z0 - lay.position.z;
    lay.add(this.addMetal(layHead));
    const outLen = boxLen + 0.7;
    output.add(this.addMetal(new THREE.Mesh(merge([
      cylAlongZ(0.08, outLen, 16),
      cylAlongZ(0.22, 0.08, 24).translate(0, 0, -outLen / 2 + 0.1),
    ]), M.steel)));
    output.position.z = z0 - boxLen / 2 - 0.2;

    this.gearPairs = ratios.map((k, i) => {
      const z = z0 - spacing * (i + 1);
      const isReverse = i === ratios.length - 1;
      const kk = Math.max(0.5, Math.min(3.6, k));
      const rm = (C * kk) / (1 + kk);
      const rl = C / (1 + kk);
      const main = new THREE.Mesh(gearGeometry(rm, gw), M.gear);
      main.position.set(0, 0, z);
      gbx.add(main);
      const layGear = new THREE.Mesh(gearGeometry(rl, gw), M.gear);
      layGear.position.z = z - lay.position.z;
      lay.add(layGear);
      let idler = null;
      if (isReverse) {
        // Reverse idler beside the pair flips the output's direction.
        idler = new THREE.Mesh(gearGeometry(0.2, gw), M.gear);
        idler.position.set(0.48, -C * 0.55, z);
        gbx.add(idler);
      }
      return { main, layGear, idler, ratio: k, gear: isReverse ? 'R' : i + 1, z };
    });

    // Shift collars (1-2, 3-4, 5-R) slide towards the selected gear.
    this.collars = [0, 2, 4].map((i) => {
      const a = this.gearPairs[i];
      const b = this.gearPairs[i + 1];
      const collar = this.addMetal(new THREE.Mesh(cylAlongZ(0.17, 0.08, 24), M.chrome));
      const mid = (a.z + b.z) / 2;
      collar.position.z = mid;
      gbx.add(collar);
      return { collar, mid, a, b, pos: mid };
    });

    this.input = input;
    this.lay = lay;
    this.output = output;
    this.gbx = gbx;
  }

  // Thrown connecting rod and the breach in the block, hidden until blowUp().
  buildFailureProps() {
    const { B } = this.geom;
    const geo = this.rodGeo ?? new THREE.BoxGeometry(0.3, 0.12, 0.5);
    this.thrown = new THREE.Mesh(this.rodGeo ? geo.clone() : geo, this.M.rod);
    this.thrown.visible = false;
    this.addMetal(this.thrown);
    this.root.add(this.thrown);
    const jag = new THREE.Shape();
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const rr = B * (0.3 + 0.12 * Math.sin(i * 2.7) + 0.08 * Math.cos(i * 5.3));
      if (i === 0) jag.moveTo(rr * Math.cos(a), rr * Math.sin(a));
      else jag.lineTo(rr * Math.cos(a), rr * Math.sin(a));
    }
    const hole = new THREE.Mesh(new THREE.ShapeGeometry(jag), new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.DoubleSide }));
    hole.userData.ownMaterial = true;
    const glow = new THREE.Mesh(
      new THREE.RingGeometry(B * 0.28, B * 0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    glow.userData.ownMaterial = true;
    glow.position.z = 0.002;
    this.breach = new THREE.Group();
    this.breach.add(hole, glow);
    this.breach.visible = false;
    this.breachGlow = glow;
    this.engine.add(this.breach);
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  frameInfo() {
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
    return { sphere, center, dist };
  }

  presetPose(id) {
    const { sphere, center, dist } = this.frameInfo();
    const { B } = this.geom;
    let target = center;
    let dir = v3(0.95, 0.66, 1.0);
    let k = 1;
    if (id === 'front') {
      target = v3(center.x, center.y + B * 0.4, this.geom.front);
      dir = v3(0.14, 0.22, 1);
      k = 0.78;
    } else if (id === 'side') {
      target = sphere.center.clone();
      dir = v3(1, 0.16, -0.04);
      k = this.fitAll() / dist;
    } else if (id === 'top') {
      target = sphere.center.clone();
      dir = v3(0.04, 1, 0.3);
      k = (this.fitAll() / dist) * 0.92;
    } else if (id === 'valvetrain') {
      const bank = this.banks?.[0];
      if (bank) {
        const zs = bank.cyls.map((c) => c.z);
        // Front half of the first bank's head, seen from above its exhaust side.
        target = bank.headGroup.localToWorld(v3(0, this.geom.H.camY, (Math.max(...zs) * 2 + bank.zc) / 3));
        const axis = v3(Math.sin(bank.bankDeg * DEG), Math.cos(bank.bankDeg * DEG), 0);
        dir = axis.multiplyScalar(0.9).add(v3(0.2, 0.3, 0.75));
      } else {
        target = v3(0, 0, this.geom.front);
        dir = v3(0.5, 0.35, 1);
      }
      k = 0.52;
    } else if (id === 'gearbox') {
      target = this.gbx.localToWorld(this.gearboxCenter.clone());
      dir = v3(-0.9, 0.5, -0.5);
      k = 0.6;
    } else if (id === 'under') {
      target = center.clone();
      dir = v3(0.6, -0.72, 0.65);
      k = 0.95;
    }
    const position = target.clone().addScaledVector(dir.normalize(), dist * k);
    return { target, position, dist };
  }

  // Distance that fits the whole assembly across the narrower screen axis.
  fitAll() {
    const { sphere } = this.frameInfo();
    const vFov = this.camera.fov * DEG;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const usable = Math.max(0.35, 1 - (this.insets.top + this.insets.bottom) / Math.max(1, this.height));
    return (sphere.radius * 0.92) / Math.sin(Math.min(vFov * usable, hFov) / 2);
  }

  frameModel(resetView) {
    if (!this.bounds) return;
    const { sphere, dist } = this.frameInfo();
    this.controls.minDistance = sphere.radius * 0.25;
    this.controls.maxDistance = dist * 3;
    if (resetView) {
      // Front-left three-quarter view by default: pulley end towards the viewer, gearbox behind on the right.
      const pose = this.presetPose(this.rig.active);
      this.rig.flyTo(pose.target, pose.position, true);
    }
  }

  resetView() {
    this.rig.active = 'hero';
    this.rig.setCinematic(false);
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
    this.post.setSize(width, height);
    this.effects.setScale((height * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * DEG) / 2)));
  }

  // ── Per-frame pose ────────────────────────────────────────────────────────

  update(dt, view) {
    const { crankDeg, inputDeg, outputDeg, sim, showFlashes, frozen } = view;
    const p = this.profile;
    const settings = view.settings ?? {};
    this.time += dt;

    if (this.explodeT !== this.explodeTarget) {
      const d = this.explodeTarget - this.explodeT;
      const step = Math.sign(d) * Math.max(Math.abs(d) * (1 - Math.exp(-dt * 4.5)), dt * 0.05);
      const before = this.explodeT;
      this.explodeT = Math.abs(step) >= Math.abs(d) ? this.explodeTarget : this.explodeT + step;
      this.applyExplode(this.explodeT);
      // Dolly out as the parts spread so the exploded engine stays in frame.
      if (!this.rig.flight) {
        const k = (1 + 0.45 * this.explodeT) / (1 + 0.45 * before);
        this.tmp.subVectors(this.camera.position, this.controls.target).multiplyScalar(k);
        this.camera.position.copy(this.controls.target).add(this.tmp);
      }
    }

    // Piston cranks are drawn turning −θ about +Z; the Wankel's eccentric shaft
    // turns +θ so it follows the rotor's orbit.
    this.crank.rotation.z = (p.kind === 'rotary' ? 1 : -1) * crankDeg * DEG;

    // Torque reaction: the block rolls slightly against the crank.
    const target = (-sim.engineTorque / p.peakTorqueNm) * 0.035;
    this.reactionAngle += (target - this.reactionAngle) * Math.min(1, dt * 10);
    this.engine.rotation.z = this.reactionAngle;
    this.engine.updateMatrixWorld();

    const lit = this.lit ?? (this.lit = []);
    lit.length = 0;
    const burning = sim.running && !sim.fuelCut && showFlashes;
    const strength = 0.45 + 0.55 * Math.min(1, sim.throttleEffective * 1.6);
    const load = clamp01(sim.throttleEffective ?? 0);
    const sp = this.sparks;
    const strokes = this.strokes ?? (this.strokes = []);
    const labelPts = this.labelPts ?? (this.labelPts = []);
    labelPts.length = 0;
    strokes.length = 0;

    if (p.kind === 'rotary') {
      const { R, e } = this.geom;
      const flow = this.flow ?? (this.flow = [0, 0]);
      this.rotors.forEach((k, i) => {
        const pose = rotorPose(crankDeg, k.phase, R, e);
        k.rotor.position.x = pose.center[0];
        k.rotor.position.y = pose.center[1];
        k.rotor.rotation.z = pose.rotation;
        const since = rotorDegreesSinceFiring(crankDeg, k.phase);
        const f = burning ? combustionFlash(since, 110) * strength : 0;
        setRotZ(this.m4, 0, 0.55, 0, -(R - e) * 0.72, k.z);
        this.m4.elements[0] = 2.2;
        this.m4.elements[10] = 1.4;
        this.glows.setMatrixAt(i, this.m4);
        this.glows.setColorAt(i, this.color.setRGB(f * 1.0, f * 0.26, f * 0.05));
        if (f > 0.01) lit.push(f, i);
        this.tmp.set(0, -(R - e) * 0.72, k.z).applyMatrix4(this.core.matrix);
        this.writeSparks(i, f, this.tmp, 0.5);
        rotaryPortFlow(since, flow);
        this.portMarks.setColorAt(i * 2, this.color.setRGB(0.2 * flow[0], 0.45 * flow[0], 1.3 * flow[0]));
        this.portMarks.setColorAt(i * 2 + 1, this.color.setRGB(1.4 * flow[1], 0.5 * flow[1], 0.12 * flow[1]));
        if (frozen) {
          // The face that fired last: expanding for 270° of shaft, then exhausting.
          strokes.push(since < 270 ? 0 : 1);
          labelPts.push(this.engine.localToWorld(k.label.set(-(R + 0.75), 0.2, k.z)));
        }
      });
      this.glows.instanceMatrix.needsUpdate = true;
      this.glows.instanceColor.needsUpdate = true;
      this.portMarks.instanceColor.needsUpdate = true;
    } else {
      const { r, L, compH, deck, B, H } = this.geom;
      const gasOn = this.display.strokeGases;
      const glowK = gasOn ? 0.5 : 0.9;
      for (let i = 0; i < this.cyls.length; i++) {
        const k = this.cyls[i];
        const pose = cylinderPose(k.c, crankDeg, r, L);
        this.pistons.setMatrixAt(i, setRotZ(this.m4, k.axisRot, 1, pose.piston[0], pose.piston[1], k.z));
        this.rings.setMatrixAt(i, this.m4);
        const dx = pose.piston[0] - pose.pin[0];
        const dy = pose.piston[1] - pose.pin[1];
        setRotZ(this.m4, -Math.atan2(dx, dy), 1, pose.pin[0], pose.pin[1], k.z);
        if (i === this.hiddenRod) this.m4.makeScale(0, 0, 0); // thrown out of the block
        this.rods.setMatrixAt(i, this.m4);
        const since = degreesSinceFiring(k.c.fireDeg, crankDeg);
        const f = burning ? combustionFlash(since, 130) * strength : 0;
        const crown = pose.pY + compH;
        const gapLen = Math.max(0.02, deck - crown);
        const mid = (deck + crown) / 2;
        setRotZ(this.m4, k.axisRot, Math.max(0.25, gapLen / (B * 0.88)), k.ax * mid, k.ay * mid, k.z);
        this.glows.setMatrixAt(i, this.m4);
        const fk = f * glowK;
        this.glows.setColorAt(i, this.color.setRGB(fk, fk * 0.22, fk * 0.04));
        if (gasOn) this.gases.write(i, k.ax * mid, k.ay * mid, k.z, k.axisRot, gapLen, since, load, burning);
        if (f > 0.01) lit.push(f, i);
        this.tmp.set(k.ax * mid, k.ay * mid, k.z);
        this.writeSparks(i, f, this.tmp, gapLen / B);
        if (frozen) {
          strokes.push(strokeIndex(since));
          labelPts.push(k.headGroup.localToWorld(k.label.set(0, H.top + 0.75 * B, k.z)));
        }
      }
      this.pistons.instanceMatrix.needsUpdate = true;
      this.rings.instanceMatrix.needsUpdate = true;
      this.rods.instanceMatrix.needsUpdate = true;
      this.glows.instanceMatrix.needsUpdate = true;
      this.glows.instanceColor.needsUpdate = true;
      if (gasOn) this.gases.commit();
      if (this.display.valvetrain) this.valvetrain.update(crankDeg);
    }
    sp.pts.geometry.attributes.position.needsUpdate = true;
    sp.pts.geometry.attributes.color.needsUpdate = true;

    // The two strongest flashes get the point lights (lit holds f, index pairs).
    for (let li = 0; li < this.flashLights.length; li++) {
      let best = -1;
      let bestF = 0.01;
      for (let j = 0; j < lit.length; j += 2) {
        if (lit[j] > bestF) {
          bestF = lit[j];
          best = j;
        }
      }
      const light = this.flashLights[li];
      if (best >= 0) {
        const idx = lit[best + 1];
        lit[best] = 0;
        if (p.kind === 'rotary') this.tmp.set(0, -(this.geom.R - this.geom.e) * 0.72, this.rotors[idx].z).applyMatrix4(this.core.matrix);
        else {
          const k = this.cyls[idx];
          const mid = this.geom.deck * 0.92;
          this.tmp.set(k.ax * mid, k.ay * mid, k.z);
        }
        light.position.copy(this.engine.localToWorld(this.tmp));
        light.intensity = bestF * 9;
      } else light.intensity = 0;
    }

    // Exhaust heat, flames, induction.
    const egt = typeof sim.egtC === 'number'
      ? sim.egtC
      : 350 + 560 * (sim.running ? clamp01(sim.throttleEffective ?? 0) * clamp01(sim.rpm / p.redlineRpm + 0.2) : 0);
    this.exhaust.update(dt, egt);
    // A turbo freewheels on exhaust flow even off boost.
    const turboRpm = Math.max(typeof sim.turboRpm === 'number' ? sim.turboRpm : 0, sim.running ? sim.rpm * 8 : 0);
    this.inductionHw.update(dt, crankDeg, turboRpm, settings.visualSpeed ?? 1);
    const flameNow = this.exhaust.flameNow;
    this.fxLightLevel = Math.max(this.fxLightLevel * Math.exp(-dt * 6), flameNow);
    if (flameNow > 0.02 && this.exhaust.tips.length) {
      this.fxLight.position.copy(this.engine.localToWorld(this.tmp.copy(this.exhaust.tips[0])));
      this.fxLight.position.z -= 0.4;
    }
    this.fxLight.intensity = this.fxLightLevel * 14;

    this.updateDriveline(dt, sim, inputDeg, outputDeg);
    this.updateFailure(dt, sim);
    this.effects.update(dt);

    this.rig.update(dt);
    this.controls.update();
    if (frozen && labelPts.length) {
      this.camera.updateMatrixWorld();
      this.labels.update(this.camera, labelPts, strokes, this.width, this.height, this.insets);
    } else this.labels.hide();
  }

  updateDriveline(dt, sim, inputDeg, outputDeg) {
    const pedal = sim.clutchPedal;
    const sep = clamp01(pedal / 0.8);
    explodeOffset('flywheel', 0, this.explodeT, this.geom.B, this.off);
    const fly = this.off[2];
    explodeOffset('clutch', 0, this.explodeT, this.geom.B, this.off);
    const clutch = this.off[2];
    this.flywheel.position.z = this.fwZ + fly;
    this.pressurePlate.position.z = this.pressureZ - sep * 0.07 + (fly + clutch) / 2;
    this.clutchDisc.position.z = this.discZ - sep * 0.035 + clutch;
    this.clutchDisc.rotation.z = -inputDeg * DEG;
    const inAngle = inputDeg * DEG;
    this.input.rotation.z = -inAngle;
    this.lay.rotation.z = inAngle; // meshing gears counter-rotate
    const xray = this.display.xray;
    for (const gp of this.gearPairs) {
      const live = gp.gear === sim.gear;
      const mat = live ? (xray ? this.xrayLive : this.M.gearLive) : (xray ? this.xrayMat : this.M.gear);
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

  applyExplode(t) {
    const B = this.geom.B;
    for (const e of this.explodables) {
      if (!e.base) continue;
      explodeOffset(e.part, e.bankDeg, t, B, this.off);
      e.obj.position.set(e.base.x + this.off[0], e.base.y + this.off[1], e.base.z + this.off[2]);
    }
    this.valvetrain?.setExplode(t);
    if (this.inductionHw?.belt) this.inductionHw.belt.visible = t < 0.01;
  }

  // ── Failure ───────────────────────────────────────────────────────────────

  updateFailure(dt, sim) {
    const bl = this.blown;
    const B = this.geom.B;
    if (bl) {
      bl.t += dt;
      // Thrown rod: ballistic, tumbling, then it lands and slides to a stop.
      const th = this.thrown;
      if (!bl.resting) {
        bl.vel.y -= 32 * dt;
        th.position.addScaledVector(bl.vel, dt);
        th.rotation.x += bl.spin.x * dt;
        th.rotation.y += bl.spin.y * dt;
        th.rotation.z += bl.spin.z * dt;
        const floorY = this.floor.position.y + 0.12 * B;
        if (th.position.y < floorY) {
          th.position.y = floorY;
          bl.vel.y = Math.abs(bl.vel.y) * 0.3;
          bl.vel.x *= 0.55;
          bl.vel.z *= 0.55;
          bl.spin.multiplyScalar(0.45);
          if (bl.vel.y < 0.8) {
            bl.resting = true;
            th.rotation.x = Math.PI / 2;
            th.rotation.y = 0;
          }
        }
      }
      // Smoke pours from the breach, thinning over a few seconds.
      const rate = 34 * Math.exp(-bl.t / 2.6) + 3.5;
      this.smokeDebt += rate * dt;
      if (this.smokeDebt >= 1) {
        const count = Math.floor(this.smokeDebt);
        this.smokeDebt -= count;
        const at = this.breach.localToWorld(this.tmp.set(0, 0, 0.05));
        this.effects.smokeBurst(at, this.tmp2.copy(this.geom.breachNormal).multiplyScalar(0.6).add(v3(0, 1, 0)), count, 1.6, 1.5 * B, 0.2, 0.5, 3.4);
      }
      this.breachGlow.material.opacity = 0.25 + 0.75 * Math.exp(-bl.t / 1.4) * (0.8 + 0.2 * Math.sin(this.time * 23));
    } else if ((sim.damage ?? 0) > 0.4 && sim.running) {
      // A tired engine trails light smoke from the breather.
      this.smokeDebt += (sim.damage - 0.4) * 6 * dt;
      if (this.smokeDebt >= 1) {
        this.smokeDebt -= 1;
        const at = this.engine.localToWorld(this.tmp.set(0, (this.geom.caseTop ?? 0) + 0.3 * B, 0));
        this.effects.smokeBurst(at, this.tmp2.set(0, 1, -0.2), 1, 1.0, 0.5 * B, 0.5, 0.3, 2.4);
      }
    }
  }

  // ── View API (docs/CONTRACT.md → "EngineView API") ─────────────────────────

  /** Apply display settings: strokeGases, valvetrain, xray, cutaway, quality. Receives the full settings object. */
  setDisplay(settings = {}) {
    const next = {
      strokeGases: settings.strokeGases ?? true,
      valvetrain: settings.valvetrain ?? true,
      xray: !!settings.xray,
      cutaway: !!settings.cutaway,
      quality: settings.quality ?? 'auto',
    };
    const qualityChanged = next.quality !== this.display.quality;
    this.display = next;
    if (this.root) this.applyDisplay();
    if (qualityChanged) {
      this.quality = initialQuality(next.quality, deviceCaps());
      this.applyQuality();
    }
  }

  applyDisplay() {
    const d = this.display;
    const M = this.M;
    if (this.gases) this.gases.mesh.visible = d.strokeGases;
    if (this.valvetrain) for (const o of this.valvetrain.objects) o.visible = d.valvetrain;
    if (this.portMarks) this.portMarks.visible = d.valvetrain;
    for (const m of this.metal) m.material = d.xray ? this.xrayMat : m.userData.baseMaterial;
    // Housings: nearly gone in x-ray; solid castings in cutaway so the cut reads.
    const solid = d.cutaway && !d.xray;
    this.setHousing(M.glass, solid ? { color: 0x4a5463, opacity: 1, metalness: 0.55, roughness: 0.42 } : this.housingLook.glass, d.xray ? 0.05 : null);
    this.setHousing(M.glassDark, solid ? { color: 0x2c333e, opacity: 1, metalness: 0.5, roughness: 0.4 } : this.housingLook.glassDark, d.xray ? 0.07 : null);
    M.edge.color.set(this.blown ? 0xff6a3a : d.xray ? 0x7fd8ff : solid ? 0xc6d4e8 : 0xa9bedc);
    M.edge.opacity = d.xray ? 0.5 : solid ? 0.5 : 0.3;
    for (const mat of [M.glass, M.glassDark, M.edge]) {
      const planes = d.cutaway ? this.cutPlanes : null;
      if (mat.clippingPlanes !== planes) {
        mat.clippingPlanes = planes;
        mat.clipIntersection = true;
        mat.needsUpdate = true;
      }
    }
    if (this.geom) this.cutPlanes[1].constant = -0.25 * this.geom.B;
  }

  setHousing(mat, look, opacityOverride) {
    const opaque = look.opacity >= 1 && opacityOverride === null;
    if (mat.transparent === opaque) {
      mat.transparent = !opaque;
      mat.depthWrite = opaque;
      // Solid housings show cut faces in the section colour.
      if (opaque) mat.defines = { ...mat.defines, SECTION_FACES: '' };
      else if (mat.defines) delete mat.defines.SECTION_FACES;
      mat.needsUpdate = true;
    }
    mat.color.set(look.color);
    mat.metalness = look.metalness;
    mat.roughness = look.roughness;
    mat.opacity = opacityOverride ?? look.opacity;
  }

  applyQuality() {
    const q = this.quality;
    this.maxPixelRatio = q.maxPixelRatio;
    this.pixelRatio = q.pixelRatio;
    this.renderer.setPixelRatio(q.pixelRatio);
    this.post.setEnabled(q.bloom);
    if (this.width > 1) this.resize(this.width, this.height, this.insets);
  }

  /** Whether bloom is currently on (for tests and the HUD). */
  get bloomActive() {
    return this.post.enabled;
  }

  /** Animate towards an exploded view: 0 = assembled, 1 = fully exploded. */
  setExplode(target) {
    this.explodeTarget = clamp01(Number(target) || 0);
  }

  /** Camera preset names, in cycle order. */
  get cameraPresets() {
    return CAMERA_PRESETS;
  }

  /** Fly the camera to a named preset; returns a human-readable label. */
  setCameraPreset(name) {
    const id = CAMERA_PRESETS.includes(name) ? name : 'hero';
    this.rig.active = id;
    if (this.bounds) {
      const pose = this.presetPose(id);
      this.rig.flyTo(pose.target, pose.position);
    }
    return this.rig.label(id, this.profile?.kind === 'rotary');
  }

  /** Slow automatic orbit; any user camera input turns it off. */
  setCinematic(on) {
    this.rig.setCinematic(on);
  }

  get cinematic() {
    return this.rig.cinematic;
  }

  /** Camera shake impulse, 0..1. */
  shake(amount) {
    this.rig.shake(clamp01(Number(amount) || 0));
  }

  /** One-shot effect: kind 'flame' | 'bov' | 'smoke' | 'sparks'; opts.strength 0..1. */
  burst(kind, opts = {}) {
    if (!this.root) return;
    const s = clamp01(opts.strength ?? 0.7);
    const B = this.geom.B;
    if (kind === 'flame') {
      this.exhaust.flame(s);
      for (const tip of this.exhaust.tips) {
        const at = this.engine.localToWorld(this.tmp.copy(tip));
        this.effects.sparkBurst(at, this.tmp2.set(0, 0.15, -1), Math.round(4 + 10 * s), 6 + 6 * s, 0.6, 0.1 * B);
      }
    } else if (kind === 'bov') {
      const at = this.inductionHw.group.localToWorld(this.tmp.copy(this.inductionHw.bovPoint));
      this.effects.smokeBurst(at, this.tmp2.set(0.3, 1, 0.5), Math.round(10 + 14 * s), 2.2, 0.45 * B, 0.95, 0.32, 0.8);
    } else if (kind === 'smoke') {
      const at = this.engine.localToWorld(this.tmp.set(0, (this.geom.caseTop ?? 0) + 0.6 * B, 0));
      this.effects.smokeBurst(at, this.tmp2.set(0, 1, 0), Math.round(8 + 20 * s), 1.4, 0.8 * B, 0.2, 0.5, 2.6);
    } else if (kind === 'sparks') {
      const at = this.engine.localToWorld(this.tmp.copy(this.geom.breachAt));
      this.effects.sparkBurst(at, this.tmp2.copy(this.geom.breachNormal).add(v3(0, 0.6, 0)).normalize(), Math.round(20 + 60 * s), 9, 1.1, 0.07 * B);
    }
  }

  /**
   * Catastrophic failure: a rod leaves through the side of the block in smoke
   * and sparks. opts.instant shows the aftermath without the explosion (used
   * when the model is rebuilt while the engine is still blown).
   */
  blowUp(opts = {}) {
    if (!this.root || this.blown) return;
    const B = this.geom.B;
    const n = this.geom.breachNormal;
    let rodPos;
    let z = 0;
    if (this.cyls) {
      // The cylinder on the side facing the camera, nearest the front.
      let best = 0;
      let bestScore = -Infinity;
      this.cyls.forEach((k, i) => {
        const score = (n.y ? k.ay : k.ax) * 10 + k.z;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      });
      this.hiddenRod = best;
      this.rods.getMatrixAt(best, this.m4);
      rodPos = v3().setFromMatrixPosition(this.m4);
      z = this.cyls[best].z;
      this.thrown.quaternion.setFromRotationMatrix(this.m4);
    } else {
      rodPos = v3(0, 0, this.rotors[0].z);
      z = this.rotors[0].z;
      this.thrown.rotation.set(0, 0, 0);
    }
    this.engine.localToWorld(rodPos);
    this.thrown.position.copy(rodPos);
    this.thrown.visible = true;
    this.blown = {
      t: 0, resting: false,
      vel: v3(n.x * 3.4 + 0.5, 8 + n.y * 2, 1.8),
      spin: v3(7, 3.5, 11),
    };
    // Breach in the block where the rod came out.
    const at = this.geom.breachAt;
    this.breach.position.set(at.x, at.y, z);
    this.breach.lookAt(this.tmp.copy(this.breach.position).add(n));
    this.breach.visible = true;
    if (opts.instant) {
      // Let the rod land where it would have, without the fireworks.
      for (let i = 0; i < 600 && !this.blown.resting; i++) this.updateFailure(1 / 60, { damage: 1 });
      this.blown.t = 30;
      this.effects.clear();
      this.M.edge.color.set(0xff6a3a);
      return;
    }
    const world = this.engine.localToWorld(this.tmp.set(at.x, at.y, z));
    this.effects.sparkBurst(world, this.tmp2.copy(n).add(v3(0, 0.5, 0.1)).normalize(), 160, 12, 1.2, 0.13 * B);
    this.effects.smokeBurst(world, this.tmp2.copy(n).add(v3(0, 0.8, 0)), 44, 2.8, 1.7 * B, 0.18, 0.6, 3.6);
    this.fxLight.position.copy(world).addScaledVector(n, 0.6);
    this.fxLightLevel = 2.2;
    this.M.edge.color.set(0xff6a3a);
    this.rig.shake(1);
  }

  /** Undo blowUp(): the engine is whole again. */
  restore() {
    this.blown = null;
    this.hiddenRod = -1;
    if (this.thrown) this.thrown.visible = false;
    if (this.breach) this.breach.visible = false;
    this.effects.clear();
    this.applyDisplay();
  }

  get isBlown() {
    return !!this.blown;
  }

  render() {
    const shaking = this.rig.beginShake(this.bounds ? this.bounds.getSize(this.tmp).length() * 0.012 : 0.05);
    this.post.render();
    if (shaking) this.rig.endShake();
  }

  /**
   * Adapt to the frame rate: in 'auto' bloom goes first, then resolution;
   * both come back when there is headroom (policy in scene/quality.js).
   */
  adaptQuality(frameMs) {
    const t = this.frameTimes;
    t.push(frameMs);
    if (t.length < QUALITY_WINDOW) return;
    let sum = 0;
    for (const v of t) sum += v;
    t.length = 0;
    if (adaptQuality(this.quality, sum / QUALITY_WINDOW)) this.applyQuality();
  }
}

// Driveline: flywheel and clutch on the crank, bell housing and a two-shaft
// gearbox whose gears are sized from the ratios, with sliding shift collars.

import * as THREE from 'three';
import { Z_AXIS, cylAlongZ, gearGeometry, merge, withEdges } from './geometry.js';

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Gearbox layout shared by the driveline and the exhaust that runs past it. */
export function drivelineDims(back, drive) {
  const fwZ = back - 0.2;
  const z0 = fwZ - 0.75;
  const spacing = 0.3;
  const pairs = drive.gearRatios.length + 1;
  const boxLen = spacing * (pairs + 1) + 0.5;
  const caseFront = z0 + 0.15;
  return { fwZ, z0, spacing, boxLen, caseFront, outputEnd: z0 - boxLen - 0.55, C: 0.82 };
}

/** Build the driveline behind the engine (view.dl from drivelineDims). */
export function buildDriveline(view, drive) {
  const M = view.M;
  const { fwZ, z0, spacing, boxLen, C } = view.dl;
  const g = new THREE.Group();
  view.root.add(g);

  // Flywheel with ring gear, bolted to the crank.
  const fwR = 1.45;
  const flywheel = new THREE.Group();
  flywheel.add(view.addMetal(new THREE.Mesh(cylAlongZ(fwR, 0.16, 64), M.darkSteel)));
  const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.07, 0.13), M.steel, 96);
  const q = new THREE.Quaternion();
  const one = v3(1, 1, 1);
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    q.setFromAxisAngle(Z_AXIS, -a);
    view.m4.compose(v3(Math.sin(a) * (fwR + 0.03), Math.cos(a) * (fwR + 0.03), 0), q, one);
    teeth.setMatrixAt(i, view.m4);
  }
  flywheel.add(view.addMetal(teeth));
  const marks = merge([0, Math.PI].map((a) => {
    const m = new THREE.BoxGeometry(0.1, 0.32, 0.03);
    m.rotateZ(-a);
    return m.translate(Math.sin(a) * (fwR - 0.3), Math.cos(a) * (fwR - 0.3), 0.09);
  }));
  flywheel.add(new THREE.Mesh(marks, M.timing));
  flywheel.position.z = fwZ;
  view.crank.add(flywheel);
  view.flywheel = flywheel;
  view.fwZ = fwZ;

  // Clutch: pressure plate turns with the engine, disc with the gearbox input.
  const pressure = view.addMetal(new THREE.Mesh(cylAlongZ(1.22, 0.1, 48), M.steel));
  view.crank.add(pressure);
  view.pressurePlate = pressure;
  view.pressureZ = fwZ - 0.24;
  const disc = new THREE.Group();
  disc.add(view.addMetal(new THREE.Mesh(cylAlongZ(1.1, 0.05, 48), M.friction)));
  disc.add(view.addMetal(new THREE.Mesh(merge([0, 1, 2, 3, 4, 5].map((i) => {
    const a = (i / 6) * Math.PI * 2;
    return new THREE.BoxGeometry(0.1, 0.2, 0.08).rotateZ(-a).translate(Math.sin(a) * 0.45, Math.cos(a) * 0.45, 0);
  })), M.chrome)));
  view.clutchDisc = disc;
  g.add(disc);
  view.discZ = fwZ - 0.13;
  disc.position.z = view.discZ;

  const bell = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.7, 0.75, 40, 1, true), M.glass);
  bell.rotation.x = Math.PI / 2;
  bell.position.z = fwZ - 0.2;
  const bellGroup = new THREE.Group();
  bellGroup.add(withEdges(bell, M.edge, 50));
  g.add(view.addExplodable(bellGroup, 'bell'));

  // Gearbox: input shaft on the axis, lay shaft below, gears sized from the ratios.
  const gbx = new THREE.Group();
  g.add(view.addExplodable(gbx, 'gearbox'));
  const gw = 0.15;
  const ratios = [...drive.gearRatios, drive.reverseRatio];
  const caseMesh = new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.35, boxLen), M.glass);
  caseMesh.position.set(0, -C / 2, z0 - boxLen / 2 + 0.15);
  gbx.add(withEdges(caseMesh, M.edge));
  view.gearboxCenter = caseMesh.position.clone();

  const input = new THREE.Group();
  const lay = new THREE.Group();
  lay.position.y = -C;
  const output = new THREE.Group();
  gbx.add(input, lay, output);
  input.add(view.addMetal(new THREE.Mesh(cylAlongZ(0.07, 0.9, 16), M.steel)));
  input.position.z = z0 + 0.3;
  // Constant-mesh head pair at 1:1, so each main gear turns at input / ratio.
  const head = new THREE.Mesh(gearGeometry(C * 0.5, gw), M.gear);
  head.position.z = -0.3;
  input.add(view.addMetal(head));
  lay.add(view.addMetal(new THREE.Mesh(cylAlongZ(0.07, boxLen - 0.2, 16), M.steel)));
  lay.position.z = z0 - boxLen / 2 + 0.15;
  const layHead = new THREE.Mesh(gearGeometry(C * 0.5, gw), M.gear);
  layHead.position.z = z0 - lay.position.z;
  lay.add(view.addMetal(layHead));
  const outLen = boxLen + 0.7;
  output.add(view.addMetal(new THREE.Mesh(merge([
    cylAlongZ(0.08, outLen, 16),
    cylAlongZ(0.22, 0.08, 24).translate(0, 0, -outLen / 2 + 0.1),
  ]), M.steel)));
  output.position.z = z0 - boxLen / 2 - 0.2;

  view.gearPairs = ratios.map((k, i) => {
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
  view.collars = [0, 2, 4].map((i) => {
    const a = view.gearPairs[i];
    const b = view.gearPairs[i + 1];
    const collar = view.addMetal(new THREE.Mesh(cylAlongZ(0.17, 0.08, 24), M.chrome));
    const mid = (a.z + b.z) / 2;
    collar.position.z = mid;
    gbx.add(collar);
    return { collar, mid, a, b, pos: mid };
  });

  view.input = input;
  view.lay = lay;
  view.output = output;
  view.gbx = gbx;
}

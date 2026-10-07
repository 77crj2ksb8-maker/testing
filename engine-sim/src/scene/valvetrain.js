// DOHC valvetrain: per bank an intake and an exhaust camshaft turning at half
// crank speed, two intake + two exhaust poppet valves per cylinder with
// springs and bucket followers, and a timing chain from the crank sprocket.
// Valve lift follows the four-stroke timing (timing.js) and every lobe points
// at its follower exactly when that valve is fully open.

import * as THREE from 'three';
import {
  INTAKE_PEAK, EXHAUST_PEAK, INTAKE_DURATION, EXHAUST_DURATION, camLobeAngle, camRotationDeg, intakeLift, exhaustLift,
} from './timing.js';
import { bankToEngine, chainPath, pointOnPath, explodeOffset } from './layout.js';
import { camshaftGeometry, valveGeometry, springGeometry, cylAlongZ, setRotZ } from './geometry.js';

const DEG = Math.PI / 180;

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

/**
 * Build the valvetrain into each bank's head group.
 * ctx: {B, head (headDims), chainZ, banks: [{bankDeg, side, group, cyls: [{c, z}]}], M, crank (Object3D)}
 */
export function buildValvetrain(ctx) {
  const { B, head: H, chainZ, banks, M } = ctx;
  const metal = [];
  const objects = [];
  const intakeGeo = valveGeometry(0.17 * B, 0.028 * B, H.stemLen);
  const exhaustGeo = valveGeometry(0.145 * B, 0.028 * B, H.stemLen);
  const springGeo = springGeometry(H.springR, 0.014 * B, 6);
  const bucketGeo = new THREE.CylinderGeometry(H.bucketR, H.bucketR, H.bucketH, 18);
  bucketGeo.translate(0, H.bucketH / 2, 0);
  const lobeW = 0.11 * B;

  const bankParts = banks.map((bank, b) => {
    const valves = [];
    const n = bank.cyls.length * 2;
    const make = (geo, mat, count) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      bank.group.add(m);
      objects.push(m);
      metal.push(m);
      return m;
    };
    const intake = make(intakeGeo, M.valveIntake, n);
    const exhaust = make(exhaustGeo, M.valveExhaust, n);
    const springs = make(springGeo, M.spring, n * 2);
    const buckets = make(bucketGeo, M.steel, n * 2);

    const zs = bank.cyls.map((k) => k.z);
    const zBack = Math.min(...zs) - 0.45 * B;
    const cams = [];
    for (const kind of ['intake', 'exhaust']) {
      // Intake valves sit on the side away from the exhaust.
      const sigma = kind === 'intake' ? -bank.side : bank.side;
      const ux = sigma * Math.sin(H.tilt);
      const uy = Math.cos(H.tilt);
      const followerDeg = Math.atan2(-uy, -ux) / DEG;
      const peak = kind === 'intake' ? INTAKE_PEAK : EXHAUST_PEAK;
      const lobes = [];
      for (const k of bank.cyls) {
        const angleDeg = camLobeAngle(k.c.fireDeg, peak, followerDeg);
        for (const dz of [-H.valveZ, H.valveZ]) {
          lobes.push({ z: k.z + dz, angleDeg });
          valves.push({
            kind, k, x: sigma * H.valveX, y: H.deck, z: k.z + dz, ux, uy, rot: -sigma * H.tilt,
          });
        }
      }
      const geo = camshaftGeometry({
        lobes, baseR: H.baseR, lift: H.lift, width: lobeW,
        durationDeg: kind === 'intake' ? INTAKE_DURATION : EXHAUST_DURATION,
        zFront: chainZ + b * 0.15 * B, zBack, sprocketR: H.sprocketR, sprocketTeeth: 32,
      });
      const cam = new THREE.Mesh(geo, M.cam);
      cam.position.set(sigma * H.camX, H.camY, 0);
      bank.group.add(cam);
      objects.push(cam);
      metal.push(cam);
      cams.push({ cam, x: sigma * H.camX, y: H.camY });
    }
    return { bank, intake, exhaust, springs, buckets, valves, cams };
  });

  // Timing chains: one loop per bank from the crank sprocket round that
  // bank's two cam sprockets, each bank in its own plane.
  const planeGap = 0.15 * B;
  const crankSprocket = new THREE.Mesh(cylAlongZ(H.crankSprocketR, 0.1 * B + planeGap * (bankParts.length - 1), 18), M.steel);
  crankSprocket.position.z = chainZ + (planeGap * (bankParts.length - 1)) / 2;
  ctx.crank.add(crankSprocket);
  metal.push(crankSprocket);
  const linkPitch = 0.11 * B;
  const linkGeo = new THREE.BoxGeometry(linkPitch * 0.86, 0.045 * B, 0.12 * B);
  const tmp = [0, 0];
  const off = [0, 0, 0];
  const circlesAt = (bp, t) => {
    explodeOffset('head', bp.bank.bankDeg, t, B, off);
    const list = [{ x: 0, y: 0, r: H.crankSprocketR + 0.02 * B }];
    for (const c of bp.cams) {
      bankToEngine(bp.bank.bankDeg, c.x, c.y, tmp);
      list.push({ x: tmp[0] + off[0], y: tmp[1] + off[1], r: H.sprocketR + 0.02 * B });
    }
    return list;
  };
  let capacity = 0;
  const loops = bankParts.map((bp, b) => {
    const max = Math.ceil(chainPath(circlesAt(bp, 1), 24).total / linkPitch) + 4;
    const loop = { bp, z: chainZ + b * planeGap, start: capacity, max, count: 0, path: null };
    capacity += max;
    return loop;
  });
  const chain = new THREE.InstancedMesh(linkGeo, M.chain, capacity);
  chain.frustumCulled = false;
  chain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  objects.push(chain);
  metal.push(chain);

  const m4 = new THREE.Matrix4();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const pt = [0, 0, 0];
  let pathT = -1;
  let travel = 0; // chain travel, accumulated so it never jumps when the crank angle wraps
  let lastCrank = null;

  function setExplode(t) {
    if (t === pathT) return;
    pathT = t;
    for (const loop of loops) {
      loop.path = chainPath(circlesAt(loop.bp, t), 36);
      loop.count = Math.min(loop.max, Math.max(8, Math.round(loop.path.total / linkPitch)));
      for (let i = loop.count; i < loop.max; i++) chain.setMatrixAt(loop.start + i, hidden);
    }
  }
  setExplode(0);

  function update(crankDeg) {
    const camRot = camRotationDeg(crankDeg) * DEG;
    for (const bp of bankParts) {
      for (const c of bp.cams) c.cam.rotation.z = camRot;
      let iv = 0;
      let ev = 0;
      for (let i = 0; i < bp.valves.length; i++) {
        const v = bp.valves[i];
        const since = crankDeg - v.k.c.fireDeg;
        const lift = (v.kind === 'intake' ? intakeLift(since) : exhaustLift(since)) * H.lift;
        // The valve opens down into the chamber, along its own axis.
        const vx = v.x - v.ux * lift;
        const vy = v.y - v.uy * lift;
        const target = v.kind === 'intake' ? bp.intake : bp.exhaust;
        target.setMatrixAt(v.kind === 'intake' ? iv++ : ev++, setRotZ(m4, v.rot, 1, vx, vy, v.z));
        const seat = H.springSeat;
        const topAlong = H.stemLen - lift;
        bp.springs.setMatrixAt(i, setRotZ(m4, v.rot, topAlong - seat, v.x + v.ux * seat, v.y + v.uy * seat, v.z));
        bp.buckets.setMatrixAt(i, setRotZ(m4, v.rot, 1, v.x + v.ux * topAlong, v.y + v.uy * topAlong, v.z));
      }
      bp.intake.instanceMatrix.needsUpdate = true;
      bp.exhaust.instanceMatrix.needsUpdate = true;
      bp.springs.instanceMatrix.needsUpdate = true;
      bp.buckets.instanceMatrix.needsUpdate = true;
    }

    // Links move with the crank sprocket's rim: clockwise seen from the front.
    if (lastCrank !== null) {
      let d = crankDeg - lastCrank;
      if (d > 1080) d -= 2160;
      else if (d < -1080) d += 2160;
      travel -= d * DEG * (H.crankSprocketR + 0.02 * B);
    }
    lastCrank = crankDeg;
    for (const loop of loops) {
      const step = loop.path.total / loop.count;
      for (let i = 0; i < loop.count; i++) {
        pointOnPath(loop.path, travel + i * step, pt);
        chain.setMatrixAt(loop.start + i, setRotZ(m4, pt[2], 1, pt[0], pt[1], loop.z));
      }
    }
    chain.instanceMatrix.needsUpdate = true;
  }

  return { objects, metal, chain, update, setExplode };
}

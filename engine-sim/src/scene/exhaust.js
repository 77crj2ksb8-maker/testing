// Exhaust system: one primary pipe per cylinder (or rotor port) into a
// collector per bank, pipes running back past the gearbox, tailpipe tips and
// flames. The headers glow with exhaust-gas temperature.

import * as THREE from 'three';
import { pipeGeometry, merge, cylAlongZ } from './geometry.js';
import { makeFlameMaterial } from './materials.js';
import { egtHeat, heatColor } from './timing.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * Collector positions for each exhaust group.
 * groups: [{ports: [Vector3], out: Vector3 (unit, outward), bankDeg, members}]
 * mid: true puts the collector at the middle of the bank (to feed a turbo),
 * otherwise at its rear end so the pipe runs straight back.
 */
export function planExhaust(groups, B, { mid = false } = {}) {
  return groups.map((g) => {
    const mean = new THREE.Vector3();
    for (const p of g.ports) mean.add(p);
    mean.multiplyScalar(1 / g.ports.length);
    const zs = g.ports.map((p) => p.z);
    const z = mid ? (Math.min(...zs) + Math.max(...zs)) / 2 : Math.min(...zs) - 0.35 * B;
    const collector = mean.clone().addScaledVector(g.out, 1.0 * B);
    collector.y -= 1.25 * B;
    collector.z = z;
    return { ...g, collector };
  });
}

export class ExhaustSystem {
  /**
   * plan: from planExhaust. opts: {B, M, run: {x, y, endZ}, starts: [{group, from: Vector3}]
   * (where each tailpipe run begins: a collector or a turbine outlet), crossovers: [[from, to]]}
   */
  constructor(plan, { B, M, run, starts, crossovers = [] }) {
    this.B = B;
    this.M = M;
    this.groups = [];
    this.tips = [];
    const hot = [];
    const warm = [];
    plan.forEach((g) => {
      const group = new THREE.Group();
      const geos = [];
      for (const p of g.ports) {
        const a = p.clone().addScaledVector(g.out, 0.42 * B);
        const b = p.clone().addScaledVector(g.out, 0.85 * B);
        b.y -= 0.5 * B;
        const c = g.collector.clone();
        c.y += 0.4 * B;
        c.z += (p.z - g.collector.z) * 0.45;
        geos.push(pipeGeometry([p, a, b, c, g.collector], 0.11 * B, 36, 10));
        // Flange where the primary bolts to the head.
        const flange = new THREE.CylinderGeometry(0.17 * B, 0.17 * B, 0.05 * B, 14);
        flange.rotateX(Math.PI / 2);
        flange.lookAt(g.out);
        flange.translate(p.x, p.y, p.z);
        geos.push(flange);
      }
      if (g.feed) {
        // Short hot pipe from the collector into a turbine scroll.
        const mid = g.feed.from.clone().lerp(g.feed.to, 0.5);
        mid.y -= 0.12 * B;
        geos.push(pipeGeometry([g.feed.from, mid, g.feed.to], 0.13 * B, 12, 10));
      }
      const col = new THREE.SphereGeometry(0.22 * B, 16, 12);
      col.translate(g.collector.x, g.collector.y, g.collector.z);
      geos.push(col);
      const headers = new THREE.Mesh(merge(geos), M.header);
      group.add(headers);
      this.groups.push({ group, bankDeg: g.bankDeg, headers, out: g.out });
      hot.push(headers);
    });

    // Tailpipe runs: down, inboard to the run line beside the gearbox, then back.
    const pipeGeos = [];
    const tipGeos = [];
    for (const s of starts) {
      const side = Math.sign(s.from.x) || 1;
      const x = side * run.x;
      const p0 = s.from;
      const p1 = v3(p0.x, p0.y - 0.5 * B, p0.z - 0.5 * B);
      const p2 = v3((p0.x + x) / 2, (p0.y + run.y) / 2, p0.z - 1.4 * B);
      const p3 = v3(x, run.y, Math.min(p0.z - 2.6 * B, run.startZ));
      const end = v3(x, run.y, run.endZ);
      pipeGeos.push(pipeGeometry([p0, p1, p2, p3, end], 0.12 * B, 64, 10));
      // Silencer box along the run, then the tip.
      const can = cylAlongZ(0.3 * B, 1.6 * B, 20);
      can.scale(1.25, 0.8, 1);
      can.translate(x, run.y, run.endZ + 1.6 * B);
      pipeGeos.push(can);
      // Hollow tip: outer wall, rolled lip and a dark bore.
      const tip = new THREE.LatheGeometry([
        [0.13 * B, 0.25 * B], [0.13 * B, -0.25 * B], [0.15 * B, -0.27 * B], [0.17 * B, -0.25 * B], [0.17 * B, 0.25 * B],
      ].map(([r, y]) => new THREE.Vector2(r, y)), 20);
      tip.rotateX(Math.PI / 2);
      tip.translate(x, run.y, run.endZ - 0.1 * B);
      tipGeos.push(tip);
      this.tips.push(v3(x, run.y, run.endZ - 0.35 * B));
    }
    for (const [a, b] of crossovers) {
      const low = Math.min(a.y, b.y) - 0.6 * B;
      pipeGeos.push(pipeGeometry([a, v3(a.x * 0.6, low, a.z - 0.3 * B), v3(b.x * 0.6, low, b.z - 0.3 * B), b], 0.11 * B, 48, 10));
    }
    this.pipes = new THREE.Mesh(merge(pipeGeos), M.pipe);
    this.tipMesh = new THREE.Mesh(merge(tipGeos), M.chrome);
    this.pipeGroup = new THREE.Group();
    this.pipeGroup.add(this.pipes, this.tipMesh);
    warm.push(this.pipes);

    // Flames: one additive cone per tailpipe.
    const cone = new THREE.ConeGeometry(0.5, 1, 18, 1, true);
    cone.translate(0, 0.5, 0);
    this.flameLevel = new Float32Array(this.tips.length);
    this.aFlame = new THREE.InstancedBufferAttribute(new Float32Array(this.tips.length), 1);
    cone.setAttribute('aFlame', this.aFlame);
    this.flames = new THREE.InstancedMesh(cone, makeFlameMaterial(), Math.max(1, this.tips.length));
    this.flames.userData.ownMaterial = true;
    this.flames.frustumCulled = false;
    this.flames.renderOrder = 3;
    this.flameQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    this.m4 = new THREE.Matrix4();
    this.scale = new THREE.Vector3();
    this.heat = [0, 0, 0];
    this.time = 0;
    this.flameOffset = new THREE.Vector3();
  }

  /** Add the exhaust to the scene: headers per bank group, pipes and flames on `parent`. */
  attach(parent) {
    for (const g of this.groups) parent.add(g.group);
    parent.add(this.pipeGroup, this.flames);
  }

  /** Light the tailpipes. strength 0..1. */
  flame(strength) {
    for (let i = 0; i < this.flameLevel.length; i++) this.flameLevel[i] = Math.max(this.flameLevel[i], 0.35 + 0.65 * strength);
  }

  /** Current brightest flame level (for the flame light). */
  get flameNow() {
    let f = 0;
    for (const v of this.flameLevel) f = Math.max(f, v);
    return f;
  }

  update(dt, egtC) {
    const M = this.M;
    const heat = egtHeat(egtC);
    heatColor(heat, this.heat);
    const k = 1.4 + 2.2 * heat;
    M.header.emissive.setRGB(this.heat[0] * k, this.heat[1] * k, this.heat[2] * k);
    M.turbine.emissive.copy(M.header.emissive);
    const kp = 0.35;
    M.pipe.emissive.setRGB(this.heat[0] * k * kp, this.heat[1] * k * kp, this.heat[2] * k * kp);

    this.time += dt;
    this.flames.material.uniforms.uTime.value = this.time % 100;
    const B = this.B;
    const decay = Math.exp(-dt / 0.09);
    for (let i = 0; i < this.tips.length; i++) {
      const f = this.flameLevel[i];
      this.aFlame.array[i] = f;
      const flick = 0.85 + 0.15 * Math.sin(this.time * 47 + i * 2.1);
      const len = f > 0.002 ? B * (0.7 + 2.6 * f) * flick : 0.0001;
      const w = B * (0.22 + 0.18 * f);
      this.scale.set(w, len, w);
      this.flameOffset.copy(this.tips[i]).add(this.pipeGroup.position);
      this.m4.compose(this.flameOffset, this.flameQ, this.scale);
      this.flames.setMatrixAt(i, this.m4);
      this.flameLevel[i] = f * decay;
    }
    this.flames.instanceMatrix.needsUpdate = true;
    this.aFlame.needsUpdate = true;
  }
}

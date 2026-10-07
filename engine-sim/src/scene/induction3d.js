// Induction hardware by settings.induction: an intake plenum with one runner
// per port (all engines), plus a belt-driven Roots blower with visible rotors,
// or one/two turbochargers with spinning compressor wheels, glowing turbine
// housings and charge pipes through a front intercooler.

import * as THREE from 'three';
import {
  pipeGeometry, merge, roundedBox, cylAlongZ, rootsRotorGeometry, wheelGeometry, ribbonGeometry, withEdges,
} from './geometry.js';
import { chainPath } from './layout.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;
const MAX_WHEEL_STEP = 11 * DEG; // per frame, below half a blade pitch so spin never strobes backwards

export class Induction {
  /**
   * ctx: {kind, B, M, ports: [{p: Vector3, d: Vector3}], twoBanks, pulley: {z, r},
   *       collectors: [{collector: Vector3, out: Vector3}], frontZ, lowY}
   */
  constructor(ctx) {
    const { kind, B, M, ports } = ctx;
    this.kind = kind;
    this.B = B;
    this.group = new THREE.Group(); // explodes upwards
    this.belt = null;
    this.metal = [];
    this.housings = [];
    this.spinners = [];
    this.glowing = []; // hot parts for the bloom pass
    this.turbos = [];
    this.starts = null;
    this.crossovers = [];

    // Plenum: centred over the ports' outward reach (the valley of a V, the top of a boxer).
    const reach = ports.map((q) => q.p.clone().addScaledVector(q.d, 1.05 * B));
    const pc = new THREE.Vector3();
    for (const r of reach) pc.add(r);
    pc.multiplyScalar(1 / reach.length);
    if (ctx.twoBanks) pc.y = Math.max(...reach.map((r) => r.y)) + 0.2 * B;
    const zs = ports.map((q) => q.p.z);
    const len = Math.max(...zs) - Math.min(...zs) + 1.1 * B;
    pc.z = (Math.max(...zs) + Math.min(...zs)) / 2;
    const plenumW = 1.0 * B;
    const plenumH = 0.62 * B;
    const geos = [];
    const plenum = roundedBox(plenumW, plenumH, len, 0.26 * B);
    plenum.translate(pc.x, pc.y, pc.z);
    geos.push(plenum);
    for (const q of ports) {
      const a = q.p.clone().addScaledVector(q.d, 0.38 * B);
      const toPort = v3(q.p.x - pc.x, q.p.y - pc.y, 0);
      if (toPort.lengthSq() < 1e-6) toPort.set(0, -1, 0);
      toPort.normalize();
      const end = v3(pc.x + toPort.x * plenumW * 0.3, pc.y + toPort.y * plenumH * 0.3, q.p.z);
      const mid = a.clone().lerp(end, 0.5);
      mid.y += 0.15 * B;
      geos.push(pipeGeometry([q.p, a, mid, end], 0.1 * B, 24, 8));
    }
    // Throttle body at the front of the plenum.
    const tbZ = pc.z + len / 2 + 0.22 * B;
    const tb = cylAlongZ(0.3 * B, 0.45 * B, 24);
    tb.translate(pc.x, pc.y, tbZ);
    geos.push(tb);
    this.throttleBody = v3(pc.x, pc.y, tbZ + 0.25 * B);
    const intake = new THREE.Mesh(merge(geos), M.alloy);
    this.group.add(intake);
    this.bovPoint = this.throttleBody.clone();
    this.top = pc.y + plenumH / 2;

    if (kind === 'supercharger') this.buildBlower(ctx, pc, len);
    else if (kind === 'turbo' || kind === 'twin-turbo') this.buildTurbos(ctx);
  }

  buildBlower(ctx, pc, len) {
    const { B, M, pulley } = ctx;
    const caseW = 1.3 * B;
    const caseH = 0.95 * B;
    const caseL = len * 0.92;
    const c = v3(pc.x, this.top + caseH / 2 + 0.05 * B, pc.z);
    const body = new THREE.Mesh(roundedBox(caseW, caseH, caseL, 0.34 * B), M.glass);
    body.position.copy(c);
    this.group.add(withEdges(body, M.edge, 30));
    this.housings.push(body);
    // Snout and inlet on top.
    const snout = new THREE.Mesh(merge([
      (() => {
        const g = cylAlongZ(0.14 * B, pulley.z - (c.z + caseL / 2), 16);
        g.translate(c.x, c.y, (pulley.z + c.z + caseL / 2) / 2);
        return g;
      })(),
      (() => {
        const g = roundedBox(0.9 * B, 0.25 * B, 0.9 * B, 0.1 * B);
        g.translate(c.x, c.y + caseH / 2 + 0.12 * B, c.z + caseL * 0.3);
        return g;
      })(),
    ]), M.blackAlloy);
    this.group.add(snout);
    const rotorR = 0.3 * B;
    const rotorGeo = rootsRotorGeometry(rotorR, caseL * 0.94, 60 * DEG);
    const spacing = rotorR * 0.81;
    for (const s of [-1, 1]) {
      const rotor = new THREE.Mesh(rotorGeo, M.chrome);
      rotor.position.set(c.x + s * spacing, c.y, c.z);
      this.group.add(rotor);
      this.metal.push(rotor);
      // Counter-rotating; the second rotor is phased 60° so the lobes interleave.
      this.spinners.push({ obj: rotor, ratio: s * 2, phase: s > 0 ? 60 * DEG : 0 });
    }
    // Belt drive from the crank pulley.
    const rb = pulley.r / 2; // 2:1 overdrive, so the pattern repeats when the crank angle wraps
    const pul = new THREE.Mesh(merge([
      cylAlongZ(rb, 0.18 * B, 24),
      ...[0, 1, 2].map((k) => {
        const g = new THREE.BoxGeometry(rb * 1.7, 0.05 * B, 0.2 * B);
        g.rotateZ((k * Math.PI) / 3);
        return g;
      }),
    ]), M.steel);
    pul.position.set(c.x, c.y, pulley.z);
    this.group.add(pul);
    this.metal.push(pul);
    this.spinners.push({ obj: pul, ratio: pulley.r / rb, phase: 0 });
    const path = chainPath([{ x: 0, y: 0, r: pulley.r + 0.015 * B }, { x: c.x, y: c.y, r: rb + 0.015 * B }], 48);
    this.belt = new THREE.Mesh(ribbonGeometry(path, 0.16 * B, 0.03 * B), M.belt);
    this.belt.position.z = pulley.z;
    this.bovPoint = v3(c.x, c.y + caseH / 2 + 0.3 * B, c.z + caseL * 0.3);
  }

  buildTurbos(ctx) {
    const { B, M, collectors, kind } = ctx;
    const count = kind === 'twin-turbo' ? Math.min(2, collectors.length) : 1;
    const turbineGeo = merge([
      new THREE.TorusGeometry(0.3 * B, 0.15 * B, 10, 24),
      cylAlongZ(0.22 * B, 0.3 * B, 20),
    ]);
    const compressorGeo = merge([
      new THREE.TorusGeometry(0.4 * B, 0.13 * B, 10, 28),
      (() => {
        const g = new THREE.CylinderGeometry(0.28 * B, 0.28 * B, 0.36 * B, 24, 1, true);
        g.rotateX(Math.PI / 2);
        g.translate(0, 0, 0.2 * B);
        return g;
      })(),
    ]);
    const coreGeo = cylAlongZ(0.12 * B, 0.5 * B, 14);
    const wheelGeo = wheelGeometry(0.26 * B, 0.16 * B, 11);
    const outlets = [];
    this.starts = [];
    this.feed = [];
    for (let i = 0; i < count; i++) {
      const g = collectors[i];
      const t = g.collector.clone().addScaledVector(g.out, 0.55 * B);
      t.y += 0.15 * B;
      const turbine = new THREE.Mesh(turbineGeo, M.turbine);
      turbine.position.copy(t);
      this.glowing.push(turbine);
      const cz = t.z + 0.8 * B;
      const core = new THREE.Mesh(coreGeo, M.blackAlloy);
      core.position.set(t.x, t.y, t.z + 0.4 * B);
      const comp = new THREE.Mesh(compressorGeo, M.alloy);
      comp.position.set(t.x, t.y, cz);
      const wheel = new THREE.Mesh(wheelGeo, M.chrome);
      wheel.position.set(t.x, t.y, cz + 0.04 * B);
      this.group.add(turbine, core, comp, wheel);
      this.metal.push(wheel);
      this.turbos.push({ wheel, angle: i * 0.7 });
      // Feed pipe from the collector into the turbine scroll.
      outlets.push(v3(t.x, t.y + 0.4 * B, cz));
      this.starts.push({ group: i, from: v3(t.x, t.y - 0.1 * B, t.z - 0.35 * B) });
      this.feed.push({ group: i, from: g.collector, to: t });
    }
    // A single turbo also takes the other bank's collector through a crossover.
    for (let i = count; i < collectors.length; i++) {
      const t0 = this.turbos[0].wheel.position;
      this.crossovers.push([collectors[i].collector, v3(t0.x, t0.y - 0.2 * B, t0.z - 0.8 * B)]);
    }

    // Front intercooler, low so the timing drive stays in view.
    const icZ = ctx.frontZ + 0.7 * B;
    const icW = Math.min(3.4 * B, Math.max(2.4 * B, Math.abs(outlets[0].x) * 1.3));
    const icH = 0.72 * B;
    const icY = ctx.lowY + icH / 2 + 0.1 * B;
    const core = new THREE.Mesh(roundedBox(icW, icH, 0.28 * B, 0.04 * B), M.blackAlloy);
    core.position.set(0, icY, icZ);
    const tanks = new THREE.Mesh(merge([-1, 1].map((s) => {
      const tk = roundedBox(0.28 * B, icH * 1.08, 0.36 * B, 0.1 * B);
      tk.translate(s * (icW / 2 + 0.14 * B), icY, icZ);
      return tk;
    })), M.alloy);
    this.group.add(core, tanks);

    const pipes = [];
    outlets.forEach((o, i) => {
      const s = count === 2 ? (i === 0 ? Math.sign(o.x) || 1 : -(Math.sign(outlets[0].x) || 1)) : Math.sign(o.x) || 1;
      const inlet = v3(s * (icW / 2 + 0.14 * B), icY + icH * 0.25, icZ - 0.1 * B);
      pipes.push(pipeGeometry([
        o, v3(o.x, o.y + 0.25 * B, o.z + 0.3 * B), v3(o.x * 0.85 + inlet.x * 0.15, o.y + 0.1 * B, icZ - 0.8 * B),
        v3(inlet.x, inlet.y + 0.3 * B, icZ - 0.3 * B), inlet,
      ], 0.12 * B, 48, 10));
    });
    // Intercooler outlet up to the throttle body.
    const outSide = count === 2 ? -(Math.sign(outlets[0].x) || 1) : -(Math.sign(outlets[0].x) || 1);
    const icOut = v3(outSide * (icW / 2 + 0.14 * B), icY - icH * 0.25, icZ + 0.12 * B);
    const tb = this.throttleBody;
    pipes.push(pipeGeometry([icOut, v3(icOut.x, icOut.y, icZ + 0.4 * B), v3(icOut.x * 0.6, tb.y, icZ + 0.3 * B), v3(tb.x, tb.y, tb.z + 0.35 * B), tb], 0.13 * B, 48, 10));
    this.group.add(new THREE.Mesh(merge(pipes), M.alloy));
    this.bovPoint = v3(icOut.x * 0.6, tb.y + 0.2 * B, icZ + 0.3 * B);
  }

  /** dt seconds; crankDeg for belt-driven parts; turboRpm drives the wheels at visual speed. */
  update(dt, crankDeg, turboRpm, visualSpeed) {
    for (const s of this.spinners) s.obj.rotation.z = -crankDeg * DEG * s.ratio + s.phase;
    if (this.turbos.length) {
      const step = Math.min(MAX_WHEEL_STEP, (turboRpm / 60) * Math.PI * 2 * visualSpeed * dt);
      for (const t of this.turbos) {
        t.angle = (t.angle + step) % (Math.PI * 2);
        t.wheel.rotation.z = t.angle;
      }
    }
  }
}

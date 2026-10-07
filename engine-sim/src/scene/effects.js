// One-shot effects: pooled CPU particles for sparks (additive) and smoke
// (alpha-blended), drawn as two point clouds. Nothing allocates after the
// pools are built; emitting past capacity recycles the oldest particle.

import * as THREE from 'three';
import { makeParticleMaterial } from './materials.js';

// Small seeded PRNG so effects look the same run to run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ParticlePool {
  constructor(capacity, additive) {
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.rgb = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.s0 = new Float32Array(capacity);
    this.s1 = new Float32Array(capacity);
    this.a0 = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.next = 0;
    this.alive = 0;
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aSize', this.aSize);
    this.points = new THREE.Points(geo, makeParticleMaterial(additive));
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 5 : 4;
    this.points.visible = false;
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav, drag) {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    const o = i * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.vel[o] = vx;
    this.vel[o + 1] = vy;
    this.vel[o + 2] = vz;
    this.rgb[o] = r;
    this.rgb[o + 1] = g;
    this.rgb[o + 2] = b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.a0[i] = a;
    this.grav[i] = grav;
    this.drag[i] = drag;
  }

  update(dt) {
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      const c = i * 4;
      if (this.life[i] <= 0) {
        this.col[c + 3] = 0;
        continue;
      }
      this.life[i] -= dt;
      const o = i * 3;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[o] *= k;
      this.vel[o + 1] = this.vel[o + 1] * k - this.grav[i] * dt;
      this.vel[o + 2] *= k;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const t = Math.max(0, this.life[i]) / this.maxLife[i]; // 1 → 0
      this.size[i] = this.s1[i] + (this.s0[i] - this.s1[i]) * t;
      // Fade in quickly, out slowly.
      const fade = Math.min(1, (1 - t) * 8) * t;
      this.col[c] = this.rgb[o];
      this.col[c + 1] = this.rgb[o + 1];
      this.col[c + 2] = this.rgb[o + 2];
      this.col[c + 3] = this.a0[i] * fade;
      if (this.life[i] > 0) alive++;
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    if (alive || this.wasAlive) {
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aSize.needsUpdate = true;
    }
    this.wasAlive = alive > 0;
  }

  clear() {
    this.life.fill(0);
    this.col.fill(0);
    this.points.visible = false;
    this.aCol.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene) {
    this.sparks = new ParticlePool(480, true);
    this.smoke = new ParticlePool(320, false);
    scene.add(this.smoke.points, this.sparks.points);
    this.rand = mulberry32(1234567);
  }

  /** World units → pixels at depth 1 (viewport height in device pixels / (2·tan(fov/2))). */
  setScale(scale) {
    this.sparks.points.material.uniforms.uScale.value = scale;
    this.smoke.points.material.uniforms.uScale.value = scale;
  }

  /** Sparks from p, mostly along dir (unit Vector3), speed in units/s. */
  sparkBurst(p, dir, count, speed, spread, size) {
    const R = this.rand;
    for (let i = 0; i < count; i++) {
      const sp = speed * (0.4 + 0.6 * R());
      const vx = dir.x * sp + (R() - 0.5) * spread * sp;
      const vy = dir.y * sp + (R() - 0.5) * spread * sp;
      const vz = dir.z * sp + (R() - 0.5) * spread * sp;
      const hot = R();
      this.sparks.emit(
        p.x, p.y, p.z, vx, vy, vz, 0.35 + 0.6 * R(), size * (0.6 + 0.6 * R()), size * 0.25,
        1.6, 0.75 + 0.5 * hot, 0.25 + 0.4 * hot, 1, speed * 1.4, 1.2,
      );
    }
  }

  /** Smoke from p drifting along dir. tone 0 = black soot … 1 = white vapour. */
  smokeBurst(p, dir, count, speed, size, tone, alpha, life = 2.4) {
    const R = this.rand;
    for (let i = 0; i < count; i++) {
      const sp = speed * (0.5 + 0.5 * R());
      const g = 0.12 + tone * 0.75 + (R() - 0.5) * 0.06;
      this.smoke.emit(
        p.x + (R() - 0.5) * size * 0.4, p.y + (R() - 0.5) * size * 0.4, p.z + (R() - 0.5) * size * 0.4,
        dir.x * sp + (R() - 0.5) * sp * 0.6, dir.y * sp + (R() - 0.5) * sp * 0.6 + speed * 0.3, dir.z * sp + (R() - 0.5) * sp * 0.6,
        life * (0.7 + 0.6 * R()), size * 0.5, size * (1.6 + R()), g, g, g * 1.04 + 0.02, alpha, -speed * 0.25, 1.6,
      );
    }
  }

  update(dt) {
    this.sparks.update(dt);
    this.smoke.update(dt);
  }

  clear() {
    this.sparks.clear();
    this.smoke.clear();
  }
}

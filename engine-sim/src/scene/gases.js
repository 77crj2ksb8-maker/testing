// Stroke gases: one translucent volume per cylinder filling the space between
// the piston crown and the head, tinted by stroke (blue intake mist, denser
// violet compression, flame on power, grey exhaust smoke). One draw call.

import * as THREE from 'three';
import { gasColor } from './timing.js';
import { makeGasMaterial } from './materials.js';
import { setRotZ } from './geometry.js';

export class GasVolumes {
  constructor(count, boreRadius) {
    const geo = new THREE.CylinderGeometry(boreRadius, boreRadius, 1, 28, 1);
    this.gas = new Float32Array(count * 4);
    this.glow = new Float32Array(count);
    this.aGas = new THREE.InstancedBufferAttribute(this.gas, 4);
    this.aGlow = new THREE.InstancedBufferAttribute(this.glow, 1);
    this.aGas.setUsage(THREE.DynamicDrawUsage);
    this.aGlow.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGas', this.aGas);
    geo.setAttribute('aGlow', this.aGlow);
    this.mesh = new THREE.InstancedMesh(geo, makeGasMaterial(), count);
    this.mesh.userData.ownMaterial = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 2;
    this.m4 = new THREE.Matrix4();
    this.c = [0, 0, 0, 0, 0];
  }

  /** Pose cylinder i: centre (x, y, z), axis rotation about Z, height, and the gas state. */
  write(i, x, y, z, rotZ, height, degSinceFire, load, burning) {
    this.mesh.setMatrixAt(i, setRotZ(this.m4, rotZ, Math.max(0.001, height), x, y, z));
    const c = gasColor(degSinceFire, load, burning, this.c);
    const o = i * 4;
    this.gas[o] = c[0];
    this.gas[o + 1] = c[1];
    this.gas[o + 2] = c[2];
    this.gas[o + 3] = c[3];
    this.glow[i] = c[4];
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aGas.needsUpdate = true;
    this.aGlow.needsUpdate = true;
  }
}

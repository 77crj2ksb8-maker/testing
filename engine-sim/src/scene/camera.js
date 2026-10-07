// Camera choreography on top of OrbitControls: named presets with an eased
// fly-to that arcs around the target, a slow cinematic orbit, and shake.
// Any user input on the controls cancels a flight and the cinematic orbit.

import * as THREE from 'three';
import { easeInOutCubic, lerpOrbit, shakeNoise } from './timing.js';

export const CAMERA_PRESETS = ['hero', 'front', 'side', 'top', 'valvetrain', 'gearbox', 'under'];

const LABELS = {
  hero: 'Hero', front: 'Front', side: 'Side', top: 'Top', valvetrain: 'Valvetrain', gearbox: 'Gearbox', under: 'Underside',
};

const FLY_SECONDS = 0.8;
const CINEMATIC_RAD_PER_S = 0.16;

export class CameraRig {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.flight = null;
    this.cinematic = false;
    this.cineTime = 0;
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.shakeOffset = new THREE.Vector3();
    this.active = 'hero';
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.from = { radius: 1, theta: 0, phi: 1 };
    this.to = { radius: 1, theta: 0, phi: 1 };
    this.cur = { radius: 1, theta: 0, phi: 1 };
    this.sph = new THREE.Spherical();
    this.fromTarget = new THREE.Vector3();
    this.toTarget = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    controls.addEventListener('start', () => {
      this.flight = null;
      this.cinematic = false;
      this.onUserInput?.();
    });
  }

  label(id, rotary) {
    if (id === 'valvetrain' && rotary) return 'Rotors';
    return LABELS[id] ?? 'Hero';
  }

  /** Fly to a pose (target + camera position). instant skips the animation. */
  flyTo(target, position, instant = false) {
    if (instant) {
      this.flight = null;
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.controls.update();
      return;
    }
    this.fromTarget.copy(this.controls.target);
    this.toTarget.copy(target);
    this.sph.setFromVector3(this.tmp.copy(this.camera.position).sub(this.controls.target));
    Object.assign(this.from, { radius: this.sph.radius, theta: this.sph.theta, phi: this.sph.phi });
    this.sph.setFromVector3(this.tmp.copy(position).sub(target));
    Object.assign(this.to, { radius: this.sph.radius, theta: this.sph.theta, phi: this.sph.phi });
    this.flight = { t: 0 };
  }

  setCinematic(on) {
    this.cinematic = !!on;
    if (on) this.flight = null;
  }

  shake(amount) {
    const k = this.reducedMotion ? 0.25 : 1;
    this.shakeAmp = Math.min(1, Math.max(this.shakeAmp, amount * k));
  }

  update(dt) {
    if (this.flight) {
      this.flight.t = Math.min(1, this.flight.t + dt / FLY_SECONDS);
      const e = easeInOutCubic(this.flight.t);
      lerpOrbit(this.from, this.to, e, this.cur);
      this.controls.target.lerpVectors(this.fromTarget, this.toTarget, e);
      this.sph.set(this.cur.radius, this.cur.phi, this.cur.theta);
      this.camera.position.setFromSpherical(this.sph).add(this.controls.target);
      if (this.flight.t >= 1) this.flight = null;
    } else if (this.cinematic) {
      this.cineTime += dt;
      this.sph.setFromVector3(this.tmp.copy(this.camera.position).sub(this.controls.target));
      this.sph.theta += CINEMATIC_RAD_PER_S * dt;
      // A slow rise and fall so the orbit does not feel mechanical.
      this.sph.phi += Math.sin(this.cineTime * 0.35) * 0.05 * dt;
      this.sph.phi = Math.min(1.45, Math.max(0.45, this.sph.phi));
      this.camera.position.setFromSpherical(this.sph).add(this.controls.target);
    }
    this.shakeTime += dt;
    this.shakeAmp *= Math.exp(-dt * 5);
    if (this.shakeAmp < 0.002) this.shakeAmp = 0;
  }

  /** Temporarily offset the camera for shake; call endShake() after rendering. */
  beginShake(scale) {
    if (!this.shakeAmp) return false;
    const a = this.shakeAmp * this.shakeAmp * scale;
    const t = this.shakeTime;
    this.shakeOffset.set(shakeNoise(t, 1) * a, shakeNoise(t, 2) * a, shakeNoise(t, 3) * a * 0.6);
    this.camera.position.add(this.shakeOffset);
    this.camera.updateMatrixWorld();
    return true;
  }

  endShake() {
    this.camera.position.sub(this.shakeOffset);
    this.camera.updateMatrixWorld();
  }
}

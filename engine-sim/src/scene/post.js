// Post-processing: a selective bloom. Only objects on BLOOM_LAYER (flames,
// combustion, hot exhaust, sparks) are rendered into a small bloom pre-pass,
// without the environment map, so chrome highlights never bloom. The halo is
// then added over the normal render. Built lazily the first time it is on.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const BLOOM_LAYER = 1;

/** Let an object glow in the bloom pass (it still renders normally). */
export function markBloom(obj) {
  obj.layers.enable(BLOOM_LAYER);
  return obj;
}

const BLOOM_SCALE = 0.5; // bloom pre-pass resolution relative to the canvas

// three.js ACES filmic curve (tonemapping_pars_fragment), applied to a linear RGB triple.
function aces(rgb, exposure, out) {
  const k = exposure / 0.6;
  const r = rgb[0] * k;
  const g = rgb[1] * k;
  const b = rgb[2] * k;
  const i = [0.59719 * r + 0.35458 * g + 0.04823 * b, 0.076 * r + 0.90834 * g + 0.01566 * b, 0.0284 * r + 0.13383 * g + 0.83777 * b];
  const f = i.map((v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081));
  out[0] = 1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2];
  out[1] = -0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2];
  out[2] = -0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2];
  return out;
}

/**
 * The linear colour that comes out of the tone mapper as `target`. The direct
 * render path clears to the background without tone mapping, the composer
 * path tone-maps it, so the composer gets this pre-compensated background.
 */
export function untoneMapped(target, exposure) {
  const t = [target.r, target.g, target.b];
  const x = [...t];
  const y = [0, 0, 0];
  for (let n = 0; n < 60; n++) {
    aces(x, exposure, y);
    for (let c = 0; c < 3; c++) x[c] = Math.max(0, x[c] + (t[c] - y[c]) * 2.5);
  }
  return new THREE.Color(x[0], x[1], x[2]);
}

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = null;
    this.enabled = false;
    this.width = 1;
    this.height = 1;
  }

  build() {
    const r = this.renderer;
    this.bloomComposer = new EffectComposer(r, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.25, 0.18);
    this.bloomComposer.addPass(this.bloom);

    // Linear HDR target with MSAA so edges stay as clean as the direct path.
    this.composer = new EffectComposer(r, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const mix = new ShaderPass(new THREE.ShaderMaterial({
      uniforms: { baseTexture: { value: null }, bloomTexture: { value: this.bloomComposer.renderTarget2.texture } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(baseTexture, vUv) + vec4(texture2D(bloomTexture, vUv).rgb, 0.0); }`,
    }), 'baseTexture');
    this.composer.addPass(mix);
    this.composer.addPass(new OutputPass());
    this.black = new THREE.Color(0x000000);
    this.bgFor = null;
    this.setSize(this.width, this.height);
  }

  setEnabled(on) {
    this.enabled = on;
    if (on && !this.composer) this.build();
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    if (!this.composer) return;
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(width, height);
    this.bloomComposer.setPixelRatio(pr * BLOOM_SCALE);
    this.bloomComposer.setSize(width, height);
  }

  render() {
    if (!this.enabled || !this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const { scene, camera } = this;
    const background = scene.background;
    const envIntensity = scene.environmentIntensity;
    const mask = camera.layers.mask;
    // Bloom pre-pass: glowing objects only, on black, without reflections.
    scene.background = this.black;
    scene.environmentIntensity = 0;
    camera.layers.set(BLOOM_LAYER);
    this.bloomComposer.render();
    camera.layers.mask = mask;
    scene.environmentIntensity = envIntensity;
    if (background?.isColor) {
      if (this.bgFor !== background.getHex()) {
        this.bgFor = background.getHex();
        this.bg = untoneMapped(background, this.renderer.toneMappingExposure);
      }
      scene.background = this.bg;
    }
    this.composer.render();
    scene.background = background;
  }
}

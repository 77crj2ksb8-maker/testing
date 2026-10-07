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
import { untoneMapped } from './tonemap.js';

export const BLOOM_LAYER = 1;

/** Let an object glow in the bloom pass (it still renders normally). */
export function markBloom(obj) {
  obj.layers.enable(BLOOM_LAYER);
  return obj;
}

const BLOOM_SCALE = 0.5; // bloom pre-pass resolution relative to the canvas

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
    // MSAA only where pixels are big enough for jaggies to show.
    const samples = pr >= 1.75 ? 0 : 4;
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples !== samples) {
        t.samples = samples;
        t.dispose();
      }
    }
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
        this.bg = new THREE.Color().fromArray(untoneMapped([background.r, background.g, background.b], this.renderer.toneMappingExposure));
      }
      scene.background = this.bg;
    }
    this.composer.render();
    scene.background = background;
  }
}

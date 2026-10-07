// Post-processing: a subtle bloom that only catches emissive parts (flames,
// hot headers, combustion), built lazily the first time it is switched on.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

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
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    // Linear HDR target with MSAA so edges stay as clean as the direct path.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Threshold well above 1: only emissive surfaces pushed past white bloom,
    // not specular highlights on the chrome.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.5, 0.35, 1.3);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
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
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  render() {
    if (this.enabled && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

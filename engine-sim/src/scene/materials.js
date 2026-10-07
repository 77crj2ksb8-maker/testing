// Shared materials for the engine model: polished metal, glass housings and
// the special-purpose shaders (x-ray, stroke gases, flames, particles).

import * as THREE from 'three';

// Housings show their inside faces in a flat section colour while cut away,
// which reads as a solid cut surface without building caps.
function withSectionFaces(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
      #ifdef SECTION_FACES
        if (!gl_FrontFacing) gl_FragColor = vec4(0.36, 0.15, 0.07, 1.0);
      #endif`,
    );
  };
  return mat;
}

export function makeMaterials() {
  const flashBase = new THREE.MeshBasicMaterial({
    color: 0xff5a14, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return {
    chrome: new THREE.MeshStandardMaterial({ color: 0xe9edf2, metalness: 1, roughness: 0.14 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xa3abb6, metalness: 0.95, roughness: 0.3 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: 0x40464f, metalness: 0.85, roughness: 0.42 }),
    rod: new THREE.MeshStandardMaterial({ color: 0xc6ccd4, metalness: 1, roughness: 0.22 }),
    ring: new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.6, roughness: 0.5 }),
    glass: withSectionFaces(new THREE.MeshPhysicalMaterial({
      color: 0x2a3a52, metalness: 0, roughness: 0.1, transparent: true, opacity: 0.16,
      depthWrite: false, side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: 0.08,
    })),
    glassDark: withSectionFaces(new THREE.MeshPhysicalMaterial({
      color: 0x18202c, metalness: 0.2, roughness: 0.25, transparent: true, opacity: 0.42,
      depthWrite: false, side: THREE.DoubleSide, clearcoat: 1,
    })),
    edge: new THREE.LineBasicMaterial({ color: 0xa9bedc, transparent: true, opacity: 0.3 }),
    friction: new THREE.MeshStandardMaterial({ color: 0xd9692a, metalness: 0.2, roughness: 0.75 }),
    gear: new THREE.MeshStandardMaterial({ color: 0x9aa3ae, metalness: 0.95, roughness: 0.3 }),
    gearLive: new THREE.MeshStandardMaterial({
      color: 0xffb070, emissive: 0xff6a10, emissiveIntensity: 0.55, metalness: 0.8, roughness: 0.3,
    }),
    timing: new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 0.4 }),
    plug: new THREE.MeshStandardMaterial({ color: 0xeef2f6, emissive: 0xffc070, emissiveIntensity: 0, roughness: 0.4 }),
    ceramic: new THREE.MeshStandardMaterial({ color: 0xf2f4f7, metalness: 0, roughness: 0.35 }),
    coil: new THREE.MeshStandardMaterial({ color: 0x1c2027, metalness: 0.3, roughness: 0.5 }),
    // Valves are colour-coded: cool blue intake, warm exhaust.
    valveIntake: new THREE.MeshStandardMaterial({ color: 0xa9c4ff, metalness: 0.95, roughness: 0.22 }),
    valveExhaust: new THREE.MeshStandardMaterial({ color: 0xffc9a1, metalness: 0.95, roughness: 0.26 }),
    spring: new THREE.MeshStandardMaterial({ color: 0x6f86a8, metalness: 0.8, roughness: 0.35 }),
    cam: new THREE.MeshStandardMaterial({ color: 0xd7dde5, metalness: 1, roughness: 0.18 }),
    chain: new THREE.MeshStandardMaterial({ color: 0x8c949f, metalness: 0.95, roughness: 0.35 }),
    alloy: new THREE.MeshStandardMaterial({ color: 0xb9c0c9, metalness: 0.9, roughness: 0.32 }),
    blackAlloy: new THREE.MeshStandardMaterial({ color: 0x2a2f37, metalness: 0.7, roughness: 0.38 }),
    belt: new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.1, roughness: 0.8 }),
    // Charge piping: dark anodised so it frames the engine instead of competing with it.
    charge: new THREE.MeshStandardMaterial({ color: 0x3c4552, metalness: 0.75, roughness: 0.32 }),
    // Exhaust parts glow with EGT through their emissive colour (set per frame).
    header: new THREE.MeshStandardMaterial({ color: 0x7d838c, metalness: 0.9, roughness: 0.34, emissive: 0x000000 }),
    pipe: new THREE.MeshStandardMaterial({ color: 0x6d737c, metalness: 0.9, roughness: 0.4, emissive: 0x000000 }),
    turbine: new THREE.MeshStandardMaterial({ color: 0x585e67, metalness: 0.85, roughness: 0.45, emissive: 0x000000 }),
    flashBase,
  };
}

/**
 * X-ray look for moving parts: a rim-lit additive shell. Works on plain and
 * instanced meshes (three.js adds the instancing attribute for ShaderMaterial).
 */
export function makeXrayMaterial(color, strength = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 p = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
          n = mat3(instanceMatrix) * n;
        #endif
        vec4 mv = modelViewMatrix * p;
        vN = normalize(normalMatrix * n);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float a = (0.08 + 0.92 * pow(rim, 2.2)) * uStrength;
        gl_FragColor = vec4(uColor * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/**
 * Stroke-gas volume: per-instance colour and alpha (attribute aGas = rgba)
 * plus a glow term (aGlow) that lifts it above 1 for the bloom pass. Denser
 * towards the middle of the bore so it reads as a volume, not a shell.
 */
export function makeGasMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec4 aGas;
      attribute float aGlow;
      varying vec4 vGas;
      varying float vGlow;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 p = instanceMatrix * vec4(position, 1.0);
        vec4 mv = modelViewMatrix * p;
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vV = normalize(-mv.xyz);
        vGas = aGas;
        vGlow = aGlow;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vGas;
      varying float vGlow;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float a = vGas.a * (0.35 + 0.65 * facing);
        vec3 c = vGas.rgb * (0.7 + vGlow * 1.1);
        gl_FragColor = vec4(c, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}

/** Exhaust flame: an additive cone that flickers; per-instance intensity in aFlame. */
export function makeFlameMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aFlame;
      varying float vFlame;
      varying float vY;
      varying float vR;
      void main() {
        vFlame = aFlame;
        vY = position.y;
        vR = length(position.xz);
        vec4 p = instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * p;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying float vFlame;
      varying float vY;
      varying float vR;
      void main() {
        if (vFlame < 0.002) discard;
        // vY: 0 at the pipe, 1 at the tip. Blue-white core, orange body, red tip.
        float flicker = 0.75 + 0.25 * sin(uTime * 60.0 + vY * 14.0);
        float body = (1.0 - vY) * flicker;
        vec3 core = vec3(0.75, 0.85, 1.0);
        vec3 mid = vec3(1.0, 0.55, 0.12);
        vec3 tip = vec3(0.9, 0.18, 0.04);
        vec3 c = mix(mix(core, mid, smoothstep(0.0, 0.35, vY)), tip, smoothstep(0.45, 1.0, vY));
        float edge = 1.0 - smoothstep(0.0, 1.0, vR * 2.2);
        gl_FragColor = vec4(c * body * vFlame * (1.0 + edge) * 2.2, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/**
 * Round soft particles with per-particle size (world units), colour and alpha.
 * uScale converts world size to pixels: viewport height / (2·tan(fov/2)).
 */
export function makeParticleMaterial(additive) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec4 aColor;
      uniform float uScale;
      varying vec4 vColor;
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aColor.a > 0.0 ? max(1.0, aSize * uScale / -mv.z) : 0.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d) * 4.0;
        if (r > 1.0 || vColor.a <= 0.0) discard;
        float soft = ${additive ? '(1.0 - r) * (1.0 - r)' : '1.0 - r'};
        gl_FragColor = vec4(vColor.rgb, vColor.a * soft);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

export function radialGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(70,96,140,0.55)');
  grad.addColorStop(0.5, 'rgba(40,56,84,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

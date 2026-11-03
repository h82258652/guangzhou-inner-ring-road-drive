/**
 * Shared materials: CC0 PBR textures (Poly Haven) plus procedural canvas
 * textures, and shader patches for night-time lamp light pools and rain.
 */
import * as THREE from 'three';
import { mulberry32 } from '../shared/math';

export const envUniforms = {
  uNight: { value: 0 },
  uWet: { value: 0 },
  uTime: { value: 0 },
};

const loader = new THREE.TextureLoader();
let anisotropy = 4;
export function setAnisotropy(a: number) {
  anisotropy = a;
}

function tex(url: string, srgb: boolean, repeat = 1): THREE.Texture {
  const t = loader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(repeat, repeat);
  return t;
}

const base = import.meta.env.BASE_URL + 'assets/textures/';

/** Patch: lamp light pools along roads at night + wet look. uv must be in metres (x = lateral, y = along). */
function patchRoad(m: THREE.MeshStandardMaterial, lampScale = 1) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = envUniforms.uNight;
    shader.uniforms.uWet = envUniforms.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aExtra;\nvarying vec2 vRoad;\nvarying float vLampD;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRoad = uv;\nvLampD = aExtra;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uNight;\nuniform float uWet;\nvarying vec2 vRoad;\nvarying float vLampD;',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, roughnessFactor * 0.35, uWet);',
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.72, uWet);',
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float sl = mod(vRoad.y - 18.0, 36.0);
          sl = min(sl, 36.0 - sl);
          float pool = exp(-sl * sl / 220.0) * exp(-pow(vRoad.x - vLampD, 2.0) / 90.0);
          totalEmissiveRadiance += uNight * ${lampScale.toFixed(2)} * (0.05 + 1.1 * pool) * vec3(1.0, 0.88, 0.72) * diffuseColor.rgb;
        }`,
      );
  };
  m.customProgramCacheKey = () => 'road' + lampScale;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function flowerTexture() {
  return canvasTexture(256, 128, (g) => {
    const rnd = mulberry32(7);
    g.fillStyle = '#2f5a23';
    g.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 900; i++) {
      const x = rnd() * 256;
      const y = rnd() * 128;
      g.fillStyle = `hsl(${95 + rnd() * 35}, ${35 + rnd() * 30}%, ${18 + rnd() * 22}%)`;
      g.beginPath();
      g.ellipse(x, y, 3 + rnd() * 5, 2 + rnd() * 3, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
    // bougainvillea bracts (簕杜鹃)
    for (let i = 0; i < 700; i++) {
      const x = rnd() * 256;
      const y = rnd() * 128;
      const hue = rnd() < 0.85 ? 315 + rnd() * 25 : 20 + rnd() * 20;
      g.fillStyle = `hsl(${hue}, ${70 + rnd() * 25}%, ${48 + rnd() * 18}%)`;
      g.beginPath();
      g.arc(x, y, 1.5 + rnd() * 3.2, 0, Math.PI * 2);
      g.fill();
    }
  });
}

export function hangingFlowerTexture() {
  return canvasTexture(256, 128, (g) => {
    const rnd = mulberry32(11);
    g.clearRect(0, 0, 256, 128);
    for (let k = 0; k < 70; k++) {
      const x0 = rnd() * 256;
      const len = 30 + rnd() * 95;
      for (let y = 0; y < len; y += 3) {
        const x = x0 + Math.sin(y * 0.08 + k) * 4;
        const flower = rnd() < 0.55;
        g.fillStyle = flower ? `hsl(${318 + rnd() * 22}, 80%, ${50 + rnd() * 15}%)` : `hsl(${100 + rnd() * 30}, 45%, ${22 + rnd() * 15}%)`;
        g.beginPath();
        g.arc(x, y, 2 + rnd() * 3 * (1 - y / 140), 0, Math.PI * 2);
        g.fill();
      }
    }
  });
}

export function noiseWallTexture() {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = 'rgba(170, 205, 210, 0.38)';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(90, 100, 105, 0.95)';
    g.fillRect(0, 0, 14, 256);
    g.fillRect(0, 0, 256, 10);
    g.fillRect(0, 120, 256, 6);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(40, 230);
    g.lineTo(120, 150);
    g.stroke();
  });
}

export function cushionTexture() {
  return canvasTexture(128, 64, (g) => {
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? '#111' : '#f2c200';
      g.fillRect(i * 16, 0, 16, 64);
    }
  });
}

export interface RoadMaterials {
  road: THREE.MeshStandardMaterial;
  marking: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  girder: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  planter: THREE.MeshStandardMaterial;
  hanging: THREE.MeshStandardMaterial;
  noiseWall: THREE.MeshStandardMaterial;
  lampHead: THREE.MeshStandardMaterial;
  cushion: THREE.MeshStandardMaterial;
  joint: THREE.MeshStandardMaterial;
  pavement: THREE.MeshStandardMaterial;
}

let cached: RoadMaterials | null = null;

export function roadMaterials(): RoadMaterials {
  if (cached) return cached;
  const road = new THREE.MeshStandardMaterial({
    map: tex(base + 'asphalt_diff.jpg', true, 1 / 3.2),
    normalMap: tex(base + 'asphalt_normal.jpg', false, 1 / 3.2),
    roughnessMap: tex(base + 'asphalt_rough.jpg', false, 1 / 3.2),
    color: new THREE.Color(0.62, 0.62, 0.64),
    roughness: 1,
    metalness: 0,
  });
  road.normalScale.set(0.6, 0.6);
  patchRoad(road);
  const marking = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  patchRoad(marking, 1.3);
  const concreteMap = tex(base + 'concrete_diff.jpg', true, 1 / 3);
  const concreteNormal = tex(base + 'concrete_normal.jpg', false, 1 / 3);
  const concrete = new THREE.MeshStandardMaterial({ map: concreteMap, normalMap: concreteNormal, color: new THREE.Color(0.86, 0.85, 0.82), roughness: 0.92, side: THREE.DoubleSide });
  const girder = new THREE.MeshStandardMaterial({ map: concreteMap, normalMap: concreteNormal, color: new THREE.Color(0.66, 0.66, 0.64), roughness: 0.95, side: THREE.DoubleSide });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.45, metalness: 0.75 });
  const planter = new THREE.MeshStandardMaterial({ map: flowerTexture(), roughness: 0.9, side: THREE.DoubleSide });
  const hanging = new THREE.MeshStandardMaterial({ map: hangingFlowerTexture(), roughness: 0.9, alphaTest: 0.4, side: THREE.DoubleSide });
  const noiseWall = new THREE.MeshStandardMaterial({ map: noiseWallTexture(), transparent: true, roughness: 0.15, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false });
  const lampHead = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: new THREE.Color(1.0, 0.93, 0.8), emissiveIntensity: 0, roughness: 0.4 });
  const cushion = new THREE.MeshStandardMaterial({ map: cushionTexture(), roughness: 0.6 });
  const joint = new THREE.MeshStandardMaterial({ color: 0x3a3c3e, roughness: 0.35, metalness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const pavement = new THREE.MeshStandardMaterial({
    map: tex(base + 'pavement_diff.jpg', true, 1 / 6),
    normalMap: tex(base + 'pavement_normal.jpg', false, 1 / 6),
    color: new THREE.Color(0.8, 0.8, 0.78),
    roughness: 0.95,
  });
  cached = { road, marking, concrete, girder, metal, planter, hanging, noiseWall, lampHead, cushion, joint, pavement };
  return cached;
}


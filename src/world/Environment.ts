/** Sky, sun/moon, fog, time of day and rain. */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { envUniforms } from './Materials';
import { clamp, lerp, smoothstep } from '../shared/math';

export type Weather = 'clear' | 'cloudy' | 'rain';

const LAT = (23.125 * Math.PI) / 180;
const DECL = (12 * Math.PI) / 180;

export class Environment {
  readonly sky = new Sky();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbcd3ef, 0x55524a, 1.2);
  readonly fog: THREE.Fog;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private skyScene = new THREE.Scene();
  hour = 14;
  weather: Weather = 'clear';
  drawDistance = 2600;
  night = 0;
  private rain: THREE.LineSegments | null = null;
  readonly sunDir = new THREE.Vector3();

  constructor(
    readonly scene: THREE.Scene,
    readonly renderer: THREE.WebGLRenderer,
  ) {
    this.sky.scale.setScalar(40000);
    this.sky.material.uniforms.turbidity.value = 4;
    this.sky.material.uniforms.rayleigh.value = 2.2;
    this.sky.material.uniforms.mieCoefficient.value = 0.005;
    this.sky.material.uniforms.mieDirectionalG.value = 0.82;
    scene.add(this.sky);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -130;
    sc.right = 130;
    sc.top = 130;
    sc.bottom = -130;
    sc.near = 10;
    sc.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.hemi);
    this.fog = new THREE.Fog(0xc8d2dc, 200, 2600);
    scene.fog = this.fog;
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  set(hour: number, weather: Weather) {
    this.hour = hour;
    this.weather = weather;
    this.apply();
  }

  /** Sun direction for Guangzhou (approx. spring/autumn). */
  private sunVector(hour: number): THREE.Vector3 {
    const H = ((hour - 12.4) / 24) * Math.PI * 2;
    const sinEl = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H);
    const el = Math.asin(sinEl);
    const cosAz = (Math.sin(DECL) - Math.sin(el) * Math.sin(LAT)) / (Math.cos(el) * Math.cos(LAT) + 1e-6);
    let az = Math.acos(clamp(cosAz, -1, 1));
    if (H > 0) az = Math.PI * 2 - az; // afternoon: west
    // az from north clockwise; world: north = -Z, east = +X
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  }

  apply() {
    const v = this.sunVector(this.hour);
    this.sunDir.copy(v);
    const el = Math.asin(v.y);
    const elDeg = (el * 180) / Math.PI;
    this.night = 1 - smoothstep(-6, 4, elDeg);
    envUniforms.uNight.value = this.night;
    const cloudy = this.weather === 'cloudy' ? 1 : this.weather === 'rain' ? 1.4 : 0;
    envUniforms.uWet.value = this.weather === 'rain' ? 1 : 0;

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(v);
    u.turbidity.value = 4 + cloudy * 7;
    u.rayleigh.value = lerp(2.2, 0.6, Math.min(1, cloudy));
    this.sky.visible = elDeg > -8;

    const day = smoothstep(-2, 12, elDeg);
    const golden = smoothstep(18, 3, elDeg) * smoothstep(-4, 3, elDeg);
    const sunColor = new THREE.Color().setRGB(1, lerp(0.95, 0.62, golden), lerp(0.9, 0.4, golden));
    this.sun.color.copy(sunColor);
    this.sun.intensity = 3.0 * day * (1 - 0.65 * Math.min(1, cloudy));
    this.sun.castShadow = day > 0.05 && cloudy < 1;

    const nightSky = new THREE.Color(0.035, 0.045, 0.075);
    const dayHemi = new THREE.Color(0.72, 0.8, 0.92);
    const hemiSky = dayHemi.clone().lerp(new THREE.Color(1.0, 0.72, 0.55), golden * 0.6).lerp(nightSky, this.night);
    this.hemi.color.copy(hemiSky);
    this.hemi.groundColor.copy(new THREE.Color(0.35, 0.33, 0.3).lerp(new THREE.Color(0.06, 0.05, 0.05), this.night));
    this.hemi.intensity = lerp(1.15, 0.55, this.night) * (1 + 0.25 * Math.min(1, cloudy));

    // haze typical of Guangzhou; orange city glow at night
    const dayFog = new THREE.Color(0.78, 0.82, 0.86).lerp(new THREE.Color(0.62, 0.64, 0.66), Math.min(1, cloudy));
    const duskFog = new THREE.Color(0.86, 0.68, 0.55);
    const nightFog = new THREE.Color(0.11, 0.1, 0.12);
    const fogColor = dayFog.lerp(duskFog, golden * 0.7).lerp(nightFog, this.night);
    this.fog.color.copy(fogColor);
    const dist = this.drawDistance * (this.weather === 'rain' ? 0.55 : this.weather === 'cloudy' ? 0.8 : 1);
    this.fog.near = dist * 0.12;
    this.fog.far = dist;
    if (!this.sky.visible || this.night > 0.6) this.scene.background = fogColor.clone().multiplyScalar(this.night > 0.6 ? 1.3 : 1);
    else this.scene.background = null;

    this.renderer.toneMappingExposure = lerp(0.62, 0.95, this.night) * (this.weather === 'rain' ? 0.9 : 1);
    this.updateEnvMap(fogColor);
    this.setRain(this.weather === 'rain');
  }

  private updateEnvMap(fogColor: THREE.Color) {
    // reflections: sky dome (day) or dark city ambience (night)
    this.skyScene.clear();
    if (this.sky.visible && this.night < 0.6) {
      const s = new Sky();
      s.scale.setScalar(1000);
      const su = s.material.uniforms;
      const u = this.sky.material.uniforms;
      for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) su[k].value = u[k].value;
      su.sunPosition.value.copy(u.sunPosition.value);
      this.skyScene.add(s);
      this.skyScene.background = null;
    } else {
      this.skyScene.background = fogColor.clone().multiplyScalar(2.2);
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshBasicMaterial({ color: fogColor.clone().multiplyScalar(0.5) }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -10;
    this.skyScene.add(ground);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.skyScene, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = lerp(0.1, 0.05, this.night);
  }

  private setRain(on: boolean) {
    if (on && !this.rain) {
      const n = 6000;
      const pos = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        const x = (Math.random() - 0.5) * 120;
        const y = Math.random() * 60;
        const z = (Math.random() - 0.5) * 120;
        pos.set([x, y, z, x + 0.05, y - 0.9, z + 0.05], i * 6);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaab4bf, transparent: true, opacity: 0.35 }));
      this.rain.frustumCulled = false;
      this.scene.add(this.rain);
    } else if (!on && this.rain) {
      this.scene.remove(this.rain);
      this.rain.geometry.dispose();
      this.rain = null;
    }
  }

  /** Per-frame: follow the focus point with the shadow camera and rain volume. */
  update(dt: number, focus: THREE.Vector3) {
    envUniforms.uTime.value += dt;
    const d = this.sunDir;
    const texel = 260 / 2048;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.position.set(fx + d.x * 400, focus.y + d.y * 400, fz + d.z * 400);
    this.sun.target.position.set(fx, focus.y, fz);
    if (this.rain) {
      this.rain.position.set(focus.x, focus.y - 10, focus.z);
      const pos = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 6) {
        arr[i + 1] -= dt * 22;
        arr[i + 4] -= dt * 22;
        if (arr[i + 4] < 0) {
          arr[i + 1] += 60;
          arr[i + 4] += 60;
        }
      }
      pos.needsUpdate = true;
    }
  }
}


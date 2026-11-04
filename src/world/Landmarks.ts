/**
 * Procedural landmark models placed at their real coordinates: Canton Tower
 * (twisted hyperboloid lattice with night lights), Zhujiang New Town towers,
 * CITIC Plaza, Zhenhai Tower, Guangzhou Railway Station, Sun Yat-sen Memorial
 * Hall, Guangzhou Circle, Haiyin Bridge pylons and Haizhu Bridge arches.
 */
import * as THREE from 'three';
import type { LandmarkRec } from '../shared/types';
import { envUniforms } from './Materials';
import type { Terrain } from './City';
import { buildingMaterial, CELL_H, CELL_W } from './Facades';
import { MeshBuilder } from './MeshBuilder';

export interface LandmarkVisuals {
  group: THREE.Group;
  update(dt: number): void;
}

export function buildLandmarks(list: LandmarkRec[], terrain: Terrain | null): LandmarkVisuals {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const updaters: ((dt: number) => void)[] = [];
  const at = (id: string) => list.find((l) => l.id === id);
  const ground = (x: number, z: number) => (terrain ? terrain.height(x, z) : 0);

  const ct = at('canton-tower');
  if (ct) {
    const { obj, update } = cantonTower();
    obj.position.set(ct.x, ground(ct.x, ct.z), ct.z);
    group.add(obj);
    updaters.push(update);
  }
  const bm = buildingMaterial();
  const towerFrom = (id: string, build: () => THREE.BufferGeometry) => {
    const l = at(id);
    if (!l) return;
    const m = new THREE.Mesh(build(), bm);
    m.position.set(l.x, ground(l.x, l.z), l.z);
    m.castShadow = true;
    group.add(m);
  };
  towerFrom('ctf', () => steppedTower([62, 58, 52, 44], [0, 260, 420, 490, 530], 7));
  towerFrom('ifc', () => triTower(32, 440, 3));
  towerFrom('citic', () => {
    const g = steppedTower([46, 40], [0, 322, 330], 4);
    return g;
  });
  const citic = at('citic');
  if (citic) {
    for (const off of [-9, 9]) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.2, 62, 8), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.35 }));
      mast.position.set(citic.x + off, ground(citic.x, citic.z) + 330 + 31, citic.z);
      group.add(mast);
    }
  }
  const zh = at('zhenhai');
  if (zh) {
    const obj = zhenhaiTower();
    obj.position.set(zh.x, ground(zh.x, zh.z), zh.z);
    group.add(obj);
  }
  const st = at('station');
  if (st) {
    const obj = railwayStation();
    obj.position.set(st.x, ground(st.x, st.z), st.z);
    group.add(obj);
  }
  const mem = at('memorial');
  if (mem) {
    const obj = memorialHall();
    obj.position.set(mem.x, ground(mem.x, mem.z), mem.z);
    group.add(obj);
  }
  const gc = at('guangzhou-circle');
  if (gc) {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, 73, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, 25, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 32, bevelEnabled: false, curveSegments: 48 });
    geo.translate(0, 0, -16);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 0.85, roughness: 0.3 }));
    mesh.position.set(gc.x, ground(gc.x, gc.z) + 69, gc.z);
    group.add(mesh);
  }
  const hy = at('haiyin-bridge');
  if (hy) group.add(cableStayed(hy.x, hy.z, -0.27));
  const hz = at('haizhu-bridge');
  if (hz) group.add(archBridge(hz.x, hz.z, 0.03));

  return {
    group,
    update(dt: number) {
      for (const u of updaters) u(dt);
    },
  };
}

/** Canton Tower: 454 m twisted hyperboloid + 146 m antenna. */
function cantonTower(): { obj: THREE.Object3D; update: (dt: number) => void } {
  const obj = new THREE.Group();
  const H = 454;
  const cols = 24;
  const steps = 48;
  // ellipse radii along height (waist at ~0.62 H), twist of 45 degrees
  const rx = (t: number) => 40 - 30 * Math.sin(Math.min(1, t / 0.62) * Math.PI * 0.5) + Math.max(0, t - 0.62) * 30;
  const rz = (t: number) => 30 - 20 * Math.sin(Math.min(1, t / 0.62) * Math.PI * 0.5) + Math.max(0, t - 0.62) * 22;
  const lattice = new MeshBuilder();
  const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number) => {
    const dir = b.clone().sub(a);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r, r, len, 5, 1, true);
    g.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    g.applyQuaternion(q);
    g.translate(a.x, a.y, a.z);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const base = lattice.vertexCount;
    for (let i = 0; i < p.count; i++) lattice.vertex(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), 0, p.getY(i) / H);
    const idx = g.index!;
    for (let i = 0; i < idx.count; i += 3) lattice.tri(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
  };
  const pt = (k: number, t: number, twistSign: number) => {
    const a = (k / cols) * Math.PI * 2 + twistSign * t * Math.PI * 0.75;
    return new THREE.Vector3(Math.cos(a) * rx(t), t * H, Math.sin(a) * rz(t));
  };
  for (let k = 0; k < cols; k++) {
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      tube(pt(k, t0, 1), pt(k, t1, 1), 0.9);
    }
  }
  // horizontal rings
  for (let s = 2; s < steps; s += 2) {
    const t = s / steps;
    for (let k = 0; k < cols; k++) tube(pt(k, t, 1), pt(k + 1, t, 1), 0.45);
  }
  const latticeGeo = lattice.build()!;
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 0.6, roughness: 0.4, emissive: new THREE.Color(1, 1, 1) });
  lightMat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = envUniforms.uNight;
    shader.uniforms.uTime = envUniforms.uTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float vH;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvH = uv.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uTime;\nvarying float vH;\nvec3 hsv(float h){ vec3 k = vec3(1.0, 2.0/3.0, 1.0/3.0); vec3 p = abs(fract(h + k) * 6.0 - 3.0); return clamp(p - 1.0, 0.0, 1.0); }')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = uNight * 3.0 * hsv(fract(vH * 0.8 - uTime * 0.05));');
  };
  const latticeMesh = new THREE.Mesh(latticeGeo, lightMat);
  obj.add(latticeMesh);
  // inner core
  const core = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, H, 16), new THREE.MeshStandardMaterial({ color: 0x9aa2a8, roughness: 0.6, metalness: 0.3 }));
  core.position.y = H / 2;
  obj.add(core);
  // decks
  for (const t of [0.33, 0.45, 0.82, 0.95]) {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(rx(t) * 0.92, rx(t) * 0.92, 6, 24), new THREE.MeshStandardMaterial({ color: 0x5f7383, metalness: 0.5, roughness: 0.3 }));
    d.scale.z = rz(t) / rx(t);
    d.position.y = t * H;
    obj.add(d);
  }
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 6, 146, 12), new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.7, roughness: 0.3, emissive: 0xff2020, emissiveIntensity: 0 }));
  antenna.position.y = H + 73;
  obj.add(antenna);
  let blink = 0;
  return {
    obj,
    update(dt) {
      blink += dt;
      (antenna.material as THREE.MeshStandardMaterial).emissiveIntensity = envUniforms.uNight.value * (Math.sin(blink * 3) > 0.6 ? 3 : 0.3);
    },
  };
}

/** Box tower with setbacks; widths per tier, heights[0..n]. */
function steppedTower(widths: number[], heights: number[], style: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  for (let k = 0; k < widths.length; k++) {
    const w = widths[k] / 2;
    const y0 = heights[k];
    const y1 = heights[k + 1];
    const ch = 0.18 * w; // chamfered corners
    const pts: [number, number][] = [
      [-w + ch, -w],
      [w - ch, -w],
      [w, -w + ch],
      [w, w - ch],
      [w - ch, w],
      [-w + ch, w],
      [-w, w - ch],
      [-w, -w + ch],
    ];
    // listed clockwise in map orientation; prism() expects counter-clockwise
    prism(b, pts.reverse(), y0, y1, style);
  }
  return b.build('aStyle')!;
}

function triTower(r: number, h: number, style: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const pts: [number, number][] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const rr = r * (0.82 + 0.18 * Math.cos(3 * a));
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  // reverse to make the polygon CCW in map orientation (x, -z)
  prism(b, pts.reverse(), 0, h, style);
  return b.build('aStyle')!;
}

/** Vertical prism with facade atlas UVs; pts are CCW in map orientation (x east, z south => use (x,-z)). */
function prism(b: MeshBuilder, pts: [number, number][], y0: number, y1: number, style: number) {
  let per = 0;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    const c = pts[(k + 1) % pts.length];
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    const nx = -dz / len;
    const nz = dx / len;
    const u0 = per / CELL_W;
    const u1 = (per + len) / CELL_W;
    per += len;
    const i0 = b.vertex(a[0], y0, a[1], nx, 0, nz, u0, y0 / CELL_H, undefined, style);
    const i1 = b.vertex(c[0], y0, c[1], nx, 0, nz, u1, y0 / CELL_H, undefined, style);
    const i2 = b.vertex(c[0], y1, c[1], nx, 0, nz, u1, y1 / CELL_H, undefined, style);
    const i3 = b.vertex(a[0], y1, a[1], nx, 0, nz, u0, y1 / CELL_H, undefined, style);
    b.quad(i0, i1, i2, i3);
  }
  const ids = pts.map(([x, z]) => b.vertex(x, y1, z, 0, 1, 0, x / 30, z / 30, undefined, 9));
  for (let k = 1; k + 1 < pts.length; k++) b.tri(ids[0], ids[k], ids[k + 1]);
}

function zhenhaiTower(): THREE.Object3D {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xa3352a, roughness: 0.8 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x2f6b45, roughness: 0.6 });
  for (let k = 0; k < 5; k++) {
    const w = 31 - k * 2.6;
    const d = 16 - k * 1.2;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 4.4, d), red);
    wall.position.y = 2.2 + k * 5.2;
    g.add(wall);
    const r = new THREE.Mesh(new THREE.BoxGeometry(w + 3, 0.8, d + 3), roof);
    r.position.y = 4.8 + k * 5.2;
    g.add(r);
  }
  const top = new THREE.Mesh(new THREE.ConeGeometry(12, 5, 4), roof);
  top.rotation.y = Math.PI / 4;
  top.scale.z = 0.55;
  top.position.y = 28.5;
  g.add(top);
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

function railwayStation(): THREE.Object3D {
  const g = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = '#e6e2d8';
  x.fillRect(0, 0, 1024, 128);
  for (let i = 0; i < 40; i++) {
    x.fillStyle = '#3c4a55';
    x.fillRect(10 + i * 25, 70, 18, 46);
  }
  x.fillStyle = '#c4161c';
  x.font = 'bold 72px "Microsoft YaHei","PingFang SC",sans-serif';
  x.textAlign = 'center';
  x.fillText('广 州', 512, 62);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const side = new THREE.MeshStandardMaterial({ color: 0xe0dcd2, roughness: 0.8 });
  const front = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
  // facade faces south (+Z)
  const box = new THREE.Mesh(new THREE.BoxGeometry(220, 22, 45), [side, side, side, side, front, side]);
  box.position.y = 11;
  g.add(box);
  const clock = new THREE.Mesh(new THREE.BoxGeometry(14, 40, 14), side);
  clock.position.set(0, 20, 18);
  g.add(clock);
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

function memorialHall(): THREE.Object3D {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(36, 38, 22, 8), new THREE.MeshStandardMaterial({ color: 0xe8e1d0, roughness: 0.8 }));
  base.position.y = 11;
  g.add(base);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(42, 28, 8), new THREE.MeshStandardMaterial({ color: 0x2c4f9e, roughness: 0.5 }));
  roof.position.y = 36;
  g.add(roof);
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

/** Cable-stayed bridge pylons (Haiyin Bridge). angle = bridge axis rotation from north-south. */
function cableStayed(x: number, z: number, angle: number): THREE.Object3D {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xe9ecee, roughness: 0.6 });
  const cable = new THREE.LineBasicMaterial({ color: 0xdfe3e6 });
  for (const side of [-1, 1]) {
    const py = new THREE.Mesh(new THREE.BoxGeometry(3, 110, 3.6), white);
    py.position.set(side * 13, 55, 0);
    g.add(py);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(30, 3, 3), white);
  beam.position.set(0, 98, 0);
  g.add(beam);
  const pos: number[] = [];
  for (const side of [-1, 1])
    for (let k = 1; k <= 9; k++)
      for (const dir of [-1, 1]) {
        pos.push(side * 13, 104 - k * 2.5, 0, side * 12, 13, dir * k * 11);
      }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.add(new THREE.LineSegments(lg, cable));
  g.position.set(x, 0, z);
  g.rotation.y = angle;
  return g;
}

/** Steel arch bridge (Haizhu Bridge) – three arches over the deck along the N-S axis. */
function archBridge(x: number, z: number, angle: number): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a9aa8, metalness: 0.6, roughness: 0.45 });
  const spans = [-62, 0, 62];
  for (const c of spans) {
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        pts.push(new THREE.Vector3(side * 9, 8 + Math.sin(t * Math.PI) * 16, c - 30 + 60 * t));
      }
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.7, 6), mat);
      g.add(tube);
    }
  }
  g.position.set(x, 0, z);
  g.rotation.y = angle;
  return g;
}


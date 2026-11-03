/**
 * City renderer: extruded OSM / infill buildings with the facade atlas,
 * streets, non-drivable expressways, Pearl River, parks, trees, railways,
 * terrain (Baiyun Mountain / Yuexiu Hill) and the distant skyline.
 */
import * as THREE from 'three';
import type { BuildingRec, CityFile } from '../shared/types';
import { ChunkedBuilder, MeshBuilder } from './MeshBuilder';
import { buildingMaterial, CELL_H, CELL_W, ROOF_STYLE } from './Facades';
import { envUniforms, roadMaterials } from './Materials';
import { hash01, mulberry32 } from '../shared/math';

export class Terrain {
  constructor(
    readonly bounds: [number, number, number, number],
    readonly w: number,
    readonly h: number,
    readonly data: Float32Array,
  ) {}
  height(x: number, z: number): number {
    const [x0, z0, x1, z1] = this.bounds;
    const u = ((x - x0) / (x1 - x0)) * (this.w - 1);
    const v = ((z - z0) / (z1 - z0)) * (this.h - 1);
    if (u < 0 || v < 0 || u > this.w - 1 || v > this.h - 1) return 0;
    const i = Math.min(Math.floor(u), this.w - 2);
    const j = Math.min(Math.floor(v), this.h - 2);
    const fu = u - i;
    const fv = v - j;
    const d = this.data;
    const a = d[j * this.w + i];
    const b = d[j * this.w + i + 1];
    const c = d[(j + 1) * this.w + i];
    const e = d[(j + 1) * this.w + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv;
  }
}

export interface CityVisuals {
  group: THREE.Group;
  chunks: THREE.Object3D[];
  treeChunks: THREE.Object3D[];
  terrain: Terrain | null;
}

const dq = (v: number) => v / 10;

export function buildCity(city: CityFile, opts: { trees: boolean; infill: boolean }): CityVisuals {
  const group = new THREE.Group();
  group.name = 'city';
  const terrain = city.terrain ? decodeTerrain(city.terrain) : null;
  const bmat = buildingMaterial();

  /* ---- buildings ---- */
  const cb = new ChunkedBuilder(500);
  const addBuilding = (b: BuildingRec, idx: number, target: ChunkedBuilder | MeshBuilder) => {
    const pts: [number, number][] = [];
    for (let k = 0; k < b.p.length; k += 2) pts.push([dq(b.p[k]), dq(b.p[k + 1])]);
    if (pts.length < 3) return;
    let cx = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p[0] / pts.length;
      cz += p[1] / pts.length;
    }
    const mb = target instanceof ChunkedBuilder ? target.get(cx, cz, 'b') : target;
    const groundY = terrain ? terrain.height(cx, cz) : 0;
    const base = groundY + (b.m ?? 0);
    const top = groundY + b.h;
    const style = b.s;
    const uOff = Math.floor(hash01(idx) * 4) * 0.25;
    const v0 = (b.m ?? 0) / CELL_H;
    const v1 = b.h / CELL_H;
    let per = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const c = pts[(k + 1) % pts.length];
      const dx = c[0] - a[0];
      const dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = -dz / len;
      const nz = dx / len;
      const u0 = per / CELL_W + uOff;
      const u1 = (per + len) / CELL_W + uOff;
      per += len;
      const i0 = mb.vertex(a[0], base, a[1], nx, 0, nz, u0, v0, undefined, style);
      const i1 = mb.vertex(c[0], base, c[1], nx, 0, nz, u1, v0, undefined, style);
      const i2 = mb.vertex(c[0], top, c[1], nx, 0, nz, u1, v1, undefined, style);
      const i3 = mb.vertex(a[0], top, a[1], nx, 0, nz, u0, v1, undefined, style);
      mb.quad(i0, i1, i2, i3);
    }
    // roof
    const contour = pts.map(([x, z]) => new THREE.Vector2(x, -z));
    let tris: number[][];
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      return;
    }
    const roofStyle = ROOF_STYLE + Math.floor(hash01(idx * 3 + 1) * 4);
    const ids = pts.map(([x, z]) => mb.vertex(x, top, z, 0, 1, 0, x / 30, z / 30, undefined, roofStyle));
    for (const [a, b2, c] of tris) {
      // ensure upward facing (CCW seen from above)
      const pa = pts[a];
      const pb = pts[b2];
      const pc = pts[c];
      const cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (cross < 0) mb.tri(ids[a], ids[b2], ids[c]);
      else mb.tri(ids[a], ids[c], ids[b2]);
    }
  };
  const blds = opts.infill ? city.buildings : city.buildings.filter((_, i) => i % 3 !== 0 || city.buildings[i].h > 30);
  blds.forEach((b, i) => addBuilding(b, i, cb));
  const bgroup = cb.toGroup({ b: bmat }, 'aStyle', { shadows: { b: true } });
  bgroup.name = 'buildings';
  group.add(bgroup);
  const chunks = [...bgroup.children];

  // skyline: merged, no shadows
  const sky = new MeshBuilder();
  city.skyline.forEach((b, i) => addBuilding(b, i + 1e6, sky));
  const skyGeo = sky.build('aStyle');
  if (skyGeo) {
    const m = new THREE.Mesh(skyGeo, bmat);
    m.name = 'skyline';
    group.add(m);
  }

  /* ---- ground / terrain ---- */
  group.add(buildGround(city, terrain));

  /* ---- streets & visual expressways ---- */
  const rmats = roadMaterials();
  const streetMat = new THREE.MeshStandardMaterial({
    map: rmats.road.map,
    normalMap: rmats.road.normalMap,
    roughnessMap: rmats.road.roughnessMap,
    color: new THREE.Color(0.5, 0.5, 0.52),
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  patchStreetNight(streetMat);
  const sb = new ChunkedBuilder(600);
  const piers: THREE.Matrix4[] = [];
  for (const [kind, width, flat] of city.roads) {
    const pts: [number, number, number][] = [];
    for (let k = 0; k < flat.length; k += 3) pts.push([dq(flat[k]), dq(flat[k + 1]), dq(flat[k + 2])]);
    if (pts.length < 2) continue;
    const elevated = kind >= 10;
    ribbon(sb, pts, width, elevated ? 0.02 : 0.045 + (kind % 3) * 0.004, elevated ? 'x' : 's', kind >= 10 ? true : false, piers);
  }
  const sgroup = sb.toGroup({ s: streetMat, x: streetMat, xs: rmats.girder, xb: rmats.concrete }, 'aExtra', { shadows: { xs: true, xb: true } });
  sgroup.name = 'streets';
  group.add(sgroup);
  if (piers.length) {
    const pg = new THREE.CylinderGeometry(0.7, 0.8, 1, 10);
    pg.translate(0, 0.5, 0);
    const pm = new THREE.InstancedMesh(pg, rmats.girder, piers.length);
    piers.forEach((m, i) => pm.setMatrixAt(i, m));
    pm.castShadow = true;
    pm.receiveShadow = true;
    pm.frustumCulled = false;
    group.add(pm);
  }

  /* ---- water ---- */
  group.add(buildWater(city));

  /* ---- parks ---- */
  group.add(buildGreen(city));

  /* ---- railway ---- */
  group.add(buildRail(city));

  /* ---- trees ---- */
  const treeChunks = opts.trees ? buildTrees(city, terrain) : [];
  for (const t of treeChunks) group.add(t);

  return { group, chunks: [...chunks, ...sgroup.children], treeChunks, terrain };
}

function decodeTerrain(t: NonNullable<CityFile['terrain']>): Terrain {
  const bin = atob(t.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 10;
  return new Terrain(t.bounds, t.w, t.h, f);
}

function buildGround(city: CityFile, terrain: Terrain | null): THREE.Object3D {
  const mats = roadMaterials();
  const size = 26000;
  const res = terrain ? 256 : 2;
  const g = new THREE.PlaneGeometry(size, size, res, res);
  g.rotateX(-Math.PI / 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const [cx0, cz0, cx1, cz1] = city.bounds;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrain ? terrain.height(x, z) : 0;
    pos.setY(i, h - 0.02);
    const hill = Math.min(1, h / 8);
    const inCity = x > cx0 && x < cx1 && z > cz0 && z < cz1 ? 1 : 0.6;
    const c = new THREE.Color(0.62 * inCity + 0.25 * (1 - inCity), 0.62 * inCity + 0.33 * (1 - inCity), 0.6 * inCity + 0.22 * (1 - inCity)).lerp(new THREE.Color(0.2, 0.33, 0.16), hill);
    colors.set([c.r, c.g, c.b], i * 3);
    uv.setXY(i, x / 6, z / 6);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ map: mats.pavement.map, normalMap: mats.pavement.normalMap, vertexColors: true, roughness: 1 });
  m.map = mats.pavement.map!.clone();
  m.map.repeat.set(1, 1);
  m.map.needsUpdate = true;
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

function patchStreetNight(m: THREE.MeshStandardMaterial) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = envUniforms.uNight;
    shader.uniforms.uWet = envUniforms.uWet;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uWet;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, roughnessFactor * 0.35, uWet);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uNight * 0.55 * vec3(1.0, 0.8, 0.55) * diffuseColor.rgb;');
  };
  m.customProgramCacheKey = () => 'street';
}

/** Flat ribbon for streets; elevated ones get a deck, low barriers and piers. */
function ribbon(cb: ChunkedBuilder, pts: [number, number, number][], width: number, lift: number, mat: string, elevated: boolean, piers: THREE.Matrix4[]) {
  const n = pts.length;
  const half = width / 2;
  const normals: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    normals.push([-dz / l, dx / l]);
  }
  const mid = pts[Math.floor(n / 2)];
  const b = cb.get(mid[0], mid[1], mat);
  let s = 0;
  let prev: [number, number] | null = null;
  for (let i = 0; i < n; i++) {
    const [x, z, y] = pts[i];
    if (i > 0) s += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
    const [nx, nz] = normals[i];
    const yy = y + lift;
    const L = b.vertex(x - nx * half, yy, z - nz * half, 0, 1, 0, -half, s, undefined, 999);
    const R = b.vertex(x + nx * half, yy, z + nz * half, 0, 1, 0, half, s, undefined, 999);
    if (prev) b.quad(prev[0], prev[1], R, L);
    prev = [L, R];
  }
  if (!elevated) return;
  // deck sides and barriers where elevated
  const side = cb.get(mid[0], mid[1], 'xs');
  const bar = cb.get(mid[0], mid[1], 'xb');
  s = 0;
  let lastPier = -20;
  for (let i = 1; i < n; i++) {
    const [x0, z0, y0] = pts[i - 1];
    const [x1, z1, y1] = pts[i];
    const seg = Math.hypot(x1 - x0, z1 - z0);
    if (y0 < 2 && y1 < 2) {
      s += seg;
      continue;
    }
    for (const sd of [-1, 1]) {
      const [n0x, n0z] = normals[i - 1];
      const [n1x, n1z] = normals[i];
      const ax = x0 + n0x * half * sd;
      const az = z0 + n0z * half * sd;
      const bx = x1 + n1x * half * sd;
      const bz = z1 + n1z * half * sd;
      // girder side
      const a0 = side.vertex(ax, y0, az, n0x * sd, 0, n0z * sd, s / 3, 0);
      const b0 = side.vertex(bx, y1, bz, n1x * sd, 0, n1z * sd, (s + seg) / 3, 0);
      const b1 = side.vertex(bx, y1 - 1.6, bz, n1x * sd, 0, n1z * sd, (s + seg) / 3, 0.5);
      const a1 = side.vertex(ax, y0 - 1.6, az, n0x * sd, 0, n0z * sd, s / 3, 0.5);
      side.quad(a0, b0, b1, a1);
      // barrier
      const c0 = bar.vertex(ax, y0, az, -n0x * sd, 0, -n0z * sd, s / 3, 0);
      const c1 = bar.vertex(bx, y1, bz, -n1x * sd, 0, -n1z * sd, (s + seg) / 3, 0);
      const c2 = bar.vertex(bx, y1 + 1.0, bz, -n1x * sd, 0, -n1z * sd, (s + seg) / 3, 0.35);
      const c3 = bar.vertex(ax, y0 + 1.0, az, -n0x * sd, 0, -n0z * sd, s / 3, 0.35);
      bar.quad(c0, c1, c2, c3);
    }
    // underside
    {
      const [n0x, n0z] = normals[i - 1];
      const [n1x, n1z] = normals[i];
      const u0 = side.vertex(x0 - n0x * half, y0 - 1.6, z0 - n0z * half, 0, -1, 0, 0, 0);
      const u1 = side.vertex(x1 - n1x * half, y1 - 1.6, z1 - n1z * half, 0, -1, 0, 0, 1);
      const u2 = side.vertex(x1 + n1x * half, y1 - 1.6, z1 + n1z * half, 0, -1, 0, 1, 1);
      const u3 = side.vertex(x0 + n0x * half, y0 - 1.6, z0 + n0z * half, 0, -1, 0, 1, 0);
      side.quad(u0, u1, u2, u3);
    }
    for (let t = lastPier + 32 - s; t < seg; t += 32) {
      if (t < 0) continue;
      const f = t / seg;
      const px = x0 + (x1 - x0) * f;
      const pz = z0 + (z1 - z0) * f;
      const py = y0 + (y1 - y0) * f;
      if (py > 4) piers.push(new THREE.Matrix4().compose(new THREE.Vector3(px, 0, pz), new THREE.Quaternion(), new THREE.Vector3(1, py - 1.6, 1)));
      lastPier = s + t;
    }
    s += seg;
  }
}

function buildWater(city: CityFile): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'water';
  const geos: THREE.BufferGeometry[] = [];
  for (const polys of city.water) {
    const toV = (flat: number[]) => {
      const v: THREE.Vector2[] = [];
      for (let k = 0; k < flat.length; k += 2) v.push(new THREE.Vector2(dq(flat[k]), -dq(flat[k + 1])));
      return v;
    };
    const shape = new THREE.Shape(toV(polys[0]));
    for (const h of polys.slice(1)) shape.holes.push(new THREE.Path(toV(h)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    geos.push(g);
  }
  if (!geos.length) return group;
  const merged = mergeSimple(geos);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.17, 0.22, 0.19), roughness: 0.08, metalness: 0.1, envMapIntensity: 6 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = envUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWPos;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz;
          float t = uTime;
          vec2 g = vec2(0.0);
          g += vec2(cos(p.x * 0.31 + t * 1.3), sin(p.y * 0.27 + t * 1.1)) * 0.035;
          g += vec2(sin(p.x * 0.83 - p.y * 0.41 + t * 2.1), cos(p.y * 0.77 + p.x * 0.29 - t * 1.7)) * 0.02;
          g += vec2(sin(p.x * 2.1 + t * 3.0), cos(p.y * 1.9 - t * 2.6)) * 0.01;
          normal = normalize(normal + (viewMatrix * vec4(g.x, 0.0, g.y, 0.0)).xyz);
        }`,
      );
  };
  const mesh = new THREE.Mesh(merged, mat);
  mesh.position.y = 0.06;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

function buildGreen(city: CityFile): THREE.Object3D {
  const geos: THREE.BufferGeometry[] = [];
  const colors = [new THREE.Color(0.3, 0.45, 0.22), new THREE.Color(0.33, 0.48, 0.24), new THREE.Color(0.38, 0.5, 0.28), new THREE.Color(0.2, 0.33, 0.16), new THREE.Color(0.36, 0.42, 0.33)];
  for (const [kind, flat] of city.green) {
    const v: THREE.Vector2[] = [];
    for (let k = 0; k < flat.length; k += 2) v.push(new THREE.Vector2(dq(flat[k]), -dq(flat[k + 1])));
    if (v.length < 3) continue;
    const g = new THREE.ShapeGeometry(new THREE.Shape(v));
    g.rotateX(-Math.PI / 2);
    const c = colors[Math.min(colors.length - 1, kind)];
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  }
  const mesh = new THREE.Mesh(mergeSimple(geos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  mesh.position.y = 0.03;
  mesh.receiveShadow = true;
  mesh.name = 'green';
  return mesh;
}

function buildRail(city: CityFile): THREE.Object3D {
  const b = new MeshBuilder();
  const ballast = new THREE.Color(0.42, 0.38, 0.34);
  const rail = new THREE.Color(0.25, 0.24, 0.24);
  for (const flat of city.rail) {
    const pts: [number, number][] = [];
    for (let k = 0; k < flat.length; k += 2) pts.push([dq(flat[k]), dq(flat[k + 1])]);
    for (const [w, y, c] of [
      [3.2, 0.05, ballast],
      [0.12, 0.2, rail],
    ] as [number, number, THREE.Color][]) {
      const offs = w < 1 ? [-0.72, 0.72] : [0];
      for (const off of offs) {
        let pl = -1;
        let pr = -1;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)];
          const bb = pts[Math.min(pts.length - 1, i + 1)];
          const dx = bb[0] - a[0];
          const dz = bb[1] - a[1];
          const l = Math.hypot(dx, dz) || 1;
          const nx = -dz / l;
          const nz = dx / l;
          const [x, z] = pts[i];
          const L = b.vertex(x + nx * (off - w / 2), y, z + nz * (off - w / 2), 0, 1, 0, 0, 0, c);
          const R = b.vertex(x + nx * (off + w / 2), y, z + nz * (off + w / 2), 0, 1, 0, 0, 0, c);
          if (pl >= 0) b.quad(pl, pr, R, L);
          pl = L;
          pr = R;
        }
      }
    }
  }
  const g = b.build();
  const mesh = new THREE.Mesh(g ?? new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  mesh.receiveShadow = true;
  mesh.name = 'rail';
  return mesh;
}

function buildTrees(city: CityFile, terrain: Terrain | null): THREE.Object3D[] {
  const chunkSize = 500;
  const groups = new Map<string, number[]>();
  for (let k = 0; k < city.trees.length; k += 3) {
    const x = dq(city.trees[k]);
    const z = dq(city.trees[k + 1]);
    const key = `${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`;
    let a = groups.get(key);
    if (!a) groups.set(key, (a = []));
    a.push(x, z, city.trees[k + 2] / 100);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 3.2, 5);
  trunkGeo.translate(0, 1.6, 0);
  const crownGeo = new THREE.IcosahedronGeometry(2.6, 0);
  crownGeo.scale(1.25, 0.85, 1.25);
  crownGeo.translate(0, 4.6, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4a3a, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const out: THREE.Object3D[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const rnd = mulberry32(5);
  for (const [key, arr] of groups) {
    const n = arr.length / 3;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, n);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = arr[i * 3];
      const z = arr[i * 3 + 1];
      const s = arr[i * 3 + 2];
      const y = terrain ? terrain.height(x, z) : 0;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s * (0.85 + rnd() * 0.4), s));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      col.setHSL(0.24 + rnd() * 0.08, 0.35 + rnd() * 0.2, 0.2 + rnd() * 0.1);
      crowns.setColorAt(i, col);
    }
    trunks.castShadow = false;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    const g = new THREE.Group();
    g.add(trunks, crowns);
    const [cx, cz] = key.split(',').map(Number);
    g.userData.center = new THREE.Vector3((cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize);
    trunks.computeBoundingSphere();
    crowns.computeBoundingSphere();
    out.push(g);
  }
  return out;
}

export function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let off = 0;
  let hasColor = false;
  for (const g of geos) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const c = g.getAttribute('color');
    if (c) hasColor = true;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
      col.push(c ? c.getX(i) : 1, c ? c.getY(i) : 1, c ? c.getZ(i) : 1);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  if (hasColor) out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

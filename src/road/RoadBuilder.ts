/**
 * Builds the visual road infrastructure from the network: deck surfaces,
 * lane markings (GB 5768 style), New Jersey barriers, box girders, piers
 * (incl. portal frames under double-deck sections), single-arm LED street
 * lights, bougainvillea planters, noise barriers, expansion joints, gore
 * chevrons, pavement speed numerals, guide arrows and crash cushions.
 */
import * as THREE from 'three';
import { ChunkedBuilder, MeshBuilder } from '../world/MeshBuilder';
import { roadMaterials } from '../world/Materials';
import { type Edge, type RoadNetwork, newFrame, type RoadFrame } from './Network';
import { BARRIER_WIDTH, DeckIndex, GIRDER_DEPTH, TRAFFIC_HEADROOM } from './Clearance';

const WHITE = new THREE.Color(0.92, 0.92, 0.9);
// linear-space road paint yellow (≈ sRGB #EDB627)
const YELLOW = new THREE.Color(0.84, 0.47, 0.02);
const DARK = new THREE.Color(0.25, 0.25, 0.26);

const LAMP_SPACING = 36;
const PIER_SPACING = 30;
const JOINT_SPACING = 96;

/** New Jersey barrier profile: [outward offset from bound, height]. */
const BARRIER_PROFILE: [number, number][] = [
  [0, 0],
  [0.06, 0.08],
  [0.16, 0.3],
  [0.21, 0.84],
  [0.23, 1.05],
  [0.5, 1.05],
  [0.52, 0.0],
];

export interface RoadVisuals {
  group: THREE.Group;
  lampHeads: THREE.InstancedMesh;
  lampPositions: THREE.Vector3[];
  /** pavement markings placed: guide arrow sets and speed numeral sets */
  pavement: { arrows: number; numerals: number };
}

export function buildRoads(net: RoadNetwork, decks: DeckIndex = new DeckIndex(net)): RoadVisuals {
  const mats = roadMaterials();
  const cb = new ChunkedBuilder(400);
  const f = newFrame();
  const f2 = newFrame();

  const piers: THREE.Matrix4[] = [];
  const caps: THREE.Matrix4[] = [];
  const lampPoles: THREE.Matrix4[] = [];
  const lampHeads: THREE.Matrix4[] = [];
  const lampPositions: THREE.Vector3[] = [];
  const cushions: THREE.Matrix4[] = [];

  occluder = makeOccluder(net);
  for (const e of net.edges) {
    const lampD = e.kind === 'main' ? 'right' : 'right';
    buildSurface(e, cb, f, lampD);
    buildMarkings(e, cb, f, f2);
    buildBarriers(e, cb, f);
    buildStructure(e, cb, f);
    buildPiers(e, decks, piers, caps);
    buildLamps(e, decks, lampPoles, lampHeads, lampPositions);
    buildCushions(e, cushions, f);
  }
  const pavement = buildRoadText(net, cb, f);

  const group = cb.toGroup(
    {
      road: mats.road,
      marking: mats.marking,
      concrete: mats.concrete,
      girder: mats.girder,
      planter: mats.planter,
      hanging: mats.hanging,
      noise: mats.noiseWall,
      joint: mats.joint,
    },
    'aExtra',
    { shadows: { concrete: true, girder: true, noise: false } },
  );
  group.name = 'roads';

  // instanced elements
  const pierGeo = new THREE.CylinderGeometry(0.85, 0.95, 1, 12, 1);
  pierGeo.translate(0, 0.5, 0);
  group.add(instanced(pierGeo, mats.girder, piers, true));
  const capGeo = new THREE.BoxGeometry(1, 1, 1);
  capGeo.translate(0, -0.5, 0);
  group.add(instanced(capGeo, mats.girder, caps, true));
  const poleGeo = lampPoleGeometry();
  group.add(instanced(poleGeo, mats.metal, lampPoles, false));
  const headGeo = new THREE.BoxGeometry(0.75, 0.16, 0.36);
  const heads = instanced(headGeo, mats.lampHead, lampHeads, false);
  group.add(heads);
  const cushionGeo = new THREE.CylinderGeometry(0.42, 0.42, 1.0, 12);
  cushionGeo.translate(0, 0.5, 0);
  group.add(instanced(cushionGeo, mats.cushion, cushions, false));
  return { group, lampHeads: heads, lampPositions, pavement };
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], shadow: boolean) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
  list.forEach((mx, i) => m.setMatrixAt(i, mx));
  m.count = list.length;
  m.castShadow = shadow;
  m.receiveShadow = true;
  m.computeBoundingSphere();
  m.frustumCulled = false;
  return m;
}

function lampPoleGeometry() {
  // vertical pole 10.5 m + single arm reaching 2.6 m to the left (local -X) at the top
  const pole = new THREE.CylinderGeometry(0.09, 0.14, 10.5, 8);
  pole.translate(0, 5.25, 0);
  const arm = new THREE.CylinderGeometry(0.06, 0.07, 2.7, 6);
  arm.rotateZ(Math.PI / 2 - 0.12);
  arm.translate(-1.3, 10.55, 0);
  const merged = mergeGeometries([pole, arm]);
  return merged;
}

export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let off = 0;
  for (const g of geos) {
    const gg = g.index ? g : g;
    const p = gg.getAttribute('position');
    const n = gg.getAttribute('normal');
    const u = gg.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
    if (gg.index) for (let i = 0; i < gg.index.count; i++) idx.push(gg.index.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

/* ---------------- helpers ---------------- */

/**
 * Where OSM geometry makes two decks on the same level overlap slightly, a
 * barrier would cut through the neighbouring roadway; such barrier pieces are
 * suppressed.
 */
let occluder: (e: Edge, x: number, z: number, y: number) => boolean = () => false;

function makeOccluder(net: RoadNetwork) {
  const cell = 10;
  const grid = new Map<number, [Edge, number][]>();
  const key = (cx: number, cz: number) => (cx + 5000) * 10000 + (cz + 5000);
  for (const e of net.edges) {
    for (let i = 0; i < e.n; i++) {
      const k = key(Math.floor(e.x[i] / cell), Math.floor(e.z[i] / cell));
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push([e, i]);
    }
  }
  return (e: Edge, x: number, z: number, y: number) => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const a = grid.get(key(cx + dx, cz + dz));
        if (!a) continue;
        for (const [o, i] of a) {
          if (o === e || Math.abs(o.y[i] - y) > 1.2) continue;
          const rx = x - o.x[i];
          const rz = z - o.z[i];
          const along = rx * o.tx[i] + rz * o.tz[i];
          if (Math.abs(along) > o.ds * 0.6) continue;
          const d = -rx * o.tz[i] + rz * o.tx[i];
          if (d > o.bl[i] + 0.3 && d < o.br[i] - 0.3) return true;
        }
      }
    return false;
  };
}

function lampLateral(e: Edge, i: number): number {
  // lamps stand on the right barrier; on open sides they are absent
  return e.or[i] >= 0 ? 999 : e.br[i] - 2.4;
}

/** Road surface ribbon between the drivable bounds. */
function buildSurface(e: Edge, cb: ChunkedBuilder, f: RoadFrame, _lampSide: string) {
  let b: MeshBuilder | null = null;
  let prevKey = '';
  let prevL = -1;
  let prevR = -1;
  for (let i = 0; i < e.n; i++) {
    const s = i * e.ds;
    e.frame(s, 0, f);
    const key = chunkKey(f.x, f.z, cb.size);
    // ramps sit a hair above main decks so overlapping surfaces do not z-fight
    const yy = e.y[i] + (e.kind === 'ramp' ? 0.012 : 0);
    const lx = f.x + f.nx * e.bl[i];
    const lz = f.z + f.nz * e.bl[i];
    const rx = f.x + f.nx * e.br[i];
    const rz = f.z + f.nz * e.br[i];
    const lamp = lampLateral(e, i);
    if (b && key !== prevKey && i > 0) {
      // finish previous strip at this sample, then start a new strip in the new chunk
      const L = b.vertex(lx, yy, lz, 0, 1, 0, e.bl[i], s, undefined, lamp);
      const R = b.vertex(rx, yy, rz, 0, 1, 0, e.br[i], s, undefined, lamp);
      b.quad(prevL, prevR, R, L);
      b = null;
    }
    if (!b) {
      b = cb.get(f.x, f.z, 'road');
      prevKey = key;
      prevL = b.vertex(lx, yy, lz, 0, 1, 0, e.bl[i], s, undefined, lamp);
      prevR = b.vertex(rx, yy, rz, 0, 1, 0, e.br[i], s, undefined, lamp);
      continue;
    }
    const L = b.vertex(lx, yy, lz, 0, 1, 0, e.bl[i], s, undefined, lamp);
    const R = b.vertex(rx, yy, rz, 0, 1, 0, e.br[i], s, undefined, lamp);
    b.quad(prevL, prevR, R, L);
    prevL = L;
    prevR = R;
  }
}

function chunkKey(x: number, z: number, size: number) {
  return `${Math.floor(x / size)},${Math.floor(z / size)}`;
}

/**
 * Emits a flat quad strip on the road between arc lengths s0..s1 at lateral
 * offsets given by dA(s), dB(s) (dA < dB).
 */
function stripe(
  e: Edge,
  cb: ChunkedBuilder,
  f: RoadFrame,
  s0: number,
  s1: number,
  dA: (s: number) => number,
  dB: (s: number) => number,
  color: THREE.Color,
  mat = 'marking',
  lift = 0.012,
) {
  if (s1 <= s0) return;
  const steps = Math.max(1, Math.ceil((s1 - s0) / 2.5));
  e.frame((s0 + s1) / 2, 0, f);
  const b = cb.get(f.x, f.z, mat);
  let pa = -1;
  let pb = -1;
  for (let k = 0; k <= steps; k++) {
    const s = s0 + ((s1 - s0) * k) / steps;
    e.frame(s, 0, f);
    const a = dA(s);
    const c = dB(s);
    const y = e.yAt(s) + lift + (e.kind === 'ramp' ? 0.012 : 0);
    const lamp = 999;
    const ia = b.vertex(f.x + f.nx * a, y, f.z + f.nz * a, 0, 1, 0, a, s, color, lamp);
    const ib = b.vertex(f.x + f.nx * c, y, f.z + f.nz * c, 0, 1, 0, c, s, color, lamp);
    if (k > 0) b.quad(pa, pb, ib, ia);
    pa = ia;
    pb = ib;
  }
}

/** Polygon in (s, d) road coordinates (convex, CCW in s-d plane). */
function roadPoly(e: Edge, cb: ChunkedBuilder, f: RoadFrame, pts: [number, number][], color: THREE.Color, lift = 0.013) {
  e.frame(pts[0][0], 0, f);
  const b = cb.get(f.x, f.z, 'marking');
  const ids = pts.map(([s, d]) => {
    e.frame(s, d, f);
    return b.vertex(f.x, e.yAt(s) + lift + (e.kind === 'ramp' ? 0.012 : 0), f.z, 0, 1, 0, d, s, color, 999);
  });
  for (let k = 1; k + 1 < ids.length; k++) b.tri(ids[0], ids[k + 1], ids[k]);
}

function buildMarkings(e: Edge, cb: ChunkedBuilder, f: RoadFrame, _f2: RoadFrame) {
  const lw = e.laneWidth;
  const halfW = (s: number) => (e.lanesAt(s) * lw) / 2;
  const L = e.length;
  const isMain = e.kind === 'main';
  // lane dividers: dashed 6 m / 9 m; solid near gores and the last 50 m before diverges
  const maxLanes = Math.ceil(Math.max(...e.lanes));
  for (let k = 1; k < maxLanes; k++) {
    const pos = (s: number) => -halfW(s) + k * lw;
    for (let s = 0; s < L; s += 15) {
      const s0 = s;
      const s1 = Math.min(L, s + 6);
      const mid = (s0 + s1) / 2;
      if (e.lanesAt(mid) < k + 0.05) continue;
      stripe(e, cb, f, s0, s1, (q) => pos(q) - 0.075, (q) => pos(q) + 0.075, WHITE);
    }
  }
  // edge lines (left yellow on main lines, white elsewhere) and open-side lines
  const runs = (side: 'l' | 'r') => {
    const out: { s0: number; s1: number; open: boolean }[] = [];
    const arr = side === 'l' ? e.ol : e.or;
    let start = 0;
    for (let i = 1; i <= e.n; i++) {
      if (i === e.n || (arr[i] >= 0) !== (arr[start] >= 0)) {
        out.push({ s0: start * e.ds, s1: Math.min(L, i * e.ds), open: arr[start] >= 0 });
        start = i;
      }
    }
    return out;
  };
  for (const side of ['l', 'r'] as const) {
    const sign = side === 'l' ? -1 : 1;
    const color = side === 'l' && isMain ? YELLOW : WHITE;
    for (const run of runs(side)) {
      if (!run.open) {
        stripe(e, cb, f, run.s0, run.s1, (q) => sign * halfW(q) - 0.1, (q) => sign * halfW(q) + 0.1, color);
        continue;
      }
      // open side: gap between lane edge and bound
      const gap = (q: number) => (side === 'l' ? -e.blAt(q) : e.brAt(q)) - halfW(q);
      for (let s = run.s0; s < run.s1; s += 2.5) {
        const s1 = Math.min(run.s1, s + 2.5);
        const g = gap((s + s1) / 2);
        if (g < 0.2) {
          // thick dashed line between main lanes and the deceleration/acceleration lane (drawn by main/through edge)
          if (!isMain && e.kind === 'ramp' && side === 'l') continue;
          const phase = s % 7.5;
          if (phase < 3.75) stripe(e, cb, f, s, s1, (q) => sign * halfW(q) - 0.22, (q) => sign * halfW(q) + 0.22, WHITE);
        } else {
          stripe(e, cb, f, s, s1, (q) => sign * halfW(q) - 0.1, (q) => sign * halfW(q) + 0.1, WHITE);
        }
      }
      // chevrons in the gore area (each edge paints its half up to the bound)
      for (let s = run.s0 + 2; s < run.s1 - 2; s += 5) {
        const g = gap(s);
        if (g < 0.5) continue;
        const a = halfW(s) + 0.12;
        const bnd = side === 'l' ? -e.blAt(s) : e.brAt(s);
        const sk = (bnd - a) * 0.9;
        const pts: [number, number][] = [
          [s, sign * a],
          [s + 0.6, sign * a],
          [s + 0.6 + sk, sign * bnd],
          [s + sk, sign * bnd],
        ];
        if (sign < 0) pts.reverse();
        roadPoly(e, cb, f, pts, WHITE);
      }
    }
  }
  // expansion joints on viaducts
  for (let s = JOINT_SPACING / 2; s < L; s += JOINT_SPACING) {
    const i = e.idx(s);
    if (e.struct[i] === 0) continue;
    stripe(e, cb, f, s, s + 0.35, () => e.blAt(s) + 0.05, () => e.brAt(s) - 0.05, DARK, 'joint', 0.008);
  }
}

/* ---------- pavement numerals and guide arrows (GB 5768.3 style) ---------- */

type Poly = [number, number][]; // (along road, lateral to the right), CCW

const rect = (s0: number, s1: number, d0: number, d1: number): Poly => [
  [s0, d0],
  [s1, d0],
  [s1, d1],
  [s0, d1],
];

/** Elongated seven-segment numerals; the top of each digit points down the road. */
function numeralPolys(text: string, H: number, W: number, gap: number): Poly[] {
  const th = H * 0.085;
  const tv = W * 0.24;
  const m = H / 2;
  const SEG: Record<string, [number, number, number, number]> = {
    a: [H - th, H, 0, W],
    b: [m, H, W - tv, W],
    c: [0, m, W - tv, W],
    d: [0, th, 0, W],
    e: [0, m, 0, tv],
    f: [m, H, 0, tv],
    g: [m - th / 2, m + th / 2, 0, W],
  };
  const DIGITS: Record<string, string> = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
  const total = text.length * W + (text.length - 1) * gap;
  const out: Poly[] = [];
  [...text].forEach((ch, i) => {
    const d0 = -total / 2 + i * (W + gap);
    for (const k of DIGITS[ch] ?? '') {
      const [s0, s1, a, b] = SEG[k];
      out.push(rect(s0, s1, d0 + a, d0 + b));
    }
  });
  return out;
}

/** 6 m guide arrow; 'right' / 'left' add a forward-diagonal branch towards an exit. */
function arrowPolys(branch: 0 | 1 | -1): Poly[] {
  const out: Poly[] = [
    rect(0, 4.3, -0.1, 0.1),
    [
      [4.3, -0.36],
      [6.0, 0],
      [4.3, 0.36],
    ],
  ];
  if (branch) {
    const ang = (32 * Math.PI) / 180;
    const u: [number, number] = [Math.cos(ang), branch * Math.sin(ang)];
    const w: [number, number] = [-u[1], u[0]];
    const at = (p: [number, number], v: [number, number], k: number): [number, number] => [p[0] + v[0] * k, p[1] + v[1] * k];
    const p0: [number, number] = [1.3, 0];
    const p1 = at(p0, u, 1.15);
    out.push([at(p0, w, -0.1), at(p1, w, -0.1), at(p1, w, 0.1), at(p0, w, 0.1)]);
    out.push([at(p1, w, -0.32), at(p1, u, 0.95), at(p1, w, 0.32)]);
  }
  return out;
}

function buildRoadText(net: RoadNetwork, cb: ChunkedBuilder, f: RoadFrame) {
  const count = { arrows: 0, numerals: 0 };
  const used = new Map<number, [number, number][]>();
  const free = (e: Edge, s0: number, s1: number) => {
    if (s0 < 3 || s1 > e.length - 3) return false;
    if ((used.get(e.id) ?? []).some(([a, b]) => s1 > a - 4 && s0 < b + 4)) return false;
    const n0 = e.lanesAt(s0);
    if (Math.abs(n0 - Math.round(n0)) > 0.02 || n0 < 0.98) return false;
    for (let s = s0; s <= s1; s += 1) {
      const i = e.idx(s);
      if (e.ol[i] >= 0 || e.or[i] >= 0 || Math.abs(e.lanesAt(s) - n0) > 0.02) return false;
    }
    return true;
  };
  const paint = (e: Edge, s: number, polys: Poly[], len: number, color: THREE.Color, lanes: (k: number, n: number) => Poly[] | null) => {
    const n = Math.round(e.lanesAt(s));
    for (let k = 0; k < n; k++) {
      const dc = e.laneCenter(s, k);
      for (const p of lanes(k, n) ?? polys) roadPoly(e, cb, f, p.map(([a, d]) => [s + a, dc + d] as [number, number]), color, 0.014);
    }
    const list = used.get(e.id) ?? [];
    list.push([s, s + len]);
    used.set(e.id, list);
  };
  const speedMark = (e: Edge, s: number) => {
    const v = Math.round(e.speedAt(s) / 10) * 10;
    paint(e, s, numeralPolys(String(v), 5, 0.82, 0.3), 5, YELLOW, () => null);
    count.numerals++;
  };
  // guide arrows on the approach to every exit: the exit lane gets straight + diagonal
  for (const x of net.exits) {
    const side = x.side === 'right' ? 1 : -1;
    for (const back of [280, 170, 70]) {
      const loc = net.atLineS(x.line, x.s - back);
      if (!free(loc.edge, loc.s - 1, loc.s + 7) || loc.edge.lanesAt(loc.s) < 1.98) continue;
      const branchy = arrowPolys(side as 1 | -1);
      paint(loc.edge, loc.s, arrowPolys(0), 6, WHITE, (k, n) => ((side > 0 ? k === n - 1 : k === 0) ? branchy : null));
      count.arrows++;
    }
    // ramp speed limit once the ramp has left the main line
    const r = net.edges[x.edge];
    for (let s = 40; s < r.length - 20; s += 10)
      if (free(r, s - 1, s + 6)) {
        speedMark(r, s);
        break;
      }
  }
  // maximum-speed numerals on the main lines (roughly every 1.2 km, shifted to a clear spot)
  for (const line of ['A', 'B'] as const) {
    const L = net.lines[line].length;
    for (let ls = 500; ls < L - 200; ls += 1200)
      for (let off = 0; off <= 300; off += 15) {
        const loc = net.atLineS(line, ls + off);
        if (!free(loc.edge, loc.s - 1, loc.s + 6)) continue;
        speedMark(loc.edge, loc.s);
        break;
      }
  }
  return count;
}

/** Barriers along non-open sides; planters / noise walls on top for viaducts. */
function buildBarriers(e: Edge, cb: ChunkedBuilder, f: RoadFrame) {
  for (const side of [-1, 1]) {
    const open = side < 0 ? e.ol : e.or;
    const bound = side < 0 ? e.bl : e.br;
    const noise = side < 0 ? e.noiseL : e.noiseR;
    // samples where a barrier is wanted (not open, not cutting through another deck)
    const want = new Uint8Array(e.n);
    for (let i = 0; i < e.n; i++) {
      if (open[i] >= 0) continue;
      e.frame(i * e.ds, bound[i] + side * 0.25, f);
      want[i] = occluder(e, f.x, f.z, e.y[i]) ? 0 : 1;
    }
    let i = 0;
    while (i < e.n - 1) {
      if (!want[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < e.n - 1 && want[j + 1]) j++;
      if (j > i) extrudeBarrier(e, cb, f, i, j, side, bound, noise);
      i = j + 1;
    }
  }
}

function extrudeBarrier(e: Edge, cb: ChunkedBuilder, f: RoadFrame, i0: number, i1: number, side: number, bound: Float32Array, noise: Uint8Array) {
  const prof = BARRIER_PROFILE;
  // split into chunk pieces
  let start = i0;
  while (start < i1) {
    const mid = Math.min(i1, start + 60);
    e.frame(((start + mid) / 2) * e.ds, 0, f);
    const b = cb.get(f.x, f.z, 'concrete');
    const rows: number[][] = [];
    for (let i = start; i <= mid; i++) {
      const s = i * e.ds;
      e.frame(s, 0, f);
      const row: number[] = [];
      let u = 0;
      for (let k = 0; k < prof.length; k++) {
        const [o, h] = prof[k];
        const d = bound[i] + side * o;
        const x = f.x + f.nx * d;
        const z = f.z + f.nz * d;
        // profile normal
        const k2 = Math.min(prof.length - 1, k + 1);
        const k1 = Math.max(0, k - 1);
        const dox = prof[k2][0] - prof[k1][0];
        const doh = prof[k2][1] - prof[k1][1];
        const len = Math.hypot(dox, doh) || 1;
        // 2D normal of the profile in (outward, up) space
        const nO = -doh / len;
        const nH = dox / len;
        const nx = f.nx * side * nO;
        const nz = f.nz * side * nO;
        if (k > 0) u += Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]);
        row.push(b.vertex(x, e.y[i] + h, z, nx, nH, nz, u, s));
      }
      rows.push(row);
    }
    for (let r = 1; r < rows.length; r++) {
      for (let k = 0; k + 1 < prof.length; k++) {
        const a = rows[r - 1][k];
        const c = rows[r][k];
        const d = rows[r][k + 1];
        const g = rows[r - 1][k + 1];
        if (side > 0) b.quad(a, g, d, c);
        else b.quad(a, c, d, g);
      }
    }
    // planters / hanging flowers or noise walls
    buildBarrierTop(e, cb, f, start, mid, side, bound, noise);
    start = mid;
  }
}

function buildBarrierTop(e: Edge, cb: ChunkedBuilder, f: RoadFrame, i0: number, i1: number, side: number, bound: Float32Array, noise: Uint8Array) {
  const viaduct = (i: number) => e.y[i] > 4;
  e.frame(((i0 + i1) / 2) * e.ds, 0, f);
  const planter = cb.get(f.x, f.z, 'planter');
  const hanging = cb.get(f.x, f.z, 'hanging');
  const wall = cb.get(f.x, f.z, 'noise');
  // left side of main lines faces the median: no planters there
  const outer = !(e.kind === 'main' && side < 0);
  for (let i = i0; i < i1; i++) {
    const s = i * e.ds;
    const s2 = (i + 1) * e.ds;
    if (noise[i]) {
      quadVertical(wall, e, f, s, s2, bound[i] + side * 0.42, bound[i + 1] + side * 0.42, 1.05, 4.4, side, 0, 3.4);
      continue;
    }
    if (!outer || !viaduct(i)) continue;
    // flower box on top of the barrier (outer half) and bracts hanging over the deck edge
    const dIn = side * 0.3;
    const dOut = side * 0.62;
    boxStrip(planter, e, f, s, s2, bound[i] + dIn, bound[i] + dOut, bound[i + 1] + dIn, bound[i + 1] + dOut, 1.0, 1.42);
    quadVertical(hanging, e, f, s, s2, bound[i] + side * 0.64, bound[i + 1] + side * 0.64, 1.4, -1.2, side, 0, 1);
  }
}

function quadVertical(b: MeshBuilder, e: Edge, f: RoadFrame, s0: number, s1: number, d0: number, d1: number, h0: number, h1: number, side: number, v0 = 0, v1 = 1) {
  e.frame(s0, d0, f);
  const x0 = f.x;
  const z0 = f.z;
  const nx = f.nx * side;
  const nz = f.nz * side;
  const y0 = e.yAt(s0);
  e.frame(s1, d1, f);
  const x1 = f.x;
  const z1 = f.z;
  const y1 = e.yAt(s1);
  const a = b.vertex(x0, y0 + h0, z0, nx, 0, nz, s0 / 4, v0);
  const c = b.vertex(x1, y1 + h0, z1, nx, 0, nz, s1 / 4, v0);
  const d = b.vertex(x1, y1 + h1, z1, nx, 0, nz, s1 / 4, v1);
  const g = b.vertex(x0, y0 + h1, z0, nx, 0, nz, s0 / 4, v1);
  if ((h1 - h0) * side > 0) b.quad(a, c, d, g);
  else b.quad(a, g, d, c);
}

function boxStrip(b: MeshBuilder, e: Edge, f: RoadFrame, s0: number, s1: number, a0: number, o0: number, a1: number, o1: number, h0: number, h1: number) {
  // top face + two sides
  const p = (s: number, d: number, h: number) => {
    e.frame(s, d, f);
    return [f.x, e.yAt(s) + h, f.z] as const;
  };
  const A = p(s0, a0, h1);
  const B = p(s1, a1, h1);
  const C = p(s1, o1, h1);
  const D = p(s0, o0, h1);
  const ia = b.vertex(A[0], A[1], A[2], 0, 1, 0, s0 / 3, 0);
  const ib = b.vertex(B[0], B[1], B[2], 0, 1, 0, s1 / 3, 0);
  const ic = b.vertex(C[0], C[1], C[2], 0, 1, 0, s1 / 3, 0.5);
  const id = b.vertex(D[0], D[1], D[2], 0, 1, 0, s0 / 3, 0.5);
  if ((o0 - a0) > 0) b.quad(ia, id, ic, ib);
  else b.quad(ia, ib, ic, id);
  // outer side
  const E = p(s0, o0, h0);
  const F = p(s1, o1, h0);
  e.frame(s0, 0, f);
  const sgn = Math.sign(o0 - a0);
  const ie = b.vertex(E[0], E[1], E[2], f.nx * sgn, 0, f.nz * sgn, s0 / 3, 1);
  const iff = b.vertex(F[0], F[1], F[2], f.nx * sgn, 0, f.nz * sgn, s1 / 3, 1);
  const ic2 = b.vertex(C[0], C[1], C[2], f.nx * sgn, 0, f.nz * sgn, s1 / 3, 0.5);
  const id2 = b.vertex(D[0], D[1], D[2], f.nx * sgn, 0, f.nz * sgn, s0 / 3, 0.5);
  if (sgn > 0) b.quad(ie, iff, ic2, id2);
  else b.quad(ie, id2, ic2, iff);
}

/** Deck slab edges and box girder underneath viaduct sections; retaining walls for low embankments. */
function buildStructure(e: Edge, cb: ChunkedBuilder, f: RoadFrame) {
  let i = 0;
  while (i < e.n - 1) {
    const mode = e.y[i] > 3.2 ? 2 : e.y[i] > 0.3 ? 1 : 0;
    let j = i;
    while (j < e.n - 1 && (e.y[j + 1] > 3.2 ? 2 : e.y[j + 1] > 0.3 ? 1 : 0) === mode && j - i < 60) j++;
    if (j === i) j = i + 1;
    if (mode > 0) girderSegment(e, cb, f, i, j, mode);
    i = j;
  }
}

function girderSegment(e: Edge, cb: ChunkedBuilder, f: RoadFrame, i0: number, i1: number, mode: number) {
  e.frame(((i0 + i1) / 2) * e.ds, 0, f);
  const b = cb.get(f.x, f.z, 'girder');
  const rows: { L: number[]; R: number[]; B: number[] }[] = [];
  for (let i = i0; i <= i1; i++) {
    const s = i * e.ds;
    e.frame(s, 0, f);
    const y = e.y[i];
    // outer deck edges include barriers (0.5 m) unless the side is open
    const l = e.bl[i] - (e.ol[i] >= 0 ? 0 : 0.52);
    const r = e.br[i] + (e.or[i] >= 0 ? 0 : 0.52);
    const mid = (l + r) / 2;
    const half = (r - l) / 2;
    const P = (d: number, h: number) => [f.x + f.nx * d, y + h, f.z + f.nz * d] as const;
    if (mode === 2) {
      const depth = 1.9;
      const pts = [P(l, 0), P(l, -0.42), P(mid - half * 0.62, -depth), P(mid + half * 0.62, -depth), P(r, -0.42), P(r, 0)];
      const nL = [-f.nx, 0, -f.nz];
      const nR = [f.nx, 0, f.nz];
      const L = [
        b.vertex(pts[0][0], pts[0][1], pts[0][2], nL[0], 0, nL[2], 0, s / 3),
        b.vertex(pts[1][0], pts[1][1], pts[1][2], nL[0], 0, nL[2], 0.42, s / 3),
        b.vertex(pts[1][0], pts[1][1], pts[1][2], -f.nx * 0.8, -0.6, -f.nz * 0.8, 0.42, s / 3),
        b.vertex(pts[2][0], pts[2][1], pts[2][2], -f.nx * 0.8, -0.6, -f.nz * 0.8, 2.2, s / 3),
      ];
      const R = [
        b.vertex(pts[5][0], pts[5][1], pts[5][2], nR[0], 0, nR[2], 0, s / 3),
        b.vertex(pts[4][0], pts[4][1], pts[4][2], nR[0], 0, nR[2], 0.42, s / 3),
        b.vertex(pts[4][0], pts[4][1], pts[4][2], f.nx * 0.8, -0.6, f.nz * 0.8, 0.42, s / 3),
        b.vertex(pts[3][0], pts[3][1], pts[3][2], f.nx * 0.8, -0.6, f.nz * 0.8, 2.2, s / 3),
      ];
      const B = [
        b.vertex(pts[2][0], pts[2][1], pts[2][2], 0, -1, 0, mid - half * 0.62, s / 3),
        b.vertex(pts[3][0], pts[3][1], pts[3][2], 0, -1, 0, mid + half * 0.62, s / 3),
        // deck underside overhangs
        b.vertex(pts[1][0], pts[1][1], pts[1][2], 0, -1, 0, l, s / 3),
        b.vertex(pts[4][0], pts[4][1], pts[4][2], 0, -1, 0, r, s / 3),
      ];
      rows.push({ L, R, B });
    } else {
      // low embankment: vertical retaining walls down to the ground
      const nL = [-f.nx, 0, -f.nz];
      const nR = [f.nx, 0, f.nz];
      const L = [b.vertex(...P(l, 0), nL[0], 0, nL[2], 0, s / 3), b.vertex(...P(l, -y - 0.05), nL[0], 0, nL[2], y, s / 3)];
      const R = [b.vertex(...P(r, 0), nR[0], 0, nR[2], 0, s / 3), b.vertex(...P(r, -y - 0.05), nR[0], 0, nR[2], y, s / 3)];
      rows.push({ L, R, B: [] });
    }
  }
  for (let k = 1; k < rows.length; k++) {
    const p = rows[k - 1];
    const c = rows[k];
    if (mode === 2) {
      b.quad(p.L[0], c.L[0], c.L[1], p.L[1]);
      b.quad(p.L[2], c.L[2], c.L[3], p.L[3]);
      b.quad(p.R[0], p.R[1], c.R[1], c.R[0]);
      b.quad(p.R[2], p.R[3], c.R[3], c.R[2]);
      b.quad(p.B[0], c.B[0], c.B[1], p.B[1]);
    } else {
      b.quad(p.L[0], c.L[0], c.L[1], p.L[1]);
      b.quad(p.R[0], p.R[1], c.R[1], c.R[0]);
    }
  }
}

/**
 * Piers every ~30 m: a single column with a hammerhead cap, or a portal frame
 * straddling decks that run underneath. Columns never stand in a roadway or
 * pass through another deck; a pier that cannot be placed is moved a few
 * metres along the deck or left out.
 */
/** A vertical (cylinder) or horizontal (box) piece of a pier: centre x/z, vertical extent, heading of the deck. */
export interface PierPart {
  x: number;
  z: number;
  y0: number;
  y1: number;
  heading: number;
  /** boxes only: size along and across the deck */
  along?: number;
  across?: number;
}

export const PIER_RADIUS = 0.95;

/** Columns and caps of an edge's piers (see buildPiers). */
export function pierSpots(e: Edge, decks: DeckIndex): { columns: PierPart[]; caps: PierPart[] } {
  const f = newFrame();
  const columns: PierPart[] = [];
  const caps: PierPart[] = [];
  const start = (e.id * 7.3) % PIER_SPACING;
  const R = PIER_RADIUS;
  const tryAt = (s: number): boolean => {
    const i = e.idx(s);
    const y = e.yAt(s);
    if (y < 4.5) return true;
    e.frame(s, 0, f);
    const bl = e.blAt(s);
    const br = e.brAt(s);
    const mid = (bl + br) / 2;
    const width = br - bl + 1.04;
    const topY = y - 1.9;
    const groundY = e.struct[i] === 2 ? -1.0 : 0;
    const heading = Math.atan2(f.tz, f.tx);
    const at = (d: number) => [f.x + f.nx * d, f.z + f.nz * d] as const;
    // decks at this level are carried by the pier; anything lower must be kept clear of
    const lower = (d: number, r: number, margin: number) =>
      decks.at(...at(d), r, margin).filter((h) => h.edge !== e && h.y < y - 1.2 && h.y - GIRDER_DEPTH < topY && h.y + TRAFFIC_HEADROOM > groundY);
    if (!lower(mid, R, BARRIER_WIDTH).length) {
      const [x, z] = at(mid);
      columns.push({ x, z, y0: groundY, y1: topY - 1.2, heading });
      caps.push({ x, z, y0: topY - 1.25, y1: topY, heading, along: 1.8, across: Math.max(3, width * 0.75) });
      return true;
    }
    // portal: find the decks crossing underneath and stand the columns just outside them
    const blocked = (d: number) => lower(d, 0, BARRIER_WIDTH + R + 0.3).length > 0;
    let lo = mid;
    let hi = mid;
    while (blocked(lo) && mid - lo < 20) lo -= 0.25;
    while (blocked(hi) && hi - mid < 20) hi += 0.25;
    if (hi - lo > 34 || blocked(lo) || blocked(hi)) return false;
    for (const d of [lo, hi]) if (lower(d, R, BARRIER_WIDTH).length) return false;
    for (const d of [lo, hi]) {
      const [x, z] = at(d);
      columns.push({ x, z, y0: groundY, y1: topY, heading });
    }
    // the cross beam sits within the depth of the deck's girder, above the traffic underneath
    const [x, z] = at((lo + hi) / 2);
    caps.push({ x, z, y0: topY, y1: topY + 1.45, heading, along: 1.6, across: hi - lo + 2.2 });
    return true;
  };
  for (let s = start + 8; s < e.length - 4; s += PIER_SPACING) {
    for (const shift of [0, 4, -4, 8, -8, 12, -12]) {
      const ss = s + shift;
      if (ss > 2 && ss < e.length - 2 && tryAt(ss)) break;
    }
  }
  return { columns, caps };
}

/** Piers every ~30 m (see pierSpots): instance matrices for the column cylinders and cap boxes. */
function buildPiers(e: Edge, decks: DeckIndex, piers: THREE.Matrix4[], caps: THREE.Matrix4[]) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const spots = pierSpots(e, decks);
  for (const c of spots.columns) {
    q.setFromAxisAngle(up, -c.heading);
    m.compose(new THREE.Vector3(c.x, c.y0, c.z), q, new THREE.Vector3(1, c.y1 - c.y0, 1));
    piers.push(m.clone());
  }
  // cap geometry hangs below its origin: place it at the top face
  for (const c of spots.caps) {
    q.setFromAxisAngle(up, -c.heading);
    m.compose(new THREE.Vector3(c.x, c.y1, c.z), q, new THREE.Vector3(c.along!, c.y1 - c.y0, c.across!));
    caps.push(m.clone());
  }
}

/** Street light: pole foot on the barrier top, head 2.6 m over the road. */
export interface LampSpot {
  x: number;
  z: number;
  /** pole foot height */
  y: number;
  hx: number;
  hz: number;
  heading: number;
}

export const LAMP_HEIGHT = 10.75;

/** Street lights along the right barrier of an edge, left out where a pole or arm would meet another deck. */
export function lampSpots(e: Edge, decks: DeckIndex): LampSpot[] {
  const f = newFrame();
  const out: LampSpot[] = [];
  for (let s = 18; s < e.length; s += LAMP_SPACING) {
    const i = e.idx(s);
    if (e.or[i] >= 0) continue;
    e.frame(s, e.br[i] + 0.35, f);
    const y = e.y[i] + 1.05;
    // the pole stands on the barrier and the arm reaches 2.6 m over the road: under a deck above
    // (double-deck sections) or next to another roadway there is no room for it
    if (!decks.clear(f.x, f.z, 0.16, y, y + 11, [e])) continue;
    const hx = f.x - f.nx * 2.6;
    const hz = f.z - f.nz * 2.6;
    if (!decks.clear(hx, hz, 0.5, y + 9.8, y + 11.3, [e])) continue;
    out.push({ x: f.x, z: f.z, y, hx, hz, heading: Math.atan2(f.tz, f.tx) });
  }
  return out;
}

function buildLamps(e: Edge, decks: DeckIndex, poles: THREE.Matrix4[], heads: THREE.Matrix4[], positions: THREE.Vector3[]) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const l of lampSpots(e, decks)) {
    // pole local -X points to the road (left of the outward normal)
    q.setFromAxisAngle(up, -l.heading - Math.PI / 2);
    m.compose(new THREE.Vector3(l.x, l.y, l.z), q, new THREE.Vector3(1, 1, 1));
    poles.push(m.clone());
    m.compose(new THREE.Vector3(l.hx, l.y + LAMP_HEIGHT, l.hz), q, new THREE.Vector3(1, 1, 1));
    heads.push(m.clone());
    positions.push(new THREE.Vector3(l.hx, l.y + 10.6, l.hz));
  }
}

function buildCushions(e: Edge, cushions: THREE.Matrix4[], f: RoadFrame) {
  // crash cushions where an open side closes (gore nose); drawn on main/through edges
  const m = new THREE.Matrix4();
  for (const side of [-1, 1]) {
    const open = side < 0 ? e.ol : e.or;
    for (let i = 1; i < e.n; i++) {
      const wasOpen = open[i - 1] >= 0;
      const isOpen = open[i] >= 0;
      if (wasOpen === isOpen) continue;
      if (e.kind !== 'main') continue;
      const s = i * e.ds;
      const b = side < 0 ? e.bl[i] : e.br[i];
      e.frame(s, b + side * 0.7, f);
      m.makeTranslation(f.x, e.y[i], f.z);
      cushions.push(m.clone());
    }
  }
}




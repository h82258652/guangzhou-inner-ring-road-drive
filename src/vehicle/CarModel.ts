/**
 * Procedural vehicle models (no external brands): lofted body, glass cabin,
 * wheels, lights and Guangzhou licence plates (粤A). Local frame: +X forward,
 * +Y up, +Z right; origin on the ground at the vehicle centre.
 */
import * as THREE from 'three';
import { MeshBuilder } from '../world/MeshBuilder';
import { mulberry32 } from '../shared/math';

export type VehicleKind = 'sedan' | 'suv' | 'taxi' | 'mpv' | 'hatch' | 'bus' | 'van';

export interface VehicleParams {
  kind: VehicleKind;
  length: number;
  width: number;
  height: number;
  clearance: number;
  belt: number;
  hood: number;
  /** cabin start/end as fraction of half length (-1 rear .. 1 front) */
  cabinRear: number;
  cabinFront: number;
  roofRear: number;
  roofFront: number;
  wheelBase: number;
  wheelRadius: number;
  boxy: number;
}

export const VEHICLES: Record<VehicleKind, VehicleParams> = {
  sedan: { kind: 'sedan', length: 4.75, width: 1.82, height: 1.46, clearance: 0.17, belt: 0.93, hood: 0.82, cabinRear: -0.66, cabinFront: 0.36, roofRear: -0.36, roofFront: 0.06, wheelBase: 2.78, wheelRadius: 0.32, boxy: 0.25 },
  taxi: { kind: 'taxi', length: 4.68, width: 1.78, height: 1.48, clearance: 0.16, belt: 0.92, hood: 0.8, cabinRear: -0.64, cabinFront: 0.36, roofRear: -0.36, roofFront: 0.06, wheelBase: 2.7, wheelRadius: 0.31, boxy: 0.25 },
  hatch: { kind: 'hatch', length: 4.2, width: 1.76, height: 1.5, clearance: 0.16, belt: 0.95, hood: 0.84, cabinRear: -0.9, cabinFront: 0.3, roofRear: -0.78, roofFront: 0.0, wheelBase: 2.6, wheelRadius: 0.31, boxy: 0.35 },
  suv: { kind: 'suv', length: 4.7, width: 1.9, height: 1.72, clearance: 0.21, belt: 1.08, hood: 1.0, cabinRear: -0.88, cabinFront: 0.32, roofRear: -0.8, roofFront: 0.02, wheelBase: 2.8, wheelRadius: 0.36, boxy: 0.6 },
  mpv: { kind: 'mpv', length: 5.0, width: 1.88, height: 1.82, clearance: 0.17, belt: 1.02, hood: 0.95, cabinRear: -0.95, cabinFront: 0.5, roofRear: -0.9, roofFront: 0.22, wheelBase: 3.0, wheelRadius: 0.33, boxy: 0.75 },
  van: { kind: 'van', length: 5.3, width: 1.95, height: 2.2, clearance: 0.18, belt: 1.05, hood: 1.0, cabinRear: -0.98, cabinFront: 0.6, roofRear: -0.98, roofFront: 0.35, wheelBase: 3.2, wheelRadius: 0.34, boxy: 0.95 },
  bus: { kind: 'bus', length: 12, width: 2.5, height: 3.15, clearance: 0.3, belt: 1.25, hood: 1.2, cabinRear: -0.99, cabinFront: 0.995, roofRear: -0.99, roofFront: 0.98, wheelBase: 6.0, wheelRadius: 0.5, boxy: 1 },
};

export interface VehicleGeometry {
  body: THREE.BufferGeometry; // paint (vertex colour white => instance colour)
  trim: THREE.BufferGeometry; // glass, tyres, rims, bumpers (vertex colours)
  head: THREE.BufferGeometry; // headlights
  tail: THREE.BufferGeometry; // tail/brake lights
  ind: THREE.BufferGeometry; // turn indicators (aSide attribute: -1 left, 1 right)
  plate: THREE.BufferGeometry; // licence plate quads (uv mapped)
  params: VehicleParams;
}

const GLASS = new THREE.Color(0.06, 0.08, 0.1);
const TYRE = new THREE.Color(0.05, 0.05, 0.05);
const RIM = new THREE.Color(0.62, 0.64, 0.66);
const PLASTIC = new THREE.Color(0.08, 0.08, 0.085);
const CHROME = new THREE.Color(0.75, 0.76, 0.78);

/** Lofted closed sections: sections[k] has the same number of points (y,z) at x = xs[k]. */
function loft(b: MeshBuilder, xs: number[], sections: [number, number][][], color?: THREE.Color) {
  const n = sections[0].length;
  const rows: number[][] = [];
  for (let k = 0; k < xs.length; k++) {
    const sec = sections[k];
    const row: number[] = [];
    for (let i = 0; i < n; i++) {
      const [y, z] = sec[i];
      // approximate normal from section neighbours
      const p = sec[(i - 1 + n) % n];
      const q = sec[(i + 1) % n];
      let ny = -(q[1] - p[1]);
      let nz = q[0] - p[0];
      const l = Math.hypot(ny, nz) || 1;
      ny /= l;
      nz /= l;
      // x component from neighbouring stations
      const ka = Math.max(0, k - 1);
      const kb = Math.min(xs.length - 1, k + 1);
      const ra = Math.hypot(...sections[ka][i]);
      const rb = Math.hypot(...sections[kb][i]);
      const nx = xs[kb] !== xs[ka] ? -((rb - ra) / (xs[kb] - xs[ka])) * 0.5 : 0;
      const nl = Math.hypot(nx, ny, nz) || 1;
      row.push(b.vertex(xs[k], y, z, nx / nl, ny / nl, nz / nl, i / n, k / xs.length, color));
    }
    rows.push(row);
  }
  for (let k = 1; k < rows.length; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      b.quad(rows[k - 1][i], rows[k - 1][j], rows[k][j], rows[k][i]);
    }
  }
  // end caps (fan)
  for (const k of [0, rows.length - 1]) {
    const cx = xs[k];
    let cy = 0;
    let cz = 0;
    for (const [y, z] of sections[k]) {
      cy += y / n;
      cz += z / n;
    }
    const nx = k === 0 ? -1 : 1;
    const c = b.vertex(cx, cy, cz, nx, 0, 0, 0.5, 0.5, color);
    const ring = sections[k].map(([y, z]) => b.vertex(cx, y, z, nx, 0, 0, 0, 0, color));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (k === 0) b.tri(c, ring[j], ring[i]);
      else b.tri(c, ring[i], ring[j]);
    }
  }
}

/** Rounded rectangle section (y from y0 to y1, half widths wBottom..wTop) as closed polyline, CCW seen from +X. */
function roundedSection(y0: number, y1: number, wBot: number, wTop: number, r: number, segs = 3): [number, number][] {
  const pts: [number, number][] = [];
  const corner = (cy: number, cz: number, a0: number, a1: number) => {
    for (let s = 0; s <= segs; s++) {
      const a = a0 + ((a1 - a0) * s) / segs;
      pts.push([cy + Math.sin(a) * r, cz + Math.cos(a) * r]);
    }
  };
  const rr = Math.min(r, (y1 - y0) / 2.2, wBot * 0.45);
  r = rr;
  // start bottom right, go up the right side, across the top to the left, down, across bottom
  corner(y0 + r, wBot - r, -Math.PI / 2, 0);
  corner(y1 - r, wTop - r, 0, Math.PI / 2);
  corner(y1 - r, -wTop + r, Math.PI / 2, Math.PI);
  corner(y0 + r, -wBot + r, Math.PI, (3 * Math.PI) / 2);
  return pts;
}

export function buildVehicleGeometry(P: VehicleParams): VehicleGeometry {
  const body = new MeshBuilder();
  const trim = new MeshBuilder();
  const head = new MeshBuilder();
  const tail = new MeshBuilder();
  const plate = new MeshBuilder();
  const L2 = P.length / 2;
  const W2 = P.width / 2;
  const N = 18;
  const xs: number[] = [];
  const lower: [number, number][][] = [];
  for (let k = 0; k <= N; k++) {
    const t = -1 + (2 * k) / N;
    const x = t * L2;
    const endRound = 1 - Math.pow(Math.abs(t), 6 + P.boxy * 10) * (0.55 - P.boxy * 0.4);
    const w = W2 * endRound;
    // top of the lower body: hood at the front, deck at the rear
    let top = P.belt;
    if (t > P.cabinFront) top = P.belt + (P.hood - P.belt) * Math.min(1, (t - P.cabinFront) / (1 - P.cabinFront)) - Math.pow(Math.max(0, t - 0.85) / 0.15, 2) * 0.12;
    if (t < P.cabinRear) top = P.belt - Math.pow((P.cabinRear - t) / (1 + P.cabinRear + 1e-6), 2) * 0.08;
    let bottom = P.clearance + Math.pow(Math.max(0, Math.abs(t) - 0.75) / 0.25, 2) * 0.12;
    if (P.kind === 'bus') bottom = P.clearance;
    xs.push(x);
    lower.push(roundedSection(bottom, top, w * 0.96, w, 0.12 + P.boxy * 0.05, 3));
  }
  loft(body, xs, lower);

  // cabin (greenhouse) — glass with painted roof
  const cxs: number[] = [];
  const csec: [number, number][][] = [];
  const M = 14;
  for (let k = 0; k <= M; k++) {
    const t = P.cabinRear + ((P.cabinFront - P.cabinRear) * k) / M;
    const x = t * L2;
    let roof: number;
    if (t > P.roofFront) roof = P.height - ((t - P.roofFront) / (P.cabinFront - P.roofFront)) * (P.height - P.belt);
    else if (t < P.roofRear) roof = P.height - ((P.roofRear - t) / (P.roofRear - P.cabinRear + 1e-6)) * (P.height - P.belt);
    else roof = P.height;
    roof = Math.max(P.belt + 0.02, roof);
    const w = W2 * (1 - Math.pow(Math.abs(t), 8) * 0.3);
    const wBot = w - 0.03;
    const wTop = w - 0.12 - (1 - P.boxy) * 0.12;
    cxs.push(x);
    csec.push(roundedSection(P.belt - 0.01, roof, wBot, wTop, 0.08 + P.boxy * 0.04, 2));
  }
  loft(trim, cxs, csec, GLASS);
  // painted roof panel slightly above the glass
  {
    const rx0 = P.roofRear * L2 + 0.05;
    const rx1 = P.roofFront * L2 - 0.05;
    const wTop = W2 - 0.15 - (1 - P.boxy) * 0.12;
    const y = P.height + 0.006;
    const a = body.vertex(rx0, y, -wTop, 0, 1, 0, 0, 0);
    const bb = body.vertex(rx1, y, -wTop, 0, 1, 0, 1, 0);
    const c = body.vertex(rx1, y, wTop, 0, 1, 0, 1, 1);
    const d = body.vertex(rx0, y, wTop, 0, 1, 0, 0, 1);
    body.quad(a, d, c, bb);
    // B/C pillars as body-coloured strips on the cabin sides
    if (P.kind !== 'bus') {
      const pillars = P.kind === 'mpv' || P.kind === 'van' || P.kind === 'suv' ? [-0.45, 0.0] : [-0.12];
      for (const pt of pillars) {
        const px = pt * L2;
        for (const side of [-1, 1]) {
          const zz = side * (W2 - 0.04);
          const zt = side * (wTop + 0.02);
          const v0 = body.vertex(px - 0.06, P.belt, zz, 0, 0, side, 0, 0);
          const v1 = body.vertex(px + 0.06, P.belt, zz, 0, 0, side, 0, 0);
          const v2 = body.vertex(px + 0.06, P.height - 0.02, zt, 0, 0, side, 0, 0);
          const v3 = body.vertex(px - 0.06, P.height - 0.02, zt, 0, 0, side, 0, 0);
          if (side > 0) body.quad(v0, v1, v2, v3);
          else body.quad(v0, v3, v2, v1);
        }
      }
    }
  }

  // bumpers / sills (dark plastic)
  boxAt(trim, P.length / 2 - 0.08, P.clearance + 0.12, 0, 0.16, 0.18, P.width * 0.94, PLASTIC);
  boxAt(trim, -P.length / 2 + 0.08, P.clearance + 0.12, 0, 0.16, 0.2, P.width * 0.94, PLASTIC);
  // grille
  if (P.kind !== 'bus') boxAt(trim, P.length / 2 - 0.02, P.hood - 0.25, 0, 0.04, 0.16, P.width * 0.42, P.kind === 'taxi' ? CHROME : PLASTIC);

  // wheels
  const wr = P.wheelRadius;
  const wheelX = P.wheelBase / 2;
  const axles = P.kind === 'bus' ? [wheelX + 0.4, -wheelX + 0.6] : [wheelX, -wheelX];
  for (const ax of axles)
    for (const side of [-1, 1]) {
      wheel(trim, ax, wr, side * (W2 - 0.14), side, wr);
    }

  // lights: lenses follow the rounded body ends; amber indicators sit outboard and wrap round the corners
  const hy = P.kind === 'bus' ? 0.7 : P.hood - 0.2;
  const ty = P.kind === 'bus' ? 0.9 : P.belt - 0.17;
  const ind = new MeshBuilder();
  const shellB = new MeshBuilder();
  loft(shellB, xs, lower);
  const shell = new THREE.Mesh(shellB.build()!, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  for (const side of [-1, 1]) {
    const zr = (a: number, b: number): [number, number] => (side > 0 ? [a * W2, b * W2] : [-b * W2, -a * W2]);
    lensPatch(head, shell, L2, 1, hy - 0.08, hy + 0.08, ...zr(0.46, 0.86));
    lensPatch(tail, shell, L2, -1, ty - 0.07, ty + 0.07, ...zr(0.5, 0.86));
    lensPatch(ind, shell, L2, 1, hy - 0.06, hy + 0.04, ...zr(0.86, 0.93), side);
    lensPatch(ind, shell, L2, -1, ty - 0.07, ty + 0.07, ...zr(0.86, 0.93), side);
  }
  shell.geometry.dispose();
  // licence plates (front and rear)
  plateQuad(plate, P.length / 2 + 0.012, P.clearance + 0.3, 1);
  plateQuad(plate, -P.length / 2 - 0.012, P.clearance + 0.38, -1);

  // taxi roof sign
  if (P.kind === 'taxi') boxAt(trim, -0.15, P.height + 0.12, 0, 0.32, 0.22, 0.75, new THREE.Color(0.95, 0.95, 0.9));

  return {
    body: body.build()!,
    trim: trim.build()!,
    head: head.build()!,
    tail: tail.build()!,
    ind: ind.build('aSide')!,
    plate: plate.build()!,
    params: P,
  };
}

const lensRay = new THREE.Raycaster();
const lensOrigin = new THREE.Vector3();
const lensDir = new THREE.Vector3();

/**
 * Light lens draped over the body end between heights y0..y1 and lateral z0..z1 (z0 < z1):
 * each vertex is projected onto the body shell along the car axis and lifted off the paint.
 */
function lensPatch(b: MeshBuilder, shell: THREE.Mesh, L2: number, dir: number, y0: number, y1: number, z0: number, z1: number, extra?: number) {
  const NZ = 6;
  const NY = 2;
  const grid: number[][] = [];
  for (let j = 0; j <= NZ; j++) {
    const z = z0 + ((z1 - z0) * j) / NZ;
    const col: number[] = [];
    for (let r = 0; r <= NY; r++) {
      const y = y0 + ((y1 - y0) * r) / NY;
      lensRay.set(lensOrigin.set(dir * (L2 + 1), y, z), lensDir.set(-dir, 0, 0));
      const hit = lensRay.intersectObject(shell)[0];
      let x = dir * L2;
      let nx = dir;
      let ny = 0;
      let nz = 0;
      if (hit?.face) {
        x = hit.point.x;
        const n = hit.face.normal;
        const flip = n.x * dir + n.z * Math.sign(z) < 0 ? -1 : 1;
        nx = n.x * flip;
        ny = n.y * flip;
        nz = n.z * flip;
      }
      col.push(b.vertex(x + nx * 0.006, y + ny * 0.006, z + nz * 0.006, nx, ny, nz, j / NZ, r / NY, undefined, extra));
    }
    grid.push(col);
  }
  for (let j = 0; j < NZ; j++)
    for (let r = 0; r < NY; r++) {
      if (dir > 0) b.quad(grid[j][r], grid[j][r + 1], grid[j + 1][r + 1], grid[j + 1][r]);
      else b.quad(grid[j][r], grid[j + 1][r], grid[j + 1][r + 1], grid[j][r + 1]);
    }
}

/**
 * Amber indicator material. Vertices carry aSide (-1 left / 1 right); the lit
 * state comes from an instanced aInd (x = left, y = right) or uniforms uL / uR.
 */
export function indicatorMaterial(mode: 'instanced' | 'uniform') {
  const uniforms = { uL: { value: 0 }, uR: { value: 0 } };
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.25, 0.12), toneMapped: false });
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    const decl = mode === 'instanced' ? 'attribute vec2 aInd;' : 'uniform float uL;\nuniform float uR;';
    const lit = mode === 'instanced' ? 'vOn = aSide < 0.0 ? aInd.x : aInd.y;' : 'vOn = aSide < 0.0 ? uL : uR;';
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aSide;\n${decl}\nvarying float vOn;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${lit}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vOn;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.06, 1.0, vOn);');
  };
  material.customProgramCacheKey = () => 'indicator-' + mode;
  return { material, uniforms };
}

function boxAt(b: MeshBuilder, cx: number, cy: number, cz: number, lx: number, ly: number, lz: number, color: THREE.Color) {
  const g = new THREE.BoxGeometry(lx, ly, lz);
  g.translate(cx, cy, cz);
  appendGeometry(b, g, color);
}

function wheel(b: MeshBuilder, x: number, r: number, z: number, side: number, y: number) {
  const tyre = new THREE.CylinderGeometry(r, r, 0.23, 18, 1);
  tyre.rotateX(Math.PI / 2);
  tyre.translate(x, y, z);
  appendGeometry(b, tyre, TYRE);
  const rim = new THREE.CylinderGeometry(r * 0.66, r * 0.66, 0.02, 12, 1);
  rim.rotateX(Math.PI / 2);
  rim.translate(x, y, z + side * 0.118);
  appendGeometry(b, rim, RIM);
}

function appendGeometry(b: MeshBuilder, g: THREE.BufferGeometry, color: THREE.Color) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const u = g.getAttribute('uv');
  const base = b.vertexCount;
  for (let i = 0; i < p.count; i++) b.vertex(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), u ? u.getX(i) : 0, u ? u.getY(i) : 0, color);
  const idx = g.index!;
  for (let i = 0; i < idx.count; i += 3) b.tri(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
}

function plateQuad(b: MeshBuilder, x: number, y: number, dir: number) {
  const w = 0.44;
  const h = 0.14;
  // u runs from the viewer's left to right for both plates: someone looking at the
  // front plate faces -X and has +Z on their left; behind the car +Z is on the right
  const z0 = dir > 0 ? w / 2 : -w / 2;
  const z1 = -z0;
  const a = b.vertex(x, y - h / 2, z0, dir, 0, 0, 0, 0);
  const c = b.vertex(x, y - h / 2, z1, dir, 0, 0, 1, 0);
  const d = b.vertex(x, y + h / 2, z1, dir, 0, 0, 1, 1);
  const e = b.vertex(x, y + h / 2, z0, dir, 0, 0, 0, 1);
  // counter-clockwise as seen from the viewer (face normal along dir)
  b.quad(a, c, d, e);
}

/* ---------------- licence plates ---------------- */

const PLATE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function randomPlate(seed: number): { text: string; green: boolean } {
  const r = mulberry32(seed);
  const green = r() < 0.32; // new-energy vehicles are common in Guangzhou
  let s = '';
  if (green) {
    s = (r() < 0.8 ? 'D' : 'F') + PLATE_LETTERS[Math.floor(r() * PLATE_LETTERS.length)];
    for (let i = 0; i < 4; i++) s += Math.floor(r() * 10);
  } else {
    for (let i = 0; i < 5; i++) s += r() < 0.3 ? PLATE_LETTERS[Math.floor(r() * PLATE_LETTERS.length)] : Math.floor(r() * 10);
  }
  return { text: '粤A·' + s, green };
}

/** Plate atlas: 8x8 plates on a 1024x512 canvas; returns texture and uv offsets. */
export function plateAtlas(count = 64, seed = 1) {
  const cols = 8;
  const rows = Math.ceil(count / cols);
  const cw = 128;
  const ch = 64;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cw;
  canvas.height = rows * ch;
  const g = canvas.getContext('2d')!;
  const plates: { text: string; green: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const p = randomPlate(seed * 1000 + i);
    plates.push(p);
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * ch;
    drawPlate(g, x, y, cw, ch, p.text, p.green);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, cols, rows, plates };
}

export function drawPlate(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, green: boolean) {
  if (green) {
    const grad = g.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, '#e9f7ea');
    grad.addColorStop(1, '#3bb26a');
    g.fillStyle = grad;
  } else g.fillStyle = '#1446c4';
  g.fillRect(x + 2, y + 2, w - 4, h - 4);
  g.strokeStyle = green ? '#222' : '#fff';
  g.lineWidth = 2;
  g.strokeRect(x + 5, y + 5, w - 10, h - 10);
  g.fillStyle = green ? '#111' : '#fff';
  g.font = `bold ${Math.round(h * 0.5)}px "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x + w / 2, y + h / 2 + 1, w - 12);
}

/* ---------------- paint palette ---------------- */

export const PAINT_COLORS = [
  0xf2f2f0, 0xf2f2f0, 0xf2f2f0, 0xdedede, 0x1b1c1e, 0x1b1c1e, 0x2a2d31, 0x7d8288, 0xa9adb2, 0x9aa3ab, 0x23355f, 0x6e1c1c, 0x8a6d4e, 0x3f4b3a, 0xc7c2b6,
];
export const TAXI_COLOR = 0x5aa7e0;


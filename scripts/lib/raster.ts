/** Binary/byte raster helpers used for occupancy masks and water extraction. */
import type { V2 } from '../../src/shared/polyline';

export class Raster {
  readonly data: Uint8Array;
  readonly w: number;
  readonly h: number;
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly x1: number,
    readonly z1: number,
    readonly res: number,
  ) {
    this.w = Math.ceil((x1 - x0) / res);
    this.h = Math.ceil((z1 - z0) / res);
    this.data = new Uint8Array(this.w * this.h);
  }
  ix(x: number) {
    return Math.floor((x - this.x0) / this.res);
  }
  iz(z: number) {
    return Math.floor((z - this.z0) / this.res);
  }
  get(x: number, z: number): number {
    const i = this.ix(x);
    const j = this.iz(z);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0;
    return this.data[j * this.w + i];
  }
  setCell(i: number, j: number, v: number) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return;
    this.data[j * this.w + i] = v;
  }
  /** Scanline polygon fill (even-odd) with value v (bitwise OR). */
  fillPolygon(poly: V2[], v: number) {
    if (poly.length < 3) return;
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const p of poly) {
      zmin = Math.min(zmin, p[1]);
      zmax = Math.max(zmax, p[1]);
    }
    const j0 = Math.max(0, this.iz(zmin));
    const j1 = Math.min(this.h - 1, this.iz(zmax));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const zc = this.z0 + (j + 0.5) * this.res;
      xs.length = 0;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const pa = poly[a];
        const pb = poly[b];
        if (pa[1] > zc !== pb[1] > zc) xs.push(pa[0] + ((zc - pa[1]) / (pb[1] - pa[1])) * (pb[0] - pa[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / this.res - 0.5));
        const i1 = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.x0) / this.res - 0.5));
        for (let i = i0; i <= i1; i++) this.data[j * this.w + i] |= v;
      }
    }
  }
  /** Marks cells within radius r of the segment a-b (bitwise OR). */
  strokeSegment(a: V2, b: V2, r: number, v: number) {
    const i0 = Math.max(0, this.ix(Math.min(a[0], b[0]) - r));
    const i1 = Math.min(this.w - 1, this.ix(Math.max(a[0], b[0]) + r));
    const j0 = Math.max(0, this.iz(Math.min(a[1], b[1]) - r));
    const j1 = Math.min(this.h - 1, this.iz(Math.max(a[1], b[1]) + r));
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const zc = this.z0 + (j + 0.5) * this.res;
      for (let i = i0; i <= i1; i++) {
        const xc = this.x0 + (i + 0.5) * this.res;
        let t = l2 > 0 ? ((xc - a[0]) * dx + (zc - a[1]) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = xc - (a[0] + dx * t);
        const ez = zc - (a[1] + dz * t);
        if (ex * ex + ez * ez <= r2) this.data[j * this.w + i] |= v;
      }
    }
  }
  strokePolyline(pts: V2[], r: number, v: number) {
    for (let k = 0; k + 1 < pts.length; k++) this.strokeSegment(pts[k], pts[k + 1], r, v);
  }
  /** True if all cells covered by polygon are free of bits in mask. */
  polygonFree(poly: V2[], mask: number): boolean {
    let xmin = Infinity;
    let xmax = -Infinity;
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const p of poly) {
      xmin = Math.min(xmin, p[0]);
      xmax = Math.max(xmax, p[0]);
      zmin = Math.min(zmin, p[1]);
      zmax = Math.max(zmax, p[1]);
    }
    for (let z = zmin; z <= zmax; z += this.res * 0.7) {
      for (let x = xmin; x <= xmax; x += this.res * 0.7) {
        if (!pointInPoly(x, z, poly)) continue;
        if (this.get(x, z) & mask) return false;
      }
    }
    return true;
  }
}

function pointInPoly(x: number, z: number, poly: V2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1] + 1e-12) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Marching squares on a binary raster (cells with value & bit). Returns closed
 * contours in world coordinates; outer boundaries are counter-clockwise in map
 * orientation, holes clockwise.
 */
export function traceContours(r: Raster, bit: number): V2[][] {
  const W = r.w;
  const H = r.h;
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < W && j < H && r.data[j * W + i] & bit ? 1 : 0);
  // segments keyed by start point (edge midpoints identified by integer keys)
  const next = new Map<number, number>();
  const key = (i2: number, j2: number) => j2 * (2 * W + 3) + i2; // doubled coordinates
  const addSeg = (a: number, b: number) => next.set(a, b);
  for (let j = -1; j < H; j++) {
    for (let i = -1; i < W; i++) {
      // corners: tl (i,j) tr (i+1,j) br (i+1,j+1) bl (i,j+1) ; z grows downward (south)
      const tl = at(i, j);
      const tr = at(i + 1, j);
      const br = at(i + 1, j + 1);
      const bl = at(i, j + 1);
      const c = tl * 8 + tr * 4 + br * 2 + bl;
      if (c === 0 || c === 15) continue;
      // edge midpoints in doubled coordinates (offset by +1 to keep >= 0)
      const top = key(2 * i + 2, 2 * j + 1);
      const right = key(2 * i + 3, 2 * j + 2);
      const bottom = key(2 * i + 2, 2 * j + 3);
      const left = key(2 * i + 1, 2 * j + 2);
      // orientation: keep filled cells on the left when walking (in raster coords, z down)
      switch (c) {
        case 1:
          addSeg(bottom, left);
          break;
        case 2:
          addSeg(right, bottom);
          break;
        case 3:
          addSeg(right, left);
          break;
        case 4:
          addSeg(top, right);
          break;
        case 5:
          addSeg(top, left);
          addSeg(bottom, right);
          break;
        case 6:
          addSeg(top, bottom);
          break;
        case 7:
          addSeg(top, left);
          break;
        case 8:
          addSeg(left, top);
          break;
        case 9:
          addSeg(bottom, top);
          break;
        case 10:
          addSeg(left, bottom);
          addSeg(right, top);
          break;
        case 11:
          addSeg(right, top);
          break;
        case 12:
          addSeg(left, right);
          break;
        case 13:
          addSeg(bottom, right);
          break;
        case 14:
          addSeg(left, bottom);
          break;
      }
    }
  }
  const stride = 2 * W + 3;
  const toWorld = (k: number): V2 => {
    const i2 = k % stride;
    const j2 = Math.floor(k / stride);
    return [r.x0 + ((i2 - 1) / 2 + 0.5) * r.res, r.z0 + ((j2 - 1) / 2 + 0.5) * r.res];
  };
  const contours: V2[][] = [];
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const pts: V2[] = [];
    let k = start;
    let guard = 0;
    while (!used.has(k) && guard++ < 5_000_000) {
      used.add(k);
      pts.push(toWorld(k));
      const n = next.get(k);
      if (n === undefined) break;
      k = n;
    }
    if (pts.length >= 4) contours.push(pts);
  }
  return contours;
}

/** 4-connected flood fill from seed cells, writing `bit` into cells where `barrier` bit is not set. Returns filled count. */
export function floodFill(r: Raster, seeds: [number, number][], barrier: number, bit: number, maxCells: number): number {
  const W = r.w;
  const H = r.h;
  const stack: number[] = [];
  const touched: number[] = [];
  for (const [i, j] of seeds) {
    if (i < 0 || j < 0 || i >= W || j >= H) continue;
    const idx = j * W + i;
    if (r.data[idx] & (barrier | bit)) continue;
    stack.push(idx);
    r.data[idx] |= bit;
    touched.push(idx);
  }
  while (stack.length) {
    const idx = stack.pop()!;
    const i = idx % W;
    const j = (idx - i) / W;
    const nb = [i > 0 ? idx - 1 : -1, i < W - 1 ? idx + 1 : -1, j > 0 ? idx - W : -1, j < H - 1 ? idx + W : -1];
    for (const n of nb) {
      if (n < 0 || r.data[n] & (barrier | bit)) continue;
      r.data[n] |= bit;
      touched.push(n);
      stack.push(n);
      if (touched.length > maxCells) {
        // runaway (leak into land): undo
        for (const t of touched) r.data[t] &= ~bit;
        return -1;
      }
    }
  }
  return touched.length;
}

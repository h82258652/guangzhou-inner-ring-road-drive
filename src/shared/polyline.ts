/** 2D polyline helpers working in the world XZ plane. */
export type V2 = [number, number];

export function dist2(a: V2, b: V2): number {
  const dx = a[0] - b[0];
  const dz = a[1] - b[1];
  return Math.sqrt(dx * dx + dz * dz);
}

export function cumulativeLengths(pts: V2[], closed = false): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + dist2(pts[i - 1], pts[i]));
  if (closed && pts.length > 1) out.push(out[out.length - 1] + dist2(pts[pts.length - 1], pts[0]));
  return out;
}

export function polylineLength(pts: V2[], closed = false): number {
  const c = cumulativeLengths(pts, closed);
  return c[c.length - 1];
}

/** Interpolates a point at arc length s on an (optionally closed) polyline with precomputed cumulative lengths. */
export function pointAt(pts: V2[], cum: number[], s: number, closed = false): V2 {
  const n = pts.length;
  const total = cum[cum.length - 1];
  if (closed) {
    s = ((s % total) + total) % total;
  } else {
    if (s <= 0) return [pts[0][0], pts[0][1]];
    if (s >= total) return [pts[n - 1][0], pts[n - 1][1]];
  }
  // binary search segment
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = pts[lo % n];
  const b = pts[(lo + 1) % n];
  const segLen = cum[lo + 1] - cum[lo];
  const t = segLen > 1e-9 ? (s - cum[lo]) / segLen : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Resamples a polyline at (almost) uniform spacing. For open polylines both
 * endpoints are kept and the spacing is adjusted so that all intervals are equal.
 * Returns the new points and, for each, the arc length in the source polyline.
 */
export function resampleUniform(
  pts: V2[],
  spacing: number,
  closed = false,
): { pts: V2[]; s: number[]; ds: number } {
  const cum = cumulativeLengths(pts, closed);
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.round(total / spacing));
  const ds = total / n;
  const out: V2[] = [];
  const ss: number[] = [];
  const count = closed ? n : n + 1;
  for (let i = 0; i < count; i++) {
    const s = Math.min(i * ds, total);
    out.push(pointAt(pts, cum, s, closed));
    ss.push(s);
  }
  return { pts: out, s: ss, ds };
}

/**
 * Gaussian smoothing of a uniformly sampled polyline. Open polylines use
 * point-reflection padding so endpoints and end tangents are preserved.
 */
export function gaussianSmooth(pts: V2[], sigmaSamples: number, closed = false): V2[] {
  const n = pts.length;
  if (n < 3 || sigmaSamples <= 0) return pts.map((p) => [p[0], p[1]] as V2);
  const r = Math.ceil(sigmaSamples * 3);
  const w: number[] = [];
  let wsum = 0;
  for (let k = -r; k <= r; k++) {
    const v = Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples));
    w.push(v);
    wsum += v;
  }
  const get = (i: number): V2 => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) {
      const q = pts[Math.min(-i, n - 1)];
      return [2 * pts[0][0] - q[0], 2 * pts[0][1] - q[1]];
    }
    if (i >= n) {
      const q = pts[Math.max(2 * (n - 1) - i, 0)];
      return [2 * pts[n - 1][0] - q[0], 2 * pts[n - 1][1] - q[1]];
    }
    return pts[i];
  };
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      out.push([pts[i][0], pts[i][1]]);
      continue;
    }
    let x = 0;
    let z = 0;
    for (let k = -r; k <= r; k++) {
      const p = get(i + k);
      x += p[0] * w[k + r];
      z += p[1] * w[k + r];
    }
    out.push([x / wsum, z / wsum]);
  }
  return out;
}

export interface NearestResult {
  /** index of segment start */
  i: number;
  /** parameter on the segment [0,1] */
  t: number;
  /** distance from the query point */
  dist: number;
  /** signed lateral offset (positive = right of travel direction) */
  lateral: number;
  /** closest point */
  p: V2;
}

/**
 * Finds the closest point on the polyline segments [i0, i1). Right-hand side is
 * positive. In XZ with +Z south, the right of a direction (dx,dz) is (-dz, dx).
 */
export function nearestOnPolyline(pts: V2[], q: V2, i0 = 0, i1 = pts.length - 1): NearestResult {
  let best: NearestResult = { i: 0, t: 0, dist: Infinity, lateral: 0, p: [pts[0][0], pts[0][1]] };
  const lo = Math.max(0, i0);
  const hi = Math.min(pts.length - 1, i1);
  for (let i = lo; i < hi; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-12 ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + dx * t;
    const pz = a[1] + dz * t;
    const ex = q[0] - px;
    const ez = q[1] - pz;
    const d = Math.sqrt(ex * ex + ez * ez);
    if (d < best.dist) {
      const len = Math.sqrt(l2) || 1;
      // right normal = (-dz, dx)/len
      const lateral = (ex * -dz + ez * dx) / len;
      best = { i, t, dist: d, lateral, p: [px, pz] };
    }
  }
  return best;
}

/** Signed area in map orientation (x east, y north): positive = counter-clockwise. */
export function signedAreaMap(pts: V2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    // map y = -z
    a += p[0] * -q[1] - q[0] * -p[1];
  }
  return a / 2;
}

/** Heading of the segment a->b as atan2(dz, dx). */
export function heading(a: V2, b: V2): number {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/** Point-in-polygon (even-odd). */
export function pointInPolygon(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] + 1e-12) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from a point to a polygon boundary. */
export function distToPolygonEdge(p: V2, poly: V2[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = p[0] - (a[0] + dx * t);
    const ez = p[1] - (a[1] + dz * t);
    best = Math.min(best, Math.sqrt(ex * ex + ez * ez));
  }
  return best;
}

export function polygonArea(poly: V2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  }
  return Math.abs(a / 2);
}

/** Douglas-Peucker simplification. */
export function simplify(pts: V2[], tol: number): V2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    const pa = pts[a];
    const pb = pts[b];
    const dx = pb[0] - pa[0];
    const dz = pb[1] - pa[1];
    const l2 = dx * dx + dz * dz;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i];
      let t = l2 > 0 ? ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = p[0] - (pa[0] + dx * t);
      const ez = p[1] - (pa[1] + dz * t);
      const d = ex * ex + ez * ez;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol * tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

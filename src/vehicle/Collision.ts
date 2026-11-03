/** 2D oriented-box overlap (separating axis theorem) in the XZ plane. */
export interface Box2 {
  x: number;
  z: number;
  heading: number;
  halfLength: number;
  halfWidth: number;
}

export interface Overlap {
  depth: number;
  /** unit normal pointing from b towards a */
  nx: number;
  nz: number;
}

export function obbOverlap(a: Box2, b: Box2): Overlap | null {
  const axes: [number, number][] = [];
  for (const h of [a.heading, b.heading]) {
    const c = Math.cos(h);
    const s = Math.sin(h);
    axes.push([c, s], [-s, c]);
  }
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  let best: Overlap | null = null;
  for (const [ax, az] of axes) {
    const ext = (bx: Box2) => {
      const c = Math.cos(bx.heading);
      const s = Math.sin(bx.heading);
      return Math.abs(c * ax + s * az) * bx.halfLength + Math.abs(-s * ax + c * az) * bx.halfWidth;
    };
    const dist = dx * ax + dz * az;
    const ov = ext(a) + ext(b) - Math.abs(dist);
    if (ov <= 0) return null;
    if (!best || ov < best.depth) {
      const sgn = dist >= 0 ? 1 : -1;
      best = { depth: ov, nx: ax * sgn, nz: az * sgn };
    }
  }
  return best;
}

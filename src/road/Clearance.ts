/**
 * Spatial queries against the drivable decks of the network, used to keep
 * roadside furniture (sign posts and gantries, lamp posts, piers, trees) out
 * of carriageways and from piercing decks above or below.
 *
 * Every deck occupies two volumes around its centreline sample:
 *  - the traffic envelope: the drivable band [bl, br] from just below the
 *    surface up to TRAFFIC_HEADROOM above it (nothing may stand in it);
 *  - the structure: the band widened by the barriers, from the bottom of the
 *    girder up to the barrier top (nothing may pass through it, except
 *    furniture standing on that very deck).
 */
import type { Edge, RoadNetwork } from './Network';

export const TRAFFIC_HEADROOM = 5.2;
export const GIRDER_DEPTH = 2.0;
export const BARRIER_WIDTH = 0.55;
export const BARRIER_HEIGHT = 1.1;

export interface DeckHit {
  edge: Edge;
  /** arc length and lateral offset of the query point on the deck */
  s: number;
  d: number;
  /** deck surface height */
  y: number;
  bl: number;
  br: number;
}

export class DeckIndex {
  private grid = new Map<number, number[]>();
  private readonly cell: number;

  constructor(
    readonly net: RoadNetwork,
    cell = 12,
  ) {
    this.cell = cell;
    // register every segment in all cells its widened footprint touches
    for (const e of net.edges) {
      for (let i = 0; i < e.n - 1; i++) {
        const w = Math.max(-e.bl[i], e.br[i], -e.bl[i + 1], e.br[i + 1]) + BARRIER_WIDTH + 1;
        const x0 = Math.min(e.x[i], e.x[i + 1]) - w;
        const x1 = Math.max(e.x[i], e.x[i + 1]) + w;
        const z0 = Math.min(e.z[i], e.z[i + 1]) - w;
        const z1 = Math.max(e.z[i], e.z[i + 1]) + w;
        for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
          for (let cz = Math.floor(z0 / cell); cz <= Math.floor(z1 / cell); cz++) {
            const k = this.key(cx, cz);
            let a = this.grid.get(k);
            if (!a) this.grid.set(k, (a = []));
            a.push(e.id * 65536 + i);
          }
      }
    }
  }

  private key(cx: number, cz: number) {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /**
   * Decks whose band widened by `margin` overlaps the disc of radius r at (x, z).
   * One hit per edge (the nearest segment).
   */
  at(x: number, z: number, r = 0, margin = 0): DeckHit[] {
    const out = new Map<Edge, DeckHit & { dist: number }>();
    const c = this.cell;
    const reach = Math.ceil(r / c);
    const cx0 = Math.floor(x / c);
    const cz0 = Math.floor(z / c);
    for (let cx = cx0 - reach; cx <= cx0 + reach; cx++)
      for (let cz = cz0 - reach; cz <= cz0 + reach; cz++) {
        const list = this.grid.get(this.key(cx, cz));
        if (!list) continue;
        for (const code of list) {
          const e = this.net.edges[Math.floor(code / 65536)];
          const i = code % 65536;
          const sx = e.x[i + 1] - e.x[i];
          const sz = e.z[i + 1] - e.z[i];
          const l = Math.hypot(sx, sz) || 1;
          const rx = x - e.x[i];
          const rz = z - e.z[i];
          const along = (rx * sx + rz * sz) / l;
          // a little slack along the segment closes the wedge-shaped gaps on the outside of bends
          if (along < -r - 0.6 || along > l + r + 0.6) continue;
          const t = Math.max(0, Math.min(1, along / l));
          const d = (-rx * sz + rz * sx) / l;
          const bl = e.bl[i] + (e.bl[i + 1] - e.bl[i]) * t;
          const br = e.br[i] + (e.br[i + 1] - e.br[i]) * t;
          if (d + r <= bl - margin || d - r >= br + margin) continue;
          const dist = Math.abs(d - (bl + br) / 2);
          const prev = out.get(e);
          if (prev && prev.dist <= dist) continue;
          out.set(e, { edge: e, s: (i + t) * e.ds, d, y: e.y[i] + (e.y[i + 1] - e.y[i]) * t, bl, br, dist });
        }
      }
    return [...out.values()];
  }

  /**
   * True if a vertical cylinder (radius r, from y0 to y1) at (x, z) stays out of
   * every deck's traffic envelope and out of the structure of every deck except
   * those in `standsOn` (e.g. the deck whose barrier a post is mounted on).
   */
  clear(x: number, z: number, r: number, y0: number, y1: number, standsOn: Edge[] = [], ignore: Edge[] = []): boolean {
    for (const h of this.at(x, z, r, BARRIER_WIDTH)) {
      if (ignore.includes(h.edge)) continue;
      const inBand = Math.abs(h.d - (h.bl + h.br) / 2) < (h.br - h.bl) / 2 + r;
      if (inBand && y1 > h.y - 0.3 && y0 < h.y + TRAFFIC_HEADROOM) return false;
      if (!standsOn.includes(h.edge) && y1 > h.y - GIRDER_DEPTH && y0 < h.y + BARRIER_HEIGHT) return false;
    }
    return true;
  }

  /**
   * Height of the drawn underside of the lowest deck above `y` at the point
   * (Infinity if open sky): the box girder is deepest under the middle of the
   * deck and its soffit rises towards the edges (see RoadBuilder girderSegment).
   */
  soffit(x: number, z: number, y: number): number {
    let best = Infinity;
    for (const h of this.at(x, z, 0, BARRIER_WIDTH)) {
      if (h.y - GIRDER_DEPTH <= y) continue;
      const i = h.edge.idx(h.s);
      const l = h.bl - (h.edge.ol[i] >= 0 ? 0 : 0.52);
      const r = h.br + (h.edge.or[i] >= 0 ? 0 : 0.52);
      const half = (r - l) / 2;
      const t = Math.min(1, Math.max(0, (Math.abs(h.d - (l + r) / 2) - 0.62 * half) / (0.38 * half)));
      const under = h.y > 3.2 ? h.y - SOFFIT_DEPTH + t * (SOFFIT_DEPTH - SOFFIT_EDGE) : h.y - GIRDER_DEPTH;
      if (under < best) best = under;
    }
    return best;
  }
}

/** Box girder of elevated decks: depth under the middle and at the outer edges (as drawn). */
const SOFFIT_DEPTH = 1.9;
const SOFFIT_EDGE = 0.42;

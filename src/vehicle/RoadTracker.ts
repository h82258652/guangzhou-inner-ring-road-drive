/**
 * Keeps a vehicle attached to the road network: tracks (edge, s, d), moves
 * across junctions and open (gore) sides, and resolves barrier collisions.
 */
import { type Edge, type RoadNetwork, newProjection } from '../road/Network';

export interface CollisionInfo {
  /** normal impact speed (m/s), 0 if none */
  impact: number;
  side: -1 | 0 | 1;
  scraping: boolean;
}

export interface TrackedBody {
  x: number;
  z: number;
  psi: number;
  halfWidth: number;
  halfLength: number;
  /** world velocity getter / setter */
  getVel(): [number, number];
  setVel(vx: number, vz: number): void;
  yawRate: number;
}

export class RoadTracker {
  edge: Edge;
  s: number;
  d = 0;
  /** reached the end of an exit ramp */
  terminal: Edge | null = null;
  private proj = newProjection();

  constructor(
    readonly net: RoadNetwork,
    edge: Edge,
    s: number,
  ) {
    this.edge = edge;
    this.s = s;
  }

  get y() {
    return this.edge.yAt(this.s);
  }

  roadHeading() {
    const i = this.edge.idx(this.s);
    return Math.atan2(this.edge.tz[i], this.edge.tx[i]);
  }

  /** Re-projects the body position; handles edge changes and barrier contacts. */
  update(body: TrackedBody): CollisionInfo {
    const info: CollisionInfo = { impact: 0, side: 0, scraping: false };
    this.terminal = null;
    let e = this.edge;
    const p = this.proj;
    e.project(body.x, body.z, this.s, p);
    // move through junctions
    for (let guard = 0; guard < 4; guard++) {
      if (p.s > e.length) {
        const next = this.pickNext(e.succ, body.x, body.z, 0);
        if (!next) {
          // end of the road (exit ramp terminal)
          this.terminal = e;
          p.s = e.length;
          break;
        }
        e = next.edge;
        p.s = next.s;
        p.d = next.d;
        continue;
      }
      if (p.s < 0) {
        const prev = this.pickNext(e.pred, body.x, body.z, 1);
        if (!prev) {
          p.s = 0;
          break;
        }
        e = prev.edge;
        p.s = prev.s;
        p.d = prev.d;
        continue;
      }
      break;
    }
    this.edge = e;
    this.s = Math.max(0, Math.min(e.length, p.s));
    this.d = p.d;

    // lateral extent of the body relative to the road direction
    const i = e.idx(this.s);
    const rel = body.psi - Math.atan2(e.tz[i], e.tx[i]);
    const ext = body.halfWidth * Math.abs(Math.cos(rel)) + body.halfLength * Math.abs(Math.sin(rel));
    const bl = e.blAt(this.s);
    const br = e.brAt(this.s);

    // crossing into an adjacent edge through an open side
    if (this.d > br && e.or[i] >= 0) {
      if (this.transfer(e.or[i], body)) return info;
    } else if (this.d < bl && e.ol[i] >= 0) {
      if (this.transfer(e.ol[i], body)) return info;
    }

    const rightBarrier = e.or[i] < 0;
    const leftBarrier = e.ol[i] < 0;
    const nx = -e.tz[i];
    const nz = e.tx[i];
    let pen = 0;
    let side: -1 | 0 | 1 = 0;
    if (rightBarrier && this.d + ext > br) {
      pen = this.d + ext - br;
      side = 1;
    } else if (leftBarrier && this.d - ext < bl) {
      pen = this.d - ext - bl;
      side = -1;
    } else if (!rightBarrier && this.d > br + 2.5) {
      // fell off an open side without a neighbour (should not happen) — clamp
      pen = this.d - br - 2.5;
      side = 1;
    } else if (!leftBarrier && this.d < bl - 2.5) {
      pen = this.d - bl + 2.5;
      side = -1;
    }
    if (side !== 0) {
      body.x -= nx * pen;
      body.z -= nz * pen;
      this.d -= pen;
      const [vx, vz] = body.getVel();
      const tx = e.tx[i];
      const tz = e.tz[i];
      let vt = vx * tx + vz * tz;
      let vn = vx * nx + vz * nz;
      if (vn * side > 0) {
        info.impact = Math.abs(vn);
        vn = -vn * 0.18;
        // friction while scraping along the wall
        vt *= Math.max(0.55, 1 - 0.04 - info.impact * 0.035);
        // align the car with the barrier
        const along = Math.cos(rel) >= 0 ? 0 : Math.PI;
        const target = Math.atan2(tz, tx) + along;
        let dpsi = target - body.psi;
        dpsi = Math.atan2(Math.sin(dpsi), Math.cos(dpsi));
        body.psi += dpsi * Math.min(0.5, 0.1 + info.impact * 0.04);
        body.yawRate *= 0.3;
      }
      info.side = side;
      info.scraping = true;
      body.setVel(tx * vt + nx * vn, tz * vt + nz * vn);
    }
    return info;
  }

  private transfer(id: number, body: TrackedBody): boolean {
    const n = this.net.edges[id];
    const p = this.proj;
    n.project(body.x, body.z, this.guessS(n, body.x, body.z), p, 30);
    if (p.s < -1 || p.s > n.length + 1) return false;
    const bl = n.blAt(p.s);
    const br = n.brAt(p.s);
    if (p.d < bl - 0.3 || p.d > br + 0.3) return false;
    this.edge = n;
    this.s = Math.max(0, Math.min(n.length, p.s));
    this.d = p.d;
    return true;
  }

  private guessS(n: Edge, x: number, z: number) {
    // coarse nearest sample search
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n.n; i += 4) {
      const d = (n.x[i] - x) ** 2 + (n.z[i] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best * n.ds;
  }

  /** At a junction, choose the connected edge whose surface contains the point. */
  private pickNext(cands: Edge[], x: number, z: number, atEnd: 0 | 1) {
    let best: { edge: Edge; s: number; d: number } | null = null;
    let bestScore = Infinity;
    const p = newProjection();
    for (const c of cands) {
      c.project(x, z, atEnd ? c.length : 0, p, 12);
      const bl = c.blAt(p.s);
      const br = c.brAt(p.s);
      const outside = p.d < bl ? bl - p.d : p.d > br ? p.d - br : 0;
      const score = outside * 10 + Math.abs(p.d - (bl + br) / 2) * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = { edge: c, s: p.s, d: p.d };
      }
    }
    return best;
  }
}

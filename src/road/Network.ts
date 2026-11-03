/**
 * Runtime road network: edges with per-sample arrays, interpolation,
 * projection of world positions to (edge, s, d), and graph navigation.
 * Lateral offset d is positive to the right of the travel direction.
 */
import type { CameraFile, EdgeFile, EntranceFile, ExitFile, LineId, NetworkFile, NodeFile, Rle, SignFile } from '../shared/types';

function expand<T extends number>(rle: Rle<T>, n: number, Arr: Int32ArrayConstructor | Uint8ArrayConstructor | Uint16ArrayConstructor) {
  const out = new Arr(n);
  for (let k = 0; k < rle.length; k++) {
    const [start, v] = rle[k];
    const end = k + 1 < rle.length ? rle[k + 1][0] : n;
    out.fill(v as number, start, end);
  }
  return out;
}

export class Edge {
  readonly id: number;
  readonly kind: 'main' | 'ramp';
  readonly line: LineId | null;
  readonly from: number;
  readonly to: number;
  readonly lineS0: number | null;
  readonly ds: number;
  readonly length: number;
  readonly laneWidth: number;
  readonly n: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  readonly grade: Float32Array;
  readonly lanes: Float32Array;
  readonly bl: Float32Array;
  readonly br: Float32Array;
  readonly ol: Int32Array;
  readonly or: Int32Array;
  readonly struct: Uint8Array;
  readonly noiseL: Uint8Array;
  readonly noiseR: Uint8Array;
  readonly speed: Uint8Array;
  readonly nameIdx: Uint16Array;
  succ: Edge[] = [];
  pred: Edge[] = [];
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  constructor(f: EdgeFile, names: Map<string, number>, nameList: string[]) {
    this.id = f.id;
    this.kind = f.kind;
    this.line = f.line;
    this.from = f.from;
    this.to = f.to;
    this.lineS0 = f.lineS0;
    this.ds = f.ds;
    this.length = f.length;
    this.laneWidth = f.laneWidth;
    const n = (this.n = f.x.length);
    this.x = Float32Array.from(f.x);
    this.y = Float32Array.from(f.y);
    this.z = Float32Array.from(f.z);
    this.lanes = Float32Array.from(f.lanes);
    this.bl = Float32Array.from(f.bl);
    this.br = Float32Array.from(f.br);
    this.ol = expand(f.ol, n, Int32Array) as Int32Array;
    this.or = expand(f.or, n, Int32Array) as Int32Array;
    this.struct = expand(f.struct, n, Uint8Array) as Uint8Array;
    this.noiseL = expand(f.noiseL, n, Uint8Array) as Uint8Array;
    this.noiseR = expand(f.noiseR, n, Uint8Array) as Uint8Array;
    this.speed = expand(f.speed, n, Uint8Array) as Uint8Array;
    const nameRle: Rle<number> = f.names.map(([i, s]) => {
      let k = names.get(s);
      if (k === undefined) {
        k = nameList.length;
        names.set(s, k);
        nameList.push(s);
      }
      return [i, k];
    });
    this.nameIdx = expand(nameRle, n, Uint16Array) as Uint16Array;
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.grade = new Float32Array(n);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const dx = this.x[b] - this.x[a];
      const dz = this.z[b] - this.z[a];
      const l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l;
      this.tz[i] = dz / l;
      this.grade[i] = (this.y[b] - this.y[a]) / l;
      minX = Math.min(minX, this.x[i]);
      maxX = Math.max(maxX, this.x[i]);
      minZ = Math.min(minZ, this.z[i]);
      maxZ = Math.max(maxZ, this.z[i]);
    }
    this.minX = minX;
    this.maxX = maxX;
    this.minZ = minZ;
    this.maxZ = maxZ;
  }

  /** fractional sample index for arc length s */
  u(s: number) {
    const u = s / this.ds;
    return u < 0 ? 0 : u > this.n - 1 ? this.n - 1 : u;
  }
  private lerp(arr: Float32Array, s: number) {
    const u = this.u(s);
    const i = Math.min(Math.floor(u), this.n - 2);
    const t = u - i;
    return arr[i] + (arr[i + 1] - arr[i]) * t;
  }
  yAt(s: number) {
    return this.lerp(this.y, s);
  }
  blAt(s: number) {
    return this.lerp(this.bl, s);
  }
  brAt(s: number) {
    return this.lerp(this.br, s);
  }
  lanesAt(s: number) {
    return this.lerp(this.lanes, s);
  }
  gradeAt(s: number) {
    return this.lerp(this.grade, s);
  }
  idx(s: number) {
    return Math.round(this.u(s));
  }
  speedAt(s: number) {
    return this.speed[this.idx(s)];
  }
  /** World position and frame at arc length s and lateral offset d. */
  frame(s: number, d: number, out: RoadFrame): RoadFrame {
    const u = this.u(s);
    const i = Math.min(Math.floor(u), this.n - 2);
    const t = u - i;
    const tx = this.tx[i] + (this.tx[i + 1] - this.tx[i]) * t;
    const tz = this.tz[i] + (this.tz[i + 1] - this.tz[i]) * t;
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l;
    out.tz = tz / l;
    out.nx = -out.tz;
    out.nz = out.tx;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t + out.nx * d;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * t + out.nz * d;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    out.grade = this.grade[i] + (this.grade[i + 1] - this.grade[i]) * t;
    return out;
  }
  /** Lateral centre of lane k (0 = leftmost). */
  laneCenter(s: number, k: number) {
    const lanes = this.lanesAt(s);
    const w = lanes * this.laneWidth;
    return -w / 2 + (k + 0.5) * this.laneWidth;
  }
  laneIndex(s: number, d: number) {
    const lanes = this.lanesAt(s);
    const w = lanes * this.laneWidth;
    return Math.floor((d + w / 2) / this.laneWidth);
  }

  /**
   * Projects (x, z) onto the centreline near sHint. Returns s (may be < 0 or
   * > length when beyond the ends) and signed lateral offset d.
   */
  project(x: number, z: number, sHint: number, out: Projection, window = 8): Projection {
    const n = this.n;
    let i0 = Math.max(0, Math.min(n - 2, Math.round(sHint / this.ds)));
    let bestD2 = Infinity;
    let bestI = i0;
    let bestT = 0;
    let lo = Math.max(0, i0 - window);
    let hi = Math.min(n - 2, i0 + window);
    for (let pass = 0; pass < 4; pass++) {
      for (let i = lo; i <= hi; i++) {
        const ax = this.x[i];
        const az = this.z[i];
        const dx = this.x[i + 1] - ax;
        const dz = this.z[i + 1] - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        // allow extrapolation beyond the very ends
        if (i > 0 && t < 0) t = 0;
        if (i < n - 2 && t > 1) t = 1;
        const px = ax + dx * t - x;
        const pz = az + dz * t - z;
        const d2 = px * px + pz * pz;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestI = i;
          bestT = t;
        }
      }
      // widen the window if the minimum is on its border
      if ((bestI === lo && lo > 0) || (bestI === hi && hi < n - 2)) {
        i0 = bestI;
        lo = Math.max(0, i0 - window * 4);
        hi = Math.min(n - 2, i0 + window * 4);
      } else break;
    }
    const i = bestI;
    const dx = this.x[i + 1] - this.x[i];
    const dz = this.z[i + 1] - this.z[i];
    const l = Math.hypot(dx, dz) || 1;
    const px = this.x[i] + dx * bestT;
    const pz = this.z[i] + dz * bestT;
    out.s = (i + bestT) * this.ds;
    out.d = ((x - px) * -dz + (z - pz) * dx) / l;
    out.dist = Math.sqrt(bestD2);
    return out;
  }
}

export interface RoadFrame {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  grade: number;
}
export const newFrame = (): RoadFrame => ({ x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 1, grade: 0 });

export interface Projection {
  s: number;
  d: number;
  dist: number;
}
export const newProjection = (): Projection => ({ s: 0, d: 0, dist: 0 });

export interface LineRuntime {
  id: LineId;
  name: string;
  direction: 'ccw' | 'cw';
  length: number;
  edges: Edge[];
}

export class RoadNetwork {
  readonly edges: Edge[];
  readonly names: string[] = [];
  readonly lines: Record<LineId, LineRuntime>;
  readonly nodes = new Map<number, NodeFile>();
  readonly exits: ExitFile[];
  readonly entrances: EntranceFile[];
  readonly signs: SignFile[];
  readonly cameras: CameraFile[];
  private grid = new Map<number, number[]>();
  private readonly cell = 60;

  constructor(readonly data: NetworkFile) {
    const nameMap = new Map<string, number>();
    this.edges = data.edges.map((f) => new Edge(f, nameMap, this.names));
    for (const n of data.nodes) this.nodes.set(n.id, n);
    for (const e of this.edges) {
      const to = this.nodes.get(e.to)!;
      const from = this.nodes.get(e.from)!;
      e.succ = to.out.map((id) => this.edges[id]);
      e.pred = from.in.map((id) => this.edges[id]);
    }
    this.lines = {
      A: { ...data.lines.A, edges: data.lines.A.edges.map((id) => this.edges[id]) },
      B: { ...data.lines.B, edges: data.lines.B.edges.map((id) => this.edges[id]) },
    };
    this.exits = data.exits;
    this.entrances = data.entrances;
    this.signs = data.signs;
    this.cameras = data.cameras;
    for (const e of this.edges) {
      for (let i = 0; i < e.n; i += 2) {
        const k = this.key(e.x[i], e.z[i]);
        let a = this.grid.get(k);
        if (!a) this.grid.set(k, (a = []));
        if (a[a.length - 1] !== e.id) a.push(e.id);
      }
    }
  }

  private key(x: number, z: number) {
    return (Math.floor(x / this.cell) + 1000) * 4096 + (Math.floor(z / this.cell) + 1000);
  }

  /** Edges with samples near (x, z). */
  edgesNear(x: number, z: number, radius = 60): Edge[] {
    const out = new Set<number>();
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const a = this.grid.get((cx + dx + 1000) * 4096 + (cz + dz + 1000));
        if (a) for (const id of a) out.add(id);
      }
    return [...out].map((id) => this.edges[id]);
  }

  /** Global projection: best edge for a world position (optionally near height y). */
  locate(x: number, z: number, y?: number): { edge: Edge; s: number; d: number } | null {
    let best: { edge: Edge; s: number; d: number } | null = null;
    let bestScore = Infinity;
    const p = newProjection();
    for (const e of this.edgesNear(x, z, 90)) {
      e.project(x, z, 0, p, e.n);
      if (p.s < 0 || p.s > e.length) continue;
      const inside = p.d >= e.blAt(p.s) - 0.5 && p.d <= e.brAt(p.s) + 0.5;
      let score = p.dist + (inside ? 0 : 50);
      if (y !== undefined) score += Math.abs(e.yAt(p.s) - y) * 4;
      if (score < bestScore) {
        bestScore = score;
        best = { edge: e, s: p.s, d: p.d };
      }
    }
    return best;
  }

  nameAt(e: Edge, s: number) {
    return this.names[e.nameIdx[e.idx(s)]] ?? '';
  }

  /** Arc length along the line for a main edge position. */
  lineS(e: Edge, s: number): number | null {
    if (e.lineS0 == null || !e.line) return null;
    const L = this.lines[e.line].length;
    return (((e.lineS0 + s) % L) + L) % L;
  }

  /** Main edge + local s for a line arc length. */
  atLineS(line: LineId, s: number): { edge: Edge; s: number } {
    const L = this.lines[line].length;
    s = ((s % L) + L) % L;
    for (const e of this.lines[line].edges) {
      const s0 = e.lineS0 ?? 0;
      if (s >= s0 && s <= s0 + e.length) return { edge: e, s: s - s0 };
    }
    return { edge: this.lines[line].edges[0], s: 0 };
  }
}

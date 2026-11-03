/**
 * Builds the drivable road network (inner ring A/B lines + ramps) from OSM
 * expressway ways: loop tracing, ramp discovery, edge splitting, resampling,
 * smoothing, lane/width layout, ramp attachment geometry and open (gore) zones.
 * Elevation is solved separately in ./elevation.ts.
 */
import { loadCache, geomToXZ, numTag, proj, type OsmElement, type OsmWay, type OsmRelation } from './osm';
import { STATION_REF } from './config';
import {
  type V2,
  cumulativeLengths,
  dist2,
  gaussianSmooth,
  heading,
  nearestOnPolyline,
  pointAt,
  resampleUniform,
  signedAreaMap,
} from '../../src/shared/polyline';
import { clamp, smax, smoothstep, wrapAngle } from '../../src/shared/math';
import type { LineId } from '../../src/shared/types';

export const SAMPLE_SPACING = 2.5;
export const LANE_WIDTH_MAIN = 3.5;
export const LANE_WIDTH_RAMP = 3.6;
export const SHOULDER_MAIN = 0.6;
export const SHOULDER_RAMP = 0.7;
/** lateral gap between lane edges at which the gore nose (barriers) begins */
export const GORE_NOSE_GAP = 3.0;
const TAPER_DIVERGE = 55;
const TAPER_MERGE = 75;
const MAX_RAMP_LEN = 1600;
const MAX_RADIAL_RUNOUT = 350;
const LAYER_HEIGHT = [0, 9.5, 14.5, 19.5, 24.5];

export const RING_NAMES = new Set(['内环路', '江湾大桥', '江湾桥']);

export interface Way {
  id: number;
  nodes: number[];
  pts: V2[];
  tags: Record<string, string>;
  highway: string;
  name: string | null;
  oneway: 1 | -1 | 0;
  isLink: boolean;
}

export interface DWay {
  way: Way;
  dir: 1 | -1;
  nodes: number[];
  pts: V2[];
  len: number;
}

export interface Edge {
  id: number;
  kind: 'main' | 'ramp';
  line: LineId | null;
  fromNode: number;
  toNode: number;
  chain: DWay[];
  pts: V2[];
  ds: number;
  length: number;
  srcWay: number[];
  lanes: number[];
  laneWidth: number;
  shoulder: number;
  bl: number[];
  br: number[];
  ol: number[];
  or: number[];
  yTarget: number[];
  yWeight: number[];
  y: number[];
  layer: number[];
  struct: number[];
  noiseL: number[];
  noiseR: number[];
  speed: number[];
  names: string[];
  /** elevation coupling: partner edge id and sample index (-1 = none) */
  coupleEdge: number[];
  coupleIdx: number[];
  lineS0: number | null;
  taperStart: number;
  taperEnd: number;
}

export interface GraphNode {
  id: number;
  p: V2;
  in: number[];
  out: number[];
}

export interface Attachment {
  through: Edge;
  branch: Edge;
  diverge: boolean;
  /** +1 branch lies to the right of the through edge, -1 left */
  side: number;
  mode: 'branch' | 'split';
  wBranch: number;
  wThrough: number;
}

export interface Network {
  edges: Edge[];
  nodes: Map<number, GraphNode>;
  lines: Record<LineId, { edges: number[]; length: number }>;
  ways: Map<number, Way>;
  attachments: Attachment[];
}

/* ------------------------------------------------------------------ */

function parseWays(elements: OsmElement[]): { ways: Map<number, Way>; relMembers: Set<number> } {
  const ways = new Map<number, Way>();
  let relMembers = new Set<number>();
  for (const e of elements) {
    if (e.type === 'way') {
      const w = e as OsmWay;
      if (!w.nodes || !w.geometry) continue;
      const tags = w.tags ?? {};
      const ow = tags.oneway;
      const oneway: 1 | -1 | 0 = ow === 'yes' || ow === 'true' || ow === '1' ? 1 : ow === '-1' ? -1 : 0;
      const pts = geomToXZ(w.geometry);
      if (pts.length !== w.nodes.length) continue;
      const hw = tags.highway ?? '';
      ways.set(w.id, {
        id: w.id,
        nodes: w.nodes,
        pts,
        tags,
        highway: hw,
        name: tags.name ?? null,
        oneway: oneway === 0 && hw.endsWith('_link') ? 1 : oneway,
        isLink: hw.endsWith('_link'),
      });
    } else if (e.type === 'relation') {
      const r = e as OsmRelation;
      if (r.id === 19265916) relMembers = new Set(r.members.filter((m) => m.type === 'way').map((m) => m.ref));
    }
  }
  return { ways, relMembers };
}

export function directed(w: Way, dir: 1 | -1): DWay {
  const nodes = dir === 1 ? w.nodes : [...w.nodes].reverse();
  const pts = dir === 1 ? w.pts : [...w.pts].reverse();
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist2(pts[i - 1], pts[i]);
  return { way: w, dir, nodes, pts, len };
}

export function buildAdjacency(ways: Map<number, Way>) {
  const out = new Map<number, DWay[]>();
  const inc = new Map<number, DWay[]>();
  const push = (m: Map<number, DWay[]>, k: number, d: DWay) => {
    let a = m.get(k);
    if (!a) m.set(k, (a = []));
    a.push(d);
  };
  for (const w of ways.values()) {
    const dirs: (1 | -1)[] = w.oneway === 1 ? [1] : w.oneway === -1 ? [-1] : [1, -1];
    for (const d of dirs) {
      const dw = directed(w, d);
      push(out, dw.nodes[0], dw);
      push(inc, dw.nodes[dw.nodes.length - 1], dw);
    }
  }
  return { out, inc };
}

const endHeading = (d: DWay) => heading(d.pts[d.pts.length - 2], d.pts[d.pts.length - 1]);
const startHeading = (d: DWay) => heading(d.pts[0], d.pts[1]);

/** Traces a closed loop following ring-named ways with minimal turning. */
export function traceLoop(start: DWay, out: Map<number, DWay[]>, relMembers: Set<number>): DWay[] | null {
  const score = (d: DWay) =>
    (d.way.name && RING_NAMES.has(d.way.name) ? 4 : 0) + (relMembers.has(d.way.id) ? 3 : 0) + (d.way.highway === 'trunk' ? 1 : 0);
  const seq = [start];
  const seen = new Set([start.way.id]);
  let cur = start;
  for (let iter = 0; iter < 500; iter++) {
    const endNode = cur.nodes[cur.nodes.length - 1];
    const h0 = endHeading(cur);
    const cands = (out.get(endNode) ?? []).filter((c) => c.way.id !== cur.way.id && c.way.oneway !== 0);
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ds = score(b) - score(a);
      if (ds !== 0) return ds;
      return Math.abs(wrapAngle(startHeading(a) - h0)) - Math.abs(wrapAngle(startHeading(b) - h0));
    });
    const nxt = cands[0];
    if (nxt.way.id === start.way.id) return seq;
    if (seen.has(nxt.way.id)) return null;
    seq.push(nxt);
    seen.add(nxt.way.id);
    cur = nxt;
  }
  return null;
}

/** Flattens a loop of directed ways to node ids / points / source way index (closing node omitted). */
export function loopPolyline(seq: DWay[]): { nodes: number[]; pts: V2[]; way: number[] } {
  const nodes: number[] = [];
  const pts: V2[] = [];
  const way: number[] = [];
  seq.forEach((d, wi) => {
    for (let i = 0; i < d.nodes.length - 1; i++) {
      nodes.push(d.nodes[i]);
      pts.push(d.pts[i]);
      way.push(wi);
    }
  });
  return { nodes, pts, way };
}

function rotate<T>(a: T[], k: number): T[] {
  return [...a.slice(k), ...a.slice(0, k)];
}

/* ------------------------------------------------------------------ */

export function buildNetwork(): Network {
  const { ways, relMembers } = parseWays(loadCache('expressways.json'));
  const { out, inc } = buildAdjacency(ways);
  const nodePos = new Map<number, V2>();
  for (const w of ways.values()) w.nodes.forEach((n, i) => nodePos.set(n, w.pts[i]));

  // ---- 1. trace the two loops (A = counter-clockwise, B = clockwise)
  const ringWays = [...ways.values()]
    .filter((w) => w.highway === 'trunk' && w.name === '内环路' && w.oneway === 1)
    .sort((a, b) => Math.min(...a.pts.map((p) => p[1])) - Math.min(...b.pts.map((p) => p[1])));
  let seqA: DWay[] | null = null;
  let seqB: DWay[] | null = null;
  for (const w of ringWays) {
    if (seqA && seqB) break;
    const seq = traceLoop(directed(w, 1), out, relMembers);
    if (!seq) continue;
    const area = signedAreaMap(loopPolyline(seq).pts);
    if (area > 1e6 && !seqA) seqA = seq;
    if (area < -1e6 && !seqB) seqB = seq;
  }
  if (!seqA || !seqB) throw new Error('Could not trace both inner ring loops');

  const station = proj.project(STATION_REF.lat, STATION_REF.lon);
  type Loop = { nodes: number[]; pts: V2[]; way: number[]; seq: DWay[]; wayIds: Set<number> };
  const loops = {} as Record<LineId, Loop>;
  for (const [id, seq] of [
    ['A', seqA],
    ['B', seqB],
  ] as [LineId, DWay[]][]) {
    const lp = loopPolyline(seq);
    let best = 0;
    let bd = Infinity;
    lp.pts.forEach((p, i) => {
      const d = dist2(p, station);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    loops[id] = {
      nodes: rotate(lp.nodes, best),
      pts: rotate(lp.pts, best),
      way: rotate(lp.way, best),
      seq,
      wayIds: new Set(seq.map((d) => d.way.id)),
    };
  }
  const loopWayIds = new Set([...loops.A.wayIds, ...loops.B.wayIds]);
  const loopNodeSet = new Set([...loops.A.nodes, ...loops.B.nodes]);

  // ---- 2. discover ramps (forward from diverges, backward from merges)
  const included = new Map<string, DWay>();
  const keyOf = (d: DWay) => `${d.way.id}:${d.dir}`;
  const isMajorOther = (d: DWay) =>
    !d.way.isLink && d.way.name != null && !RING_NAMES.has(d.way.name) && (d.way.highway === 'trunk' || d.way.highway === 'motorway');

  const isTunnel = (d: DWay) => !!d.way.tags.tunnel && d.way.tags.tunnel !== 'no';
  const explore = (d: DWay, acc: number, depth: number, forward: boolean) => {
    const k = keyOf(d);
    if (included.has(k) || loopWayIds.has(d.way.id) || d.way.oneway === 0) return;
    // tunnels (e.g. 珠江隧道) are not modelled: the ramp ends at the portal
    if (isTunnel(d)) return;
    if (depth > 0 && isMajorOther(d) && acc > MAX_RADIAL_RUNOUT) return;
    included.set(k, d);
    const node = forward ? d.nodes[d.nodes.length - 1] : d.nodes[0];
    if (loopNodeSet.has(node)) return;
    const total = acc + d.len;
    if (total > MAX_RAMP_LEN) return;
    for (const n of (forward ? out : inc).get(node) ?? []) {
      if (n.way.id === d.way.id) continue;
      explore(n, total, depth + 1, forward);
    }
  };
  for (const id of ['A', 'B'] as LineId[]) {
    for (const n of loops[id].nodes) {
      for (const d of out.get(n) ?? []) if (!loopWayIds.has(d.way.id)) explore(d, 0, 0, true);
      for (const d of inc.get(n) ?? []) if (!loopWayIds.has(d.way.id)) explore(d, 0, 0, false);
    }
  }

  // ---- 3. directed node-level subgraph, junctions
  interface Seg {
    a: number;
    b: number;
    d: DWay;
  }
  const sub: DWay[] = [...included.values(), ...loops.A.seq, ...loops.B.seq];
  const segOut = new Map<number, Seg[]>();
  const segIn = new Map<number, Seg[]>();
  for (const d of sub) {
    for (let k = 0; k < d.nodes.length - 1; k++) {
      const s: Seg = { a: d.nodes[k], b: d.nodes[k + 1], d };
      if (!segOut.has(s.a)) segOut.set(s.a, []);
      if (!segIn.has(s.b)) segIn.set(s.b, []);
      segOut.get(s.a)!.push(s);
      segIn.get(s.b)!.push(s);
    }
  }
  const isJunction = (n: number) => (segOut.get(n)?.length ?? 0) !== 1 || (segIn.get(n)?.length ?? 0) !== 1;

  const nodes = new Map<number, GraphNode>();
  const getNode = (osm: number): GraphNode => {
    let g = nodes.get(osm);
    if (!g) {
      g = { id: osm, p: nodePos.get(osm)!, in: [], out: [] };
      nodes.set(osm, g);
    }
    return g;
  };

  const edges: Edge[] = [];
  const newEdge = (kind: 'main' | 'ramp', line: LineId | null, from: number, to: number, chain: DWay[], pts: V2[], srcWay: number[], ds: number): Edge => {
    const n = pts.length;
    const e: Edge = {
      id: edges.length,
      kind,
      line,
      fromNode: from,
      toNode: to,
      chain,
      pts,
      ds,
      length: ds * (n - 1),
      srcWay,
      lanes: new Array(n).fill(0),
      laneWidth: kind === 'main' ? LANE_WIDTH_MAIN : LANE_WIDTH_RAMP,
      shoulder: kind === 'main' ? SHOULDER_MAIN : SHOULDER_RAMP,
      bl: new Array(n).fill(0),
      br: new Array(n).fill(0),
      ol: new Array(n).fill(-1),
      or: new Array(n).fill(-1),
      yTarget: new Array(n).fill(0),
      yWeight: new Array(n).fill(1),
      y: new Array(n).fill(0),
      layer: new Array(n).fill(0),
      struct: new Array(n).fill(0),
      noiseL: new Array(n).fill(0),
      noiseR: new Array(n).fill(0),
      speed: new Array(n).fill(60),
      names: new Array(n).fill(''),
      coupleEdge: new Array(n).fill(-1),
      coupleIdx: new Array(n).fill(-1),
      lineS0: null,
      taperStart: 0,
      taperEnd: 0,
    };
    edges.push(e);
    getNode(from).out.push(e.id);
    getNode(to).in.push(e.id);
    return e;
  };

  // ---- 4. main loops: dense resample + smoothing + A/B separation, then split at junctions
  const dense = {} as Record<LineId, { pts: V2[]; rawCum: number[]; layer: number[] }>;
  for (const id of ['A', 'B'] as LineId[]) {
    const L = loops[id];
    const rawCum = cumulativeLengths(L.pts, true);
    const rs = resampleUniform(L.pts, 1.0, true);
    let ri = 0;
    const layer = rs.s.map((s) => {
      while (ri + 1 < L.nodes.length && rawCum[ri + 1] <= s) ri++;
      const w = L.seq[L.way[ri]].way;
      return w.tags.bridge && w.tags.bridge !== 'no' ? Math.round(numTag(w.tags, 'layer') ?? 1) : 0;
    });
    dense[id] = { pts: gaussianSmooth(rs.pts, 7, true), rawCum, layer };
  }
  separateParallelLines(dense.A.pts, dense.B.pts, dense.A.layer, dense.B.layer);

  const lines = {} as Network['lines'];
  for (const id of ['A', 'B'] as LineId[]) {
    const L = loops[id];
    const D = dense[id];
    const total = D.rawCum[D.rawCum.length - 1];
    const smoothCum = cumulativeLengths(D.pts, true);
    const smoothTotal = smoothCum[smoothCum.length - 1];
    const scale = smoothTotal / total;
    const split: number[] = [];
    L.nodes.forEach((n, i) => {
      if (i === 0 || isJunction(n)) split.push(i);
    });
    const edgeIds: number[] = [];
    for (let k = 0; k < split.length; k++) {
      const i0 = split[k];
      const i1 = k + 1 < split.length ? split[k + 1] : L.nodes.length;
      const s0 = D.rawCum[i0] * scale;
      const s1 = D.rawCum[i1] * scale;
      const len = s1 - s0;
      const n = Math.max(1, Math.round(len / SAMPLE_SPACING));
      const ds = len / n;
      const chainIdx: number[] = [];
      for (let i = i0; i < i1; i++) if (!chainIdx.includes(L.way[i])) chainIdx.push(L.way[i]);
      const pts: V2[] = [];
      const srcWay: number[] = [];
      let ni = i0;
      for (let j = 0; j <= n; j++) {
        const s = s0 + j * ds;
        pts.push(pointAt(D.pts, smoothCum, s, true));
        const sRaw = s / scale;
        while (ni + 1 < i1 && D.rawCum[ni + 1] <= sRaw) ni++;
        srcWay.push(chainIdx.indexOf(L.way[ni % L.nodes.length]));
      }
      const e = newEdge(
        'main',
        id,
        L.nodes[i0],
        L.nodes[i1 % L.nodes.length],
        chainIdx.map((w) => L.seq[w]),
        pts,
        srcWay,
        ds,
      );
      e.lineS0 = s0;
      edgeIds.push(e.id);
    }
    lines[id] = { edges: edgeIds, length: smoothTotal };
  }

  // ---- 5. ramp chains between junctions
  const visited = new Set<string>();
  const mainEnd = (osmNode: number): V2 | null => {
    for (const e of edges) {
      if (e.kind !== 'main') continue;
      if (e.fromNode === osmNode) return e.pts[0];
      if (e.toNode === osmNode) return e.pts[e.pts.length - 1];
    }
    return null;
  };
  const segKey = (s: Seg) => `${s.a}>${s.b}:${s.d.way.id}`;
  const startSegs: Seg[] = [];
  for (const segs of segOut.values()) {
    for (const s of segs) if (!loopWayIds.has(s.d.way.id) && isJunction(s.a)) startSegs.push(s);
  }
  for (const s0 of startSegs) {
    if (visited.has(segKey(s0))) continue;
    const segs: Seg[] = [s0];
    visited.add(segKey(s0));
    let cur = s0;
    for (let guard = 0; guard < 5000; guard++) {
      if (isJunction(cur.b)) break;
      const nxt = segOut.get(cur.b)![0];
      if (loopWayIds.has(nxt.d.way.id) || visited.has(segKey(nxt))) break;
      segs.push(nxt);
      visited.add(segKey(nxt));
      cur = nxt;
    }
    const chain: DWay[] = [];
    const raw: V2[] = [nodePos.get(segs[0].a)!];
    const rawWay: number[] = [];
    for (const s of segs) {
      if (chain[chain.length - 1] !== s.d) chain.push(s.d);
      rawWay.push(chain.length - 1);
      raw.push(nodePos.get(s.b)!);
    }
    rawWay.push(chain.length - 1);
    const fromN = segs[0].a;
    const toN = segs[segs.length - 1].b;
    const rs = resampleUniform(raw, 1.0, false);
    const total = rs.s[rs.s.length - 1];
    const a = mainEnd(fromN);
    const b = mainEnd(toN);
    let pts = rs.pts;
    if (a || b) {
      const da: V2 = a ? [a[0] - pts[0][0], a[1] - pts[0][1]] : [0, 0];
      const db: V2 = b ? [b[0] - pts[pts.length - 1][0], b[1] - pts[pts.length - 1][1]] : [0, 0];
      const blend = Math.min(40, total * 0.5);
      pts = pts.map((p, i) => {
        const wa = 1 - smoothstep(0, blend, rs.s[i]);
        const wb = 1 - smoothstep(0, blend, total - rs.s[i]);
        return [p[0] + da[0] * wa + db[0] * wb, p[1] + da[1] * wa + db[1] * wb] as V2;
      });
    }
    const fin = resampleUniform(gaussianSmooth(pts, 5, false), SAMPLE_SPACING, false);
    const rawCum = cumulativeLengths(raw);
    const rawTotal = rawCum[rawCum.length - 1];
    const finTotal = fin.s[fin.s.length - 1];
    let ri = 0;
    const srcWay = fin.s.map((s) => {
      const sRaw = (s / finTotal) * rawTotal;
      while (ri + 1 < rawCum.length - 1 && rawCum[ri + 1] <= sRaw) ri++;
      return rawWay[Math.min(ri, rawWay.length - 1)];
    });
    newEdge('ramp', null, fromN, toN, chain, fin.pts, srcWay, fin.ds);
  }

  const net: Network = { edges, nodes, lines, ways, attachments: [] };
  assignAttributes(net);
  attachRamps(net);
  computeBounds(net);
  for (let pass = 0; pass < 3; pass++) {
    if (!separateOverlappingRamps(net)) break;
    computeBounds(net);
  }
  return net;
}

const halfDeck = (e: Edge, i: number) => Math.max(-e.bl[i], e.br[i]) + 0.5;

function sharesNodeNear(a: Edge, ia: number, b: Edge, ib: number, dist: number) {
  for (const n of [a.fromNode, a.toNode]) {
    if (n !== b.fromNode && n !== b.toNode) continue;
    const da = n === a.fromNode ? ia * a.ds : (a.pts.length - 1 - ia) * a.ds;
    const db = n === b.fromNode ? ib * b.ds : (b.pts.length - 1 - ib) * b.ds;
    if (da < dist && db < dist) return true;
  }
  return false;
}

/**
 * Side-by-side decks on the same level that OSM draws slightly too close are
 * pushed apart horizontally (ramps only; samples attached to their through
 * road are kept in place). Returns true if anything moved.
 */
function separateOverlappingRamps(net: Network): boolean {
  const cell = 12;
  const grid = new Map<string, [Edge, number][]>();
  for (const e of net.edges)
    e.pts.forEach((p, i) => {
      const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push([e, i]);
    });
  let moved = false;
  for (const r of net.edges) {
    if (r.kind !== 'ramp') continue;
    const push: V2[] = r.pts.map(() => [0, 0]);
    let any = false;
    for (let i = 0; i < r.pts.length; i++) {
      if (r.coupleEdge[i] >= 0 || r.ol[i] >= 0 || r.or[i] >= 0) continue;
      const p = r.pts[i];
      const cx = Math.floor(p[0] / cell);
      const cz = Math.floor(p[1] / cell);
      let best: V2 = [0, 0];
      let bestAmt = 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          for (const [q, j] of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
            if (q === r || q.layer[j] !== r.layer[i]) continue;
            if (sharesNodeNear(r, i, q, j, 100)) continue;
            const qp = q.pts[j];
            const d = Math.hypot(p[0] - qp[0], p[1] - qp[1]);
            const hr = halfDeck(r, i);
            const hq = halfDeck(q, j);
            const need = hr + hq - 0.3;
            if (d >= need || d < 0.35 * Math.min(hr, hq)) continue;
            const share = q.kind === 'ramp' && q.coupleEdge[j] < 0 ? 0.5 : 1;
            const amt = (need - d) * share;
            if (amt > bestAmt) {
              bestAmt = amt;
              best = [((p[0] - qp[0]) / d) * amt, ((p[1] - qp[1]) / d) * amt];
            }
          }
      if (bestAmt > 0.05) {
        push[i] = best;
        any = true;
      }
    }
    if (!any) continue;
    // widen and smooth the push profile, taper it to zero next to attached samples
    const sm = gaussianSmooth(push, 6, false);
    const peak = (P: V2[]) => P.reduce((m, v) => Math.max(m, Math.hypot(v[0], v[1])), 0);
    const f = Math.min(peak(sm) > 1e-6 ? peak(push) / peak(sm) : 1, 2.5);
    const n = r.pts.length;
    const distFixed = new Array(n).fill(1e9);
    for (let i = 0; i < n; i++) if (r.coupleEdge[i] >= 0 || r.ol[i] >= 0 || r.or[i] >= 0) distFixed[i] = 0;
    for (let i = 1; i < n; i++) distFixed[i] = Math.min(distFixed[i], distFixed[i - 1] + 1);
    for (let i = n - 2; i >= 0; i--) distFixed[i] = Math.min(distFixed[i], distFixed[i + 1] + 1);
    for (let i = 0; i < n; i++) {
      const w = smoothstep(0, 12, distFixed[i]) * f;
      if (w <= 0) continue;
      r.pts[i] = [r.pts[i][0] + sm[i][0] * w, r.pts[i][1] + sm[i][1] * w];
    }
    moved = true;
  }
  return moved;
}

/**
 * Pushes apart the two carriageways where OSM draws them closer than their
 * deck widths allow (but not where they are stacked / crossing).
 */
function separateParallelLines(A: V2[], B: V2[], layerA: number[], layerB: number[]) {
  const need = 2 * (1.5 * LANE_WIDTH_MAIN + SHOULDER_MAIN + 0.5) + 0.3;
  const cell = 20;
  const grid = new Map<string, number[]>();
  B.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  });
  const pushA: V2[] = A.map(() => [0, 0]);
  const pushB: V2[] = B.map(() => [0, 0]);
  A.forEach((p, i) => {
    const cx = Math.floor(p[0] / cell);
    const cz = Math.floor(p[1] / cell);
    let best = -1;
    let bd = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const j of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const d = dist2(p, B[j]);
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
    if (best < 0 || bd >= need) return;
    // stacked decks (different layers, centrelines within the other deck) are left alone
    const sameLayer = layerA[i] === layerB[best];
    if (bd < 4.5 || (!sameLayer && bd < 9)) return;
    const q = B[best];
    const ux = (p[0] - q[0]) / bd;
    const uz = (p[1] - q[1]) / bd;
    const amt = (need - bd) / 2;
    pushA[i] = [ux * amt, uz * amt];
    pushB[best] = [-ux * amt, -uz * amt];
  });
  const sa = gaussianSmooth(pushA, 12, true);
  const sb = gaussianSmooth(pushB, 12, true);
  A.forEach((p, i) => {
    p[0] += sa[i][0] * 1.4;
    p[1] += sa[i][1] * 1.4;
  });
  B.forEach((p, i) => {
    p[0] += sb[i][0] * 1.4;
    p[1] += sb[i][1] * 1.4;
  });
}

/* ------------------------------------------------------------------ */

function wayLanes(w: Way, kind: 'main' | 'ramp'): number {
  const l = numTag(w.tags, 'lanes');
  if (l != null && l > 0 && l < 7) return l;
  if (kind === 'main') return 3;
  if (!w.isLink && w.name) return 2;
  return 1;
}

/** Lane counts, elevation targets, structure, speed limits from OSM tags. */
function assignAttributes(net: Network) {
  for (const e of net.edges) {
    const n = e.pts.length;
    const target: number[] = [];
    for (let i = 0; i < n; i++) {
      const w = e.chain[clamp(e.srcWay[i], 0, e.chain.length - 1)].way;
      const bridge = !!w.tags.bridge && w.tags.bridge !== 'no';
      const layer = bridge ? clamp(Math.round(numTag(w.tags, 'layer') ?? 1), 1, 4) : 0;
      e.layer[i] = layer;
      e.yTarget[i] = LAYER_HEIGHT[layer];
      e.yWeight[i] = bridge ? 0.5 : 1.0;
      e.struct[i] = bridge ? 1 : 0;
      target.push(wayLanes(w, e.kind));
      const ms = numTag(w.tags, 'maxspeed');
      e.speed[i] = ms && ms >= 20 && ms <= 100 ? ms : e.kind === 'main' ? 60 : 40;
      e.names[i] = w.name && !RING_NAMES.has(w.name) ? w.name : '';
    }
    const maxStep = e.ds / 90;
    const fwd = target.slice();
    for (let i = 1; i < n; i++) fwd[i] = clamp(fwd[i], fwd[i - 1] - maxStep, fwd[i - 1] + maxStep);
    const bwd = target.slice();
    for (let i = n - 2; i >= 0; i--) bwd[i] = clamp(bwd[i], bwd[i + 1] - maxStep, bwd[i + 1] + maxStep);
    for (let i = 0; i < n; i++) e.lanes[i] = (fwd[i] + bwd[i]) / 2;
  }
}

/* ---------------- tracks: polylines spanning several edges ---------------- */

export interface Track {
  pts: V2[];
  ref: { e: Edge; i: number }[];
}

export function nextThrough(net: Network, e: Edge): Edge | null {
  const outs = net.nodes.get(e.toNode)!.out.map((id) => net.edges[id]);
  if (e.kind === 'main') return outs.find((o) => o.kind === 'main' && o.line === e.line) ?? null;
  return outs.length === 1 ? outs[0] : null;
}
export function prevThrough(net: Network, e: Edge): Edge | null {
  const ins = net.nodes.get(e.fromNode)!.in.map((id) => net.edges[id]);
  if (e.kind === 'main') return ins.find((o) => o.kind === 'main' && o.line === e.line) ?? null;
  return ins.length === 1 ? ins[0] : null;
}

/**
 * Builds a local track along `T` starting at its junction end: for diverges
 * from T's start forward, for merges ending at T's end (travel order).
 */
export function localTrack(net: Network, T: Edge, diverge: boolean, maxLen = 520): Track {
  const chunks: Edge[] = [];
  let len = 0;
  let e: Edge | null = T;
  while (e && len < maxLen && !chunks.includes(e)) {
    if (diverge) chunks.push(e);
    else chunks.unshift(e);
    len += e.length;
    e = diverge ? nextThrough(net, e) : prevThrough(net, e);
  }
  const pts: V2[] = [];
  const ref: Track['ref'] = [];
  for (const c of chunks) {
    const start = pts.length ? 1 : 0;
    for (let i = start; i < c.pts.length; i++) {
      pts.push(c.pts[i]);
      ref.push({ e: c, i });
    }
  }
  return { pts, ref };
}

function projectOnTrack(tr: Track, q: V2, hint: number, window = 40) {
  const i0 = hint < 0 ? 0 : Math.max(0, hint - window);
  const i1 = hint < 0 ? tr.pts.length - 1 : Math.min(tr.pts.length - 1, hint + window);
  const r = nearestOnPolyline(tr.pts, q, i0, i1);
  const k = clamp(Math.round(r.i + r.t), 0, tr.ref.length - 1);
  return { ...r, k, ref: tr.ref[k] };
}

function trackNormal(tr: Track, k: number): V2 {
  const a = tr.pts[Math.max(0, k - 1)];
  const b = tr.pts[Math.min(tr.pts.length - 1, k + 1)];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return [-dz / l, dx / l];
}

/* ---------------- ramp attachment ---------------- */

function attachRamps(net: Network) {
  const E = net.edges;
  const atts: Attachment[] = [];
  const headingOf = (e: Edge, atStart: boolean) =>
    atStart
      ? heading(e.pts[0], e.pts[Math.min(4, e.pts.length - 1)])
      : heading(e.pts[Math.max(0, e.pts.length - 5)], e.pts[e.pts.length - 1]);

  for (const node of net.nodes.values()) {
    for (const diverge of [true, false]) {
      const group = (diverge ? node.out : node.in).map((id) => E[id]);
      if (group.length < 2) continue;
      const parent = (diverge ? node.in : node.out).map((id) => E[id])[0];
      const parentLanes = parent ? (diverge ? parent.lanes[parent.lanes.length - 1] : parent.lanes[0]) : 1;
      const parentHeading = parent ? headingOf(parent, !diverge) : headingOf(group[0], diverge);
      const lanesAtJ = (e: Edge) => (diverge ? e.lanes[0] : e.lanes[e.lanes.length - 1]);
      const sorted = group.slice().sort((a, b) => {
        const am = a.kind === 'main' && parent && a.line === parent.line ? 1 : 0;
        const bm = b.kind === 'main' && parent && b.line === parent.line ? 1 : 0;
        if (am !== bm) return bm - am;
        const ma = a.kind === 'main' ? 1 : 0;
        const mb = b.kind === 'main' ? 1 : 0;
        if (ma !== mb) return mb - ma;
        if (lanesAtJ(a) !== lanesAtJ(b)) return lanesAtJ(b) - lanesAtJ(a);
        return Math.abs(wrapAngle(headingOf(a, diverge) - parentHeading)) - Math.abs(wrapAngle(headingOf(b, diverge) - parentHeading));
      });
      const through = sorted[0];
      const sumLanes = group.reduce((s, e) => s + lanesAtJ(e), 0);
      const split = through.kind !== 'main' && sumLanes <= parentLanes + 0.5;
      for (const br of sorted.slice(1)) {
        const side = sideOf(localTrack(net, through, diverge), br, diverge);
        if (split) {
          const wl = lanesAtJ(br) * br.laneWidth;
          const wt = lanesAtJ(through) * through.laneWidth;
          atts.push({ through, branch: br, diverge, side, mode: 'split', wBranch: wt / (wl + wt), wThrough: wl / (wl + wt) });
        } else {
          atts.push({ through, branch: br, diverge, side, mode: 'branch', wBranch: 1, wThrough: 0 });
          const taper = diverge ? TAPER_DIVERGE : TAPER_MERGE;
          const n = br.lanes.length;
          for (let i = 0; i < n; i++) {
            const u = diverge ? i * br.ds : (n - 1 - i) * br.ds;
            br.lanes[i] *= smoothstep(0, taper, u) * 0.999 + 0.001;
          }
          if (diverge) br.taperStart = taper;
          else br.taperEnd = taper;
        }
      }
    }
  }
  atts.sort((a, b) => (a.through.kind === 'main' ? 0 : 1) - (b.through.kind === 'main' ? 0 : 1));
  for (const at of atts) applyAttachment(net, at);
  net.attachments = atts;
}

function sideOf(tr: Track, br: Edge, diverge: boolean): number {
  const n = br.pts.length;
  let hint = diverge ? 0 : tr.pts.length - 1;
  for (let k = 0; k < n; k++) {
    if (k * br.ds > 400) break;
    const i = diverge ? k : n - 1 - k;
    const pr = projectOnTrack(tr, br.pts[i], hint);
    hint = pr.i;
    if (Math.abs(pr.lateral) > 8 && pr.i > 0 && pr.i < tr.pts.length - 2) return Math.sign(pr.lateral);
  }
  const hb = diverge ? heading(br.pts[0], br.pts[Math.min(8, n - 1)]) : heading(br.pts[Math.max(0, n - 9)], br.pts[n - 1]);
  const m = tr.pts.length;
  const ht = diverge ? heading(tr.pts[0], tr.pts[Math.min(8, m - 1)]) : heading(tr.pts[Math.max(0, m - 9)], tr.pts[m - 1]);
  const d = wrapAngle(hb - ht);
  return diverge ? (d >= 0 ? 1 : -1) : d >= 0 ? -1 : 1;
}

function applyAttachment(net: Network, at: Attachment) {
  const { through: T, branch: B, diverge, side } = at;
  const tr = localTrack(net, T, diverge);
  const n = B.pts.length;
  let hint = diverge ? 0 : tr.pts.length - 1;
  let separated = 0;
  const corrB: (V2 | undefined)[] = [];
  const corrT = new Map<Edge, Map<number, V2>>();
  for (let k = 0; k < n; k++) {
    const u = k * B.ds;
    if (u > 320) break;
    const i = diverge ? k : n - 1 - k;
    const pr = projectOnTrack(tr, B.pts[i], hint);
    hint = pr.i;
    const { e: te, i: ti } = pr.ref;
    const halfT = (te.lanes[ti] * te.laneWidth) / 2;
    const halfB = (B.lanes[i] * B.laneWidth) / 2;
    const need = halfT + halfB;
    const sep = side * pr.lateral;
    const extra = smax(sep, need, 2.5) - sep;
    const nrm = trackNormal(tr, pr.k);
    corrB[i] = [nrm[0] * side * extra * at.wBranch, nrm[1] * side * extra * at.wBranch];
    if (at.wThrough > 0) {
      let m = corrT.get(te);
      if (!m) corrT.set(te, (m = new Map()));
      m.set(ti, [-nrm[0] * side * extra * at.wThrough, -nrm[1] * side * extra * at.wThrough]);
    }
    if (sep > need + GORE_NOSE_GAP + 12 && ++separated > 4) break;
  }
  for (let i = 0; i < n; i++) {
    const c = corrB[i];
    if (c) B.pts[i] = [B.pts[i][0] + c[0], B.pts[i][1] + c[1]];
  }
  for (const [te, m] of corrT) for (const [i, c] of m) te.pts[i] = [te.pts[i][0] + c[0], te.pts[i][1] + c[1]];
}

/** Drivable bounds, open sides (gore zones) and elevation couplings. */
export function computeBounds(net: Network) {
  const touchedL = new Map<Edge, Set<number>>();
  const touchedR = new Map<Edge, Set<number>>();
  const mark = (m: Map<Edge, Set<number>>, e: Edge, i: number) => {
    let s = m.get(e);
    if (!s) m.set(e, (s = new Set()));
    const first = !s.has(i);
    s.add(i);
    return first;
  };
  for (const e of net.edges) {
    for (let i = 0; i < e.pts.length; i++) {
      const half = (e.lanes[i] * e.laneWidth) / 2;
      e.bl[i] = -half - e.shoulder;
      e.br[i] = half + e.shoulder;
      e.ol[i] = -1;
      e.or[i] = -1;
      e.coupleEdge[i] = -1;
      e.coupleIdx[i] = -1;
    }
  }
  for (const at of net.attachments) {
    const { through: T, branch: B, diverge, side } = at;
    const tr = localTrack(net, T, diverge);
    const n = B.pts.length;
    let hint = diverge ? 0 : tr.pts.length - 1;
    // open zone and elevation coupling are contiguous from the junction
    let open = true;
    let coupling = true;
    let afterNose = 0;
    const maxOpen = at.mode === 'split' || T.kind !== 'main' ? 150 : 420;
    for (let k = 0; k < n; k++) {
      if (k * B.ds > 420 || (!open && !coupling)) break;
      const i = diverge ? k : n - 1 - k;
      const pr = projectOnTrack(tr, B.pts[i], hint);
      hint = pr.i;
      const { e: te, i: ti } = pr.ref;
      const halfT = (te.lanes[ti] * te.laneWidth) / 2;
      const halfB = (B.lanes[i] * B.laneWidth) / 2;
      const gap = k * B.ds > maxOpen ? Infinity : side * pr.lateral - halfT - halfB;
      if (coupling) {
        if (gap >= GORE_NOSE_GAP) afterNose++;
        // do not override a coupling owned by another attachment
        if (afterNose > 4 || (B.coupleEdge[i] >= 0 && B.coupleEdge[i] !== te.id)) coupling = false;
        else {
          B.coupleEdge[i] = te.id;
          B.coupleIdx[i] = ti;
        }
      }
      if (open && gap < GORE_NOSE_GAP) {
        const mid = Math.max(gap, 0) / 2;
        if (side > 0) {
          B.bl[i] = -halfB - mid;
          B.ol[i] = te.id;
        } else {
          B.br[i] = halfB + mid;
          B.or[i] = te.id;
        }
      } else open = false;
    }
    // through side: walk the track from the junction outward
    hint = diverge ? 0 : n - 1;
    let closedRun = 0;
    let walked = 0;
    for (let kk = 0; kk < tr.ref.length; kk++) {
      const k = diverge ? kk : tr.ref.length - 1 - kk;
      const { e: te, i: ti } = tr.ref[k];
      walked += te.ds;
      if (walked > maxOpen) break;
      const r = nearestOnPolyline(B.pts, tr.pts[k], Math.max(0, hint - 40), Math.min(n - 1, hint + 40));
      hint = r.i;
      const idx = r.i + r.t;
      if ((diverge && idx <= 0.01 && walked > 8) || (!diverge && idx >= n - 1.01 && walked > 8)) {
        if (++closedRun > 3) break;
        continue;
      }
      const bi = clamp(Math.round(idx), 0, n - 1);
      const halfT = (te.lanes[ti] * te.laneWidth) / 2;
      const halfB = (B.lanes[bi] * B.laneWidth) / 2;
      const gap = side * -r.lateral - halfT - halfB;
      if (gap < GORE_NOSE_GAP && B.lanes[bi] > 0.01) {
        closedRun = 0;
        const mid = Math.max(gap, 0) / 2;
        if (side > 0) {
          const first = mark(touchedR, te, ti);
          te.br[ti] = first ? halfT + mid : Math.max(te.br[ti], halfT + mid);
          te.or[ti] = B.id;
        } else {
          const first = mark(touchedL, te, ti);
          te.bl[ti] = first ? -halfT - mid : Math.min(te.bl[ti], -halfT - mid);
          te.ol[ti] = B.id;
        }
      } else if (walked > 8 && ++closedRun > 3) break;
    }
  }
}


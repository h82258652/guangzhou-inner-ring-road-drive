/**
 * Elevation solver: turns OSM layer tags into a smooth, drivable vertical
 * profile. Works on continuous "profiles" (each main line as one closed loop,
 * each ramp as an open polyline). Constraints: max grade, continuity at
 * ramp junctions, equal heights for adjacent (coupled) decks, vertical
 * clearance where decks overlap (double-deck sections and crossings), and
 * ground anchoring of ramp terminals.
 */
import type { Edge, Network } from './network';
import { clamp } from '../../src/shared/math';

export const GRADE_MAIN = 0.05;
export const GRADE_RAMP = 0.08;
/** deck-to-deck vertical separation (structure depth + clearance) */
export const CLEARANCE = 7.0;
const ITERATIONS = 500;
const BUMP_SIGMA = 14;
const MAX_HEIGHT = 30;

interface Profile {
  closed: boolean;
  ds: number;
  grade: number;
  /** edge refs per sample */
  refs: { e: Edge; i: number }[];
  y: Float64Array;
  target: Float64Array;
  weight: Float64Array;
  fixed: Uint8Array;
}

interface Pair {
  pa: Profile;
  ka: number;
  pb: Profile;
  kb: number;
  aUp: boolean;
}

function halfWidth(e: Edge, i: number) {
  return Math.max(-e.bl[i], e.br[i]) + 0.5;
}

function distToNode(e: Edge, i: number, node: number) {
  let d = Infinity;
  if (e.fromNode === node) d = Math.min(d, i * e.ds);
  if (e.toNode === node) d = Math.min(d, (e.pts.length - 1 - i) * e.ds);
  return d;
}

function buildProfiles(net: Network) {
  const profiles: Profile[] = [];
  const where = new Map<Edge, { p: Profile; k0: number }>();
  const mk = (refs: Profile['refs'], closed: boolean, grade: number, ds: number): Profile => {
    const n = refs.length;
    const p: Profile = {
      closed,
      ds,
      grade,
      refs,
      y: new Float64Array(n),
      target: new Float64Array(n),
      weight: new Float64Array(n),
      fixed: new Uint8Array(n),
    };
    refs.forEach(({ e, i }, k) => {
      p.target[k] = e.yTarget[i];
      p.weight[k] = e.yWeight[i];
      p.y[k] = e.yTarget[i];
    });
    profiles.push(p);
    return p;
  };
  for (const line of ['A', 'B'] as const) {
    const refs: Profile['refs'] = [];
    const starts: [Edge, number][] = [];
    for (const id of net.lines[line].edges) {
      const e = net.edges[id];
      starts.push([e, refs.length]);
      for (let i = 0; i < e.pts.length - 1; i++) refs.push({ e, i });
    }
    const ds = net.lines[line].length / refs.length;
    const p = mk(refs, true, GRADE_MAIN, ds);
    for (const [e, k0] of starts) where.set(e, { p, k0 });
  }
  for (const e of net.edges) {
    if (e.kind !== 'ramp') continue;
    const refs = e.pts.map((_, i) => ({ e, i }));
    const p = mk(refs, false, GRADE_RAMP, e.ds);
    where.set(e, { p, k0: 0 });
  }
  /** profile + index for an edge sample (last sample of a main edge maps to the next edge's first) */
  const locate = (e: Edge, i: number): { p: Profile; k: number } => {
    const w = where.get(e)!;
    let k = w.k0 + i;
    if (w.p.closed) k %= w.p.refs.length;
    return { p: w.p, k };
  };
  return { profiles, locate };
}

export function solveElevation(net: Network): { violations: number; maxGrade: number } {
  const { profiles, locate } = buildProfiles(net);

  // couplings (ramp sample -> main/through sample)
  const couplings: { p: Profile; k: number; q: Profile; m: number }[] = [];
  for (const e of net.edges) {
    for (let i = 0; i < e.pts.length; i++) {
      const c = e.coupleEdge[i];
      if (c < 0) continue;
      const a = locate(e, i);
      const b = locate(net.edges[c], e.coupleIdx[i]);
      couplings.push({ p: a.p, k: a.k, q: b.p, m: b.k });
      a.p.fixed[a.k] = 1;
    }
  }

  // ramp endpoints at junctions (not coupled): continuity groups
  const groups: { p: Profile; k: number }[][] = [];
  for (const node of net.nodes.values()) {
    const ends: { p: Profile; k: number }[] = [];
    for (const id of node.in) {
      const e = net.edges[id];
      if (e.kind === 'ramp' && e.coupleEdge[e.pts.length - 1] < 0) ends.push(locate(e, e.pts.length - 1));
    }
    for (const id of node.out) {
      const e = net.edges[id];
      if (e.kind === 'ramp' && e.coupleEdge[0] < 0) ends.push(locate(e, 0));
    }
    for (const id of [...node.in, ...node.out]) {
      const e = net.edges[id];
      if (e.kind === 'main') {
        ends.push(locate(e, e.fromNode === node.id ? 0 : e.pts.length - 1));
        break;
      }
    }
    if (ends.length > 1) groups.push(ends);
  }

  // terminal anchors (ramps that end/start at ground-level streets)
  const anchors: { p: Profile; k: number }[] = [];
  for (const node of net.nodes.values()) {
    if (node.in.length === 0) for (const id of node.out) if (net.edges[id].layer[0] === 0) anchors.push(locate(net.edges[id], 0));
    if (node.out.length === 0)
      for (const id of node.in) {
        const e = net.edges[id];
        if (e.layer[e.pts.length - 1] === 0) anchors.push(locate(e, e.pts.length - 1));
      }
  }

  // overlap pairs (computed on the final horizontal geometry)
  const pairs: Pair[] = [];
  const votes = new Map<string, number>();
  const rawPairs: { a: Edge; ia: number; b: Edge; ib: number }[] = [];
  {
    const cell = 12;
    const grid = new Map<string, [Edge, number][]>();
    for (const e of net.edges)
      e.pts.forEach((p, i) => {
        const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push([e, i]);
      });
    const seen = new Set<string>();
    for (const a of net.edges) {
      for (let ia = 0; ia < a.pts.length; ia++) {
        const p = a.pts[ia];
        const cx = Math.floor(p[0] / cell);
        const cz = Math.floor(p[1] / cell);
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++)
            for (const [b, ib] of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
              if (b.id <= a.id) continue;
              if (a.kind === 'main' && b.kind === 'main' && a.line === b.line) continue;
              const q = b.pts[ib];
              const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
              const ha = halfWidth(a, ia);
              const hb = halfWidth(b, ib);
              if (d >= ha + hb - 0.8) continue;
              // side-by-side decks on the same level that only touch: not a stacking constraint
              if (a.layer[ia] === b.layer[ib] && d > 0.6 * Math.min(ha, hb)) continue;
              if (a.coupleEdge[ia] === b.id || b.coupleEdge[ib] === a.id) continue;
              if (a.ol[ia] === b.id || a.or[ia] === b.id || b.ol[ib] === a.id || b.or[ib] === a.id) continue;
              let near = false;
              for (const n of [a.fromNode, a.toNode])
                if ((n === b.fromNode || n === b.toNode) && distToNode(a, ia, n) < 100 && distToNode(b, ib, n) < 100) near = true;
              if (near) continue;
              const key = `${a.id}:${ia}:${b.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              rawPairs.push({ a, ia, b, ib });
              const vk = `${a.id}:${b.id}`;
              const la = a.layer[ia];
              const lb = b.layer[ib];
              votes.set(vk, (votes.get(vk) ?? 0) + Math.sign(la - lb) * 4 + Math.sign(a.yTarget[ia] - b.yTarget[ib]));
            }
      }
    }
  }
  for (const { a, ia, b, ib } of rawPairs) {
    const v = votes.get(`${a.id}:${b.id}`) ?? 0;
    const aUp = v !== 0 ? v > 0 : a.kind === 'main' && b.kind !== 'main' ? true : b.kind === 'main' && a.kind !== 'main' ? false : a.id < b.id;
    const A = locate(a, ia);
    const B = locate(b, ib);
    pairs.push({ pa: A.p, ka: A.k, pb: B.p, kb: B.k, aUp });
  }

  const idx = (p: Profile, k: number) => {
    const n = p.refs.length;
    if (p.closed) return ((k % n) + n) % n;
    return k < 0 || k >= n ? -1 : k;
  };
  const bump = (p: Profile, k: number, amount: number) => {
    const r = Math.ceil((BUMP_SIGMA * 2.5) / p.ds);
    for (let j = -r; j <= r; j++) {
      const kk = idx(p, k + j);
      if (kk < 0 || p.fixed[kk]) continue;
      const d = j * p.ds;
      p.y[kk] += amount * Math.exp(-(d * d) / (2 * BUMP_SIGMA * BUMP_SIGMA));
    }
  };

  const smooth = (attract: number) => {
    for (const p of profiles) {
      const n = p.refs.length;
      const y = p.y.slice();
      for (let k = 0; k < n; k++) {
        if (p.fixed[k]) continue;
        const a = idx(p, k - 1);
        const b = idx(p, k + 1);
        if (a < 0 || b < 0) continue;
        const lap = (y[a] + y[b]) / 2;
        p.y[k] = y[k] + 0.5 * (lap - y[k]) + attract * p.weight[k] * (p.target[k] - y[k]);
      }
    }
  };
  /** Symmetric relaxation of grade violations (no one-sided cascades). */
  const gradeClamp = (iters = 6) => {
    for (const p of profiles) {
      const g = p.grade * p.ds;
      const n = p.refs.length;
      const last = p.closed ? n : n - 1;
      for (let it = 0; it < iters; it++) {
        let worst = 0;
        for (let k = 0; k < last; k++) {
          const a = k;
          const b = (k + 1) % n;
          const d = p.y[b] - p.y[a];
          const ex = Math.abs(d) - g;
          if (ex <= 0) continue;
          worst = Math.max(worst, ex);
          const s = Math.sign(d);
          const fa = p.fixed[a];
          const fb = p.fixed[b];
          if (fa && fb) continue;
          if (fa) p.y[b] -= s * ex;
          else if (fb) p.y[a] += s * ex;
          else {
            p.y[b] -= (s * ex) / 2;
            p.y[a] += (s * ex) / 2;
          }
        }
        if (worst < 1e-4) break;
      }
    }
  };  const applyCouplings = () => {
    for (const c of couplings) c.p.y[c.k] = c.q.y[c.m];
  };
  const applyGroups = () => {
    for (const g of groups) {
      const avg = g.reduce((s, { p, k }) => s + p.y[k], 0) / g.length;
      for (const { p, k } of g) if (!p.fixed[k]) p.y[k] = avg;
    }
  };
  const clearance = (rate: number) => {
    for (const pr of pairs) {
      const [up, ku, lo, kl] = pr.aUp ? [pr.pa, pr.ka, pr.pb, pr.kb] : [pr.pb, pr.kb, pr.pa, pr.ka];
      const deficit = CLEARANCE - (up.y[ku] - lo.y[kl]);
      if (deficit <= 0) continue;
      const loGround = lo.target[kl] === 0 && lo.weight[kl] >= 1;
      const down = loGround ? 0 : Math.min(lo.y[kl], deficit * 0.5);
      bump(lo, kl, -down * rate);
      bump(up, ku, (deficit - down) * rate);
    }
  };

  for (let it = 0; it < ITERATIONS; it++) {
    const late = it > ITERATIONS * 0.75;
    smooth(late ? 0.005 : 0.03);
    applyGroups();
    applyCouplings();
    clearance(0.04);
    for (const a of anchors) if (!a.p.fixed[a.k]) a.p.y[a.k] = 0;
    gradeClamp();
    for (const p of profiles) for (let k = 0; k < p.y.length; k++) p.y[k] = clamp(p.y[k], 0, MAX_HEIGHT);
  }
  for (let it = 0; it < 30; it++) {
    applyGroups();
    applyCouplings();
    gradeClamp(60);
  }
  applyCouplings();

  for (const p of profiles) {
    p.refs.forEach(({ e, i }, k) => {
      e.y[i] = Math.max(0, p.y[k]);
    });
  }
  for (const line of ['A', 'B'] as const) {
    const ids = net.lines[line].edges;
    ids.forEach((id, j) => {
      const e = net.edges[id];
      const nx = net.edges[ids[(j + 1) % ids.length]];
      e.y[e.pts.length - 1] = nx.y[0];
    });
  }
  for (const e of net.edges) for (let i = 0; i < e.pts.length; i++) e.struct[i] = e.y[i] > 2.2 ? 1 : 0;

  let violations = 0;
  for (const pr of pairs) {
    const ya = pr.pa.y[pr.ka];
    const yb = pr.pb.y[pr.kb];
    if (Math.abs(ya - yb) < CLEARANCE - 0.6) violations++;
  }
  let maxGrade = 0;
  for (const p of profiles) {
    const n = p.refs.length;
    for (let k = 1; k < n + (p.closed ? 1 : 0); k++) maxGrade = Math.max(maxGrade, Math.abs(p.y[k % n] - p.y[k - 1]) / p.ds);
  }
  return { violations, maxGrade };
}



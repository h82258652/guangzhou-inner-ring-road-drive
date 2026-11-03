/** Speed limits, section names, exits/entrances, signs and speed cameras. */
import type { Edge, Network } from './network';
import { RING_NAMES } from './network';
import { loadCache, geomToXZ, type OsmWay } from './osm';
import { type V2, nearestOnPolyline } from '../../src/shared/polyline';
import type { CameraFile, EntranceFile, ExitFile, LineId, SignFile } from '../../src/shared/types';

/* ---------------- speed limits ---------------- */

function circumRadius(a: V2, b: V2, c: V2): number {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  if (area2 < 1e-6) return Infinity;
  return (ab * bc * ca) / (2 * area2);
}

export function computeSpeedLimits(net: Network) {
  for (const e of net.edges) {
    const n = e.pts.length;
    const k = Math.max(2, Math.round(20 / e.ds));
    const lim: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = e.pts[Math.max(0, i - k)];
      const b = e.pts[i];
      const c = e.pts[Math.min(n - 1, i + k)];
      const R = circumRadius(a, b, c);
      let v = e.speed[i];
      if (e.kind === 'main') {
        v = Math.min(v, 60);
        if (R < 110) v = Math.min(v, 40);
        if (R < 55) v = Math.min(v, 30);
      } else {
        v = Math.min(v, 40);
        if (R < 50) v = Math.min(v, 30);
      }
      lim.push(v);
    }
    // start reduced limits ~80 m before the curve, keep them ~30 m after
    const back = Math.round(80 / e.ds);
    const fwd = Math.round(30 / e.ds);
    const out = lim.slice();
    for (let i = 0; i < n; i++) {
      let m = lim[i];
      for (let j = Math.max(0, i - fwd); j <= Math.min(n - 1, i + back); j++) m = Math.min(m, lim[j]);
      out[i] = m;
    }
    // remove very short zones (< 60 m) of higher limits between lower ones
    e.speed = out;
  }
}

/* ---------------- ground roads (for section names & terminals) ---------------- */

export interface GroundRoad {
  id: number;
  name: string;
  highway: string;
  nodes: number[];
  pts: V2[];
}

export function loadGroundRoads(): GroundRoad[] {
  const out: GroundRoad[] = [];
  for (const e of loadCache('roads.json')) {
    if (e.type !== 'way') continue;
    const w = e as OsmWay;
    const pts = geomToXZ(w.geometry);
    if (pts.length < 2) continue;
    out.push({ id: w.id, name: w.tags?.name ?? '', highway: w.tags?.highway ?? '', nodes: w.nodes ?? [], pts });
  }
  return out;
}

function roadGrid(roads: GroundRoad[], cell = 50) {
  const grid = new Map<string, { r: GroundRoad; i: number }[]>();
  for (const r of roads) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      const minx = Math.floor(Math.min(a[0], b[0]) / cell);
      const maxx = Math.floor(Math.max(a[0], b[0]) / cell);
      const minz = Math.floor(Math.min(a[1], b[1]) / cell);
      const maxz = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let x = minx; x <= maxx; x++)
        for (let z = minz; z <= maxz; z++) {
          const k = `${x},${z}`;
          let arr = grid.get(k);
          if (!arr) grid.set(k, (arr = []));
          arr.push({ r, i });
        }
    }
  }
  return {
    near(p: V2, radius: number) {
      const res: { r: GroundRoad; i: number }[] = [];
      const c0x = Math.floor((p[0] - radius) / cell);
      const c1x = Math.floor((p[0] + radius) / cell);
      const c0z = Math.floor((p[1] - radius) / cell);
      const c1z = Math.floor((p[1] + radius) / cell);
      const seen = new Set<string>();
      for (let x = c0x; x <= c1x; x++)
        for (let z = c0z; z <= c1z; z++)
          for (const s of grid.get(`${x},${z}`) ?? []) {
            const k = `${s.r.id}:${s.i}`;
            if (seen.has(k)) continue;
            seen.add(k);
            res.push(s);
          }
      return res;
    },
  };
}

const MAJOR = new Set(['primary', 'secondary', 'tertiary', 'primary_link', 'secondary_link', 'trunk']);

/** HUD section names: the named surface street the viaduct follows (or bridge names). */
export function computeSectionNames(net: Network, roads: GroundRoad[]) {
  const named = roads.filter((r) => r.name && MAJOR.has(r.highway));
  const grid = roadGrid(named);
  for (const lineId of ['A', 'B'] as LineId[]) {
    const ids = net.lines[lineId].edges;
    const samples: { e: Edge; i: number; name: string }[] = [];
    for (const id of ids) {
      const e = net.edges[id];
      for (let i = 0; i < e.pts.length; i++) {
        let name = '';
        const own = e.names[i];
        if (own && (own.includes('桥') || own.includes('隧道'))) name = own;
        else if (i % 2 === 0) {
          const p = e.pts[i];
          const a = e.pts[Math.max(0, i - 2)];
          const b = e.pts[Math.min(e.pts.length - 1, i + 2)];
          const dx = b[0] - a[0];
          const dz = b[1] - a[1];
          const dl = Math.hypot(dx, dz) || 1;
          let best = 40;
          for (const { r, i: si } of grid.near(p, 40)) {
            const q0 = r.pts[si];
            const q1 = r.pts[si + 1];
            const res = nearestOnPolyline([q0, q1], p);
            if (res.dist >= best) continue;
            const ex = q1[0] - q0[0];
            const ez = q1[1] - q0[1];
            const el = Math.hypot(ex, ez) || 1;
            const cos = Math.abs((dx * ex + dz * ez) / (dl * el));
            if (cos < 0.85) continue;
            best = res.dist;
            name = r.name;
          }
        } else name = samples.length ? samples[samples.length - 1].name : '';
        samples.push({ e, i, name });
      }
    }
    // mode filter over ±150 m, then fill gaps from neighbours
    const n = samples.length;
    const W = 60;
    const filtered: string[] = new Array(n).fill('');
    for (let k = 0; k < n; k++) {
      const counts = new Map<string, number>();
      for (let j = -W; j <= W; j++) {
        const s = samples[(k + j + n) % n].name;
        if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      let bestName = '';
      let bestC = 0;
      for (const [s, c] of counts)
        if (c > bestC) {
          bestC = c;
          bestName = s;
        }
      filtered[k] = bestName;
    }
    for (let pass = 0; pass < 2; pass++)
      for (let k = 0; k < n; k++) if (!filtered[k]) filtered[k] = filtered[(k - 1 + n) % n];
    samples.forEach((s, k) => {
      s.e.names[s.i] = filtered[k] || '内环路';
    });
  }
  // ramps: keep OSM ramp name, otherwise generic
  for (const e of net.edges) {
    if (e.kind !== 'ramp') continue;
    for (let i = 0; i < e.pts.length; i++) {
      const nm = e.names[i];
      e.names[i] = nm && !RING_NAMES.has(nm) ? nm : '匝道';
    }
  }
}

/* ---------------- exits & entrances ---------------- */

interface ExitDetect {
  line: LineId;
  s: number;
  side: 'left' | 'right';
  edge: number;
  terminals: number[];
  terminalNames: string[];
  firstWay: number;
}

function terminalName(net: Network, nodeId: number, roads: GroundRoad[], byNode: Map<number, GroundRoad[]>, viaEdge: Edge): string {
  const direct = (byNode.get(nodeId) ?? []).filter((r) => r.name);
  if (direct.length) {
    direct.sort((a, b) => (MAJOR.has(b.highway) ? 1 : 0) - (MAJOR.has(a.highway) ? 1 : 0));
    return direct[0].name;
  }
  // last named way of the chain (e.g. a radial expressway)
  for (let k = viaEdge.chain.length - 1; k >= 0; k--) {
    const nm = viaEdge.chain[k].way.name;
    if (nm && !RING_NAMES.has(nm)) return nm;
  }
  const p = net.nodes.get(nodeId)!.p;
  let best = 60;
  let name = '';
  for (const r of roads) {
    if (!r.name) continue;
    const res = nearestOnPolyline(r.pts, p);
    if (res.dist < best) {
      best = res.dist;
      name = r.name;
    }
  }
  return name;
}

export function detectExitsEntrances(net: Network, roads: GroundRoad[]) {
  const byNode = new Map<number, GroundRoad[]>();
  for (const r of roads)
    for (const n of r.nodes) {
      let a = byNode.get(n);
      if (!a) byNode.set(n, (a = []));
      a.push(r);
    }
  const exits: ExitDetect[] = [];
  const entrances: EntranceFile[] = [];
  for (const att of net.attachments) {
    if (att.through.kind !== 'main' || att.branch.kind !== 'ramp') continue;
    const line = att.through.line!;
    if (att.diverge) {
      // BFS forward to terminals or other main lines
      const terms: number[] = [];
      const names: string[] = [];
      const queue: Edge[] = [att.branch];
      const seen = new Set<number>();
      while (queue.length) {
        const e = queue.shift()!;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const node = net.nodes.get(e.toNode)!;
        const outs = node.out.map((id) => net.edges[id]);
        const mains = outs.filter((o) => o.kind === 'main');
        if (mains.length) {
          for (const m of mains) names.push(`内环路${m.line}线`);
          continue;
        }
        if (!outs.length) {
          terms.push(node.id);
          names.push(terminalName(net, node.id, roads, byNode, e));
          continue;
        }
        queue.push(...outs);
      }
      exits.push({
        line,
        s: (att.through.lineS0 ?? 0) % net.lines[line].length,
        side: att.side > 0 ? 'right' : 'left',
        edge: att.branch.id,
        terminals: terms,
        terminalNames: [...new Set(names.filter(Boolean))],
        firstWay: att.branch.chain[0].way.id,
      });
    } else {
      const queue: Edge[] = [att.branch];
      const seen = new Set<number>();
      let start = att.branch.fromNode;
      let name = '';
      while (queue.length) {
        const e = queue.shift()!;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const node = net.nodes.get(e.fromNode)!;
        const ins = node.in.map((id) => net.edges[id]);
        if (ins.some((o) => o.kind === 'main')) {
          name = name || `内环路${ins.find((o) => o.kind === 'main')!.line}线`;
          continue;
        }
        if (!ins.length) {
          start = node.id;
          name = name || terminalName(net, node.id, roads, byNode, e);
          continue;
        }
        queue.push(...ins);
      }
      const T = att.through;
      entrances.push({
        line,
        s: ((T.lineS0 ?? 0) + T.length) % net.lines[line].length,
        side: att.side > 0 ? 'right' : 'left',
        edge: att.branch.id,
        startNode: start,
        name: name || '入口',
      });
    }
  }
  exits.sort((a, b) => (a.line === b.line ? a.s - b.s : a.line < b.line ? -1 : 1));
  entrances.sort((a, b) => (a.line === b.line ? a.s - b.s : a.line < b.line ? -1 : 1));
  return { exits, entrances };
}

/* ---------------- curated exit table ---------------- */

export interface CuratedExit {
  code: string;
  names: string[];
  namesEn: string[];
  /** keywords used for automatic matching against terminal street names */
  match: string[];
  /** numbered but not open to traffic (e.g. A5, reserved for the Ruyifang radial) */
  closed?: boolean;
  note?: string;
}

export function matchExits(detected: ExitDetect[], curated: Record<LineId, CuratedExit[]>): ExitFile[] {
  const out: ExitFile[] = [];
  for (const line of ['A', 'B'] as LineId[]) {
    const det = detected.filter((d) => d.line === line);
    const cur = curated[line].filter((c) => !c.closed);
    // dynamic programming alignment (ordered matching) maximising keyword hits
    const n = det.length;
    const m = cur.length;
    const score = (i: number, j: number) => {
      const names = det[i].terminalNames.join(' ');
      let s = 0;
      for (const kw of cur[j].match) if (names.includes(kw)) s += 3;
      return s;
    };
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    const choice: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) {
        const take = score(i, j) + 1 + dp[i + 1][j + 1];
        const skipDet = dp[i + 1][j];
        const skipCur = dp[i][j + 1];
        if (take >= skipDet && take >= skipCur) {
          dp[i][j] = take;
          choice[i][j] = 0;
        } else if (skipDet >= skipCur) {
          dp[i][j] = skipDet;
          choice[i][j] = 1;
        } else {
          dp[i][j] = skipCur;
          choice[i][j] = 2;
        }
      }
    let i = 0;
    let j = 0;
    const assigned = new Map<number, number>();
    while (i < n && j < m) {
      if (choice[i][j] === 0) {
        assigned.set(i, j);
        i++;
        j++;
      } else if (choice[i][j] === 1) i++;
      else j++;
    }
    det.forEach((d, k) => {
      const c = assigned.has(k) ? cur[assigned.get(k)!] : null;
      out.push({
        line,
        code: c ? c.code : '',
        s: d.s,
        side: d.side,
        edge: d.edge,
        names: c ? c.names : d.terminalNames.slice(0, 2),
        namesEn: c ? c.namesEn : [],
        terminals: d.terminals,
      });
    });
  }
  return out;
}

/* ---------------- signs & cameras ---------------- */

/** Finds the main edge + local s at a given arc length on a line. */
export function locateOnLine(net: Network, line: LineId, s: number): { edge: Edge; s: number } {
  const L = net.lines[line].length;
  s = ((s % L) + L) % L;
  for (const id of net.lines[line].edges) {
    const e = net.edges[id];
    const s0 = e.lineS0 ?? 0;
    if (s >= s0 && s <= s0 + e.length) return { edge: e, s: s - s0 };
  }
  const e = net.edges[net.lines[line].edges[0]];
  return { edge: e, s: 0 };
}

export function placeSigns(net: Network, exits: ExitFile[], entrances: EntranceFile[]) {
  const signs: SignFile[] = [];
  const cameras: CameraFile[] = [];
  for (const line of ['A', 'B'] as LineId[]) {
    const L = net.lines[line].length;
    const lineExits = exits.filter((x) => x.line === line);
    for (let k = 0; k < lineExits.length; k++) {
      const x = lineExits[k];
      const prev = lineExits[(k - 1 + lineExits.length) % lineExits.length];
      const gapPrev = (((x.s - prev.s) % L) + L) % L || L;
      for (const dist of [1000, 500]) {
        if (dist > gapPrev - 120) continue;
        const loc = locateOnLine(net, line, x.s - dist);
        signs.push({ kind: 'exit-advance', edge: loc.edge.id, s: loc.s, line, exitCode: x.code, distanceText: dist >= 1000 ? '1 km' : `${dist} m` });
      }
      // gantry at the start of the diverge taper
      const loc = locateOnLine(net, line, x.s - 30);
      signs.push({ kind: 'exit-now', edge: loc.edge.id, s: loc.s, line, exitCode: x.code });
      // gore sign on the ramp
      const ramp = net.edges[x.edge];
      signs.push({ kind: 'exit-gore', edge: ramp.id, s: Math.min(ramp.length * 0.5, 110), line, exitCode: x.code });
    }
    // confirmation + speed limit signs after each entrance
    for (const en of entrances.filter((e) => e.line === line)) {
      const loc = locateOnLine(net, line, en.s + 180);
      signs.push({ kind: 'confirm', edge: loc.edge.id, s: loc.s, line });
      const loc2 = locateOnLine(net, line, en.s + 260);
      signs.push({ kind: 'speed', edge: loc2.edge.id, s: loc2.s, line, speed: speedAt(loc2.edge, loc2.s) });
    }
    // speed limit signs where the limit drops
    for (const id of net.lines[line].edges) {
      const e = net.edges[id];
      for (let i = 1; i < e.speed.length; i++) {
        if (e.speed[i] < e.speed[i - 1]) signs.push({ kind: 'speed', edge: e.id, s: i * e.ds, line, speed: e.speed[i] });
        if (e.speed[i] > e.speed[i - 1]) signs.push({ kind: 'speed', edge: e.id, s: i * e.ds, line, speed: e.speed[i] });
      }
    }
    // speed cameras: fixed cameras roughly every 2.8 km, plus one average-speed section
    let sectionId = line === 'A' ? 1 : 2;
    for (let s = 1400; s < L - 500; s += 2800) {
      const loc = locateOnLine(net, line, s);
      cameras.push({ line, edge: loc.edge.id, s: loc.s, lineS: s, limit: speedAt(loc.edge, loc.s), kind: 'fixed' });
      signs.push({ kind: 'camera', edge: loc.edge.id, s: Math.max(0, loc.s - 150), line });
    }
    const secStart = L * 0.35;
    const secEnd = secStart + 3000;
    for (const [s, kind] of [
      [secStart, 'section-start'],
      [secEnd, 'section-end'],
    ] as [number, CameraFile['kind']][]) {
      const loc = locateOnLine(net, line, s);
      cameras.push({ line, edge: loc.edge.id, s: loc.s, lineS: s, limit: 60, kind, sectionId });
    }
    sectionId++;
    // variable message signs
    for (const s of [L * 0.15, L * 0.6]) {
      const loc = locateOnLine(net, line, s);
      signs.push({ kind: 'vms', edge: loc.edge.id, s: loc.s, line });
    }
  }
  return { signs, cameras };
}

function speedAt(e: Edge, s: number) {
  return e.speed[Math.max(0, Math.min(e.speed.length - 1, Math.round(s / e.ds)))];
}

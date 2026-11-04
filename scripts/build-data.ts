/**
 * Builds the game data from cached OSM extracts (run `npm run data:fetch` first):
 *   public/data/network.json  drivable inner ring (A/B lines) + ramps, signs, cameras
 *   public/data/city.json     buildings, streets, water, parks, trees, landmarks, terrain
 *
 * Map data © OpenStreetMap contributors, ODbL.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR, ORIGIN } from './lib/config';
import { buildNetwork, type Edge, type Network } from './lib/network';
import { solveElevation } from './lib/elevation';
import {
  computeSectionNames,
  computeSpeedLimits,
  detectExitsEntrances,
  loadGroundRoads,
  matchExits,
  placeSigns,
  type CuratedExit,
} from './lib/annotate';
import { buildCity } from './lib/city';
import { buildTerrain } from './lib/terrain';
import type { EdgeFile, LineId, NetworkFile, NodeFile, Rle } from '../src/shared/types';

const r2 = (v: number) => Math.round(v * 100) / 100;

function rle<T>(arr: T[]): Rle<T> {
  const out: Rle<T> = [];
  arr.forEach((v, i) => {
    if (!out.length || out[out.length - 1][1] !== v) out.push([i, v]);
  });
  return out;
}

function cleanName(n: string) {
  return n.replace(/辅路$/, '').replace(/(东|西|南|北|中)?延长线$/, '') || n;
}

function exportEdge(e: Edge): EdgeFile {
  return {
    id: e.id,
    kind: e.kind,
    line: e.line,
    from: e.fromNode,
    to: e.toNode,
    lineS0: e.lineS0 == null ? null : r2(e.lineS0),
    ds: Math.round(e.ds * 10000) / 10000,
    length: r2(e.length),
    laneWidth: e.laneWidth,
    x: e.pts.map((p) => r2(p[0])),
    y: e.y.map(r2),
    z: e.pts.map((p) => r2(p[1])),
    lanes: e.lanes.map((v) => Math.round(v * 1000) / 1000),
    bl: e.bl.map(r2),
    br: e.br.map(r2),
    ol: rle(e.ol),
    or: rle(e.or),
    struct: rle(e.struct),
    noiseL: rle(e.noiseL),
    noiseR: rle(e.noiseR),
    speed: rle(e.speed),
    names: rle(e.names.map(cleanName)),
    ways: [...new Set(e.chain.map((d) => d.way.id))],
  };
}

function validate(net: Network) {
  const problems: string[] = [];
  for (const line of ['A', 'B'] as LineId[]) {
    const L = net.lines[line].length;
    if (L < 21000 || L > 26000) problems.push(`line ${line} length ${L.toFixed(0)} out of range`);
    const ids = net.lines[line].edges;
    for (let k = 0; k < ids.length; k++) {
      const a = net.edges[ids[k]];
      const b = net.edges[ids[(k + 1) % ids.length]];
      if (a.toNode !== b.fromNode) problems.push(`line ${line}: edges ${a.id}->${b.id} not connected`);
    }
  }
  for (const e of net.edges) {
    for (let i = 1; i < e.y.length; i++) {
      const g = Math.abs(e.y[i] - e.y[i - 1]) / e.ds;
      if (g > 0.2) problems.push(`edge ${e.id} grade ${(g * 100).toFixed(0)}% at ${i}`);
    }
  }
  return problems;
}

async function main() {
  const t0 = Date.now();
  console.log('Building road network ...');
  const net = buildNetwork();
  console.log(`  ${net.edges.length} edges, A ${net.lines.A.length.toFixed(0)} m, B ${net.lines.B.length.toFixed(0)} m`);
  const elev = solveElevation(net);
  console.log(`  elevation: max grade ${(elev.maxGrade * 100).toFixed(1)}%, clearance conflicts ${elev.violations}`);
  computeSpeedLimits(net);
  const roads = loadGroundRoads();
  computeSectionNames(net, roads);
  const { exits: detected, entrances } = detectExitsEntrances(net, roads);
  const curated = JSON.parse(readFileSync('scripts/data/exits.json', 'utf8')) as Record<LineId, CuratedExit[]>;
  const exits = matchExits(detected, curated);
  for (const x of exits) console.log(`  ${x.code.padEnd(4)} ${x.line} s=${x.s.toFixed(0).padStart(5)} ${x.side.padEnd(5)} ${x.names.join(' / ')}`);
  const { signs, cameras } = placeSigns(net, exits, entrances);
  console.log(`  ${exits.length} exits, ${entrances.length} entrances, ${signs.length} signs, ${cameras.length} cameras`);

  console.log('Building city ...');
  const { city, flatten } = buildCity(net);
  console.log('Building terrain ...');
  city.terrain = await buildTerrain(13000, 384, flatten);

  const problems = validate(net);
  if (problems.length) {
    console.warn(`  ${problems.length} validation warnings:`);
    for (const p of problems.slice(0, 20)) console.warn('   - ' + p);
  }

  const nodes: NodeFile[] = [...net.nodes.values()].map((n) => {
    const node: NodeFile = { id: n.id, x: r2(n.p[0]), y: 0, z: r2(n.p[1]), in: n.in, out: n.out };
    const anyEdge = n.in.length ? net.edges[n.in[0]] : net.edges[n.out[0]];
    node.y = r2(n.in.length ? anyEdge.y[anyEdge.y.length - 1] : anyEdge.y[0]);
    if (n.out.length === 0) {
      const x = exits.find((ex) => ex.terminals.includes(n.id));
      node.terminal = { kind: 'exit', name: x ? x.names[0] : '' };
    } else if (n.in.length === 0) {
      const en = entrances.find((e) => e.startNode === n.id);
      node.terminal = { kind: 'entrance', name: en ? en.name : '' };
    }
    return node;
  });

  const file: NetworkFile = {
    version: 1,
    origin: { ...ORIGIN },
    generated: new Date().toISOString(),
    attribution: 'Map data © OpenStreetMap contributors (ODbL)',
    lines: {
      A: { id: 'A', name: '内环路A线', direction: 'ccw', length: r2(net.lines.A.length), edges: net.lines.A.edges },
      B: { id: 'B', name: '内环路B线', direction: 'cw', length: r2(net.lines.B.length), edges: net.lines.B.edges },
    },
    edges: net.edges.map(exportEdge),
    nodes,
    exits: exits.map((x) => ({ ...x, s: r2(x.s) })),
    entrances: entrances.map((e) => ({ ...e, s: r2(e.s), name: cleanName(e.name) })),
    signs: signs.map((s) => ({ ...s, s: r2(s.s) })),
    cameras: cameras.map((c) => ({ ...c, s: r2(c.s), lineS: r2(c.lineS) })),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const netJson = JSON.stringify(file);
  writeFileSync(join(OUT_DIR, 'network.json'), netJson);
  const cityJson = JSON.stringify(city);
  writeFileSync(join(OUT_DIR, 'city.json'), cityJson);
  console.log(
    `Wrote network.json (${(netJson.length / 1e6).toFixed(2)} MB), city.json (${(cityJson.length / 1e6).toFixed(2)} MB): ` +
      `${city.buildings.length} buildings, ${city.roads.length} roads, ${city.water.length} water polygons in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadNetwork } from './helpers';
import { type Edge, newFrame } from '../src/road/Network';
import { BARRIER_HEIGHT, BARRIER_WIDTH, DeckIndex, GIRDER_DEPTH, TRAFFIC_HEADROOM } from '../src/road/Clearance';
import { LAMP_HEIGHT, lampSpots, PIER_RADIUS, pierSpots } from '../src/road/RoadBuilder';
import { Signs } from '../src/world/Signs';
import { placeTrees } from '../src/world/City';
import type { CityFile } from '../src/shared/types';

const net = loadNetwork();
const decks = new DeckIndex(net);

/**
 * Brute-force reference (no spatial index): decks whose band or structure a
 * vertical cylinder at (x, z) from y0 to y1 runs into.
 */
function conflicts(x: number, z: number, r: number, y0: number, y1: number, standsOn: Edge[] = [], ignore: Edge[] = []): string[] {
  const out: string[] = [];
  for (const o of net.edgesNear(x, z, 80)) {
    if (ignore.includes(o)) continue;
    for (let i = 0; i < o.n - 1; i++) {
      const sx = o.x[i + 1] - o.x[i];
      const sz = o.z[i + 1] - o.z[i];
      const l = Math.hypot(sx, sz) || 1;
      const along = ((x - o.x[i]) * sx + (z - o.z[i]) * sz) / l;
      if (along < -r || along > l + r) continue;
      const t = Math.max(0, Math.min(1, along / l));
      const d = (-(x - o.x[i]) * sz + (z - o.z[i]) * sx) / l;
      const bl = o.bl[i] + (o.bl[i + 1] - o.bl[i]) * t;
      const br = o.br[i] + (o.br[i + 1] - o.br[i]) * t;
      const y = o.y[i] + (o.y[i + 1] - o.y[i]) * t;
      const off = Math.abs(d - (bl + br) / 2) - (br - bl) / 2;
      if (off < r && y1 > y - 0.3 && y0 < y + TRAFFIC_HEADROOM) out.push(`roadway of edge ${o.id}`);
      else if (off < r + BARRIER_WIDTH && !standsOn.includes(o) && y1 > y - GIRDER_DEPTH && y0 < y + BARRIER_HEIGHT) out.push(`deck of edge ${o.id}`);
      if (out.length) return out;
    }
  }
  return out;
}

describe('roadside furniture keeps clear of the roadways', () => {
  it('places every sign support outside carriageways and below no deck', () => {
    const signs = new Signs(net, decks);
    // practically every sign finds a spot (one sits where OSM decks overlap)
    expect(signs.skipped.length).toBeLessThanOrEqual(2);
    // every enforcement camera is in the scene (a camera nobody can see must not flash)
    expect(signs.cameras.length).toBe(net.cameras.length);
    const f = newFrame();
    const bad: string[] = [];
    for (const spec of net.signs) {
      const L = signs.layout(spec);
      if (!L) continue;
      const e = L.edge;
      e.frame(L.s, 0, f);
      const at = (d: number) => [f.x + f.nx * d, f.z + f.nz * d] as const;
      const report = (what: string, c: string[]) => c.length && bad.push(`${spec.kind} on edge ${spec.edge} @${spec.s.toFixed(0)}: ${what} hits ${c[0]}`);
      if ('left' in L) {
        const top = L.y + (spec.kind === 'vms' ? 9.05 : 9.65);
        for (const p of [L.left, L.right]) report('post', conflicts(...at(p.d), 0.27, p.base, top, [p.deck]));
        for (let d = L.left.d; d <= L.right.d; d += 0.5) report('beam', conflicts(...at(d), 0.3, top - 0.8, top));
      } else if ('reach' in L) {
        const top = L.y + (spec.kind === 'vms' ? 9.05 : 9.65);
        report('post', conflicts(...at(L.post.d), 0.27, L.y, top, [e]));
        for (let k = 0.5; k <= L.reach; k += 0.5) report('arm', conflicts(...at(L.post.d - L.side * k), 0.3, top - 3.9, top));
      } else {
        report('pole', conflicts(...at(L.post.d), 0.1, L.y, L.y + 3.5, [e]));
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps street lights and piers out of other roadways and decks', () => {
    const bad: string[] = [];
    let lamps = 0;
    let columns = 0;
    for (const e of net.edges) {
      for (const l of lampSpots(e, decks)) {
        lamps++;
        const c = [...conflicts(l.x, l.z, 0.14, l.y, l.y + LAMP_HEIGHT, [e]), ...conflicts(l.hx, l.hz, 0.4, l.y + LAMP_HEIGHT - 0.3, l.y + LAMP_HEIGHT + 0.2, [e])];
        if (c.length) bad.push(`lamp on edge ${e.id}: ${c[0]}`);
      }
      for (const p of pierSpots(e, decks).columns) {
        columns++;
        // only decks below the column top matter: the column carries its own deck
        const c = conflicts(p.x, p.z, PIER_RADIUS, p.y0, p.y1 - 0.1, [], [e]).filter((s) => {
          const o = net.edges[Number(s.split(' ').pop())];
          const i = o.idx(o.project(p.x, p.z, o.length / 2, { s: 0, d: 0, dist: 0 }, o.n).s);
          return o.y[i] < p.y1 - 0.5;
        });
        if (c.length) bad.push(`pier of edge ${e.id}: ${c[0]}`);
      }
    }
    expect(lamps).toBeGreaterThan(1900);
    expect(columns).toBeGreaterThan(2400);
    expect(bad).toEqual([]);
  });

  it('keeps trees off streets and their crowns out of the decks', () => {
    const city = JSON.parse(readFileSync('public/data/city.json', 'utf8')) as CityFile;
    const trees = placeTrees(city, null, decks);
    expect(trees.length / 3).toBeGreaterThan(30000);
    const bad: string[] = [];
    for (let k = 0; k < trees.length; k += 3) {
      const [x, z, s] = [trees[k], trees[k + 1], trees[k + 2]];
      const c = [...conflicts(x, z, 0.3, 0, 3 * s), ...conflicts(x, z, 3.25 * s, 2.4 * s, 8.5 * s)];
      if (c.length) bad.push(`tree at ${x.toFixed(0)},${z.toFixed(0)}: ${c[0]}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

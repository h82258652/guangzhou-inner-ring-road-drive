import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadNetwork } from './helpers';
import { newFrame, type Edge } from '../src/road/Network';
import { type Car, Traffic, type PlayerProxy } from '../src/traffic/Traffic';
import type { LineId } from '../src/shared/types';

const net = loadNetwork();

/** Drives a virtual player along a line at 60 km/h and records what the traffic does around it. */
function simulate(line: LineId, seconds: number) {
  const traffic = new Traffic(net, { render: false });
  let ps = 200;
  traffic.populate(line, ps);
  const exitEdges = new Map(net.exits.map((x) => [x.edge, x]));
  const entranceEdges = new Set(net.entrances.map((x) => x.edge));
  const prev = new Map<number, Edge>();
  const focus = new THREE.Vector3();
  const f = newFrame();
  const out = { exitsTaken: 0, exitsAbandoned: 0, rampEndsReached: 0, merges: 0, entrancesPassed: 0, entrancesWithTraffic: 0, timedMerges: 0, timedMergesInView: 0 };
  const passed = new Map<number, boolean>();
  const joined: { id: number; from: number; t: number }[] = [];
  const dt = 1 / 30;
  const v = 60 / 3.6;
  const L = net.lines[line].length;
  for (let t = 0; t < seconds; t += dt) {
    ps += v * dt;
    const loc = net.atLineS(line, ps);
    const d = loc.edge.laneCenter(loc.s, 1);
    loc.edge.frame(loc.s, d, f);
    focus.set(f.x, loc.edge.yAt(loc.s), f.z);
    const player: PlayerProxy = { edge: loc.edge, s: loc.s, d, v, len: 4.7, width: 1.8, x: f.x, z: f.z, heading: Math.atan2(f.tz, f.tx) };
    traffic.update(dt, player, focus);
    const alive = new Set<number>();
    for (const c of traffic.cars) {
      alive.add(c.id);
      const p = prev.get(c.id);
      if (!p) continue;
      if (p.kind === 'main' && exitEdges.has(c.edge.id)) out.exitsTaken++;
      if (exitEdges.has(p.id) && c.edge.kind === 'main' && c.edge.line === exitEdges.get(p.id)!.line) out.exitsAbandoned++;
      if (entranceEdges.has(p.id) && c.edge.kind === 'main') {
        out.merges++;
        joined.push({ id: c.id, from: p.id, t });
        // cars fed in for the player: they should join just ahead of (or next to) the player
        if (c.meet && c.edge.line === line) {
          out.timedMerges++;
          let rel = (((net.lineS(c.edge, c.s)! - ps) % L) + L) % L;
          if (rel > L / 2) rel -= L;
          if (rel > -40 && rel < 300) out.timedMergesInView++;
        }
      }
    }
    for (const [id, e] of prev) if (!alive.has(id) && e.kind === 'ramp' && !e.succ.length) out.rampEndsReached++;
    prev.clear();
    for (const c of traffic.cars) prev.set(c.id, c.edge);
    // driving past an entrance: is there ramp traffic within sight, or a car that has just joined from it? (after a warm-up)
    if (t < 60) continue;
    for (const [k, en] of net.entrances.entries()) {
      if (en.line !== line) continue;
      const ahead = (((en.s - ps) % L) + L) % L;
      if (ahead <= 0 || ahead > 200) continue;
      // the entrance ramp and every ramp feeding it
      const tree = new Set<Edge>([net.edges[en.edge]]);
      for (let depth = 0; depth < 6; depth++) for (const r of [...tree]) for (const p of r.pred) if (p.kind === 'ramp') tree.add(p);
      const near = (c: Car) => Math.hypot(c.x - focus.x, c.z - focus.z) < 250;
      const fresh = new Set(joined.filter((j) => j.from === en.edge && t - j.t < 10).map((j) => j.id));
      const seen = traffic.cars.some((c) => near(c) && (tree.has(c.edge) || fresh.has(c.id)));
      passed.set(k, (passed.get(k) ?? false) || seen);
    }
  }
  out.entrancesPassed = passed.size;
  out.entrancesWithTraffic = [...passed.values()].filter(Boolean).length;
  return out;
}

describe('traffic on ramps', () => {
  for (const line of ['A', 'B'] as LineId[]) {
    it(`cars leave line ${line} by exit ramps and join it from entrance ramps`, () => {
      // ~15 km: past a dozen entrances, including short ones with nowhere for a car to wait
      const r = simulate(line, 900);
      // drivers who take an exit stay on the ramp (they used to be pulled back onto the line)
      expect(r.exitsTaken).toBeGreaterThan(100);
      expect(r.exitsAbandoned).toBe(0);
      expect(r.rampEndsReached).toBeGreaterThan(r.exitsTaken * 0.5);
      // entrance ramps carry traffic that merges, and the player sees it while driving past
      expect(r.merges).toBeGreaterThan(50);
      expect(r.entrancesPassed).toBeGreaterThanOrEqual(5);
      expect(r.entrancesWithTraffic / r.entrancesPassed).toBeGreaterThanOrEqual(0.75);
      expect(r.timedMerges).toBeGreaterThanOrEqual(10);
      expect(r.timedMergesInView / r.timedMerges).toBeGreaterThanOrEqual(0.65);
    }, 120000);
  }
});

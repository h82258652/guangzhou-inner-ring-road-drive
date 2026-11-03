import { describe, expect, it } from 'vitest';
import { Autopilot, loadNetwork } from './helpers';
import { VehicleDynamics, SEDAN } from '../src/vehicle/Dynamics';
import { type Edge, newProjection } from '../src/road/Network';
import type { LineId } from '../src/shared/types';

const net = loadNetwork();
const DT = 1 / 120;

describe('vehicle dynamics', () => {
  it('accelerates 0-100 km/h in a realistic time', () => {
    const d = new VehicleDynamics(SEDAN);
    let t = 0;
    while (d.vx < 100 / 3.6 && t < 30) {
      d.step(DT, { throttle: 1, brake: 0, steer: 0, handbrake: false }, 0);
      t += DT;
    }
    expect(t).toBeGreaterThan(6);
    expect(t).toBeLessThan(15);
  });

  it('stops from 60 km/h within a short distance', () => {
    const d = new VehicleDynamics(SEDAN);
    d.vx = 60 / 3.6;
    const x0 = d.x;
    for (let k = 0; k < 120 * 10 && d.vx > 0.05; k++) d.step(DT, { throttle: 0, brake: 1, steer: 0, handbrake: false }, 0);
    expect(d.x - x0).toBeLessThan(30);
    expect(d.vx).toBeLessThan(0.1);
  });

  it('stays stable in a steady turn', () => {
    const d = new VehicleDynamics(SEDAN);
    d.vx = 50 / 3.6;
    for (let k = 0; k < 120 * 10; k++) d.step(DT, { throttle: 0.25, brake: 0, steer: 0.6, handbrake: false }, 0);
    expect(Number.isFinite(d.x)).toBe(true);
    expect(Math.abs(d.r)).toBeLessThan(2);
    expect(Math.abs(d.vy)).toBeLessThan(5);
  });
});

function mainRoute(e: Edge): Edge | null {
  return e.succ.find((n) => n.kind === 'main' && n.line === e.line) ?? null;
}

describe('autopilot on the network', () => {
  for (const line of ['A', 'B'] as LineId[]) {
    it(`drives a full lap on line ${line} without leaving the road`, () => {
      const start = net.atLineS(line, 30);
      const ap = new Autopilot(net, start.edge, start.s, 1, mainRoute);
      let progress = 0;
      let prev = net.lineS(ap.tracker.edge, ap.tracker.s)!;
      const L = net.lines[line].length;
      let t = 0;
      while (progress < L && t < 2400) {
        ap.step(DT, 60);
        t += DT;
        const e = ap.tracker.edge;
        expect(e.kind).toBe('main');
        expect(e.line).toBe(line);
        const ls = net.lineS(e, ap.tracker.s)!;
        let dl = ls - prev;
        if (dl < -L / 2) dl += L;
        progress += dl;
        prev = ls;
      }
      expect(progress).toBeGreaterThanOrEqual(L);
      // a lap at up to 60 km/h takes roughly 25 minutes
      expect(t).toBeGreaterThan(1300);
      expect(ap.maxImpact).toBeLessThan(2);
    }, 120000);
  }

  it('can take exit ramps to their end', () => {
    const tested: string[] = [];
    const label = (xx: (typeof net.exits)[number]) => xx.code || `${xx.names[0]}(${xx.line})`;
    for (const x of net.exits) {
      const ramp = net.edges[x.edge];
      const through = ramp.pred[0].succ.find((n) => n.kind === 'main' && n.line === x.line)!;
      // start 200 m before the diverge in the outer lane, then steer into the ramp lane
      const start = net.atLineS(x.line, x.s - 200);
      const lanes = Math.max(1, Math.round(start.edge.lanesAt(start.s)));
      const outer = x.side === 'right' ? lanes - 1 : 0;
      const ap = new Autopilot(net, start.edge, start.s, outer, (e) => {
        if (e === ramp.pred[0]) return through;
        if (e.kind === 'main') return mainRoute(e);
        return e.succ[0] ?? null;
      });
      const onRamp = (e: Edge) => e.kind === 'ramp';
      const base = ap.lateral;
      const sg = x.side === 'right' ? 1 : -1;
      ap.lateral = (e, s) => {
        if (onRamp(e)) return e.laneCenter(s, 0);
        // once the gore opens: aim beyond the bound into the deceleration lane
        if (e === through && s > 4) return x.side === 'right' ? e.brAt(s) + 2.2 : e.blAt(s) - 2.2;
        // hug the exit-side edge line on the approach, as a driver would
        if (e === through || (e === ramp.pred[0] && s > e.length - 90)) return base(e, s) + sg * 1.0;
        return base(e, s);
      };
      ap.route = (e) => {
        if (e === ramp.pred[0]) return through;
        if (e === through) return through.succ.find((n) => n.kind === 'main') ?? null;
        if (e.kind === 'main') return mainRoute(e);
        return e.succ[0] ?? null;
      };
      let t = 0;
      let reachedRamp = false;
      while (t < 240) {
        ap.step(DT, 45);
        t += DT;
        if (ap.tracker.edge.kind === 'ramp') reachedRamp = true;
        if (ap.tracker.terminal) break;
        // keep following the ramp chain (the lateral target still points into the ramp while in the gore)
        if (reachedRamp) ap.route = (e) => (e === through ? null : (e.succ.find((n) => n.kind === 'ramp') ?? e.succ[0] ?? null));
        if (!reachedRamp && ap.tracker.edge.kind === 'main') {
          const L = net.lines[x.line].length;
          const past = (((net.lineS(ap.tracker.edge, ap.tracker.s)! - x.s) % L) + L) % L;
          if (past > 500 && past < L / 2) break;
        }
      }
      if (reachedRamp && ap.tracker.terminal) tested.push(label(x));
    }
    // every exit (numbered or not) can be taken to the end of its ramp
    expect(net.exits.map(label).filter((c) => !tested.includes(c))).toEqual([]);
  }, 120000);

  it('can merge onto the line from every entrance ramp', () => {
    const failed: string[] = [];
    for (const en of net.entrances) {
      // start at the beginning of the ramp chain
      const path = [net.edges[en.edge]];
      for (let k = 0; k < 6 && path[0].pred.length === 1 && path[0].pred[0].kind === 'ramp'; k++) path.unshift(path[0].pred[0]);
      const first = path[0];
      const toMain = en.side === 'right' ? -1 : 1; // main line lies on the ramp's left for right-hand entrances
      const ap = new Autopilot(net, first, Math.min(5, first.length / 2), 0, (e) => {
        const k = path.indexOf(e);
        if (k >= 0 && k < path.length - 1) return path[k + 1];
        return e.kind === 'main' ? mainRoute(e) : (e.succ.find((n) => n.kind === 'main' && n.line === en.line) ?? e.succ[0] ?? null);
      });
      // where the ramp splits, keep to the side of the branch that leads to this entrance
      const keep = new Map<Edge, number>();
      path.forEach((e, k) => {
        if (k === path.length - 1 || e.succ.length < 2) return;
        const nx = path[k + 1];
        const j = nx.idx(Math.min(nx.length, 40));
        keep.set(e, Math.sign(e.project(nx.x[j], nx.z[j], e.length, newProjection(), 40).d));
      });
      ap.lateral = (e, s) => {
        const lanes = Math.max(1, Math.round(e.lanesAt(s)));
        if (e.kind === 'main') return e.laneCenter(s, en.side === 'right' ? lanes - 1 : 0);
        const i = e.idx(Math.min(e.length, s));
        // move over through an open side onto the line, or onto the route's ramp after a ramp split
        for (const [open, sg] of [
          [e.ol[i], -1],
          [e.or[i], 1],
        ] as const) {
          if (open < 0) continue;
          const o = net.edges[open];
          const wanted = (o.kind === 'main' && o.line === en.line && sg === toMain) || (path.includes(o) && !path.includes(e));
          if (wanted) return sg < 0 ? e.blAt(s) - 2.2 : e.brAt(s) + 2.2;
        }
        const side = keep.get(e);
        if (side) return e.laneCenter(s, side > 0 ? lanes - 1 : 0) + side * 0.6;
        return e.laneCenter(s, 0);
      };
      let t = 0;
      let onMain = 0;
      while (t < 200 && onMain < 150) {
        ap.step(DT, 45);
        t += DT;
        const e = ap.tracker.edge;
        if (e.kind === 'main' && e.line === en.line) onMain += Math.max(0, ap.dyn.vx) * DT;
        else onMain = 0;
        if (ap.tracker.terminal) break;
      }
      if (onMain < 150) failed.push(`${en.line}@${en.s.toFixed(0)}`);
    }
    expect(failed).toEqual([]);
  }, 120000);
});

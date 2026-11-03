import { describe, expect, it } from 'vitest';
import { Autopilot, loadNetwork } from './helpers';
import { VehicleDynamics, SEDAN } from '../src/vehicle/Dynamics';
import type { Edge } from '../src/road/Network';
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
    for (const x of net.exits.filter((xx) => xx.code).slice(0, 38)) {
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
      ap.lateral = (e, s) => {
        if (onRamp(e)) return e.laneCenter(s, 0);
        // after the diverge: aim beyond the bound into the deceleration lane
        if (e === through && s > 25) return x.side === 'right' ? e.brAt(s) + 2.2 : e.blAt(s) - 2.2;
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
        if (reachedRamp) {
          // keep following the ramp chain
          ap.route = (e) => e.succ.find((n) => n.kind === 'ramp') ?? e.succ[0] ?? null;
          ap.lateral = (e, s) => (e.kind === 'ramp' ? e.laneCenter(s, 0) : base(e, s));
        }
        if (!reachedRamp && ap.tracker.edge.kind === 'main' && net.lineS(ap.tracker.edge, ap.tracker.s)! > x.s + 500) break;
      }
      if (reachedRamp) tested.push(x.code);
    }
    // the large majority of exits must be drivable
    expect(tested.length).toBeGreaterThanOrEqual(30);
  }, 120000);
});

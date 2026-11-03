import { readFileSync } from 'node:fs';
import { RoadNetwork, type Edge, newFrame } from '../src/road/Network';
import type { NetworkFile } from '../src/shared/types';
import { VehicleDynamics, SEDAN, type Controls } from '../src/vehicle/Dynamics';
import { RoadTracker } from '../src/vehicle/RoadTracker';
import { clamp, lerp, smoothstep } from '../src/shared/math';

let cached: RoadNetwork | null = null;
export function loadNetwork(): RoadNetwork {
  if (!cached) cached = new RoadNetwork(JSON.parse(readFileSync('public/data/network.json', 'utf8')) as NetworkFile);
  return cached;
}

/** Simple autopilot driving the physics model along a sequence of edges. */
export class Autopilot {
  dyn = new VehicleDynamics(SEDAN);
  tracker: RoadTracker;
  /** desired lateral offset as function of edge/s (lane centre by default) */
  lateral: (e: Edge, s: number) => number;
  maxImpact = 0;
  route: (e: Edge) => Edge | null;
  private f = newFrame();

  constructor(
    readonly net: RoadNetwork,
    edge: Edge,
    s: number,
    lane: number,
    route: (e: Edge) => Edge | null,
  ) {
    this.tracker = new RoadTracker(net, edge, s);
    this.route = route;
    this.lateral = (e, ss) => {
      const lanes = Math.max(1, Math.round(e.lanesAt(ss)));
      return e.laneCenter(ss, Math.min(lane, lanes - 1));
    };
    const fr = edge.frame(s, this.lateral(edge, s), this.f);
    this.dyn.x = fr.x;
    this.dyn.z = fr.z;
    this.dyn.psi = Math.atan2(fr.tz, fr.tx);
    this.dyn.vx = 12;
  }

  /** Point ahead along the planned route. */
  ahead(dist: number) {
    let e: Edge | null = this.tracker.edge;
    let s = this.tracker.s + dist;
    for (let k = 0; k < 8 && e && s > e.length; k++) {
      s -= e.length;
      e = this.route(e);
    }
    if (!e) {
      e = this.tracker.edge;
      s = e.length;
    }
    return e.frame(Math.min(s, e.length), this.lateral(e, Math.min(s, e.length)), newFrame());
  }

  step(dt: number, targetKmh: number) {
    const d = this.dyn;
    const t = this.tracker;
    const limit = Math.min(targetKmh, t.edge.speedAt(Math.min(t.edge.length, t.s + 40)) + 2) / 3.6;
    const err = limit - d.vx;
    const c: Controls = { throttle: clamp(err * 0.6, 0, 1), brake: clamp(-err * 0.5, 0, 1), steer: 0, handbrake: false };
    const ld = 7 + d.vx * 0.7;
    const p = this.ahead(ld);
    const ang = Math.atan2(p.z - d.z, p.x - d.x) - d.psi;
    const alpha = Math.atan2(Math.sin(ang), Math.cos(ang));
    const L = d.spec.a + d.spec.b;
    const delta = Math.atan2(2 * L * Math.sin(alpha), ld);
    const steerLimit = d.spec.maxSteer * lerp(1, 0.16, smoothstep(2, 32, Math.abs(d.vx)));
    c.steer = clamp(delta / steerLimit, -1, 1);
    const i = t.edge.idx(t.s);
    const grade = t.edge.grade[i] * Math.cos(d.psi - Math.atan2(t.edge.tz[i], t.edge.tx[i]));
    d.step(dt, c, grade);
    const body = {
      x: d.x,
      z: d.z,
      psi: d.psi,
      halfWidth: d.spec.halfWidth,
      halfLength: d.spec.halfLength - 0.2,
      yawRate: d.r,
      getVel: () => d.worldVelocity(),
      setVel: (vx: number, vz: number) => d.setWorldVelocity(vx, vz),
    };
    const info = t.update(body);
    d.x = body.x;
    d.z = body.z;
    d.psi = body.psi;
    d.r = body.yawRate;
    this.maxImpact = Math.max(this.maxImpact, info.impact);
    return info;
  }
}

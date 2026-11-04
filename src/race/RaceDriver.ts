/**
 * AI race driver for the full vehicle model. It follows the race line with
 * pure pursuit, picks the lane with the most room ahead (overtaking traffic
 * and rivals), brakes for corners from the road's curvature — speed limits do
 * not apply in a race — and keeps a short gap to whatever is in front.
 */
import { type Edge, type RoadNetwork, newFrame } from '../road/Network';
import type { Controls, VehicleDynamics } from '../vehicle/Dynamics';
import type { RoadTracker } from '../vehicle/RoadTracker';
import type { LineId } from '../shared/types';
import { clamp, lerp, smoothstep } from '../shared/math';

/** Something on the race line, in race-line coordinates. */
export interface Obstacle {
  /** arc length along the line */
  ls: number;
  /** lateral position measured from the left edge of the lanes (m) */
  fromLeft: number;
  v: number;
  len: number;
  width: number;
  /** lane another race driver is heading for (counts as taken) */
  lane?: number;
}

/** Lateral position of (edge, s, d) measured from the left edge of the lanes. */
export const fromLeftEdge = (e: Edge, s: number, d: number) => d + (e.lanesAt(s) * e.laneWidth) / 2;

const CURV_STEP = 2.5;

/** Curvature (1/m) along a line, sampled every 2.5 m of arc length (peak over ±5 m of a ±10 m chord estimate). */
export class LineCurvature {
  readonly k: Float32Array;
  readonly L: number;

  constructor(net: RoadNetwork, line: LineId) {
    this.L = net.lines[line].length;
    const n = Math.ceil(this.L / CURV_STEP);
    const head = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const loc = net.atLineS(line, i * CURV_STEP);
      const j = loc.edge.idx(loc.s);
      head[i] = Math.atan2(loc.edge.tz[j], loc.edge.tx[j]);
    }
    const raw = new Float32Array(n);
    const span = 4;
    for (let i = 0; i < n; i++) {
      const a = head[(i - span + n) % n];
      const b = head[(i + span) % n];
      raw[i] = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) / (2 * span * CURV_STEP);
    }
    this.k = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = -2; j <= 2; j++) m = Math.max(m, raw[(i + j + n) % n]);
      this.k[i] = m;
    }
  }

  at(ls: number) {
    const n = this.k.length;
    return this.k[((Math.round(ls / CURV_STEP) % n) + n) % n];
  }
}

export interface DriverSkill {
  /** share of the tyre grip used in corners */
  grip: number;
  /** top speed (m/s) */
  vmax: number;
  /** braking deceleration planned with (m/s²) */
  brake: number;
}

export class RaceDriver {
  readonly controls: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** lane the driver is heading for (0 = leftmost) */
  lane = 0;
  /** pace multiplier set by the race (catch-up / ease-off) */
  pace = 1;
  /** speed the driver wants right now (low when held up by traffic) */
  target = 0;
  /** lateral offset the car is steering for (moves towards the chosen lane at a bounded rate) */
  private dRef: number | null = null;
  private decideT = 0;
  private f = newFrame();

  constructor(
    readonly net: RoadNetwork,
    readonly line: LineId,
    readonly curv: LineCurvature,
    public skill: DriverSkill,
  ) {}

  private route(e: Edge): Edge | null {
    return e.succ.find((n) => n.kind === 'main' && n.line === this.line) ?? null;
  }

  /** Edge and arc length `s` metres along the race line from the start of edge `e` (s may run past its end). */
  private ahead(e: Edge, s: number): { e: Edge; s: number } {
    let pe: Edge | null = e;
    while (pe && s > pe.length) {
      s -= pe.length;
      const nx = this.route(pe);
      if (!nx) return { e: pe, s: pe.length };
      pe = nx;
    }
    return { e: pe!, s };
  }

  /** Highest speed from which the car can still slow down for every corner within braking range. */
  cornerSpeed(ls: number, v: number, gripScale: number): number {
    const aLat = 9.81 * gripScale * this.skill.grip * this.pace;
    const aBrk = this.skill.brake * gripScale;
    let best = this.skill.vmax * Math.min(1.06, this.pace);
    const reach = (v * v) / (2 * aBrk) + 40;
    for (let x = 0; x <= reach; x += CURV_STEP * 2) {
      const vc = Math.sqrt(aLat / Math.max(this.curv.at(ls + x), 1e-4));
      best = Math.min(best, Math.sqrt(vc * vc + 2 * aBrk * x));
    }
    return best;
  }

  /**
   * Controls for this frame. `ls` is the car's arc length on the race line,
   * `others` everything else on the line (traffic, rivals, the player).
   * Returns the target speed.
   */
  drive(dt: number, dyn: VehicleDynamics, tracker: RoadTracker, ls: number, others: Obstacle[], gripScale: number): number {
    const e = tracker.edge;
    const c = this.controls;
    const L = this.curv.L;
    const lanes = Math.max(1, Math.round(e.lanesAt(tracker.s)));
    const lw = e.laneWidth;
    const me = fromLeftEdge(e, tracker.s, tracker.d);
    const cur = clamp(Math.floor(me / lw), 0, lanes - 1);
    const v = Math.max(0, dyn.vx);
    const myLen = dyn.spec.halfLength * 2;
    const near: (Obstacle & { along: number })[] = [];
    for (const o of others) {
      let along = (((o.ls - ls) % L) + L) % L;
      if (along > L / 2) along -= L;
      if (along > -30 && along < 220) near.push({ ...o, along });
    }
    const occupies = (o: Obstacle, k: number) => o.lane === k || (o.fromLeft + o.width / 2 + 0.3 > k * lw && o.fromLeft - o.width / 2 - 0.3 < (k + 1) * lw);
    const room = (k: number) => {
      let free = 220;
      let vLead = Infinity;
      for (const o of near) {
        if (o.along <= 0.5 || !occupies(o, k)) continue;
        const gap = Math.max(0, o.along - (o.len + myLen) / 2);
        if (gap < free) {
          free = gap;
          vLead = o.v;
        }
      }
      return { free, vLead };
    };
    const aBrk = this.skill.brake * gripScale;
    /** distance needed to drop to the speed of a car ahead, plus a margin */
    const needs = (vLead: number) => (vLead < v ? (v * v - vLead * vLead) / (2 * aBrk) : 0) + 4 + v * 0.3;
    // every lane the car's body is in at the moment (more than one while changing lanes)
    const mine: number[] = [];
    for (let k = clamp(Math.floor((me - 1.1) / lw), 0, lanes - 1); k <= clamp(Math.floor((me + 1.1) / lw), 0, lanes - 1); k++) mine.push(k);
    // lanes that end ahead (dropped at a diverge into an exit ramp, or narrowing): leave them early,
    // otherwise the car is carried off into the exit
    const horizon = 60 + v * 4;
    const ending = (k: number) => {
      const dk = e.laneCenter(tracker.s, k);
      for (let x = 15; x <= horizon; x += 15) {
        const p = this.ahead(e, tracker.s + x);
        if (Math.abs(dk) + 1.0 > (p.e.lanesAt(p.s) * p.e.laneWidth) / 2) return true;
      }
      return false;
    };
    // lane choice a few times a second: most room ahead, with some stickiness
    this.decideT -= dt;
    if (this.decideT <= 0) {
      this.decideT = 0.25;
      this.lane = clamp(this.lane, 0, lanes - 1);
      let best = this.lane;
      let bestScore = -Infinity;
      for (let k = 0; k < lanes; k++) {
        const r = room(k);
        // a car ahead only matters if it is slower than us
        let score = Math.min(r.free, 180) + (r.vLead === Infinity ? 40 : clamp((r.vLead - v) * 4, -40, 40));
        if (k === this.lane) score += 18;
        score -= Math.abs(k - cur) * 6;
        if (ending(k)) score -= 400;
        // never move across a car that is alongside, nor in behind one we could not slow down for
        let blocked = k !== cur && r.free < needs(r.vLead);
        for (const o of near) {
          if (o.along < -myLen - 2 || o.along > myLen + 2) continue;
          for (let j = Math.min(k, cur); j <= Math.max(k, cur); j++) if (j !== cur && occupies(o, j)) blocked = true;
        }
        if (!blocked && score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
      this.lane = best;
    }
    // target speed: corners, then whatever is ahead in the lanes we are in and the one we head for
    let vt = this.cornerSpeed(ls, v, gripScale);
    for (const k of new Set([this.lane, ...mine])) {
      const r = room(k);
      if (r.free >= 220) continue;
      const keep = 3 + v * 0.3;
      // close the gap no faster than we can brake for it; drop back when already too close
      vt = Math.min(vt, r.free > keep ? Math.sqrt(r.vLead ** 2 + 2 * aBrk * (r.free - keep)) : r.vLead * 0.85 * (r.free / keep));
    }
    // lateral reference: towards the chosen lane at a bounded rate (smooth lane changes at speed)
    const goal = e.laneCenter(tracker.s, this.lane);
    if (this.dRef === null || Math.abs(this.dRef - tracker.d) > 4) this.dRef = tracker.d;
    const rate = 1.4 + v * 0.03;
    this.dRef += clamp(goal - this.dRef, -rate * dt, rate * dt);
    // give a car alongside some room instead of rubbing doors with it
    const myW = dyn.spec.halfWidth * 2;
    let push = 0;
    for (const o of near) {
      if (Math.abs(o.along) > (o.len + myLen) / 2 + 1.5) continue;
      const gap = Math.abs(me - o.fromLeft) - (myW + o.width) / 2;
      if (gap < 0.6) push += Math.sign(me - o.fromLeft || 1) * (0.6 - gap);
    }
    // pure pursuit; the target stays inside the lanes of the road ahead (keeps clear of gores and walls)
    const ld = 6 + v * 0.45;
    const p = this.ahead(e, tracker.s + ld);
    const half = (p.e.lanesAt(p.s) * p.e.laneWidth) / 2 - 1.2;
    const fr = p.e.frame(p.s, clamp(this.dRef + clamp(push, -0.9, 0.9), -Math.max(0, half), Math.max(0, half)), this.f);
    const ang = Math.atan2(fr.z - dyn.z, fr.x - dyn.x) - dyn.psi;
    const alpha = Math.atan2(Math.sin(ang), Math.cos(ang));
    const S = dyn.spec;
    const wb = S.a + S.b;
    // the kinematic pursuit angle, scaled up by the car's understeer at this speed
    const understeer = (S.mass / wb) * (S.b / S.cf - S.a / S.cr);
    const delta = Math.atan2(2 * wb * Math.sin(alpha), ld) * (1 + (understeer * v * v) / wb);
    const steerLimit = S.maxSteer * lerp(1, 0.16, smoothstep(2, 32, Math.abs(dyn.vx)));
    c.steer = clamp(delta / steerLimit, -1, 1);
    const err = vt - v;
    c.throttle = err > 0 ? clamp(0.35 + err * 0.35, 0, 1) : 0;
    // hard braking takes the grip the front tyres need to turn: go easier on the brake while cornering
    const cornering = clamp(this.curv.at(ls) * 300 + Math.abs(alpha) * 4, 0, 1);
    c.brake = err < -0.4 ? clamp(-err * 0.3, 0, 1 - 0.45 * cornering) : 0;
    c.handbrake = false;
    this.target = vt;
    return vt;
  }

  /** Forget the lateral plan (after the car has been put somewhere else). */
  reset(lane: number) {
    this.lane = lane;
    this.dRef = null;
    this.decideT = 0;
  }

  /** Hold still on the grid (handbrake: holding the foot brake at a standstill would select reverse). */
  hold() {
    const c = this.controls;
    c.throttle = 0;
    c.brake = 0;
    c.steer = 0;
    c.handbrake = true;
  }
}

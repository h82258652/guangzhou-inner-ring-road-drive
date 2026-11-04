/**
 * Race mode: a standing start against AI drivers on one line of the ring.
 * Traffic keeps driving; speed limits and every other traffic rule are
 * suspended. The race tracks each entrant's distance along the line, keeps
 * the standings, respawns AI cars that got stuck and ends when the player
 * crosses the finish.
 */
import type { Player } from '../vehicle/Player';
import { newProjection, type RoadNetwork } from '../road/Network';
import type { LineId } from '../shared/types';
import type { VehicleKind } from '../vehicle/CarModel';
import type { Car } from '../traffic/Traffic';
import { clamp } from '../shared/math';
import { type DriverSkill, fromLeftEdge, LineCurvature, type Obstacle, RaceDriver } from './RaceDriver';

export type RaceLength = 'short' | 'half' | 'lap';
export type RaceLevel = 'easy' | 'normal' | 'hard';

export const COUNTDOWN = 3;
export const SHORT_RACE = 5000;

export function raceDistance(lineLength: number, len: RaceLength) {
  return len === 'short' ? SHORT_RACE : len === 'half' ? lineLength / 2 : lineLength;
}

const SKILL: Record<RaceLevel, DriverSkill> = {
  easy: { grip: 0.62, vmax: 42, brake: 5.2 },
  normal: { grip: 0.72, vmax: 50, brake: 5.8 },
  hard: { grip: 0.8, vmax: 58, brake: 6.3 },
};

const RIVALS: { name: string; color: number; kind: VehicleKind }[] = [
  { name: '珠江飞鱼', color: 0xd62828, kind: 'sedan' },
  { name: '白云车神', color: 0xf2b705, kind: 'hatch' },
  { name: '小蛮腰', color: 0x7b2cbf, kind: 'sedan' },
  { name: '越秀闪电', color: 0x0077b6, kind: 'suv' },
  { name: '海珠漂移王', color: 0xf77f00, kind: 'hatch' },
  { name: '天河快线', color: 0x2a9d8f, kind: 'sedan' },
  { name: '荔湾老司机', color: 0x6c757d, kind: 'mpv' },
];

export interface RaceSetup {
  line: LineId;
  /** arc length of the start line */
  startS: number;
  length: RaceLength;
  rivals: number;
  level: RaceLevel;
  /** tyre grip multiplier (rain) */
  gripScale: number;
}

export interface Entrant {
  name: string;
  color: number;
  kind: VehicleKind;
  car: Player;
  /** null for the player */
  driver: RaceDriver | null;
  /** metres covered along the line since the start line (negative on the grid) */
  progress: number;
  lastLs: number | null;
  /** race time at the finish */
  finish: number | null;
  stuck: number;
}

export interface RaceEvent {
  type: 'go' | 'overtake' | 'overtaken' | 'finish' | 'respawn';
  name?: string;
  rank?: number;
}

/** Builds the car of an AI entrant on the grid. */
export type CarFactory = (kind: VehicleKind, color: number, edge: Player['tracker']['edge'], s: number, name: string) => Player;

export class Race {
  readonly L: number;
  readonly distance: number;
  readonly entrants: Entrant[] = [];
  readonly curv: LineCurvature;
  /** race clock: negative during the countdown */
  clock = -COUNTDOWN;
  state: 'countdown' | 'racing' | 'done' = 'countdown';
  private lastRank = 0;
  private eventCooldown = 0;
  /** traffic as of the last plan() (for respawning into a free lane) */
  private traffic: Car[] = [];

  constructor(
    readonly net: RoadNetwork,
    readonly setup: RaceSetup,
    player: Player,
    makeCar: CarFactory,
  ) {
    const { line } = setup;
    this.L = net.lines[line].length;
    this.distance = raceDistance(this.L, setup.length);
    this.curv = new LineCurvature(net, line);
    const slots = this.grid(setup.rivals + 1);
    const base = SKILL[setup.level];
    for (let k = 0; k < setup.rivals; k++) {
      const r = RIVALS[k % RIVALS.length];
      const slot = slots[k];
      const car = makeCar(r.kind, r.color, slot.edge, slot.s, r.name);
      car.placeAt(slot.edge, slot.s, slot.d, 0);
      // a spread of talent: the first on the grid are a little quicker
      const f = 1 + 0.03 * (1 - (2 * k) / Math.max(1, setup.rivals - 1)) * (setup.rivals > 1 ? 1 : 0);
      const skill = { grip: base.grip * f, vmax: base.vmax * f, brake: base.brake };
      const driver = new RaceDriver(net, line, this.curv, skill);
      driver.lane = slot.lane;
      this.entrants.push({ name: r.name, color: r.color, kind: r.kind, car, driver, progress: this.rel(slot.ls), lastLs: slot.ls, finish: null, stuck: 0 });
    }
    const ps = slots[slots.length - 1];
    player.placeAt(ps.edge, ps.s, ps.d, 0);
    this.entrants.push({ name: '你', color: 0xffd34d, kind: 'sedan', car: player, driver: null, progress: this.rel(ps.ls), lastLs: ps.ls, finish: null, stuck: 0 });
    this.lastRank = this.entrants.length;
  }

  get player(): Entrant {
    return this.entrants[this.entrants.length - 1];
  }

  get rivals(): Entrant[] {
    return this.entrants.filter((e) => e.driver);
  }

  /** Arc length relative to the start line in (-L/2, L/2]. */
  private rel(ls: number) {
    let r = (((ls - this.setup.startS) % this.L) + this.L) % this.L;
    if (r > this.L / 2) r -= this.L;
    return r;
  }

  /** Staggered starting grid behind the start line; the player starts from the back. */
  grid(n: number) {
    const { line, startS } = this.setup;
    const at0 = this.net.atLineS(line, startS);
    const lanes = Math.max(1, Math.round(at0.edge.lanesAt(at0.s)));
    const perRow = Math.min(3, lanes);
    const out: { edge: Player['tracker']['edge']; s: number; d: number; ls: number; lane: number }[] = [];
    for (let j = 0; j < n; j++) {
      const row = Math.floor(j / perRow);
      const col = j % perRow;
      const ls = startS - 4 - row * 12 - col * 3.5;
      const loc = this.net.atLineS(line, ls);
      const lanesHere = Math.max(1, Math.round(loc.edge.lanesAt(loc.s)));
      const lane = Math.min(lanesHere - 1, perRow < lanes ? Math.round((col * (lanes - 1)) / Math.max(1, perRow - 1)) : col);
      out.push({ edge: loc.edge, s: loc.s, d: loc.edge.laneCenter(loc.s, lane), ls: (ls + this.L) % this.L, lane });
    }
    return out;
  }

  /** Arc length of the finish line. */
  get finishS() {
    return (this.setup.startS + this.distance) % this.L;
  }

  /** Everything on the race line, as seen by the drivers. */
  obstacles(traffic: Car[]): (Obstacle & { owner: unknown })[] {
    const { line } = this.setup;
    const out: (Obstacle & { owner: unknown })[] = [];
    const proj = newProjection();
    for (const c of traffic) {
      if (c.edge.kind === 'ramp') {
        // cars in an acceleration / deceleration lane right next to the race line
        const i = c.edge.idx(c.s);
        const side = c.edge.ol[i] >= 0 ? -1 : c.edge.or[i] >= 0 ? 1 : 0;
        const m = side ? this.net.edges[side < 0 ? c.edge.ol[i] : c.edge.or[i]] : null;
        if (!m || m.kind !== 'main' || m.line !== line) continue;
        m.project(c.x, c.z, m.length / 2, proj, m.n);
        if (proj.s < 0 || proj.s > m.length) continue;
        // about to merge: claims the outer lane on its side
        const merging = side < 0 ? c.dTarget < c.edge.blAt(c.s) : c.dTarget > c.edge.brAt(c.s);
        const lanes = Math.max(1, Math.round(m.lanesAt(proj.s)));
        out.push({ owner: c, ls: this.net.lineS(m, proj.s)!, fromLeft: fromLeftEdge(m, proj.s, proj.d), v: c.v, len: c.len, width: c.width, lane: merging ? (side < 0 ? lanes - 1 : 0) : undefined });
        continue;
      }
      if (c.edge.line !== line) continue;
      // a car changing lanes also claims the lane it is moving into
      const target = c.prepD ?? c.dTarget;
      const lane = Math.abs(target - c.d) > 0.3 ? Math.floor(fromLeftEdge(c.edge, c.s, target) / c.edge.laneWidth) : undefined;
      out.push({ owner: c, ls: this.net.lineS(c.edge, c.s)!, fromLeft: fromLeftEdge(c.edge, c.s, c.d), v: c.v, len: c.len, width: c.width, lane });
    }
    for (const en of this.entrants) {
      const t = en.car.tracker;
      if (t.edge.kind !== 'main' || t.edge.line !== line) continue;
      out.push({ owner: en, ls: this.net.lineS(t.edge, t.s)!, fromLeft: fromLeftEdge(t.edge, t.s, t.d), v: Math.max(0, en.car.dyn.vx), len: en.car.halfLength * 2, width: en.car.halfWidth * 2, lane: en.driver?.lane });
    }
    return out;
  }

  /** AI decisions for this frame (controls are applied by the physics steps). */
  plan(dt: number, traffic: Car[]) {
    this.traffic = traffic;
    const obs = this.obstacles(traffic);
    const me = this.player;
    for (const en of this.entrants) {
      const d = en.driver;
      if (!d) continue;
      if (this.state === 'countdown') {
        d.hold();
        continue;
      }
      const t = en.car.tracker;
      if (t.edge.kind !== 'main' || t.edge.line !== this.setup.line) {
        d.hold();
        continue;
      }
      // keep the field together a little: ease off when far ahead of the player, push when far behind
      const gap = en.progress - me.progress;
      d.pace = 1 - clamp(gap / 300, -1, 1) * 0.05;
      const ls = this.net.lineS(t.edge, t.s)!;
      d.drive(dt, en.car.dyn, t, ls, obs.filter((o) => o.owner !== en), this.setup.gripScale);
    }
  }

  /** One fixed physics step of the AI cars. */
  stepCars(dt: number) {
    for (const en of this.entrants) if (en.driver) en.car.step(dt, en.driver.controls);
  }

  /** Clock, distances, standings, finish, stuck cars. */
  update(dt: number): RaceEvent[] {
    const ev: RaceEvent[] = [];
    const wasCountdown = this.state === 'countdown';
    this.clock += dt;
    if (wasCountdown && this.clock >= 0) {
      this.state = 'racing';
      ev.push({ type: 'go' });
    }
    const { line } = this.setup;
    for (const en of this.entrants) {
      const t = en.car.tracker;
      if (t.edge.kind === 'main' && t.edge.line === line) {
        const ls = this.net.lineS(t.edge, t.s)!;
        if (en.lastLs !== null) {
          let delta = ls - en.lastLs;
          if (delta > this.L / 2) delta -= this.L;
          if (delta < -this.L / 2) delta += this.L;
          if (Math.abs(delta) < 80) en.progress += delta;
        }
        en.lastLs = ls;
      } else en.lastLs = null;
      if (this.state !== 'countdown' && en.finish === null && en.progress >= this.distance) {
        en.finish = this.clock;
        if (!en.driver) ev.push({ type: 'finish', rank: this.rankOf(en) });
      }
      if (en.driver && this.state !== 'countdown' && en.finish === null) this.watch(en, dt, ev);
    }
    if (this.player.finish !== null) this.state = 'done';
    // overtakes involving the player
    this.eventCooldown -= dt;
    const rank = this.rankOf(this.player);
    if (this.state === 'racing' && rank !== this.lastRank && this.eventCooldown <= 0) {
      const order = this.standings();
      if (rank < this.lastRank) ev.push({ type: 'overtake', name: order[rank]?.name, rank });
      else ev.push({ type: 'overtaken', name: order[rank - 2]?.name, rank });
      this.eventCooldown = 1.5;
      this.lastRank = rank;
    } else if (this.eventCooldown <= 0) this.lastRank = rank;
    return ev;
  }

  /** Put AI cars that are stuck, facing the wrong way or off the line back on track. */
  private watch(en: Entrant, dt: number, ev: RaceEvent[]) {
    const car = en.car;
    const t = car.tracker;
    const onLine = t.edge.kind === 'main' && t.edge.line === this.setup.line;
    const wrongWay = onLine && Math.cos(car.dyn.psi - t.roadHeading()) < -0.2;
    // standing still only counts when the driver wants to go (not when queueing in traffic)
    const blocked = car.dyn.vx < 2 && (en.driver?.target ?? 0) > 5;
    if (!onLine || wrongWay || blocked) en.stuck += dt;
    else en.stuck = Math.max(0, en.stuck - dt * 2);
    if (en.stuck > (onLine && !wrongWay ? 3.5 : 1.5)) {
      this.respawn(en);
      ev.push({ type: 'respawn', name: en.name });
    }
  }

  /** Back onto the race line where the car had got to, in the lane with the most room (rivals and traffic). */
  respawn(en: Entrant) {
    const ls = this.setup.startS + en.progress + 4;
    const loc = this.net.atLineS(this.setup.line, ls);
    const lanes = Math.max(1, Math.round(loc.edge.lanesAt(loc.s)));
    const here = this.net.lineS(loc.edge, loc.s)!;
    const others = this.obstacles(this.traffic).filter((o) => o.owner !== en);
    let best = 0;
    let bestGap = -Infinity;
    for (let k = 0; k < lanes; k++) {
      const from = (k + 0.5) * loc.edge.laneWidth;
      let gap = 60;
      for (const o of others) {
        if (Math.abs(o.fromLeft - from) > 2.6) continue;
        let along = (((o.ls - here) % this.L) + this.L) % this.L;
        if (along > this.L / 2) along -= this.L;
        gap = Math.min(gap, Math.abs(along));
      }
      if (gap > bestGap) {
        bestGap = gap;
        best = k;
      }
    }
    en.car.placeAt(loc.edge, loc.s, loc.edge.laneCenter(loc.s, best), 10);
    en.lastLs = this.net.lineS(loc.edge, loc.s);
    en.stuck = 0;
    en.driver?.reset(best);
  }

  /** Finished entrants by time, then the rest by distance covered. */
  standings(): Entrant[] {
    return this.entrants.slice().sort((a, b) => {
      if (a.finish !== null && b.finish !== null) return a.finish - b.finish;
      if (a.finish !== null) return -1;
      if (b.finish !== null) return 1;
      return b.progress - a.progress;
    });
  }

  rankOf(en: Entrant) {
    return this.standings().indexOf(en) + 1;
  }

  /** Distance still to go for the player (m). */
  get remaining() {
    return Math.max(0, this.distance - this.player.progress);
  }

  /** Results table: rank, name and time (or the gap for those still racing). */
  results(): [string, string][] {
    return this.standings().map((en, k) => {
      const who = en.driver ? en.name : '你';
      const time = en.finish !== null ? fmtRaceTime(en.finish) : `未完赛 · 还差 ${((this.distance - en.progress) / 1000).toFixed(2)} km`;
      return [`${k + 1}. ${who}`, time];
    });
  }
}

export function fmtRaceTime(t: number) {
  // round first, so that 119.996 s shows as 2:00.00 rather than 1:60.00
  const cs = Math.round(t * 100);
  const m = Math.floor(cs / 6000);
  return `${m}:${((cs - m * 6000) / 100).toFixed(2).padStart(5, '0')}`;
}

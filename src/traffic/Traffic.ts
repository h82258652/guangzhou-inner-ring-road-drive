/**
 * Traffic AI on the inner ring (both lines) and its ramps: Intelligent Driver
 * Model car following, MOBIL-style lane changes, mandatory lane changes for
 * exits, gap-accepting merges from entrance ramps, spawning around the player
 * and instanced rendering of several vehicle types with brake/head lights,
 * turn indicators (signal before changing lanes) and hazard lights after a crash.
 */
import * as THREE from 'three';
import { type Edge, type RoadNetwork, newFrame, newProjection } from '../road/Network';
import { buildVehicleGeometry, indicatorMaterial, PAINT_COLORS, plateAtlas, TAXI_COLOR, VEHICLES, type VehicleKind } from '../vehicle/CarModel';
import { clamp, mulberry32 } from '../shared/math';
import type { ExitFile, LineId } from '../shared/types';

export type Density = 'none' | 'sparse' | 'normal' | 'rush';

const KINDS: { kind: VehicleKind; w: number }[] = [
  { kind: 'sedan', w: 0.42 },
  { kind: 'taxi', w: 0.15 },
  { kind: 'suv', w: 0.18 },
  { kind: 'mpv', w: 0.09 },
  { kind: 'hatch', w: 0.1 },
  { kind: 'van', w: 0.03 },
  { kind: 'bus', w: 0.03 },
];
const MAX_PER_KIND = 260;
const DENSITY: Record<Density, number> = { none: 0, sparse: 4.5, normal: 11, rush: 30 };
const WINDOW = 1500;
/** share of drivers leaving at any given exit */
const EXIT_SHARE = 0.25;
/** chance per spawn tick (0.5 s) of feeding a car into an entrance ramp */
const RAMP_SPAWN: Record<Density, number> = { none: 0, sparse: 0.25, normal: 0.5, rush: 0.6 };
/** cars kept on the ramp of the next entrance ahead of the player */
const RAMP_FEED: Record<Density, number> = { none: 0, sparse: 1, normal: 2, rush: 3 };

export interface Car {
  id: number;
  kindIdx: number;
  edge: Edge;
  s: number;
  d: number;
  dTarget: number;
  v: number;
  v0f: number;
  acc: number;
  T: number;
  amax: number;
  bcomf: number;
  s0: number;
  len: number;
  width: number;
  exit: ExitFile | null;
  lcTimer: number;
  color: THREE.Color;
  plate: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  alive: boolean;
  bumped: number;
  /** turn indicator: -1 left, 1 right, 0 off */
  signal: number;
  sigHold: number;
  /** most drivers indicate; some do not */
  indicates: boolean;
  /** lane change waiting for the indicator to flash first (lateral target, timer, retries) */
  prepD: number | null;
  prepT: number;
  prepTries: number;
  /** hazard lights after a collision (seconds left) */
  hazard: number;
  /** last exit the car has decided about (each exit is considered once) */
  rolled: ExitFile | null;
  /** entrance ramp car timed to merge just ahead of the player */
  meet: EntranceChain | null;
  /** in the acceleration lane, letting the player catch up before merging */
  waitForPlayer: boolean;
}

interface EntranceChain {
  line: LineId;
  /** arc length of the merge point on the line */
  s: number;
  /** ramp edges from the first one to the edge that merges */
  chain: Edge[];
  length: number;
  /** distance from the start of the chain to where a car waiting to merge stops (0: nowhere to wait) */
  hold: number;
}

export interface PlayerProxy {
  edge: Edge;
  s: number;
  d: number;
  v: number;
  len: number;
  width: number;
  x: number;
  z: number;
  heading: number;
}

export class Traffic {
  readonly group = new THREE.Group();
  cars: Car[] = [];
  density: Density = 'normal';
  private nextId = 1;
  private rnd = mulberry32(42);
  private meshes: {
    body: THREE.InstancedMesh;
    trim: THREE.InstancedMesh;
    head: THREE.InstancedMesh;
    tail: THREE.InstancedMesh;
    ind: THREE.InstancedMesh;
    plate: THREE.InstancedMesh;
    len: number;
    width: number;
  }[] = [];
  private time = 0;
  private buckets = new Map<number, (Car | PlayerProxy)[]>();
  private spawnTimer = 0;
  private f = newFrame();
  private p = newProjection();
  night = 0;
  enabled = true;
  private plateRows = 8;
  /** body length / width per vehicle kind */
  private dims = KINDS.map(({ kind }) => ({ len: VEHICLES[kind].length, width: VEHICLES[kind].width }));

  /**
   * Ramp edges that end in an acceleration lane: sample index where the trailing
   * open (merge) zone towards a main line begins, and the arc length where the
   * tapering lane becomes too narrow to drive on (merging cars must be across by then).
   */
  private mergeZone = new Map<number, { start: number; stopS: number }>();
  /** entrance ramps: ramp chain from its first edge to the merging edge */
  private entranceChains: EntranceChain[] = [];

  /** `render: false` runs the simulation without GPU resources (tests, tools). */
  constructor(
    readonly net: RoadNetwork,
    opts: { render?: boolean } = {},
  ) {
    this.group.name = 'traffic';
    for (const e of net.edges) {
      if (e.kind !== 'ramp') continue;
      const last = e.n - 1;
      const side = e.ol[last] >= 0 ? -1 : e.or[last] >= 0 ? 1 : 0;
      if (!side) continue;
      const openTo = (i: number) => (side < 0 ? e.ol[i] : e.or[i]);
      const target = net.edges[openTo(last)];
      // an acceleration lane ends where the ramp joins that line (some exit ramps run alongside the line up to their end)
      if (target.kind !== 'main' || !e.succ.some((n) => n.kind === 'main' && n.line === target.line)) continue;
      // the merge zone is the open run that reaches the end of the edge (diverge zones touch its start)
      let k = last;
      while (k > 0 && openTo(k - 1) >= 0 && net.edges[openTo(k - 1)].kind === 'main' && net.edges[openTo(k - 1)].line === target.line) k--;
      let stopS = e.length;
      for (let i = k; i <= last; i++)
        if (e.lanes[i] < 0.7) {
          stopS = i * e.ds;
          break;
        }
      this.mergeZone.set(e.id, { start: k, stopS });
    }
    for (const en of net.entrances) {
      // up the ramp; where two ramps join, follow the longer one
      const chain = [net.edges[en.edge]];
      for (let k = 0; k < 6; k++) {
        const up = chain[0].pred.filter((p) => p.kind === 'ramp' && !chain.includes(p)).sort((a, b) => b.length - a.length)[0];
        if (!up) break;
        chain.unshift(up);
      }
      const length = chain.reduce((a, e) => a + e.length, 0);
      const last = chain[chain.length - 1];
      const mz = this.mergeZone.get(last.id);
      this.entranceChains.push({ line: en.line, s: en.s, chain, length, hold: mz ? length - last.length + mz.stopS : 0 });
    }
    if (opts.render !== false) this.initMeshes();
  }

  private initMeshes() {
    const atlas = plateAtlas(64, 7);
    this.plateRows = atlas.rows;
    const paint = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.45 });
    const trim = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.3 });
    const head = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const tail = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const indMat = indicatorMaterial('instanced').material;
    const plateMat = new THREE.MeshBasicMaterial({ map: atlas.tex });
    plateMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aPlate;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv = (uv + aPlate) / vec2(${atlas.cols}.0, ${atlas.rows}.0);`);
    };
    for (const { kind } of KINDS) {
      const g = buildVehicleGeometry(VEHICLES[kind]);
      const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, color: boolean) => {
        const m = new THREE.InstancedMesh(geo, mat, MAX_PER_KIND);
        m.count = 0;
        m.frustumCulled = false;
        if (color) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_KIND * 3), 3);
        this.group.add(m);
        return m;
      };
      const plateGeo = g.plate.clone();
      plateGeo.setAttribute('aPlate', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_KIND * 2), 2));
      const indGeo = g.ind.clone();
      indGeo.setAttribute('aInd', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_KIND * 2), 2));
      const body = mk(g.body, paint, true);
      body.castShadow = true;
      const trimM = mk(g.trim, trim, false);
      trimM.castShadow = true;
      this.meshes.push({
        body,
        trim: trimM,
        head: mk(g.head, head, true),
        tail: mk(g.tail, tail, true),
        ind: mk(indGeo, indMat, false),
        plate: mk(plateGeo, plateMat, false),
        len: g.params.length,
        width: g.params.width,
      });
    }
  }

  clear() {
    this.cars = [];
  }

  private pickKind(): number {
    let r = this.rnd();
    for (let i = 0; i < KINDS.length; i++) {
      r -= KINDS[i].w;
      if (r <= 0) return i;
    }
    return 0;
  }

  private makeCar(edge: Edge, s: number, lane: number, v: number): Car {
    const kindIdx = this.pickKind();
    const kind = KINDS[kindIdx].kind;
    const m = this.dims[kindIdx];
    const color = new THREE.Color(kind === 'taxi' ? TAXI_COLOR : kind === 'bus' ? 0x2e9a5a : PAINT_COLORS[Math.floor(this.rnd() * PAINT_COLORS.length)]);
    const rush = this.density === 'rush';
    const d = edge.laneCenter(s, lane);
    const car: Car = {
      id: this.nextId++,
      kindIdx,
      edge,
      s,
      d,
      dTarget: d,
      v,
      v0f: (kind === 'bus' ? 0.85 : 0.92 + this.rnd() * 0.24) * (rush ? 0.85 : 1),
      acc: 0,
      T: (kind === 'bus' ? 1.8 : 1.0 + this.rnd() * 0.7) * (rush ? 0.85 : 1),
      amax: kind === 'bus' ? 0.9 : 1.2 + this.rnd() * 0.8,
      bcomf: 2.0 + this.rnd() * 0.8,
      s0: 2 + this.rnd() * 1.2,
      len: m.len,
      width: m.width,
      exit: null,
      lcTimer: this.rnd() * 3,
      color,
      plate: Math.floor(this.rnd() * 64),
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      alive: true,
      bumped: 0,
      signal: 0,
      sigHold: 0,
      indicates: this.rnd() < 0.88,
      prepD: null,
      prepT: 0,
      prepTries: 0,
      hazard: 0,
      rolled: null,
      meet: null,
      waitForPlayer: false,
    };
    this.planExit(car);
    this.pose(car);
    return car;
  }

  /** Decide (once per exit) whether the car leaves at the next exit of its line. */
  private planExit(car: Car) {
    car.exit = null;
    if (car.edge.kind !== 'main' || !car.edge.line) return;
    const ls = this.net.lineS(car.edge, car.s)!;
    const L = this.net.lines[car.edge.line].length;
    let best: ExitFile | null = null;
    let bd = Infinity;
    for (const x of this.net.exits) {
      if (x.line !== car.edge.line) continue;
      const dist = (((x.s - ls) % L) + L) % L;
      if (dist > 80 && dist < bd) {
        bd = dist;
        best = x;
      }
    }
    if (!best || best === car.rolled) return;
    car.rolled = best;
    if (this.rnd() < EXIT_SHARE) car.exit = best;
  }

  /** World pose from (edge, s, d). */
  private pose(car: Car) {
    const fr = car.edge.frame(car.s, car.d, this.f);
    car.x = fr.x;
    car.y = car.edge.yAt(car.s);
    car.z = fr.z;
    const latV = clamp(car.dTarget - car.d, -1.1, 1.1);
    car.heading = Math.atan2(fr.tz, fr.tx) + Math.atan2(latV, Math.max(car.v, 3)) * 0.8;
  }

  /** Initial population around the player position on both lines. */
  populate(focusLine: LineId, focusS: number) {
    this.cars = [];
    for (const line of ['A', 'B'] as LineId[]) {
      const center = line === focusLine ? focusS : this.otherLineS(focusLine, focusS, line);
      this.fillLine(line, center - WINDOW, center + WINDOW, center);
    }
  }

  private otherLineS(line: LineId, s: number, other: LineId): number {
    const a = this.net.atLineS(line, s);
    const f = a.edge.frame(a.s, 0, this.f);
    let best = 0;
    let bd = Infinity;
    for (const e of this.net.lines[other].edges) {
      for (let i = 0; i < e.n; i += 8) {
        const d = (e.x[i] - f.x) ** 2 + (e.z[i] - f.z) ** 2;
        if (d < bd) {
          bd = d;
          best = (e.lineS0 ?? 0) + i * e.ds;
        }
      }
    }
    return best;
  }

  private fillLine(line: LineId, s0: number, s1: number, avoid: number) {
    const perLaneKm = DENSITY[this.density];
    if (perLaneKm <= 0) return;
    const spacing = 1000 / perLaneKm;
    for (let s = s0; s < s1; s += spacing * (0.6 + this.rnd() * 0.8)) {
      if (Math.abs(s - avoid) < 45) continue;
      const loc = this.net.atLineS(line, s);
      const lanes = Math.max(1, Math.round(loc.edge.lanesAt(loc.s)));
      for (let lane = 0; lane < lanes; lane++) {
        if (this.rnd() > 0.9) continue;
        const ss = s + (this.rnd() - 0.5) * spacing * 0.6;
        const l2 = this.net.atLineS(line, ss);
        const lim = l2.edge.speedAt(l2.s) / 3.6;
        const v = this.density === 'rush' ? lim * (0.25 + this.rnd() * 0.4) : lim * (0.85 + this.rnd() * 0.15);
        this.cars.push(this.makeCar(l2.edge, l2.s, lane, v));
      }
    }
  }

  private bucketize(player: PlayerProxy | null, others: PlayerProxy[]) {
    this.buckets.clear();
    const add = (o: Car | PlayerProxy) => {
      let a = this.buckets.get(o.edge.id);
      if (!a) this.buckets.set(o.edge.id, (a = []));
      a.push(o);
    };
    for (const c of this.cars) if (c.alive) add(c);
    if (player) add(player);
    for (const o of others) add(o);
    for (const a of this.buckets.values()) a.sort((p, q) => p.s - q.s);
  }

  private nextEdge(car: Car, e: Edge): Edge | null {
    if (!e.succ.length) return null;
    if (e.succ.length === 1) return e.succ[0];
    if (e.kind === 'main') return e.succ.find((n) => n.kind === 'main' && n.line === e.line) ?? e.succ[0];
    // ramps: random but stable per car
    return e.succ[car.id % e.succ.length];
  }

  /** Nearest object ahead within the lateral band [dLo, dHi]. */
  private leader(car: Car, d: number, half: number, maxLook = 160): { gap: number; v: number } | null {
    let e: Edge | null = car.edge;
    let base = -car.s;
    for (let hop = 0; e && hop < 6; hop++) {
      const list = this.buckets.get(e.id);
      if (list) {
        for (const o of list) {
          if (o === car) continue;
          const sRel = base + o.s;
          if (sRel <= 0) continue;
          if (sRel > maxLook) break;
          if (Math.abs(o.d - d) > half + o.width / 2 + 0.2) continue;
          return { gap: sRel - (o.len + car.len) / 2, v: o.v };
        }
      }
      base += e.length;
      if (base > maxLook) break;
      e = this.nextEdge(car, e);
    }
    return null;
  }

  private follower(car: Car, edge: Edge, s: number, d: number, half: number): { gap: number; v: number } | null {
    const list = this.buckets.get(edge.id);
    let best: { gap: number; v: number } | null = null;
    if (list) {
      for (const o of list) {
        if (o === car || o.s >= s) continue;
        if (Math.abs(o.d - d) > half + o.width / 2 + 0.2) continue;
        const gap = s - o.s - (o.len + car.len) / 2;
        if (!best || gap < best.gap) best = { gap, v: o.v };
      }
    }
    // look into predecessors
    if (!best && edge.pred.length) {
      const pe = edge.pred.find((p) => p.kind === edge.kind) ?? edge.pred[0];
      const pl = this.buckets.get(pe.id);
      if (pl) {
        for (const o of pl) {
          if (o === car || Math.abs(o.d - d) > half + o.width / 2 + 0.2) continue;
          const gap = s + pe.length - o.s - (o.len + car.len) / 2;
          if (!best || gap < best.gap) best = { gap, v: o.v };
        }
      }
    }
    return best;
  }

  private idm(car: Car, v0: number, lead: { gap: number; v: number } | null) {
    const v = car.v;
    let a = car.amax * (1 - Math.pow(v / Math.max(v0, 1), 4));
    if (lead) {
      const dv = v - lead.v;
      const sStar = car.s0 + Math.max(0, v * car.T + (v * dv) / (2 * Math.sqrt(car.amax * car.bcomf)));
      const gap = Math.max(lead.gap, 0.1);
      a -= car.amax * (sStar / gap) * (sStar / gap);
    }
    return clamp(a, -9, car.amax);
  }

  /**
   * @param player the player's car (also the focus for spawning); null in the menu
   * @param others further vehicles the traffic must respect (race opponents)
   */
  update(dt: number, player: PlayerProxy | null, focus: THREE.Vector3, others: PlayerProxy[] = []) {
    if (!this.enabled) return;
    this.time += dt;
    this.bucketize(player, others);
    const half = (c: Car) => c.width / 2;
    for (const car of this.cars) {
      if (!car.alive) continue;
      const e = car.edge;
      const limit = e.speedAt(car.s) / 3.6;
      // look ahead for lower limits
      const aheadLimit = e.speedAt(Math.min(e.length, car.s + 60)) / 3.6;
      let v0 = Math.min(limit, aheadLimit) * car.v0f;
      if (car.meet) v0 = this.meetSpeed(car, player, v0);
      const lead = this.leader(car, car.d, half(car));
      let a = this.idm(car, v0, lead);
      // acceleration lane: until the car is cleared to merge, the end of the taper acts like a stop line
      const mz = e.kind === 'ramp' ? this.mergeZone.get(e.id) : undefined;
      if (mz && car.s < mz.stopS && car.dTarget >= e.blAt(car.s) && car.dTarget <= e.brAt(car.s)) {
        const gap = mz.stopS - car.s - car.len / 2;
        if (gap < 150) a = Math.min(a, this.idm(car, v0, { gap, v: 0 }));
      }
      // a car timed for the player waits at the hold point of its ramp (which may lie on an earlier ramp edge)
      if (car.meet && car.waitForPlayer) {
        const k = car.meet.chain.indexOf(e);
        let pos = car.s;
        for (let j = 0; j < k; j++) pos += car.meet.chain[j].length;
        if (k >= 0) a = Math.min(a, this.idm(car, v0, { gap: Math.max(0.1, car.meet.hold - pos - car.len / 2), v: 0 }));
      }
      if (car.bumped > 0) {
        car.bumped -= dt;
        a = Math.min(a, -3);
      }
      car.acc = a;
      car.v = Math.max(0, car.v + a * dt);
      car.s += car.v * dt;

      // lane changes: indicate first, then move if the gap is still safe
      car.lcTimer -= dt;
      if (car.prepD !== null) {
        car.prepT -= dt;
        if (car.prepT <= 0) {
          if (this.safeChange(car, car.prepD, 3.5)) {
            car.dTarget = car.prepD;
            car.prepD = null;
          } else if (++car.prepTries > (car.exit ? 14 : 3)) car.prepD = null;
          else car.prepT = 0.5;
        }
      }
      this.laneLogic(car, dt);
      // lateral speed: about a lane in 3 s at speed, slower when crawling
      const latRate = Math.min(1.1, 0.3 + car.v * 0.12) * dt;
      car.d += clamp(car.dTarget - car.d, -latRate, latRate);
      this.updateIndicators(car, dt);

      // open side transfer (exits / merges) — only when the car means to cross, so that slightly
      // different bounds of the two decks cannot bounce it back and forth
      const i = car.edge.idx(car.s);
      if (car.d > car.edge.br[i] && car.dTarget > car.edge.br[i] && car.edge.or[i] >= 0) this.transfer(car, this.net.edges[car.edge.or[i]]);
      else if (car.d < car.edge.bl[i] && car.dTarget < car.edge.bl[i] && car.edge.ol[i] >= 0) this.transfer(car, this.net.edges[car.edge.ol[i]]);

      // edge end
      while (car.alive && car.s > car.edge.length) {
        const nx = this.nextEdge(car, car.edge);
        if (!nx) {
          car.alive = false;
          break;
        }
        car.s -= car.edge.length;
        // keep the world position continuous (the centrelines of consecutive edges may be offset)
        const fr = car.edge.frame(car.edge.length, car.d, this.f);
        nx.project(fr.x, fr.z, car.s, this.p, 12);
        car.edge = nx;
        const shift = this.p.d - car.d;
        if (car.prepD !== null) car.prepD += shift;
        car.d = this.p.d;
        car.dTarget = clamp(car.dTarget + shift, nx.blAt(car.s) + car.width / 2, nx.brAt(car.s) - car.width / 2);
        if (nx.kind === 'main' && (!car.exit || car.exit.line !== nx.line)) this.planExit(car);
      }
      if (!car.alive) continue;
      // keep inside the lane area
      const bl = car.edge.blAt(car.s);
      const br = car.edge.brAt(car.s);
      if (car.edge.ol[car.edge.idx(car.s)] < 0) car.d = Math.max(car.d, bl + car.width / 2);
      if (car.edge.or[car.edge.idx(car.s)] < 0) car.d = Math.min(car.d, br - car.width / 2);
      this.pose(car);
      // despawn far away
      const dx = car.x - focus.x;
      const dz = car.z - focus.z;
      if (dx * dx + dz * dz > (WINDOW + 300) ** 2) car.alive = false;
    }
    this.cars = this.cars.filter((c) => c.alive);
    this.spawn(dt, player, focus, others);
  }

  private laneLogic(car: Car, _dt: number) {
    const e = car.edge;
    const lanes = e.lanesAt(car.s);
    const lw = e.laneWidth;
    const curLane = clamp(e.laneIndex(car.s, car.dTarget), 0, Math.max(0, Math.ceil(lanes) - 1));
    const laneCenter = (k: number) => e.laneCenter(car.s, k);
    // merging from an entrance ramp onto the main line through the open side of the acceleration lane
    // (the open side at the start of an exit ramp is the deceleration lane: cars keep going)
    const i = e.idx(car.s);
    const mz = e.kind === 'ramp' ? this.mergeZone.get(e.id) : undefined;
    if (mz && i >= mz.start && (e.ol[i] >= 0 || e.or[i] >= 0)) {
      const sideRight = e.or[i] >= 0;
      const target = this.net.edges[sideRight ? e.or[i] : e.ol[i]];
      if (target.kind === 'main' && car.lcTimer <= 0 && !car.waitForPlayer) {
        car.lcTimer = 0.4;
        const fr = e.frame(car.s, car.d, this.f);
        target.project(fr.x, fr.z, target.length / 2, this.p, target.n);
        const tl = Math.max(0, Math.round(target.lanesAt(this.p.s)) - 1);
        const laneD = sideRight ? target.laneCenter(this.p.s, 0) : target.laneCenter(this.p.s, tl);
        const lead = this.leaderAt(target, this.p.s, laneD, car);
        const foll = this.follower(car, target, this.p.s, laneD, car.width / 2);
        const okLead = !lead || lead.gap > car.v * 0.5 + 4;
        const okFoll = !foll || foll.gap > Math.max(0, foll.v - car.v) * 1.5 + foll.v * 0.6 + 4;
        if (okLead && okFoll) car.dTarget = sideRight ? e.brAt(car.s) + 2.0 : e.blAt(car.s) - 2.0;
      }
      return;
    }
    if (e.kind !== 'main' || !e.line) {
      // ramps: keep to lane centre
      const c = this.laneTarget(e, car.s, curLane, car.width / 2);
      if (Math.abs(car.dTarget - c) > 0.05 && Math.abs(car.d - car.dTarget) < 0.1) car.dTarget = c;
      return;
    }
    // the road narrowed under the car (a lane ends): move into a lane that still exists right away
    if (car.prepD === null && Math.abs(car.d - car.dTarget) < 0.3 && Math.abs(car.dTarget - laneCenter(curLane)) > 0.5) car.dTarget = laneCenter(curLane);
    // mandatory: planned exit
    if (car.exit) {
      const ls = this.net.lineS(e, car.s)!;
      const L = this.net.lines[e.line].length;
      const dist = (((car.exit.s - ls) % L) + L) % L;
      const right = car.exit.side === 'right';
      const wantLane = right ? Math.ceil(lanes) - 1 : 0;
      if (dist > L - 160) {
        // just passed the diverge point: steer into the deceleration lane while it is open
        const openId = right ? e.or[i] : e.ol[i];
        if (openId === car.exit.edge && curLane === wantLane) car.dTarget = right ? e.brAt(car.s) + 2.0 : e.blAt(car.s) - 2.0;
        return;
      }
      if (dist > L / 2) {
        // missed it: think about the next one
        this.planExit(car);
        return;
      }
      if (dist < 650 && car.lcTimer <= 0 && curLane !== wantLane && car.prepD === null) {
        const dir = wantLane > curLane ? 1 : -1;
        this.prepareChange(car, laneCenter(curLane + dir), 0.9);
        car.lcTimer = 2.5 + car.prepT;
      }
      if (dist < 650) return;
    }
    if (car.lcTimer > 0 || car.prepD !== null || Math.abs(car.d - car.dTarget) > 0.3) return;
    car.lcTimer = 1.5 + this.rnd() * 2.5;
    // discretionary MOBIL
    const curLead = this.leader(car, laneCenter(curLane), car.width / 2);
    const v0 = (e.speedAt(car.s) / 3.6) * car.v0f;
    const aCur = this.idm(car, v0, curLead);
    let bestGain = 0.35;
    let best = -1;
    for (const dir of [-1, 1]) {
      const k = curLane + dir;
      if (k < 0 || k > Math.ceil(lanes) - 1 || lanes - k < 0.95) continue;
      const dk = laneCenter(k);
      const lead = this.leader(car, dk, car.width / 2);
      const aNew = this.idm(car, v0, lead);
      // keep-right bias for slower vehicles
      const bias = dir > 0 ? 0.12 : -0.05;
      const gain = aNew - aCur + bias;
      if (gain > bestGain && this.safeChange(car, dk, 3.0)) {
        bestGain = gain;
        best = k;
      }
    }
    if (best >= 0) this.prepareChange(car, laneCenter(best), 1.0);
    else if (Math.abs(car.dTarget - laneCenter(curLane)) > 0.05) car.dTarget = laneCenter(curLane);
    void lw;
  }

  /** Queue a lane change; drivers who indicate flash for a moment before moving over. */
  private prepareChange(car: Car, dTarget: number, minT: number) {
    car.prepD = dTarget;
    car.prepT = car.indicates ? minT + this.rnd() * 1.1 : 0.2;
    car.prepTries = 0;
  }

  private updateIndicators(car: Car, dt: number) {
    let sig = 0;
    if (car.prepD !== null) sig = Math.sign(car.prepD - car.d);
    else if (Math.abs(car.dTarget - car.d) > 0.8) sig = Math.sign(car.dTarget - car.d);
    else sig = this.intentSignal(car);
    if (!car.indicates) sig = 0;
    if (sig !== 0) {
      car.signal = sig;
      car.sigHold = 0.8;
    } else if (car.sigHold > 0) {
      car.sigHold -= dt;
      if (car.sigHold <= 0) car.signal = 0;
    }
    if (car.bumped > 0) car.hazard = 8;
    else if (car.hazard > 0) car.hazard -= dt;
  }

  /** Indicate towards a planned exit or towards the main line while merging from an entrance ramp. */
  private intentSignal(car: Car): number {
    const e = car.edge;
    if (car.exit && e.kind === 'main' && e.line) {
      const L = this.net.lines[e.line].length;
      const dist = (((car.exit.s - this.net.lineS(e, car.s)!) % L) + L) % L;
      if (dist < 280 || dist > L - 150) return car.exit.side === 'right' ? 1 : -1;
      return 0;
    }
    if (e.kind === 'ramp') {
      for (const ahead of [0, 50, 110]) {
        const i = e.idx(Math.min(e.length, car.s + ahead));
        if (e.ol[i] >= 0 && this.net.edges[e.ol[i]].kind === 'main') return -1;
        if (e.or[i] >= 0 && this.net.edges[e.or[i]].kind === 'main') return 1;
      }
    }
    return 0;
  }

  private leaderAt(edge: Edge, s: number, d: number, car: Car): { gap: number; v: number } | null {
    const list = this.buckets.get(edge.id);
    if (!list) return null;
    for (const o of list) {
      if (o === car || o.s <= s) continue;
      if (Math.abs(o.d - d) > car.width / 2 + o.width / 2 + 0.2) continue;
      return { gap: o.s - s - (o.len + car.len) / 2, v: o.v };
    }
    return null;
  }

  private safeChange(car: Car, dTarget: number, bSafe: number): boolean {
    const lead = this.leader(car, dTarget, car.width / 2, 80);
    if (lead && lead.gap < 3 + car.v * 0.4) return false;
    const foll = this.follower(car, car.edge, car.s, dTarget, car.width / 2);
    if (foll) {
      if (foll.gap < 3) return false;
      // follower's required deceleration
      const dv = foll.v - car.v;
      const need = dv > 0 ? (dv * dv) / (2 * Math.max(foll.gap - 2, 0.5)) : 0;
      if (need > bSafe) return false;
    }
    return true;
  }

  private transfer(car: Car, n: Edge) {
    const fr = car.edge.frame(car.s, car.d, this.f);
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n.n; i += 3) {
      const d = (n.x[i] - fr.x) ** 2 + (n.z[i] - fr.z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    n.project(fr.x, fr.z, best * n.ds, this.p, 16);
    if (this.p.s < 0 || this.p.s > n.length) return;
    car.edge = n;
    car.s = this.p.s;
    car.d = this.p.d;
    const lanes = Math.max(1, Math.round(n.lanesAt(car.s)));
    const k = clamp(n.laneIndex(car.s, car.d), 0, lanes - 1);
    car.dTarget = this.laneTarget(n, car.s, k, car.width / 2);
    car.prepD = null;
    if (n.kind === 'main') this.planExit(car);
    else car.exit = null;
  }

  /** Lane centre kept within the drivable band (tapering lanes are narrower than a full lane). */
  private laneTarget(e: Edge, s: number, k: number, half: number) {
    const lo = e.blAt(s) + half + 0.1;
    const hi = e.brAt(s) - half - 0.1;
    return lo <= hi ? clamp(e.laneCenter(s, k), lo, hi) : (lo + hi) / 2;
  }

  private spawn(dt: number, player: PlayerProxy | null, focus: THREE.Vector3, others: PlayerProxy[]) {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0 || !player) return;
    this.spawnTimer = 0.5;
    const perLaneKm = DENSITY[this.density];
    for (const line of ['A', 'B'] as LineId[]) {
      const lineEdges = this.net.lines[line];
      // focus position on this line
      const ps = player.edge.line === line && player.edge.kind === 'main' ? this.net.lineS(player.edge, player.s)! : this.otherLineSFromPoint(line, focus);
      const L = lineEdges.length;
      for (const dir of [1, -1]) {
        // count cars in the far band
        const band0 = 700;
        const band1 = WINDOW;
        let count = 0;
        for (const c of this.cars) {
          if (c.edge.line !== line || c.edge.kind !== 'main') continue;
          const cs = this.net.lineS(c.edge, c.s)!;
          let rel = (((cs - ps) % L) + L) % L;
          if (rel > L / 2) rel -= L;
          if (rel * dir > band0 && rel * dir < band1) count++;
        }
        const target = ((band1 - band0) / 1000) * perLaneKm * 2.8;
        if (count < target * 0.9 && this.totalCount() < KINDS.length * MAX_PER_KIND * 0.9) {
          const s = ps + dir * (band0 + this.rnd() * (band1 - band0));
          const loc = this.net.atLineS(line, s);
          const lanes = Math.max(1, Math.round(loc.edge.lanesAt(loc.s)));
          const lane = Math.floor(this.rnd() * lanes);
          const dLane = loc.edge.laneCenter(loc.s, lane);
          // keep a gap to existing cars
          const taken = (c: Car | PlayerProxy) => c.edge === loc.edge && Math.abs(c.s - loc.s) < 25 && Math.abs(c.d - dLane) < 2.5;
          if (this.cars.some(taken) || others.some(taken)) continue;
          const lim = loc.edge.speedAt(loc.s) / 3.6;
          const v = this.density === 'rush' ? lim * (0.2 + this.rnd() * 0.4) : lim * (0.85 + this.rnd() * 0.2);
          this.cars.push(this.makeCar(loc.edge, loc.s, lane, v));
        }
      }
    }
    this.feedEntranceAhead(player, focus);
    if (this.rnd() < RAMP_SPAWN[this.density]) {
      // background flow on the other entrances around
      const near = this.entranceChains.filter((ch) => {
        const first = ch.chain[0];
        const d2 = (first.x[0] - focus.x) ** 2 + (first.z[0] - focus.z) ** 2;
        return d2 > 350 * 350 && d2 < 1200 * 1200;
      });
      if (near.length) {
        const ch = near[Math.floor(this.rnd() * near.length)];
        this.spawnOnChain(ch, ch.length - 4, focus);
      }
    }
  }

  /**
   * Keeps the next entrance ahead of the player supplied with cars placed so
   * that they reach the acceleration lane at about the time the player passes:
   * merging traffic is then actually seen instead of happening out of sight.
   */
  private feedEntranceAhead(player: PlayerProxy, focus: THREE.Vector3) {
    if (player.edge.kind !== 'main' || !player.edge.line) return;
    const line = player.edge.line;
    const pls = this.net.lineS(player.edge, player.s)!;
    const L = this.net.lines[line].length;
    const pv = Math.max(player.v, 8);
    let best: EntranceChain | null = null;
    let bestAhead = Infinity;
    for (const ch of this.entranceChains) {
      if (ch.line !== line) continue;
      const ahead = (((ch.s - pls) % L) + L) % L;
      if (ahead > 250 && ahead < 1500 && ahead < bestAhead) {
        bestAhead = ahead;
        best = ch;
      }
    }
    // a timed car must be able to wait for the player before the end of the acceleration lane
    if (!best || best.hold < 60 || this.rnd() > 0.4) return;
    const chain = best;
    if (this.cars.filter((c) => c.meet === chain).length >= RAMP_FEED[this.density]) return;
    // where on the ramp a car averaging ~8.5 m/s reaches the acceleration lane together with the player;
    // otherwise start further up (out of sight) and let the car pace itself — always short of the stop line
    const zone = this.mergeZoneLength(chain);
    const ideal = zone + (Math.max(0, bestAhead - zone) * 8.5) / pv;
    const top = chain.length - 4;
    const lowest = chain.length - chain.hold + 25;
    if (lowest > top) return;
    for (const back of [clamp(ideal, lowest, top), top, (clamp(ideal, lowest, top) + top) / 2]) {
      const car = this.spawnOnChain(chain, back, focus, player.heading);
      if (car) {
        car.meet = chain;
        break;
      }
    }
  }

  /** Places a car `back` metres before the end of an entrance ramp chain (if that spot is free and out of sight). */
  private spawnOnChain(ch: EntranceChain, back: number, focus: THREE.Vector3, heading?: number): Car | null {
    let rest = ch.length - back;
    let k = 0;
    while (k < ch.chain.length - 1 && rest > ch.chain[k].length) rest -= ch.chain[k++].length;
    const e = ch.chain[k];
    const s = clamp(rest, 2, e.length - 2);
    // never pop up in plain view: far away, or behind the player, or well below / above the deck the player is on
    const fr = e.frame(s, 0, this.f);
    const dx = fr.x - focus.x;
    const dz = fr.z - focus.z;
    const dist = Math.hypot(dx, dz);
    const behind = heading !== undefined && dx * Math.cos(heading) + dz * Math.sin(heading) < -20;
    const otherLevel = Math.abs(e.yAt(s) - focus.y) > 5;
    if (dist < 240 && !(dist > 90 && (behind || otherLevel))) return null;
    if (this.cars.some((c) => c.edge === e && Math.abs(c.s - s) < 30)) return null;
    if (this.cars.filter((c) => ch.chain.includes(c.edge)).length >= 5) return null;
    const lanes = Math.max(1, Math.round(e.lanesAt(s)));
    const lane = Math.floor(this.rnd() * lanes);
    const car = this.makeCar(e, s, lane, (e.speedAt(s) / 3.6) * (0.75 + this.rnd() * 0.15));
    this.cars.push(car);
    return car;
  }

  /**
   * Desired speed of a ramp car that should join the line just ahead of the
   * player: it aims to reach the start of the acceleration lane together with
   * the player (never crawling below a believable minimum).
   */
  private meetSpeed(car: Car, player: PlayerProxy | null, v0: number): number {
    const ch = car.meet!;
    const k = ch.chain.indexOf(car.edge);
    car.waitForPlayer = false;
    if (k < 0 || !player || player.edge.kind !== 'main' || player.edge.line !== ch.line) {
      car.meet = null;
      return v0;
    }
    let rem = car.edge.length - car.s;
    for (let j = k + 1; j < ch.chain.length; j++) rem += ch.chain[j].length;
    const L = this.net.lines[ch.line].length;
    const ahead = (((ch.s - this.net.lineS(player.edge, player.s)!) % L) + L) % L;
    if (ahead > L / 2) {
      // the player has gone by
      car.meet = null;
      return v0;
    }
    // the ramp runs alongside the line in the acceleration lane, so distances to the merge point compare directly
    const lead = ahead - rem;
    const zone = this.mergeZoneLength(ch);
    // early: wait (at the hold point, see update) until the player is close behind, then go
    const pos = ch.length - rem;
    car.waitForPlayer = lead > 160 && pos < ch.hold - 2;
    if (rem <= zone) return car.waitForPlayer ? Math.min(v0, Math.max(3, player.v * 0.5)) : v0;
    // reach the start of the acceleration lane when the player is still ~25 m short of it
    const dCar = rem - zone;
    const dPlayer = ahead - zone - 25;
    if (dPlayer <= 0) return v0;
    return clamp(dCar / (dPlayer / Math.max(player.v, 4)), 3, v0);
  }

  private mergeZoneLength(ch: EntranceChain) {
    const last = ch.chain[ch.chain.length - 1];
    const mz = this.mergeZone.get(last.id);
    return mz ? last.length - mz.start * last.ds : 0;
  }

  /** Removes traffic between two arc lengths of a line (e.g. to clear a starting grid). */
  clearLine(line: LineId, s0: number, s1: number) {
    const L = this.net.lines[line].length;
    this.cars = this.cars.filter((c) => {
      if (c.edge.kind !== 'main' || c.edge.line !== line) return true;
      const rel = (((this.net.lineS(c.edge, c.s)! - s0) % L) + L) % L;
      return rel > s1 - s0;
    });
  }

  private otherLineSFromPoint(line: LineId, p: THREE.Vector3) {
    let best = 0;
    let bd = Infinity;
    for (const e of this.net.lines[line].edges) {
      for (let i = 0; i < e.n; i += 10) {
        const d = (e.x[i] - p.x) ** 2 + (e.z[i] - p.z) ** 2;
        if (d < bd) {
          bd = d;
          best = (e.lineS0 ?? 0) + i * e.ds;
        }
      }
    }
    return best;
  }

  private totalCount() {
    return this.cars.length;
  }

  /** Push instance transforms and light states to the GPU. */
  render(night: number) {
    if (!this.meshes.length) return;
    const counts = new Array(this.meshes.length).fill(0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const headC = new THREE.Color();
    const tailC = new THREE.Color();
    for (const car of this.cars) {
      const k = car.kindIdx;
      const i = counts[k];
      if (i >= MAX_PER_KIND) continue;
      counts[k]++;
      const ms = this.meshes[k];
      q.setFromAxisAngle(up, -car.heading);
      // slight pitch from road grade
      const g = car.edge.gradeAt(car.s);
      const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan(g));
      q.multiply(pitch);
      pos.set(car.x, car.y, car.z);
      m.compose(pos, q, one);
      ms.body.setMatrixAt(i, m);
      ms.trim.setMatrixAt(i, m);
      ms.head.setMatrixAt(i, m);
      ms.tail.setMatrixAt(i, m);
      ms.ind.setMatrixAt(i, m);
      ms.plate.setMatrixAt(i, m);
      const flash = Math.floor((this.time + car.id * 0.37) * 2.6) % 2 === 0 ? 1 : 0;
      const ia = ms.ind.geometry.getAttribute('aInd') as THREE.InstancedBufferAttribute;
      ia.setXY(i, car.hazard > 0 || car.signal < 0 ? flash : 0, car.hazard > 0 || car.signal > 0 ? flash : 0);
      ms.body.setColorAt(i, car.color);
      const braking = car.acc < -1.2 || car.v < 0.5;
      headC.setRGB(1, 1, 0.95).multiplyScalar(night > 0.4 ? 2.6 : 0.7);
      tailC.setRGB(1, 0.03, 0.02).multiplyScalar(braking ? 2.4 : night > 0.4 ? 1.0 : 0.3);
      ms.head.setColorAt(i, headC);
      ms.tail.setColorAt(i, tailC);
      const pa = ms.plate.geometry.getAttribute('aPlate') as THREE.InstancedBufferAttribute;
      // atlas rows count from the top of the canvas; texture v grows upwards
      pa.setXY(i, car.plate % 8, this.plateRows - 1 - Math.floor(car.plate / 8));
    }
    this.meshes.forEach((ms, k) => {
      for (const im of [ms.body, ms.trim, ms.head, ms.tail, ms.ind, ms.plate]) {
        im.count = counts[k];
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
      (ms.plate.geometry.getAttribute('aPlate') as THREE.InstancedBufferAttribute).needsUpdate = true;
      (ms.ind.geometry.getAttribute('aInd') as THREE.InstancedBufferAttribute).needsUpdate = true;
    });
  }
}



/**
 * Traffic AI on the inner ring (both lines) and its ramps: Intelligent Driver
 * Model car following, MOBIL-style lane changes, mandatory lane changes for
 * exits, gap-accepting merges from entrance ramps, spawning around the player
 * and instanced rendering of several vehicle types with brake/head lights.
 */
import * as THREE from 'three';
import { type Edge, type RoadNetwork, newFrame, newProjection } from '../road/Network';
import { buildVehicleGeometry, PAINT_COLORS, plateAtlas, TAXI_COLOR, VEHICLES, type VehicleKind } from '../vehicle/CarModel';
import { clamp, mulberry32 } from '../shared/math';
import type { ExitFile, LineId } from '../shared/types';

export type Density = 'sparse' | 'normal' | 'rush';

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
const DENSITY: Record<Density, number> = { sparse: 4.5, normal: 11, rush: 30 };
const WINDOW = 1500;

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
  private meshes: { body: THREE.InstancedMesh; trim: THREE.InstancedMesh; head: THREE.InstancedMesh; tail: THREE.InstancedMesh; plate: THREE.InstancedMesh; len: number; width: number }[] = [];
  private buckets = new Map<number, (Car | PlayerProxy)[]>();
  private spawnTimer = 0;
  private f = newFrame();
  private p = newProjection();
  night = 0;
  enabled = true;

  constructor(readonly net: RoadNetwork) {
    this.group.name = 'traffic';
    const atlas = plateAtlas(64, 7);
    const paint = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.45 });
    const trim = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.3 });
    const head = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const tail = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
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
      const body = mk(g.body, paint, true);
      body.castShadow = true;
      const trimM = mk(g.trim, trim, false);
      trimM.castShadow = true;
      this.meshes.push({
        body,
        trim: trimM,
        head: mk(g.head, head, true),
        tail: mk(g.tail, tail, true),
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
    const m = this.meshes[kindIdx];
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
    };
    this.planExit(car);
    return car;
  }

  /** Choose whether to take the next exit on the current line. */
  private planExit(car: Car) {
    car.exit = null;
    if (car.edge.kind !== 'main' || !car.edge.line) return;
    const ls = this.net.lineS(car.edge, car.s)!;
    const L = this.net.lines[car.edge.line].length;
    const exits = this.net.exits.filter((x) => x.line === car.edge.line);
    let best: ExitFile | null = null;
    let bd = Infinity;
    for (const x of exits) {
      const dist = (((x.s - ls) % L) + L) % L;
      if (dist > 80 && dist < bd) {
        bd = dist;
        best = x;
      }
    }
    if (best && this.rnd() < 0.16) car.exit = best;
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

  private bucketize(player: PlayerProxy | null) {
    this.buckets.clear();
    const add = (o: Car | PlayerProxy) => {
      let a = this.buckets.get(o.edge.id);
      if (!a) this.buckets.set(o.edge.id, (a = []));
      a.push(o);
    };
    for (const c of this.cars) if (c.alive) add(c);
    if (player) add(player);
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

  update(dt: number, player: PlayerProxy | null, focus: THREE.Vector3) {
    if (!this.enabled) return;
    this.bucketize(player);
    const half = (c: Car) => c.width / 2;
    for (const car of this.cars) {
      if (!car.alive) continue;
      const e = car.edge;
      const limit = e.speedAt(car.s) / 3.6;
      // look ahead for lower limits
      const aheadLimit = e.speedAt(Math.min(e.length, car.s + 60)) / 3.6;
      const v0 = Math.min(limit, aheadLimit) * car.v0f;
      const lead = this.leader(car, car.d, half(car));
      let a = this.idm(car, v0, lead);
      // ramps that taper out: stop before the end if not merged
      if (e.kind === 'ramp' && !e.succ.length) {
        // terminal ramp: just continue (despawn at the end)
      }
      if (car.bumped > 0) {
        car.bumped -= dt;
        a = Math.min(a, -3);
      }
      car.acc = a;
      car.v = Math.max(0, car.v + a * dt);
      car.s += car.v * dt;

      // lane changes
      car.lcTimer -= dt;
      this.laneLogic(car, dt);
      const latRate = 1.1 * dt;
      car.d += clamp(car.dTarget - car.d, -latRate, latRate);

      // open side transfer (exits / merges)
      const i = car.edge.idx(car.s);
      if (car.d > car.edge.br[i] && car.edge.or[i] >= 0) this.transfer(car, this.net.edges[car.edge.or[i]]);
      else if (car.d < car.edge.bl[i] && car.edge.ol[i] >= 0) this.transfer(car, this.net.edges[car.edge.ol[i]]);

      // edge end
      while (car.alive && car.s > car.edge.length) {
        const nx = this.nextEdge(car, car.edge);
        if (!nx) {
          car.alive = false;
          break;
        }
        car.s -= car.edge.length;
        // keep the world position continuous
        const fr = car.edge.frame(car.edge.length, car.d, this.f);
        nx.project(fr.x, fr.z, car.s, this.p, 12);
        car.edge = nx;
        car.d = this.p.d;
        car.dTarget = clamp(car.dTarget, nx.blAt(car.s) + car.width / 2, nx.brAt(car.s) - car.width / 2);
        if (nx.kind === 'main' && (!car.exit || car.exit.line !== nx.line)) this.planExit(car);
      }
      if (!car.alive) continue;
      // keep inside the lane area
      const bl = car.edge.blAt(car.s);
      const br = car.edge.brAt(car.s);
      if (car.edge.ol[car.edge.idx(car.s)] < 0) car.d = Math.max(car.d, bl + car.width / 2);
      if (car.edge.or[car.edge.idx(car.s)] < 0) car.d = Math.min(car.d, br - car.width / 2);
      // pose
      const fr = car.edge.frame(car.s, car.d, this.f);
      car.x = fr.x;
      car.y = car.edge.yAt(car.s);
      car.z = fr.z;
      const latV = clamp(car.dTarget - car.d, -1.1, 1.1);
      car.heading = Math.atan2(fr.tz, fr.tx) + Math.atan2(latV, Math.max(car.v, 3)) * 0.8;
      // despawn far away
      const dx = car.x - focus.x;
      const dz = car.z - focus.z;
      if (dx * dx + dz * dz > (WINDOW + 300) ** 2) car.alive = false;
    }
    this.cars = this.cars.filter((c) => c.alive);
    this.spawn(dt, player, focus);
  }

  private laneLogic(car: Car, _dt: number) {
    const e = car.edge;
    const lanes = e.lanesAt(car.s);
    const lw = e.laneWidth;
    const curLane = clamp(e.laneIndex(car.s, car.dTarget), 0, Math.max(0, Math.ceil(lanes) - 1));
    const laneCenter = (k: number) => e.laneCenter(car.s, k);
    // merging from a ramp onto the main line through an open side
    const i = e.idx(car.s);
    if (e.kind === 'ramp' && (e.ol[i] >= 0 || e.or[i] >= 0)) {
      const sideRight = e.or[i] >= 0;
      const target = this.net.edges[sideRight ? e.or[i] : e.ol[i]];
      if (target.kind === 'main' && car.lcTimer <= 0) {
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
      if (Math.abs(car.dTarget - laneCenter(curLane)) > 0.05 && Math.abs(car.d - car.dTarget) < 0.1) car.dTarget = laneCenter(curLane);
      return;
    }
    // mandatory: planned exit
    if (car.exit) {
      const ls = this.net.lineS(e, car.s)!;
      const L = this.net.lines[e.line].length;
      const dist = (((car.exit.s - ls) % L) + L) % L;
      const right = car.exit.side === 'right';
      const wantLane = right ? Math.ceil(lanes) - 1 : 0;
      if (dist > L - 120) {
        // just passed the diverge point: steer into the ramp lane if it is open
        const openId = right ? e.or[i] : e.ol[i];
        if (openId >= 0 && curLane === wantLane) car.dTarget = right ? e.brAt(car.s) + 2.0 : e.blAt(car.s) - 2.0;
        else if (dist < L - 260) car.exit = null;
        return;
      }
      if (dist < 650 && car.lcTimer <= 0 && curLane !== wantLane) {
        const dir = wantLane > curLane ? 1 : -1;
        if (this.safeChange(car, laneCenter(curLane + dir), 3.5)) {
          car.dTarget = laneCenter(curLane + dir);
          car.lcTimer = 2.5;
        } else car.lcTimer = 0.5;
      }
      if (dist < 650) return;
    }
    if (car.lcTimer > 0 || Math.abs(car.d - car.dTarget) > 0.3) return;
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
    if (best >= 0) car.dTarget = laneCenter(best);
    else if (Math.abs(car.dTarget - laneCenter(curLane)) > 0.05) car.dTarget = laneCenter(curLane);
    void lw;
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
    car.dTarget = n.laneCenter(car.s, k);
    if (n.kind === 'main') this.planExit(car);
    else car.exit = null;
  }

  private spawn(dt: number, player: PlayerProxy | null, focus: THREE.Vector3) {
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
          const list = this.cars.filter((c) => c.edge === loc.edge && Math.abs(c.s - loc.s) < 25 && Math.abs(c.d - dLane) < 2.5);
          if (list.length) continue;
          const lim = loc.edge.speedAt(loc.s) / 3.6;
          const v = this.density === 'rush' ? lim * (0.2 + this.rnd() * 0.4) : lim * (0.85 + this.rnd() * 0.2);
          this.cars.push(this.makeCar(loc.edge, loc.s, lane, v));
        }
      }
    }
    // entrance ramps near the player
    if (this.rnd() < (this.density === 'sparse' ? 0.15 : 0.35)) {
      const near = this.net.entrances.filter((en) => {
        const e = this.net.edges[en.edge];
        const dx = e.x[0] - focus.x;
        const dz = e.z[0] - focus.z;
        const d2 = dx * dx + dz * dz;
        return d2 > 350 * 350 && d2 < 1200 * 1200;
      });
      if (near.length) {
        const en = near[Math.floor(this.rnd() * near.length)];
        // start at the beginning of the ramp chain
        let e = this.net.edges[en.edge];
        for (let k = 0; k < 4 && e.pred.length === 1; k++) e = e.pred[0];
        const busy = this.cars.some((c) => c.edge === e && c.s < 30);
        if (!busy) this.cars.push(this.makeCar(e, 2, 0, 9));
      }
    }
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
      ms.plate.setMatrixAt(i, m);
      ms.body.setColorAt(i, car.color);
      const braking = car.acc < -1.2 || car.v < 0.5;
      headC.setRGB(1, 1, 0.95).multiplyScalar(night > 0.4 ? 2.6 : 0.7);
      tailC.setRGB(1, 0.03, 0.02).multiplyScalar(braking ? 2.4 : night > 0.4 ? 1.0 : 0.3);
      ms.head.setColorAt(i, headC);
      ms.tail.setColorAt(i, tailC);
      const pa = ms.plate.geometry.getAttribute('aPlate') as THREE.InstancedBufferAttribute;
      pa.setXY(i, car.plate % 8, Math.floor(car.plate / 8));
    }
    this.meshes.forEach((ms, k) => {
      for (const im of [ms.body, ms.trim, ms.head, ms.tail, ms.plate]) {
        im.count = counts[k];
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
      (ms.plate.geometry.getAttribute('aPlate') as THREE.InstancedBufferAttribute).needsUpdate = true;
    });
  }
}


/**
 * A driving session: modes (free / trip / lap), traffic-rule enforcement
 * (fixed & average-speed cameras, gore-area crossing, lane changes without
 * indicator, barrier collisions, reversing on the viaduct), navigation and
 * statistics.
 */
import type { Edge, RoadNetwork } from '../road/Network';
import type { GameOptions } from '../core/Settings';
import type { ExitFile, LineId } from '../shared/types';

export interface Violation {
  kind: string;
  text: string;
  t: number;
}

export interface SessionEvent {
  type: 'toast' | 'flash' | 'chime' | 'end';
  text?: string;
  kind?: 'bad' | 'info' | 'warn';
  end?: { reason: 'trip-done' | 'exit' | 'lap'; title: string; exit?: ExitFile | null; terminalName?: string };
}

export class Session {
  t = 0;
  distance = 0;
  maxSpeed = 0;
  violations: Violation[] = [];
  barrierHits = 0;
  carHits = 0;
  line: LineId;
  private prevLineS: number | null = null;
  private lapProgress = 0;
  private lapStartT = 0;
  lapTimes: number[] = [];
  private sectionStart = new Map<number, { t: number; s: number }>();
  private goreFlags = new Set<string>();
  private lastLane = -1;
  private lastLaneEdge: Edge | null = null;
  signal: -1 | 0 | 1 = 0;
  private signalT = 0;
  private lastSignalT = -10;
  private reverseT = 0;
  private lastReverseViolation = -100;
  private hitCooldown = 0;
  destination: ExitFile | null = null;
  private onExitRamp: ExitFile | null = null;
  missed = false;
  ended = false;

  constructor(
    readonly net: RoadNetwork,
    readonly options: GameOptions,
  ) {
    this.line = options.line;
    if (options.mode === 'trip') this.destination = net.exits.find((x) => x.line === options.line && x.code === options.destination) ?? null;
  }

  toggleSignal(dir: -1 | 1) {
    this.signal = this.signal === dir ? 0 : dir;
    this.signalT = 0;
    if (this.signal) this.lastSignalT = this.t;
  }

  private violate(kind: string, text: string, ev: SessionEvent[]) {
    this.violations.push({ kind, text, t: this.t });
    ev.push({ type: 'toast', text, kind: 'bad' });
  }

  update(
    dt: number,
    p: { edge: Edge; s: number; d: number; speed: number; gear: number; impact: number; terminal: Edge | null },
  ): SessionEvent[] {
    const ev: SessionEvent[] = [];
    if (this.ended) return ev;
    this.t += dt;
    const v = Math.abs(p.speed);
    this.distance += v * dt;
    this.maxSpeed = Math.max(this.maxSpeed, v * 3.6);
    this.hitCooldown -= dt;
    if (this.signal) {
      this.signalT += dt;
      this.lastSignalT = this.t;
      if (this.signalT > 9) this.signal = 0;
    }
    const e = p.edge;
    if (e.kind === 'main' && e.line) this.line = e.line;

    // barrier collisions
    if (p.impact > 2.2 && this.hitCooldown <= 0) {
      this.barrierHits++;
      this.hitCooldown = 1.5;
      this.violate('barrier', `碰撞护栏（${Math.round(p.impact * 3.6)} km/h）`, ev);
    }

    // reversing on the expressway
    if (p.gear === -1 && v > 1) {
      this.reverseT += dt;
      if (this.reverseT > 2.5 && this.t - this.lastReverseViolation > 25) {
        this.lastReverseViolation = this.t;
        this.violate('reverse', '在快速路上倒车', ev);
      }
    } else this.reverseT = 0;

    // lane changes without indicator (main line only)
    if (e.kind === 'main') {
      const lanes = e.lanesAt(p.s);
      const lane = Math.floor((p.d + (lanes * e.laneWidth) / 2) / e.laneWidth);
      if (this.lastLaneEdge && this.lastLane >= 0 && lane !== this.lastLane && lane >= 0 && lane < Math.ceil(lanes) && v > 5) {
        if (this.t - this.lastSignalT > 4) this.violate('signal', '变道未开启转向灯', ev);
        else if (this.signal) this.signal = 0;
      }
      this.lastLane = lane;
      this.lastLaneEdge = e;
    } else {
      this.lastLane = -1;
      this.lastLaneEdge = null;
    }

    // driving over gore chevrons
    const i = e.idx(p.s);
    const half = (e.lanes[i] * e.laneWidth) / 2;
    for (const side of [-1, 1] as const) {
      const open = side < 0 ? e.ol[i] : e.or[i];
      if (open < 0) continue;
      const bound = side < 0 ? -e.bl[i] : e.br[i];
      if (bound - half < 0.6) continue;
      if (side * p.d > half + 0.6) {
        const key = `${e.id}:${side}:${Math.floor(p.s / 200)}`;
        if (!this.goreFlags.has(key)) {
          this.goreFlags.add(key);
          this.violate('gore', '驶入导流线区域', ev);
        }
      }
    }

    // line position, cameras, laps
    const ls = this.net.lineS(e, p.s);
    if (ls != null && e.line) {
      const L = this.net.lines[e.line].length;
      if (this.prevLineS != null) {
        let delta = ls - this.prevLineS;
        if (delta > L / 2) delta -= L;
        if (delta < -L / 2) delta += L;
        if (Math.abs(delta) < 60) {
          this.lapProgress += delta;
          if (delta > 0) this.checkCameras(e.line, this.prevLineS, delta, v, p, ev);
        }
      } else this.lapStartT = this.t;
      this.prevLineS = ls;
      if (this.options.mode === 'lap' && this.lapProgress >= L) {
        this.lapTimes.push(this.t - this.lapStartT);
        this.lapStartT = this.t;
        this.lapProgress -= L;
        ev.push({ type: 'chime' });
        ev.push({ type: 'end', end: { reason: 'lap', title: `完成一圈：${fmtTime(this.lapTimes[this.lapTimes.length - 1])}` } });
        this.ended = true;
      }
    } else this.prevLineS = null;

    // exits / terminals
    if (e.kind === 'ramp') {
      const x = this.net.exits.find((xx) => xx.edge === e.id);
      if (x && this.onExitRamp !== x) {
        this.onExitRamp = x;
        const isDest = this.destination && x === this.destination;
        ev.push({ type: 'toast', text: `驶入 ${x.code} 出口匝道 · ${x.names.join(' / ')}`, kind: isDest || !this.destination ? 'info' : 'warn' });
      }
    }
    if (p.terminal) {
      const node = this.net.nodes.get(p.terminal.to);
      const name = node?.terminal?.name ?? '';
      const exit = this.net.exits.find((xx) => xx.terminals.includes(p.terminal!.to)) ?? this.onExitRamp;
      this.ended = true;
      const done = this.destination && exit === this.destination;
      ev.push({ type: 'chime' });
      ev.push({
        type: 'end',
        end: {
          reason: done ? 'trip-done' : 'exit',
          title: done ? `行程完成：到达 ${exit!.code} ${exit!.names[0]}` : `已驶离内环路${exit ? `：${exit.code} ${exit.names[0]}` : ''}`,
          exit: exit ?? null,
          terminalName: name,
        },
      });
    }
    return ev;
  }

  private checkCameras(line: LineId, s0: number, delta: number, v: number, _p: { edge: Edge; s: number }, ev: SessionEvent[]) {
    const L = this.net.lines[line].length;
    for (const c of this.net.cameras) {
      if (c.line !== line) continue;
      const rel = (((c.lineS - s0) % L) + L) % L;
      if (rel <= 0 || rel > delta) continue;
      const kmh = v * 3.6;
      if (c.kind === 'fixed') {
        if (kmh > c.limit * 1.1 + 0.5) {
          ev.push({ type: 'flash' });
          this.violate('speed', `测速拍照：超速 ${Math.round(((kmh - c.limit) / c.limit) * 100)}%（${Math.round(kmh)}/${c.limit}）`, ev);
        }
      } else if (c.kind === 'section-start') {
        this.sectionStart.set(c.sectionId ?? 0, { t: this.t, s: c.lineS });
        ev.push({ type: 'toast', text: `区间测速起点 · 限速 ${c.limit}`, kind: 'warn' });
      } else if (c.kind === 'section-end') {
        const st = this.sectionStart.get(c.sectionId ?? 0);
        if (st) {
          const dist = (((c.lineS - st.s) % L) + L) % L;
          const avg = (dist / Math.max(1, this.t - st.t)) * 3.6;
          if (avg > c.limit * 1.1) this.violate('section', `区间测速超速：平均 ${Math.round(avg)} km/h`, ev);
          else ev.push({ type: 'toast', text: `区间测速终点 · 平均 ${Math.round(avg)} km/h`, kind: 'info' });
          this.sectionStart.delete(c.sectionId ?? 0);
        }
      }
    }
  }

  /** Next exit ahead on the current line. */
  nextExit(e: Edge, s: number): { x: ExitFile; dist: number } | null {
    const ls = this.net.lineS(e, s);
    if (ls == null || !e.line) return null;
    const L = this.net.lines[e.line].length;
    let best: { x: ExitFile; dist: number } | null = null;
    for (const x of this.net.exits) {
      if (x.line !== e.line || !x.code) continue;
      const d = (((x.s - ls) % L) + L) % L;
      if (!best || d < best.dist) best = { x, dist: d };
    }
    return best;
  }

  guidance(e: Edge, s: number, d: number): string | null {
    if (!this.destination) return null;
    const x = this.destination;
    if (e.kind === 'ramp') {
      return this.onExitRamp === x ? `沿匝道行驶 · 前往 ${x.names.join(' / ')}` : null;
    }
    const ls = this.net.lineS(e, s);
    if (ls == null || e.line !== x.line) return `请驶入内环路 ${x.line}线`;
    const L = this.net.lines[x.line].length;
    const dist = (((x.s - ls) % L) + L) % L;
    const side = x.side === 'right' ? '右' : '左';
    if (dist > L - 150) {
      const lanes = e.lanesAt(s);
      const lane = Math.floor((d + (lanes * e.laneWidth) / 2) / e.laneWidth);
      const outer = x.side === 'right' ? Math.ceil(lanes) - 1 : 0;
      return lane === outer ? `${x.code} 出口 · 向${side}驶入匝道` : `已错过 ${x.code} 出口的最佳变道时机`;
    }
    if (dist < 1800) {
      const lanes = e.lanesAt(s);
      const lane = Math.floor((d + (lanes * e.laneWidth) / 2) / e.laneWidth);
      const outer = x.side === 'right' ? Math.ceil(lanes) - 1 : 0;
      const ds = dist >= 1000 ? `${(dist / 1000).toFixed(1)} 公里` : `${Math.round(dist / 50) * 50} 米`;
      return `前方 ${ds} ${x.code} 出口（${x.names[0]}）${lane === outer ? '' : `，请靠${side}行驶`}`;
    }
    return `目标：${x.code} ${x.names[0]} · 剩余约 ${(dist / 1000).toFixed(1)} 公里`;
  }

  stats(): string {
    const avg = this.t > 1 ? (this.distance / this.t) * 3.6 : 0;
    const lap = this.options.mode === 'lap' && this.prevLineS != null ? `<br/>本圈 <b>${fmtTime(this.t - this.lapStartT)}</b> · 进度 ${Math.max(0, Math.min(100, (this.lapProgress / this.net.lines[this.line].length) * 100)).toFixed(0)}%` : '';
    return `用时 <b>${fmtTime(this.t)}</b> · 里程 <b>${(this.distance / 1000).toFixed(2)}</b> km<br/>均速 ${avg.toFixed(0)} km/h · 违章 <b>${this.violations.length}</b>${lap}`;
  }

  summary(): [string, string][] {
    const avg = this.t > 1 ? (this.distance / this.t) * 3.6 : 0;
    const count = (k: string) => this.violations.filter((v) => v.kind === k).length;
    const rows: [string, string][] = [
      ['线路', `内环路 ${this.line}线`],
      ['用时', fmtTime(this.t)],
      ['里程', `${(this.distance / 1000).toFixed(2)} km`],
      ['平均速度', `${avg.toFixed(1)} km/h`],
      ['最高速度', `${this.maxSpeed.toFixed(0)} km/h`],
      ['超速（定点/区间）', `${count('speed')} / ${count('section')}`],
      ['碰撞护栏 / 车辆', `${this.barrierHits} / ${this.carHits}`],
      ['未打灯变道', String(count('signal'))],
      ['驶入导流线', String(count('gore'))],
    ];
    if (this.lapTimes.length) rows.splice(1, 0, ['圈速', fmtTime(this.lapTimes[this.lapTimes.length - 1])]);
    const penalty = count('speed') * 3 + count('section') * 3 + count('gore') * 3 + count('reverse') * 12 + count('signal') * 1 + this.barrierHits * 2 + this.carHits * 6;
    rows.push(['驾驶评分', `${Math.max(0, 100 - penalty)} / 100`]);
    return rows;
  }
}

export function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

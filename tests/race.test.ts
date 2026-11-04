import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadNetwork } from './helpers';
import { Traffic, type PlayerProxy } from '../src/traffic/Traffic';
import { Player } from '../src/vehicle/Player';
import { raceTune, SEDAN, SUV } from '../src/vehicle/Dynamics';
import { resolveContacts } from '../src/vehicle/Contacts';
import { Race, raceDistance } from '../src/race/Race';
import { RaceDriver } from '../src/race/RaceDriver';
import { Session } from '../src/game/Session';
import { defaultSettings } from '../src/core/Settings';
import type { LineId } from '../src/shared/types';

const net = loadNetwork();
const FIXED = 1 / 120;

const proxy = (p: Player): PlayerProxy => ({ edge: p.tracker.edge, s: p.tracker.s, d: p.tracker.d, v: Math.max(0, p.dyn.vx), len: p.halfLength * 2, width: p.halfWidth * 2, x: p.dyn.x, z: p.dyn.z, heading: p.dyn.psi });

/** A complete race with traffic; the "player" is driven by an AI driver as well. */
function runRace(line: LineId, startS: number) {
  const traffic = new Traffic(net, { render: false });
  traffic.density = 'sparse';
  const loc = net.atLineS(line, startS);
  const player = new Player(net, raceTune(SEDAN), 'sedan', 0xffffff, loc.edge, loc.s, { visual: false });
  const race = new Race(net, { line, startS, length: 'short', rivals: 3, level: 'normal', gripScale: 1 }, player, (kind, color, edge, s) =>
    new Player(net, raceTune(kind === 'suv' || kind === 'mpv' ? SUV : SEDAN), kind, color, edge, s, { visual: false }),
  );
  traffic.populate(line, startS);
  traffic.clearLine(line, startS - 160, startS + 260);
  const me = new RaceDriver(net, line, race.curv, { grip: 0.72, vmax: 50, brake: 5.8 });
  const bodies = race.entrants.map((e) => e.car);
  const focus = new THREE.Vector3();
  const out = { respawns: 0, hardContacts: 0, maxWall: 0, startedBeforeGo: false, events: [] as string[] };
  // keep going after the player has finished until the whole field is in
  for (let t = 0; t < 900 && race.entrants.some((e) => e.finish === null); t += 1 / 60) {
    race.plan(1 / 60, traffic.cars);
    if (race.state === 'countdown') me.hold();
    else {
      const tr = player.tracker;
      if (tr.edge.kind === 'main' && tr.edge.line === line) me.drive(1 / 60, player.dyn, tr, net.lineS(tr.edge, tr.s)!, race.obstacles(traffic.cars).filter((o) => o.owner !== race.player), 1);
    }
    for (let k = 0; k < 2; k++) {
      player.step(FIXED, me.controls);
      race.stepCars(FIXED);
      for (const en of race.rivals) out.maxWall = Math.max(out.maxWall, en.car.lastCollision.impact);
    }
    if (race.state === 'countdown' && race.rivals.some((en) => Math.abs(en.car.dyn.vx) > 0.5)) out.startedBeforeGo = true;
    focus.set(player.dyn.x, player.y, player.dyn.z);
    traffic.update(1 / 60, proxy(player), focus, race.rivals.map((e) => proxy(e.car)));
    for (const c of resolveContacts(bodies, traffic.cars)) if (c.impact > 3) out.hardContacts++;
    for (const ev of race.update(1 / 60)) {
      out.events.push(ev.type);
      if (ev.type === 'respawn') out.respawns++;
    }
  }
  return { race, ...out };
}

describe('race mode', () => {
  it('measures the race along the line', () => {
    const L = net.lines.A.length;
    expect(raceDistance(L, 'short')).toBe(5000);
    expect(raceDistance(L, 'half')).toBeCloseTo(L / 2);
    expect(raceDistance(L, 'lap')).toBeCloseTo(L);
  });

  it('lines the cars up on the grid behind the start, the player last', () => {
    const loc = net.atLineS('A', 640);
    const player = new Player(net, SEDAN, 'sedan', 0xffffff, loc.edge, loc.s, { visual: false });
    const race = new Race(net, { line: 'A', startS: 640, length: 'short', rivals: 5, level: 'easy', gripScale: 1 }, player, (kind, color, edge, s) => new Player(net, SEDAN, kind, color, edge, s, { visual: false }));
    expect(race.entrants).toHaveLength(6);
    expect(race.player.car).toBe(player);
    // everyone behind the start line, nobody overlapping
    for (const en of race.entrants) expect(en.progress).toBeLessThan(0);
    expect(Math.min(...race.rivals.map((r) => r.progress))).toBeGreaterThan(race.player.progress);
    for (let i = 0; i < race.entrants.length; i++)
      for (let k = i + 1; k < race.entrants.length; k++) {
        const a = race.entrants[i].car.dyn;
        const b = race.entrants[k].car.dyn;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(3);
      }
    expect(race.rankOf(race.player)).toBe(6);
  });

  for (const [line, startS] of [
    ['A', 640],
    ['B', 4000],
  ] as [LineId, number][]) {
    it(`runs a 5 km race on line ${line} through traffic: AI drivers race, stay on the road and finish`, () => {
      const r = runRace(line, startS);
      expect(r.race.state).toBe('done');
      expect(r.events[0]).toBe('go');
      expect(r.startedBeforeGo).toBe(false);
      const finished = r.race.entrants.filter((e) => e.finish !== null);
      expect(finished.length).toBe(4);
      // no speed limit in a race: well above the 60 km/h a law-abiding driver would average
      const best = Math.min(...finished.map((e) => e.finish!));
      expect((5000 / best) * 3.6).toBeGreaterThan(70);
      expect(r.respawns).toBeLessThanOrEqual(1);
      expect(r.hardContacts).toBeLessThanOrEqual(3);
      expect(r.maxWall).toBeLessThan(8);
      // standings: finishers by time first
      const order = r.race.standings();
      for (let k = 1; k < order.length; k++) if (order[k].finish !== null) expect(order[k - 1].finish).not.toBeNull();
      expect(r.race.results()).toHaveLength(4);
    }, 300000);
  }

  it('suspends every traffic rule during a race', () => {
    const o = { ...defaultSettings().options, mode: 'race' as const };
    const s = new Session(net, o);
    const cam = net.cameras.find((c) => c.kind === 'fixed' && c.line === 'A')!;
    const e = net.edges[cam.edge];
    // fly through a speed camera at 150 km/h, reverse, hit the barrier hard
    s.update(0.1, { edge: e, s: Math.max(0, cam.s - 3), d: 0, speed: 41, gear: 3, impact: 0, terminal: null });
    const evs = [...s.update(0.1, { edge: e, s: Math.min(e.length, cam.s + 1), d: 0, speed: 41, gear: 3, impact: 9, terminal: null })];
    for (let k = 0; k < 40; k++) evs.push(...s.update(0.1, { edge: e, s: cam.s, d: 0, speed: -3, gear: -1, impact: 0, terminal: null }));
    expect(s.violations).toEqual([]);
    expect(evs.filter((v) => v.type === 'flash')).toEqual([]);
    // the same in free driving is booked
    const free = new Session(net, { ...o, mode: 'free' });
    free.update(0.1, { edge: e, s: Math.max(0, cam.s - 3), d: 0, speed: 41, gear: 3, impact: 0, terminal: null });
    free.update(0.1, { edge: e, s: Math.min(e.length, cam.s + 1), d: 0, speed: 41, gear: 3, impact: 9, terminal: null });
    expect(free.violations.map((v) => v.kind)).toEqual(expect.arrayContaining(['speed', 'barrier']));
  });
});

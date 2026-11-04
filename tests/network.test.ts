import { describe, expect, it } from 'vitest';
import { loadNetwork } from './helpers';
import type { LineId } from '../src/shared/types';

const net = loadNetwork();

describe('road network data', () => {
  it('has two closed lines of realistic length', () => {
    for (const line of ['A', 'B'] as LineId[]) {
      const L = net.lines[line];
      expect(L.length).toBeGreaterThan(22000);
      expect(L.length).toBeLessThan(25000);
      for (let k = 0; k < L.edges.length; k++) {
        const a = L.edges[k];
        const b = L.edges[(k + 1) % L.edges.length];
        expect(a.to).toBe(b.from);
        // geometric continuity at the junction
        expect(Math.hypot(a.x[a.n - 1] - b.x[0], a.z[a.n - 1] - b.z[0])).toBeLessThan(0.05);
      }
    }
  });

  it('A line runs counter-clockwise and B line clockwise', () => {
    const area = (line: LineId) => {
      let a = 0;
      const pts: [number, number][] = [];
      for (const e of net.lines[line].edges) for (let i = 0; i < e.n - 1; i += 4) pts.push([e.x[i], -e.z[i]]);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return a / 2;
    };
    expect(area('A')).toBeGreaterThan(1e7);
    expect(area('B')).toBeLessThan(-1e7);
  });

  it('keeps grades drivable and decks above ground', () => {
    let maxGrade = 0;
    for (const e of net.edges) {
      for (let i = 1; i < e.n; i++) {
        maxGrade = Math.max(maxGrade, Math.abs(e.y[i] - e.y[i - 1]) / e.ds);
        expect(e.y[i]).toBeGreaterThanOrEqual(0);
        expect(e.y[i]).toBeLessThan(35);
      }
    }
    expect(maxGrade).toBeLessThan(0.15);
  });

  it('has numbered exits on both lines, including left-side exits', () => {
    for (const line of ['A', 'B'] as LineId[]) {
      const ex = net.exits.filter((x) => x.line === line && x.code);
      expect(ex.length).toBeGreaterThanOrEqual(15);
      expect(ex.every((x) => x.code.startsWith(line))).toBe(true);
    }
    expect(net.exits.some((x) => x.side === 'left')).toBe(true);
    expect(net.entrances.filter((e) => e.line === 'A').length).toBeGreaterThanOrEqual(12);
  });

  it('numbers exits as on the real road: A1–A19 without A5, B1–B19, in driving order', () => {
    const codes = (line: LineId) =>
      net.exits
        .filter((x) => x.line === line && x.code)
        .sort((a, b) => a.s - b.s)
        .map((x) => Number(x.code.slice(1)));
    for (const line of ['A', 'B'] as LineId[]) {
      const nums = codes(line);
      // increasing around the loop: exactly one wrap from the last number back to the first
      const wraps = nums.filter((n, k) => n < nums[(k - 1 + nums.length) % nums.length]).length;
      expect(wraps).toBe(1);
      expect(new Set(nums).size).toBe(nums.length);
    }
    expect([...codes('A')].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect([...codes('B')].sort((a, b) => a - b)).toEqual(Array.from({ length: 19 }, (_, k) => k + 1));
    const x = (code: string) => net.exits.find((e) => e.code === code)!;
    // A5 (Ruyifang radial) is not open yet; A6 leaves on the left towards Huangsha Avenue / the Pearl River Tunnel
    expect(net.exits.find((e) => e.code === 'A5')).toBeUndefined();
    expect(x('A6').side).toBe('left');
    expect(x('A6').names).toContain('珠江隧道');
    expect(x('B16').names).toContain('珠江隧道');
    // north-west corner of the B line: 增槎路 (left) before 东风西路, then 环市西路 at 西场
    expect(x('B18').names[0]).toBe('增槎路');
    expect(x('B18').side).toBe('left');
    expect(x('B19').names[0]).toBe('东风西路');
    expect(x('B1').names[0]).toBe('环市西路');
    // the ramp at the north end of 江湾大桥 has no exit number
    expect(net.exits.filter((e) => !e.code).map((e) => e.names[0])).toEqual(['大沙头路']);
  });

  it('speed limits follow the 60 km/h rule with lower limits on curves and ramps', () => {
    for (const e of net.edges) {
      const max = Math.max(...e.speed);
      if (e.kind === 'main') expect(max).toBeLessThanOrEqual(60);
      else expect(max).toBeLessThanOrEqual(40);
    }
  });

  it('projects points back onto edges', () => {
    const e = net.lines.A.edges[3];
    const p = { s: 0, d: 0, dist: 0 };
    const fr = e.frame(e.length / 2, 1.75, { x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 1, grade: 0 });
    e.project(fr.x, fr.z, e.length / 2 - 10, p);
    expect(Math.abs(p.s - e.length / 2)).toBeLessThan(0.2);
    expect(Math.abs(p.d - 1.75)).toBeLessThan(0.05);
  });
});

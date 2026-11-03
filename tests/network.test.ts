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

  it('numbers exits in driving order; A5 (Ruyifang radial) is not open yet', () => {
    for (const line of ['A', 'B'] as LineId[]) {
      const nums = net.exits
        .filter((x) => x.line === line)
        .sort((a, b) => a.s - b.s)
        .map((x) => Number(x.code.slice(1)));
      for (let k = 1; k < nums.length; k++) expect(nums[k]).toBeGreaterThan(nums[k - 1]);
    }
    const a = (code: string) => net.exits.find((x) => x.code === code);
    expect(a('A5')).toBeUndefined();
    // A6 leaves on the left towards Huangsha Avenue / the Pearl River Tunnel
    expect(a('A6')?.side).toBe('left');
    expect(a('A6')!.names).toContain('珠江隧道');
    expect(a('B15')!.names).toContain('珠江隧道');
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

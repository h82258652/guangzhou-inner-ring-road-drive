/** Loading and basic handling of cached Overpass JSON. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, ORIGIN } from './config';
import { LocalProjection } from '../../src/shared/geo';
import type { V2 } from '../../src/shared/polyline';

export const proj = new LocalProjection(ORIGIN);

export interface OsmGeomPt {
  lat: number;
  lon: number;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes?: number[];
  tags?: Record<string, string>;
  geometry?: (OsmGeomPt | null)[];
  center?: OsmGeomPt;
}

export interface OsmMember {
  type: 'way' | 'node' | 'relation';
  ref: number;
  role: string;
  geometry?: (OsmGeomPt | null)[];
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmMember[];
  tags?: Record<string, string>;
  center?: OsmGeomPt;
}

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export type OsmElement = OsmWay | OsmRelation | OsmNode;

export function loadCache(file: string): OsmElement[] {
  const raw = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf8')) as { elements: OsmElement[] };
  return raw.elements;
}

export function geomToXZ(g: (OsmGeomPt | null)[] | undefined): V2[] {
  if (!g) return [];
  const out: V2[] = [];
  for (const p of g) {
    if (!p) continue;
    out.push(proj.project(p.lat, p.lon));
  }
  return out;
}

/**
 * Assembles closed rings from multipolygon member ways (matching endpoints by
 * coordinates). Returns outer and inner rings.
 */
export function assembleMultipolygon(rel: OsmRelation): { outer: V2[][]; inner: V2[][] } {
  const result = { outer: [] as V2[][], inner: [] as V2[][] };
  if (!rel.members) return result;
  for (const role of ['outer', 'inner'] as const) {
    const segs: V2[][] = rel.members
      .filter((m) => m.type === 'way' && (m.role === role || (role === 'outer' && m.role === '')))
      .map((m) => geomToXZ(m.geometry))
      .filter((s) => s.length >= 2);
    const key = (p: V2) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    const used = new Array(segs.length).fill(false);
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const ring = segs[i].slice();
      let guard = 0;
      while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
        const endK = key(ring[ring.length - 1]);
        let found = false;
        for (let j = 0; j < segs.length; j++) {
          if (used[j]) continue;
          const s = segs[j];
          if (key(s[0]) === endK) {
            ring.push(...s.slice(1));
            used[j] = true;
            found = true;
            break;
          }
          if (key(s[s.length - 1]) === endK) {
            ring.push(...s.slice(0, -1).reverse());
            used[j] = true;
            found = true;
            break;
          }
        }
        if (!found) break;
      }
      if (ring.length >= 4) result[role].push(ring);
    }
  }
  return result;
}

export function numTag(tags: Record<string, string> | undefined, key: string): number | null {
  const v = tags?.[key];
  if (v == null) return null;
  const m = /-?\d+(\.\d+)?/.exec(v);
  return m ? parseFloat(m[0]) : null;
}


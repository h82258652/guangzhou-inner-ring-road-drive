/**
 * City data: buildings (OSM + procedural infill), streets, visual expressways,
 * water (Pearl River via flood fill), parks, trees, railways, skyline and
 * landmarks. Also annotates the network (noise barriers, bridges over water).
 */
import { loadCache, geomToXZ, assembleMultipolygon, numTag, proj, type OsmWay, type OsmRelation } from './osm';
import { BBOX_CITY } from './config';
import type { Network } from './network';
import { Raster, floodFill, traceContours } from './raster';
import { type V2, polygonArea, simplify, signedAreaMap, pointInPolygon, dist2 } from '../../src/shared/polyline';
import { hash01, mulberry32, clamp, smoothstep } from '../../src/shared/math';
import type { BuildingRec, CityFile, LandmarkRec } from '../../src/shared/types';

const OCC_BUILDING = 1;
const OCC_ROAD = 2;
const OCC_WATER = 4;
const OCC_GREEN = 8;
const OCC_RAIL = 16;
const OCC_EXPRESS = 32;
const OCC_NOBUILD = 64;
const ALL_OCC = 127;

export const cityBounds = (): [number, number, number, number] => {
  const [s, w, n, e] = BBOX_CITY;
  const a = proj.project(n, w);
  const b = proj.project(s, e);
  return [a[0], a[1], b[0], b[1]];
};

const q = (v: number) => Math.round(v * 10);
const qpoly = (p: V2[]) => p.flatMap(([x, z]) => [q(x), q(z)]);

function closedRing(pts: V2[]): V2[] {
  if (pts.length > 2 && dist2(pts[0], pts[pts.length - 1]) < 0.01) return pts.slice(0, -1);
  return pts;
}

/* ------------------------------------------------------------------ */

interface ExpressSample {
  x: number;
  z: number;
  hw: number;
  y: number;
}

function expressGrid(net: Network) {
  const cell = 25;
  const grid = new Map<string, ExpressSample[]>();
  for (const e of net.edges) {
    for (let i = 0; i < e.pts.length; i++) {
      const p = e.pts[i];
      const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push({ x: p[0], z: p[1], hw: Math.max(-e.bl[i], e.br[i]) + 0.6, y: e.y[i] });
    }
  }
  return {
    near(xmin: number, zmin: number, xmax: number, zmax: number): ExpressSample[] {
      const out: ExpressSample[] = [];
      for (let x = Math.floor((xmin - 15) / cell); x <= Math.floor((xmax + 15) / cell); x++)
        for (let z = Math.floor((zmin - 15) / cell); z <= Math.floor((zmax + 15) / cell); z++) out.push(...(grid.get(`${x},${z}`) ?? []));
      return out;
    },
  };
}

function distPointPolyEdge(p: V2, poly: V2[]) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
    t = clamp(t, 0, 1);
    best = Math.min(best, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t)));
  }
  return best;
}

/* ---------------- buildings ---------------- */

const LOW_TYPES = new Set(['house', 'detached', 'terrace', 'hut', 'shed', 'garage', 'garages', 'kiosk', 'roof', 'carport', 'toilets', 'temple', 'shrine']);
const WORK_TYPES = new Set(['office', 'commercial', 'retail', 'hotel', 'government', 'public', 'civic', 'hospital', 'university', 'college', 'school']);

function estimateHeight(id: number, tags: Record<string, string>, area: number): number {
  const h = numTag(tags, 'height');
  if (h && h > 1 && h < 700) return h;
  const lv = numTag(tags, 'building:levels');
  if (lv && lv > 0 && lv < 150) return lv * 3.1 + 1.2;
  const t = tags.building ?? 'yes';
  const r = hash01(id);
  if (LOW_TYPES.has(t)) return 3.5 + r * 5;
  if (t === 'industrial' || t === 'warehouse') return 8 + r * 8;
  let floors: number;
  if (area < 120) floors = 2 + Math.floor(r * 4);
  else if (area < 450) floors = 4 + Math.floor(r * 6);
  else if (area < 1200) floors = 7 + Math.floor(r * 12);
  else if (area < 3000) floors = 10 + Math.floor(r * 22);
  else floors = 6 + Math.floor(r * 20);
  if (WORK_TYPES.has(t)) floors = Math.max(3, Math.round(floors * 0.8));
  return floors * 3.1 + 1.2;
}

/** Facade styles: 0 old low-rise, 1 mid-rise residential (tiles/AC units), 2 high-rise residential, 3 glass office, 4 commercial podium, 5 industrial. */
function facadeStyle(id: number, tags: Record<string, string>, h: number): number {
  const t = tags.building ?? 'yes';
  const r = hash01(id * 7 + 3);
  if (t === 'industrial' || t === 'warehouse') return 5;
  if (WORK_TYPES.has(t)) return h > 35 ? 3 : 4;
  if (h <= 14) return r < 0.85 ? 0 : 4;
  if (h <= 42) return r < 0.8 ? 1 : 4;
  if (h > 90) return r < 0.6 ? 3 : 2;
  return r < 0.75 ? 2 : 3;
}

function loadBuildings(): { rings: V2[]; tags: Record<string, string>; id: number }[] {
  const out: { rings: V2[]; tags: Record<string, string>; id: number }[] = [];
  for (const e of loadCache('buildings.json')) {
    if (e.type === 'way') {
      const w = e as OsmWay;
      const tags = w.tags ?? {};
      if (!tags.building || tags.building === 'no') continue;
      const pts = closedRing(geomToXZ(w.geometry));
      if (pts.length >= 3) out.push({ rings: pts, tags, id: w.id });
    } else if (e.type === 'relation') {
      const r = e as OsmRelation;
      const tags = r.tags ?? {};
      if (!tags.building || tags.building === 'no') continue;
      const mp = assembleMultipolygon(r);
      mp.outer.forEach((ring, k) => out.push({ rings: closedRing(ring), tags, id: r.id * 13 + k }));
    }
  }
  return out;
}

/* ---------------- main ---------------- */

export interface CityResult {
  city: CityFile;
  water: Raster;
  /** 0..1 factor used to flatten terrain near streets and buildings */
  flatten: (x: number, z: number) => number;
}

export function buildCity(net: Network): CityResult {
  const [x0, z0, x1, z1] = cityBounds();
  const occ = new Raster(x0, z0, x1, z1, 4);
  const xg = expressGrid(net);

  /* ---- expressway corridor ---- */
  for (const e of net.edges) {
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const hw = Math.max(-e.bl[i], e.br[i]) + 3;
      occ.strokeSegment(e.pts[i], e.pts[i + 1], hw, OCC_EXPRESS);
    }
  }

  /* ---- water ---- */
  const waterEls = loadCache('water.json') as OsmWay[];
  const outlines: V2[][] = [];
  const seedsLines: V2[][] = [];
  const lakePolys: V2[][] = [];
  for (const w of waterEls) {
    if (w.type !== 'way') continue;
    const pts = geomToXZ(w.geometry);
    if (pts.length < 2) continue;
    const t = w.tags ?? {};
    if (t.waterway === 'river' || t.waterway === 'canal') {
      // only the large channels seed the flood fill (small creeks often lack water areas)
      if (/珠江|航道|水道|河$/.test(t.name ?? '') && !/涌/.test(t.name ?? '')) seedsLines.push(pts);
    }
    else {
      outlines.push(pts);
      if ((t.natural === 'water' || t.waterway === 'riverbank') && dist2(pts[0], pts[pts.length - 1]) < 0.5) lakePolys.push(pts);
    }
  }
  const wr = new Raster(x0, z0, x1, z1, 4);
  const BARRIER = 1;
  const WATER = 2;
  for (const o of outlines) {
    for (let k = 0; k + 1 < o.length; k++) wr.strokeSegment(o[k], o[k + 1], 2.9, BARRIER);
  }
  for (const lp of lakePolys) wr.fillPolygon(lp, WATER);
  const seeds: [number, number][] = [];
  for (const line of seedsLines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k];
      const b = line[k + 1];
      const n = Math.max(1, Math.ceil(dist2(a, b) / 25));
      for (let t = 0; t <= n; t++) seeds.push([wr.ix(a[0] + ((b[0] - a[0]) * t) / n), wr.iz(a[1] + ((b[1] - a[1]) * t) / n)]);
    }
  }
  const maxCells = Math.round(wr.w * wr.h * 0.05);
  let filled = 0;
  for (const s of seeds) {
    const c = floodFill(wr, [s], BARRIER, WATER, maxCells);
    if (c > 0) filled += c;
  }
  // barrier cells adjacent to water become water (close the outline gap)
  for (let j = 1; j < wr.h - 1; j++)
    for (let i = 1; i < wr.w - 1; i++) {
      const idx = j * wr.w + i;
      if (!(wr.data[idx] & BARRIER) || wr.data[idx] & WATER) continue;
      let nw = 0;
      if (wr.data[idx - 1] & WATER) nw++;
      if (wr.data[idx + 1] & WATER) nw++;
      if (wr.data[idx - wr.w] & WATER) nw++;
      if (wr.data[idx + wr.w] & WATER) nw++;
      if (nw >= 1) wr.data[idx] |= 4;
    }
  for (let k = 0; k < wr.data.length; k++) if (wr.data[k] & 4) wr.data[k] |= WATER;
  console.log(`  water: ${((filled * 16) / 1e6).toFixed(2)} km² filled from ${seeds.length} seeds`);
  const contours = traceContours(wr, WATER)
    .map((c) => simplify(c, 2.0))
    .filter((c) => c.length >= 4 && polygonArea(c) > 400);
  // group: outer = CCW (map) , holes = CW
  const outers = contours.filter((c) => signedAreaMap(c) > 0);
  const holes = contours.filter((c) => signedAreaMap(c) < 0);
  const water: number[][][] = outers.map((o) => [qpoly(o)]);
  for (const h of holes) {
    const idx = outers.findIndex((o) => pointInPolygon(h[0], o));
    if (idx >= 0) water[idx].push(qpoly(h));
  }
  for (let j = 0; j < occ.h; j++)
    for (let i = 0; i < occ.w; i++) {
      const xc = occ.x0 + (i + 0.5) * occ.res;
      const zc = occ.z0 + (j + 0.5) * occ.res;
      if (wr.get(xc, zc) & WATER) occ.data[j * occ.w + i] |= OCC_WATER;
    }

  /* ---- landuse / green ---- */
  const green: [number, number[]][] = [];
  const greenPolys: V2[][] = [];
  const NOBUILD_LANDUSE = new Set(['railway', 'construction', 'brownfield', 'grass', 'cemetery', 'recreation_ground', 'village_green', 'meadow', 'forest', 'military']);
  const GREEN_KIND: Record<string, number> = { park: 1, garden: 1, grass: 2, village_green: 2, recreation_ground: 2, meadow: 2, forest: 3, wood: 3, scrub: 3, cemetery: 2, pitch: 4, stadium: 4, playground: 2, sports_centre: 4 };
  for (const e of loadCache('landuse.json')) {
    let rings: V2[][] = [];
    let tags: Record<string, string> = {};
    if (e.type === 'way') {
      const w = e as OsmWay;
      tags = w.tags ?? {};
      const pts = closedRing(geomToXZ(w.geometry));
      if (pts.length >= 3) rings = [pts];
    } else if (e.type === 'relation') {
      const r = e as OsmRelation;
      tags = r.tags ?? {};
      rings = assembleMultipolygon(r).outer.map(closedRing);
    }
    const kindKey = tags.leisure ?? tags.landuse ?? tags.natural ?? '';
    const gk = GREEN_KIND[kindKey];
    for (const ring of rings) {
      if (ring.length < 3) continue;
      if (gk) {
        const simp = simplify(ring, 1.0);
        if (simp.length >= 3 && polygonArea(simp) > 150) {
          green.push([gk, qpoly(simp)]);
          greenPolys.push(simp);
          occ.fillPolygon(simp, OCC_GREEN);
        }
      } else if (tags.landuse && NOBUILD_LANDUSE.has(tags.landuse)) occ.fillPolygon(ring, OCC_NOBUILD);
      else if (tags.amenity === 'parking' || tags.amenity === 'school' || tags.amenity === 'university') occ.fillPolygon(ring, OCC_NOBUILD);
    }
  }

  /* ---- streets ---- */
  const ROAD_W: Record<string, number> = {
    trunk: 22,
    primary: 20,
    primary_link: 7,
    secondary: 15,
    secondary_link: 7,
    tertiary: 11,
    tertiary_link: 6,
    unclassified: 7,
    residential: 6.5,
    living_street: 5,
    pedestrian: 6,
  };
  const ROAD_KIND: Record<string, number> = { trunk: 0, primary: 0, primary_link: 1, secondary: 1, secondary_link: 2, tertiary: 2, tertiary_link: 3, unclassified: 3, residential: 3, living_street: 4, pedestrian: 5 };
  const roads: [number, number, number[]][] = [];
  const roadLines: { pts: V2[]; w: number; kind: number }[] = [];
  const nodeH = new Map<number, number>();
  const roadWays = (loadCache('roads.json') as OsmWay[]).filter((w) => w.type === 'way' && w.geometry && w.nodes);
  for (const w of roadWays) {
    const t = w.tags ?? {};
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.bridge && t.bridge !== 'no') {
      const hgt = 7 + 3 * clamp((numTag(t, 'layer') ?? 1) - 1, 0, 3);
      for (const n of [w.nodes![0], w.nodes![w.nodes!.length - 1]]) nodeH.set(n, Math.max(nodeH.get(n) ?? 0, hgt));
    }
  }
  for (const w of roadWays) {
    const t = w.tags ?? {};
    if (t.tunnel && t.tunnel !== 'no') continue;
    const hw = t.highway ?? 'residential';
    const lanes = numTag(t, 'lanes');
    const width = lanes && lanes > 0 && lanes < 12 ? Math.max(5, lanes * 3.3 + 1.5) : (ROAD_W[hw] ?? 6);
    const pts = geomToXZ(w.geometry);
    if (pts.length < 2) continue;
    const isBridge = !!t.bridge && t.bridge !== 'no';
    const ownH = isBridge ? 7 + 3 * clamp((numTag(t, 'layer') ?? 1) - 1, 0, 3) : 0;
    const ys = profileHeights(pts, ownH, nodeH.get(w.nodes![0]) ?? 0, nodeH.get(w.nodes![w.nodes!.length - 1]) ?? 0, 0.06);
    const simp = simplifyWithY(pts, ys, 0.8);
    roads.push([ROAD_KIND[hw] ?? 3, Math.round(width * 10) / 10, simp.flatMap(([x, z, y]) => [q(x), q(z), q(y)])]);
    roadLines.push({ pts, w: width, kind: ROAD_KIND[hw] ?? 3 });
    if (!isBridge) occ.strokePolyline(pts, width / 2 + 3, OCC_ROAD);
  }

  /* ---- visual expressways (not drivable): trunk/motorway outside the network ---- */
  const used = new Set<number>();
  for (const e of net.edges) for (const d of e.chain) used.add(d.way.id);
  const exprWays = (loadCache('expressways.json') as OsmWay[]).filter((w) => w.type === 'way' && w.geometry && w.nodes && !used.has(w.id));
  const exNodeH = new Map<number, number>();
  const LAYER_H = [0, 9.5, 14.5, 19.5, 24.5];
  for (const w of exprWays) {
    const t = w.tags ?? {};
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.bridge && t.bridge !== 'no') {
      const hgt = LAYER_H[clamp(Math.round(numTag(t, 'layer') ?? 1), 1, 4)];
      for (const n of [w.nodes![0], w.nodes![w.nodes!.length - 1]]) exNodeH.set(n, Math.max(exNodeH.get(n) ?? 0, hgt));
    }
  }
  // nodes shared with the drivable network take its height
  const netNodeY = new Map<number, number>();
  for (const e of net.edges) {
    netNodeY.set(e.fromNode, e.y[0]);
    netNodeY.set(e.toNode, e.y[e.y.length - 1]);
  }
  const express: [number, number, number[]][] = [];
  for (const w of exprWays) {
    const t = w.tags ?? {};
    if (t.tunnel && t.tunnel !== 'no') continue;
    const pts = geomToXZ(w.geometry);
    if (pts.length < 2) continue;
    // keep only those inside the city box
    if (!pts.some((p) => p[0] > x0 && p[0] < x1 && p[1] > z0 && p[1] < z1)) continue;
    const isBridge = !!t.bridge && t.bridge !== 'no';
    const ownH = isBridge ? LAYER_H[clamp(Math.round(numTag(t, 'layer') ?? 1), 1, 4)] : 0;
    const n0 = w.nodes![0];
    const n1 = w.nodes![w.nodes!.length - 1];
    const ys = profileHeights(pts, ownH, netNodeY.get(n0) ?? exNodeH.get(n0) ?? 0, netNodeY.get(n1) ?? exNodeH.get(n1) ?? 0, 0.06);
    const lanes = numTag(t, 'lanes') ?? (t.highway?.endsWith('link') ? 1 : 2);
    const width = lanes * 3.5 + 1.6;
    const simp = simplifyWithY(pts, ys, 0.6);
    express.push([t.highway === 'motorway' || t.highway === 'motorway_link' ? 1 : 0, Math.round(width * 10) / 10, simp.flatMap(([x, z, y]) => [q(x), q(z), q(y)])]);
    if (!isBridge) occ.strokePolyline(pts, width / 2 + 3, OCC_ROAD);
    else occ.strokePolyline(pts, width / 2 + 2, OCC_EXPRESS);
  }

  /* ---- railway ---- */
  const rail: number[][] = [];
  for (const e of loadCache('railway.json') as OsmWay[]) {
    if (e.type !== 'way') continue;
    const pts = geomToXZ(e.geometry);
    if (pts.length < 2) continue;
    rail.push(qpoly(simplify(pts, 0.8)));
    occ.strokePolyline(pts, 6, OCC_RAIL);
  }

  /* ---- OSM buildings ---- */
  const buildings: BuildingRec[] = [];
  let dropped = 0;
  for (const b of loadBuildings()) {
    let ring = simplify(b.rings, 0.4);
    if (ring.length < 3) continue;
    const area = polygonArea(ring);
    if (area < 12) continue;
    if (signedAreaMap(ring) < 0) ring = ring.slice().reverse();
    // drop buildings conflicting with expressway decks
    let xmin = Infinity;
    let xmax = -Infinity;
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const p of ring) {
      xmin = Math.min(xmin, p[0]);
      xmax = Math.max(xmax, p[0]);
      zmin = Math.min(zmin, p[1]);
      zmax = Math.max(zmax, p[1]);
    }
    let conflict = false;
    for (const s of xg.near(xmin, zmin, xmax, zmax)) {
      const p: V2 = [s.x, s.z];
      if (pointInPolygon(p, ring) || distPointPolyEdge(p, ring) < s.hw + 1.0) {
        conflict = true;
        break;
      }
    }
    if (conflict) {
      dropped++;
      continue;
    }
    const h = estimateHeight(b.id, b.tags, area);
    const minH = numTag(b.tags, 'min_height') ?? (numTag(b.tags, 'building:min_level') ?? 0) * 3.1;
    const rec: BuildingRec = { p: qpoly(ring), h: Math.round(h * 10) / 10, s: facadeStyle(b.id, b.tags, h) };
    if (minH > 0 && minH < h - 2) rec.m = Math.round(minH * 10) / 10;
    buildings.push(rec);
    occ.fillPolygon(ring, OCC_BUILDING);
  }
  console.log(`  OSM buildings: ${buildings.length} (dropped ${dropped} conflicting with the expressway)`);

  /* ---- procedural infill near the ring ---- */
  const ringDist = new Raster(x0, z0, x1, z1, 40);
  for (const e of net.edges) for (const p of e.pts) ringDist.setCell(ringDist.ix(p[0]), ringDist.iz(p[1]), 1);
  // chamfer distance (in cells) from the network
  const dist = new Float32Array(ringDist.w * ringDist.h).fill(1e9);
  for (let k = 0; k < dist.length; k++) if (ringDist.data[k]) dist[k] = 0;
  const W = ringDist.w;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < ringDist.h; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (i > 0) dist[k] = Math.min(dist[k], dist[k - 1] + 1);
        if (j > 0) dist[k] = Math.min(dist[k], dist[k - W] + 1);
      }
    for (let j = ringDist.h - 1; j >= 0; j--)
      for (let i = W - 1; i >= 0; i--) {
        const k = j * W + i;
        if (i < W - 1) dist[k] = Math.min(dist[k], dist[k + 1] + 1);
        if (j < ringDist.h - 1) dist[k] = Math.min(dist[k], dist[k + W] + 1);
      }
  }
  const distAt = (x: number, z: number) => {
    const i = ringDist.ix(x);
    const j = ringDist.iz(z);
    if (i < 0 || j < 0 || i >= W || j >= ringDist.h) return 1e9;
    return dist[j * W + i] * ringDist.res;
  };
  // nearest street direction for alignment
  const streetGrid = new Map<string, { a: V2; b: V2 }[]>();
  for (const r of roadLines) {
    for (let k = 0; k + 1 < r.pts.length; k++) {
      const a = r.pts[k];
      const b = r.pts[k + 1];
      const key = `${Math.floor(a[0] / 60)},${Math.floor(a[1] / 60)}`;
      let arr = streetGrid.get(key);
      if (!arr) streetGrid.set(key, (arr = []));
      arr.push({ a, b });
    }
  }
  const streetAngle = (x: number, z: number) => {
    let best = Infinity;
    let ang = 0;
    const cx = Math.floor(x / 60);
    const cz = Math.floor(z / 60);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const { a, b } of streetGrid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const d = Math.hypot((a[0] + b[0]) / 2 - x, (a[1] + b[1]) / 2 - z);
          if (d < best) {
            best = d;
            ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
          }
        }
    return ang;
  };
  const rnd = mulberry32(20000128);
  let infill = 0;
  const step = 22;
  for (let z = z0 + 10; z < z1 - 10; z += step) {
    for (let x = x0 + 10; x < x1 - 10; x += step) {
      const px = x + (rnd() - 0.5) * 10;
      const pz = z + (rnd() - 0.5) * 10;
      const d = distAt(px, pz);
      if (d > 1200) continue;
      if (occ.get(px, pz) & ALL_OCC) continue;
      const ang = streetAngle(px, pz);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      for (let attempt = 0; attempt < 3; attempt++) {
        const shrink = 1 - attempt * 0.25;
        const lw = (14 + rnd() * 22) * shrink;
        const ld = (11 + rnd() * 16) * shrink;
        const corners: V2[] = [
          [-lw / 2, -ld / 2],
          [lw / 2, -ld / 2],
          [lw / 2, ld / 2],
          [-lw / 2, ld / 2],
        ].map(([u, v]) => [px + u * ca - v * sa, pz + u * sa + v * ca] as V2);
        if (!occ.polygonFree(corners, ALL_OCC)) continue;
        const r = rnd();
        let floors: number;
        if (d < 250) floors = r < 0.5 ? 6 + Math.floor(rnd() * 6) : r < 0.85 ? 10 + Math.floor(rnd() * 14) : 24 + Math.floor(rnd() * 16);
        else floors = r < 0.35 ? 5 + Math.floor(rnd() * 5) : r < 0.8 ? 9 + Math.floor(rnd() * 15) : 25 + Math.floor(rnd() * 20);
        const h = floors * 3.1 + 1.2;
        const ring = signedAreaMap(corners) < 0 ? corners.slice().reverse() : corners;
        buildings.push({ p: qpoly(ring), h: Math.round(h * 10) / 10, s: h > 60 ? (rnd() < 0.7 ? 2 : 3) : h > 25 ? 1 : 0 });
        occ.fillPolygon(ring, OCC_BUILDING);
        // keep a small courtyard margin around
        occ.strokePolyline([...ring, ring[0]], 3, OCC_BUILDING);
        infill++;
        break;
      }
    }
  }
  console.log(`  procedural infill buildings: ${infill}`);

  /* ---- trees ---- */
  const trees: number[] = [];
  const trnd = mulberry32(1999);
  for (const r of roadLines) {
    if (r.kind > 3) continue;
    for (let k = 0; k + 1 < r.pts.length; k++) {
      const a = r.pts[k];
      const b = r.pts[k + 1];
      const len = dist2(a, b);
      const nx = -(b[1] - a[1]) / (len || 1);
      const nz = (b[0] - a[0]) / (len || 1);
      for (let s = trnd() * 10; s < len; s += 13 + trnd() * 8) {
        const t = s / len;
        const cx = a[0] + (b[0] - a[0]) * t;
        const cz = a[1] + (b[1] - a[1]) * t;
        if (distAt(cx, cz) > 650) continue;
        for (const side of [-1, 1]) {
          const off = r.w / 2 + 1.8;
          const px = cx + nx * off * side;
          const pz = cz + nz * off * side;
          if (occ.get(px, pz) & (OCC_BUILDING | OCC_WATER | OCC_EXPRESS | OCC_RAIL)) continue;
          trees.push(q(px), q(pz), Math.round(70 + trnd() * 70));
        }
      }
    }
  }
  for (const gp of greenPolys) {
    const area = polygonArea(gp);
    let cxmin = Infinity;
    let cxmax = -Infinity;
    let czmin = Infinity;
    let czmax = -Infinity;
    for (const p of gp) {
      cxmin = Math.min(cxmin, p[0]);
      cxmax = Math.max(cxmax, p[0]);
      czmin = Math.min(czmin, p[1]);
      czmax = Math.max(czmax, p[1]);
    }
    const count = Math.min(700, Math.floor(area / 200));
    for (let k = 0; k < count; k++) {
      const px = cxmin + trnd() * (cxmax - cxmin);
      const pz = czmin + trnd() * (czmax - czmin);
      if (!pointInPolygon([px, pz], gp)) continue;
      if (distAt(px, pz) > 900) continue;
      if (occ.get(px, pz) & (OCC_BUILDING | OCC_WATER | OCC_EXPRESS | OCC_ROAD | OCC_RAIL)) continue;
      trees.push(q(px), q(pz), Math.round(80 + trnd() * 90));
    }
  }
  console.log(`  trees: ${trees.length / 3}`);

  /* ---- skyline (tall buildings outside the detailed area) ---- */
  const skyline: BuildingRec[] = [];
  for (const e of loadCache('skyline.json')) {
    let rings: V2[][] = [];
    let tags: Record<string, string> = {};
    let id = e.id;
    if (e.type === 'way') {
      tags = (e as OsmWay).tags ?? {};
      rings = [closedRing(geomToXZ((e as OsmWay).geometry))];
    } else if (e.type === 'relation') {
      tags = (e as OsmRelation).tags ?? {};
      rings = assembleMultipolygon(e as OsmRelation).outer.map(closedRing);
      id = e.id * 13;
    }
    for (const ring0 of rings) {
      if (ring0.length < 3) continue;
      const c = ring0.reduce((s, p) => [s[0] + p[0] / ring0.length, s[1] + p[1] / ring0.length], [0, 0]);
      if (c[0] > x0 && c[0] < x1 && c[1] > z0 && c[1] < z1) continue;
      let ring = simplify(ring0, 1.0);
      if (ring.length < 3) continue;
      if (signedAreaMap(ring) < 0) ring = ring.slice().reverse();
      const h = estimateHeight(id, tags, polygonArea(ring));
      skyline.push({ p: qpoly(ring), h: Math.round(h * 10) / 10, s: facadeStyle(id, tags, h) });
    }
  }
  console.log(`  skyline buildings: ${skyline.length}`);

  const landmarks: LandmarkRec[] = LANDMARKS.map((l) => {
    const [x, z] = proj.project(l.lat, l.lon);
    return { id: l.id, name: l.name, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, h: l.h };
  });

  annotateNetwork(net, buildings, wr, WATER);

  const city: CityFile = {
    version: 1,
    bounds: [Math.round(x0), Math.round(z0), Math.round(x1), Math.round(z1)],
    buildings,
    skyline,
    roads: [...roads, ...express.map(([k, w, p]) => [10 + k, w, p] as [number, number, number[]])],
    water,
    green,
    rail,
    trees,
    landmarks,
    terrain: null,
  };

  // terrain flattening mask: distance to streets / buildings / expressways
  const fm = new Raster(x0, z0, x1, z1, 20);
  for (let j = 0; j < fm.h; j++)
    for (let i = 0; i < fm.w; i++) {
      const v = occ.get(fm.x0 + (i + 0.5) * fm.res, fm.z0 + (j + 0.5) * fm.res);
      if (v & (OCC_ROAD | OCC_EXPRESS | OCC_BUILDING | OCC_RAIL)) fm.data[j * fm.w + i] = 1;
    }
  const fd = new Float32Array(fm.w * fm.h).fill(1e9);
  for (let k = 0; k < fd.length; k++) if (fm.data[k]) fd[k] = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < fm.h; j++)
      for (let i = 0; i < fm.w; i++) {
        const k = j * fm.w + i;
        if (i > 0) fd[k] = Math.min(fd[k], fd[k - 1] + 1);
        if (j > 0) fd[k] = Math.min(fd[k], fd[k - fm.w] + 1);
      }
    for (let j = fm.h - 1; j >= 0; j--)
      for (let i = fm.w - 1; i >= 0; i--) {
        const k = j * fm.w + i;
        if (i < fm.w - 1) fd[k] = Math.min(fd[k], fd[k + 1] + 1);
        if (j < fm.h - 1) fd[k] = Math.min(fd[k], fd[k + fm.w] + 1);
      }
  }
  const flatten = (x: number, z: number) => {
    const i = fm.ix(x);
    const j = fm.iz(z);
    if (i < 0 || j < 0 || i >= fm.w || j >= fm.h) return 1;
    return smoothstep(30, 160, fd[j * fm.w + i] * fm.res);
  };
  return { city, water: wr, flatten };
}

const LANDMARKS = [
  { id: 'canton-tower', name: '广州塔', lat: 23.108988, lon: 113.317793, h: 600 },
  { id: 'ctf', name: '广州周大福金融中心', lat: 23.120524, lon: 113.320759, h: 530 },
  { id: 'ifc', name: '广州国际金融中心', lat: 23.119558, lon: 113.317855, h: 440 },
  { id: 'citic', name: '中信广场', lat: 23.144768, lon: 113.319385, h: 391 },
  { id: 'zhenhai', name: '镇海楼', lat: 23.140603, lon: 113.260276, h: 28 },
  { id: 'station', name: '广州火车站', lat: 23.150612, lon: 113.252099, h: 30 },
  { id: 'opera', name: '广州大剧院', lat: 23.117781, lon: 113.317111, h: 43 },
  { id: 'memorial', name: '中山纪念堂', lat: 23.135588, lon: 113.259354, h: 49 },
  { id: 'guangzhou-circle', name: '广州圆', lat: 23.052582, lon: 113.254532, h: 138 },
  { id: 'haiyin-bridge', name: '海印大桥', lat: 23.112216, lon: 113.281724, h: 157 },
  { id: 'haizhu-bridge', name: '海珠桥', lat: 23.115422, lon: 113.261615, h: 30 },
];

/** Heights along a polyline: own height, ramping from/to the endpoint heights with max grade g. */
function profileHeights(pts: V2[], own: number, h0: number, h1: number, g: number): number[] {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist2(pts[k - 1], pts[k]));
  const L = cum[cum.length - 1];
  return cum.map((s) => {
    const fromStart = h0 - g * s;
    const fromEnd = h1 - g * (L - s);
    let y = Math.max(own, fromStart, fromEnd, 0);
    // bridges rise from their ends when the end nodes are lower
    if (own > 0) y = Math.min(y, Math.max(h0 + g * s, h1 + g * (L - s), fromStart, fromEnd));
    return Math.max(0, y);
  });
}

function simplifyWithY(pts: V2[], ys: number[], tol: number): [number, number, number][] {
  // simplify in xz but keep vertices where y changes notably
  const keep = new Set(simplify(pts.map((p, i) => [p[0], p[1] + ys[i] * 0] as V2), tol).map((p) => `${p[0]},${p[1]}`));
  const out: [number, number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const k = `${pts[i][0]},${pts[i][1]}`;
    const yChange = i > 0 && i < pts.length - 1 && Math.abs(ys[i] - (ys[i - 1] + ys[i + 1]) / 2) > 0.3;
    if (keep.has(k) || yChange || i === 0 || i === pts.length - 1) out.push([pts[i][0], pts[i][1], ys[i]]);
  }
  return out;
}

/** Noise barriers next to nearby buildings; bridges over water. */
function annotateNetwork(net: Network, buildings: BuildingRec[], wr: Raster, WATER: number) {
  const cell = 40;
  const grid = new Map<string, { poly: V2[]; h: number }[]>();
  for (const b of buildings) {
    const poly: V2[] = [];
    for (let k = 0; k < b.p.length; k += 2) poly.push([b.p[k] / 10, b.p[k + 1] / 10]);
    const c = poly[0];
    const key = `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)}`;
    let a = grid.get(key);
    if (!a) grid.set(key, (a = []));
    a.push({ poly, h: b.h });
  }
  const nearBuilding = (p: V2, y: number, maxD: number) => {
    const cx = Math.floor(p[0] / cell);
    const cz = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const b of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          if (b.h < y + 3) continue;
          if (distPointPolyEdge(p, b.poly) < maxD) return true;
        }
    return false;
  };
  for (const e of net.edges) {
    const n = e.pts.length;
    e.noiseL = new Array(n).fill(0);
    e.noiseR = new Array(n).fill(0);
    const nl = e.noiseL;
    const nr = e.noiseR;
    for (let i = 0; i < n; i++) {
      // bridges over the river
      if (e.y[i] > 2.5 && wr.get(e.pts[i][0], e.pts[i][1]) & WATER) e.struct[i] = 2;
      if (e.kind !== 'main' || e.y[i] < 4 || i % 2) continue;
      const a = e.pts[Math.max(0, i - 1)];
      const b = e.pts[Math.min(n - 1, i + 1)];
      const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / dl;
      const nz = (b[0] - a[0]) / dl;
      const pR: V2 = [e.pts[i][0] + nx * (e.br[i] + 4), e.pts[i][1] + nz * (e.br[i] + 4)];
      const pL: V2 = [e.pts[i][0] + nx * (e.bl[i] - 4), e.pts[i][1] + nz * (e.bl[i] - 4)];
      if (e.or[i] < 0 && nearBuilding(pR, e.y[i], 14)) nr[i] = nr[Math.min(n - 1, i + 1)] = 1;
      if (e.ol[i] < 0 && nearBuilding(pL, e.y[i], 14)) nl[i] = nl[Math.min(n - 1, i + 1)] = 1;
    }
    // close short gaps and drop short runs
    for (const arr of [nl, nr]) {
      fillGaps(arr, Math.round(40 / e.ds));
      dropShort(arr, Math.round(60 / e.ds));
      for (let i = 0; i < n; i++) if ((arr === nl ? e.ol[i] : e.or[i]) >= 0) arr[i] = 0;
    }
  }
}

function fillGaps(a: number[], maxGap: number) {
  let last = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i]) {
      if (last >= 0 && i - last - 1 <= maxGap) for (let k = last + 1; k < i; k++) a[k] = 1;
      last = i;
    }
  }
}
function dropShort(a: number[], minRun: number) {
  let start = -1;
  for (let i = 0; i <= a.length; i++) {
    if (i < a.length && a[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start < minRun) for (let k = start; k < i; k++) a[k] = 0;
      start = -1;
    }
  }
}





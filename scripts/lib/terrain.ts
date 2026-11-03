/**
 * Distant terrain (Baiyun Mountain, Yuexiu Hill) from public Terrarium
 * elevation tiles (AWS Open Data, derived from SRTM and others). The flat
 * city base is removed so only hills remain; areas near streets are flattened.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from './config';
import { proj } from './osm';
import { decodePNG } from './png';
import { smoothstep } from '../../src/shared/math';
import type { TerrainRec } from '../../src/shared/types';

const ZOOM = 13;
const TILE_URL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

function lonToTile(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function getTile(x: number, y: number): Promise<{ w: number; h: number; data: Uint8Array; channels: number } | null> {
  const dir = join(CACHE_DIR, 'dem');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${ZOOM}_${x}_${y}.png`);
  let buf: Buffer;
  if (await exists(file)) buf = await readFile(file);
  else {
    const res = await fetch(TILE_URL(ZOOM, x, y));
    if (!res.ok) {
      console.warn(`  DEM tile ${x},${y}: HTTP ${res.status}`);
      return null;
    }
    buf = Buffer.from(await res.arrayBuffer());
    await writeFile(file, buf);
  }
  return decodePNG(buf);
}

/**
 * @param flatten optional mask function returning 0..1 (0 = force flat) for world xz.
 */
export async function buildTerrain(halfSize = 13000, res = 384, flatten?: (x: number, z: number) => number): Promise<TerrainRec | null> {
  try {
    const tiles = new Map<string, Awaited<ReturnType<typeof getTile>>>();
    const sample = async (lat: number, lon: number): Promise<number> => {
      const tx = lonToTile(lon, ZOOM);
      const ty = latToTile(lat, ZOOM);
      const ix = Math.floor(tx);
      const iy = Math.floor(ty);
      const key = `${ix},${iy}`;
      if (!tiles.has(key)) tiles.set(key, await getTile(ix, iy));
      const t = tiles.get(key);
      if (!t) return 0;
      const px = Math.min(t.w - 1, Math.floor((tx - ix) * t.w));
      const py = Math.min(t.h - 1, Math.floor((ty - iy) * t.h));
      const k = (py * t.w + px) * t.channels;
      return t.data[k] * 256 + t.data[k + 1] + t.data[k + 2] / 256 - 32768;
    };
    const raw = new Float32Array(res * res);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = -halfSize + (i / (res - 1)) * 2 * halfSize;
        const z = -halfSize + (j / (res - 1)) * 2 * halfSize;
        const ll = proj.unproject(x, z);
        raw[j * res + i] = await sample(ll.lat, ll.lon);
      }
    }
    // city base level: median of the central area
    const central: number[] = [];
    for (let j = res * 0.35; j < res * 0.65; j += 3) for (let i = res * 0.35; i < res * 0.65; i += 3) central.push(raw[Math.floor(j) * res + Math.floor(i)]);
    central.sort((a, b) => a - b);
    const base = central[Math.floor(central.length / 2)];
    const out = new Int16Array(res * res);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = -halfSize + (i / (res - 1)) * 2 * halfSize;
        const z = -halfSize + (j / (res - 1)) * 2 * halfSize;
        let h = raw[j * res + i] - base;
        // keep hills only, smooth transition to the flat city
        h = Math.max(0, h - 10) * smoothstep(10, 30, h);
        if (flatten) h *= flatten(x, z);
        // water / below base
        out[j * res + i] = Math.round(Math.max(0, h) * 10);
      }
    }
    console.log(`  terrain: base ${base.toFixed(1)} m, ${tiles.size} tiles`);
    return {
      bounds: [-halfSize, -halfSize, halfSize, halfSize],
      w: res,
      h: res,
      data: Buffer.from(out.buffer).toString('base64'),
    };
  } catch (err) {
    console.warn('  terrain unavailable:', (err as Error).message);
    return null;
  }
}

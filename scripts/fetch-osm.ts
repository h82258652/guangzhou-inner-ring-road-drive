/**
 * Downloads the raw OpenStreetMap data used by the game from the Overpass API
 * and caches it in scripts/.cache (gitignored). Run `npm run data:fetch`.
 *
 * Map data © OpenStreetMap contributors, available under the ODbL.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { BBOX_CITY, BBOX_EXPRESS, BBOX_SKYLINE, CACHE_DIR } from './lib/config';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const USER_AGENT = 'guangzhou-inner-ring-road-drive/0.1 (open source game data pipeline)';

interface QuerySpec {
  file: string;
  query: string;
}

const bb = (b: readonly number[]) => b.join(',');

const QUERIES: QuerySpec[] = [
  {
    file: 'expressways.json',
    query: `[out:json][timeout:240];
(
  way["highway"~"^(motorway|trunk|motorway_link|trunk_link)$"](${bb(BBOX_EXPRESS)});
);
out body geom;
rel(19265916);
out body;`,
  },
  {
    file: 'roads.json',
    query: `[out:json][timeout:240];
way["highway"~"^(primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian)$"](${bb(BBOX_CITY)});
out body geom;`,
  },
  {
    file: 'buildings.json',
    query: `[out:json][timeout:300];
(
  way["building"](${bb(BBOX_CITY)});
  relation["building"](${bb(BBOX_CITY)});
);
out geom;`,
  },
  {
    // Large river multipolygons are too heavy to download whole; fetch only the
    // outline ways that intersect the area (rebuilt by flood fill in the pipeline).
    file: 'water.json',
    query: `[out:json][timeout:300];
(
  relation["natural"="water"](${bb(BBOX_CITY)});
  relation["waterway"="riverbank"](${bb(BBOX_CITY)});
)->.rels;
way(r.rels)(${bb(BBOX_CITY)});
out geom;
(
  way["natural"="water"](${bb(BBOX_CITY)});
  way["waterway"="riverbank"](${bb(BBOX_CITY)});
);
out geom;
way["waterway"~"^(river|canal)$"](${bb(BBOX_CITY)});
out geom;`,
  },
  {
    file: 'landuse.json',
    query: `[out:json][timeout:300];
(
  way["leisure"~"^(park|garden|pitch|playground|stadium|sports_centre)$"](${bb(BBOX_CITY)});
  relation["leisure"~"^(park|garden)$"](${bb(BBOX_CITY)});
  way["landuse"](${bb(BBOX_CITY)});
  relation["landuse"](${bb(BBOX_CITY)});
  way["natural"~"^(wood|scrub|grassland|heath)$"](${bb(BBOX_CITY)});
  relation["natural"~"^(wood|scrub)$"](${bb(BBOX_CITY)});
  way["amenity"~"^(parking|school|university|hospital)$"](${bb(BBOX_CITY)});
);
out geom;`,
  },
  {
    file: 'railway.json',
    query: `[out:json][timeout:240];
way["railway"~"^(rail)$"]["tunnel"!="yes"](${bb(BBOX_CITY)});
out geom;`,
  },
  {
    file: 'skyline.json',
    query: `[out:json][timeout:300];
(
  way["building"]["height"](${bb(BBOX_SKYLINE)})(if: number(t["height"]) >= 60);
  way["building"]["building:levels"](${bb(BBOX_SKYLINE)})(if: number(t["building:levels"]) >= 20);
  relation["building"]["height"](${bb(BBOX_SKYLINE)})(if: number(t["height"]) >= 60);
);
out geom;`,
  },
  {
    file: 'landmarks.json',
    query: `[out:json][timeout:120];
(
  nwr["name"~"^(广州塔|中信广场|广州国际金融中心|广州周大福金融中心|镇海楼|广州站|广州火车站|海印大桥|中山纪念堂|广州大剧院|白云山|越秀山|摩星岭|海珠桥|人民桥|江湾大桥|广州圆)$"](23.0,113.15,23.25,113.45);
);
out tags center;`,
  },
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runQuery(query: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
      const text = await res.text();
      const parsed = JSON.parse(text) as { remark?: string };
      if (parsed.remark && /runtime error|timed out/i.test(parsed.remark)) {
        throw new Error(`${endpoint} -> ${parsed.remark}`);
      }
      return text;
    } catch (err) {
      lastErr = err;
      const wait = 5000 * (attempt + 1);
      console.warn(`  attempt ${attempt + 1} failed: ${(err as Error).message}; retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main() {
  const force = process.argv.includes('--force');
  await mkdir(CACHE_DIR, { recursive: true });
  for (const q of QUERIES) {
    const out = join(CACHE_DIR, q.file);
    if (!force && (await exists(out))) {
      console.log(`✓ ${q.file} (cached)`);
      continue;
    }
    console.log(`↓ ${q.file} ...`);
    const text = await runQuery(q.query);
    await writeFile(out, text);
    console.log(`  saved ${(text.length / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log('Done. Map data © OpenStreetMap contributors (ODbL).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


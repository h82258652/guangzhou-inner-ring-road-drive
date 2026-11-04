/**
 * Downloads CC0 PBR textures from Poly Haven (https://polyhaven.com, CC0) into
 * public/assets/textures and records their provenance in CREDITS.md.
 * Run `npm run assets`.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

interface Spec {
  id: string;
  as: string;
  maps: ('Diffuse' | 'nor_gl' | 'Rough')[];
}

const TEXTURES: Spec[] = [
  { id: 'asphalt_02', as: 'asphalt', maps: ['Diffuse', 'nor_gl', 'Rough'] },
  { id: 'brushed_concrete', as: 'concrete', maps: ['Diffuse', 'nor_gl', 'Rough'] },
  { id: 'concrete_floor_02', as: 'pavement', maps: ['Diffuse', 'nor_gl'] },
];

const SUFFIX: Record<string, string> = { Diffuse: 'diff', nor_gl: 'normal', Rough: 'rough' };
const OUT = 'public/assets/textures';

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const credits: string[] = [];
  for (const t of TEXTURES) {
    const info = (await (await fetch(`https://api.polyhaven.com/info/${t.id}`)).json()) as { name: string; authors: Record<string, string> };
    const files = (await (await fetch(`https://api.polyhaven.com/files/${t.id}`)).json()) as Record<string, Record<string, { jpg: { url: string } }>>;
    for (const m of t.maps) {
      const url = files[m]['1k'].jpg.url;
      const out = join(OUT, `${t.as}_${SUFFIX[m]}.jpg`);
      if (!(await exists(out))) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        await writeFile(out, Buffer.from(await res.arrayBuffer()));
        console.log(`↓ ${out}`);
      } else console.log(`✓ ${out}`);
    }
    credits.push(`| \`${t.as}_*.jpg\` | ${info.name} | ${Object.keys(info.authors).join(', ')} | https://polyhaven.com/a/${t.id} | CC0 |`);
  }
  console.log('\nCREDITS rows:\n' + credits.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Procedural facade atlas (4x3 cells): day colour + night emissive windows,
 * modelled on Guangzhou building types (tiled 90s residential blocks with
 * security grilles and AC units, old arcade houses, glass offices, ...).
 * Each wall cell spans 4 window columns x 4 floors (12.8 m x 12.4 m).
 */
import * as THREE from 'three';
import { mulberry32 } from '../shared/math';
import { envUniforms } from './Materials';

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 3;
export const CELL_W = 12.8;
export const CELL_H = 12.4;
export const ROOF_STYLE = 8;
const CELL = 512;

type Painter = (g: CanvasRenderingContext2D, n: CanvasRenderingContext2D, r: () => number) => void;

function windowGrid(
  g: CanvasRenderingContext2D,
  n: CanvasRenderingContext2D,
  r: () => number,
  opt: { wall: string; win: string; frame: string; wx: number; wy: number; ww: number; wh: number; grill?: boolean; ac?: boolean; balcony?: string; lit?: number },
) {
  g.fillStyle = opt.wall;
  g.fillRect(0, 0, CELL, CELL);
  // tile texture
  g.globalAlpha = 0.08;
  for (let y = 0; y < CELL; y += 8) {
    g.fillStyle = y % 16 ? '#000' : '#fff';
    g.fillRect(0, y, CELL, 1);
  }
  g.globalAlpha = 1;
  n.fillStyle = '#000';
  n.fillRect(0, 0, CELL, CELL);
  const cw = CELL / 4;
  const ch = CELL / 4;
  for (let fy = 0; fy < 4; fy++) {
    for (let fx = 0; fx < 4; fx++) {
      const x = fx * cw + (cw - opt.ww) * opt.wx;
      const y = fy * ch + (ch - opt.wh) * opt.wy;
      if (opt.balcony) {
        g.fillStyle = opt.balcony;
        g.fillRect(fx * cw + 6, y + opt.wh - 4, cw - 12, ch * 0.18);
      }
      g.fillStyle = opt.frame;
      g.fillRect(x - 3, y - 3, opt.ww + 6, opt.wh + 6);
      const shade = 0.75 + r() * 0.35;
      g.fillStyle = opt.win;
      g.globalAlpha = shade;
      g.fillRect(x, y, opt.ww, opt.wh);
      g.globalAlpha = 1;
      // reflections
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.beginPath();
      g.moveTo(x, y + opt.wh);
      g.lineTo(x + opt.ww * 0.5, y);
      g.lineTo(x + opt.ww * 0.7, y);
      g.lineTo(x + opt.ww * 0.2, y + opt.wh);
      g.fill();
      if (opt.grill) {
        // 防盗网 security grilles
        g.strokeStyle = 'rgba(60,60,60,0.75)';
        g.lineWidth = 2;
        g.strokeRect(x - 6, y - 6, opt.ww + 12, opt.wh + 10);
        for (let k = 1; k < 7; k++) {
          g.beginPath();
          g.moveTo(x - 6 + ((opt.ww + 12) * k) / 7, y - 6);
          g.lineTo(x - 6 + ((opt.ww + 12) * k) / 7, y + opt.wh + 4);
          g.stroke();
        }
      }
      if (opt.ac && r() < 0.7) {
        // air conditioner outdoor units
        const ax = x + (r() < 0.5 ? -26 : opt.ww - 8);
        const ay = y + opt.wh - 22;
        g.fillStyle = '#e8e8e2';
        g.fillRect(ax, ay, 34, 24);
        g.strokeStyle = '#999';
        g.lineWidth = 1;
        g.strokeRect(ax, ay, 34, 24);
        g.fillStyle = '#777';
        g.beginPath();
        g.arc(ax + 12, ay + 12, 8, 0, Math.PI * 2);
        g.fill();
      }
      // night lights
      const lit = r() < (opt.lit ?? 0.45);
      if (lit) {
        const warm = r() < 0.65;
        n.fillStyle = warm ? `rgb(${230 + r() * 25},${170 + r() * 40},${90 + r() * 40})` : `rgb(${200 + r() * 30},${215 + r() * 30},${235})`;
        n.globalAlpha = 0.55 + r() * 0.45;
        n.fillRect(x, y, opt.ww, opt.wh);
        n.globalAlpha = 1;
      }
    }
  }
}

const PAINTERS: Painter[] = [
  // 0 old low-rise (plaster, shutters)
  (g, n, r) =>
    windowGrid(g, n, r, { wall: '#c9b48e', win: '#2b2f33', frame: '#7d6a4f', wx: 0.5, wy: 0.45, ww: 58, wh: 74, grill: true, lit: 0.5 }),
  // 1 mid-rise residential: white tiles, grilles, AC units
  (g, n, r) => windowGrid(g, n, r, { wall: '#dcd8cc', win: '#30383e', frame: '#b8b4aa', wx: 0.5, wy: 0.45, ww: 70, wh: 66, grill: true, ac: true, lit: 0.55 }),
  // 2 high-rise residential: beige tiles, balconies
  (g, n, r) => windowGrid(g, n, r, { wall: '#d6cdbd', win: '#3a4750', frame: '#efe9dc', wx: 0.5, wy: 0.35, ww: 84, wh: 72, ac: true, balcony: '#bfb6a6', lit: 0.5 }),
  // 3 glass office tower
  (g, n, r) => {
    g.fillStyle = '#5d7f8e';
    g.fillRect(0, 0, CELL, CELL);
    n.fillStyle = '#000';
    n.fillRect(0, 0, CELL, CELL);
    for (let fy = 0; fy < 4; fy++)
      for (let fx = 0; fx < 8; fx++) {
        const x = fx * 64;
        const y = fy * 128;
        const l = 38 + r() * 18;
        g.fillStyle = `hsl(${195 + r() * 12}, ${22 + r() * 18}%, ${l}%)`;
        g.fillRect(x + 3, y + 3, 58, 104);
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fillRect(x + 3, y + 3, 58, 30);
        if (r() < 0.55) {
          n.fillStyle = `rgb(${210 + r() * 40},${225 + r() * 25},255)`;
          n.globalAlpha = 0.4 + r() * 0.5;
          n.fillRect(x + 3, y + 3, 58, 104);
          n.globalAlpha = 1;
        }
      }
    g.fillStyle = '#c9d3d8';
    for (let fy = 0; fy < 4; fy++) g.fillRect(0, fy * 128 + 107, CELL, 21);
    for (let fx = 0; fx <= 8; fx++) g.fillRect(fx * 64 - 2, 0, 4, CELL);
  },
  // 4 commercial / podium
  (g, n, r) => {
    windowGrid(g, n, r, { wall: '#b9b4ab', win: '#28343c', frame: '#8f8a80', wx: 0.5, wy: 0.4, ww: 112, wh: 80, lit: 0.6 });
    for (let fy = 0; fy < 4; fy++) {
      if (r() < 0.5) continue;
      const hue = Math.floor(r() * 360);
      g.fillStyle = `hsl(${hue},55%,45%)`;
      g.fillRect(10, fy * 128 + 8, CELL - 20, 20);
      n.fillStyle = `hsl(${hue},80%,55%)`;
      n.fillRect(10, fy * 128 + 8, CELL - 20, 20);
    }
  },
  // 5 industrial
  (g, n, r) => {
    g.fillStyle = '#8f9696';
    g.fillRect(0, 0, CELL, CELL);
    for (let x = 0; x < CELL; x += 12) {
      g.fillStyle = x % 24 ? '#7f8686' : '#9ea5a5';
      g.fillRect(x, 0, 6, CELL);
    }
    n.fillStyle = '#000';
    n.fillRect(0, 0, CELL, CELL);
    for (let fx = 0; fx < 4; fx++) {
      g.fillStyle = '#39444a';
      g.fillRect(fx * 128 + 20, 380, 88, 40);
      if (r() < 0.3) {
        n.fillStyle = '#d8c79a';
        n.fillRect(fx * 128 + 20, 380, 88, 40);
      }
    }
  },
  // 6 pink/peach tiled residential
  (g, n, r) => windowGrid(g, n, r, { wall: '#d9b3a4', win: '#2f363b', frame: '#efe2da', wx: 0.5, wy: 0.45, ww: 66, wh: 70, grill: true, ac: true, lit: 0.55 }),
  // 7 dark glass office
  (g, n, r) => {
    g.fillStyle = '#26323a';
    g.fillRect(0, 0, CELL, CELL);
    n.fillStyle = '#000';
    n.fillRect(0, 0, CELL, CELL);
    for (let fy = 0; fy < 8; fy++)
      for (let fx = 0; fx < 4; fx++) {
        g.fillStyle = `hsl(205, 20%, ${18 + r() * 14}%)`;
        g.fillRect(fx * 128 + 4, fy * 64 + 6, 120, 52);
        if (r() < 0.5) {
          n.fillStyle = 'rgb(230,238,255)';
          n.globalAlpha = 0.35 + r() * 0.5;
          n.fillRect(fx * 128 + 4, fy * 64 + 6, 120, 52);
          n.globalAlpha = 1;
        }
      }
  },
  // 8-11 roofs
  (g, _n, r) => roof(g, r, '#8e8c86'),
  (g, _n, r) => roof(g, r, '#7c7b78'),
  (g, _n, r) => roof(g, r, '#9a948a'),
  (g, _n, r) => roof(g, r, '#6f7377'),
];

function roof(g: CanvasRenderingContext2D, r: () => number, base: string) {
  g.fillStyle = base;
  g.fillRect(0, 0, CELL, CELL);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.12})`;
    g.fillRect(r() * CELL, r() * CELL, 4 + r() * 30, 4 + r() * 30);
  }
  // water tanks / equipment
  for (let i = 0; i < 4; i++) {
    g.fillStyle = r() < 0.5 ? '#c9c9c4' : '#4f6d8a';
    const x = r() * 420;
    const y = r() * 420;
    g.fillRect(x, y, 40 + r() * 50, 40 + r() * 50);
  }
}

let atlas: { day: THREE.CanvasTexture; night: THREE.CanvasTexture } | null = null;

export function facadeAtlas() {
  if (atlas) return atlas;
  const W = CELL * ATLAS_COLS;
  const H = CELL * ATLAS_ROWS;
  const dc = document.createElement('canvas');
  dc.width = W;
  dc.height = H;
  const nc = document.createElement('canvas');
  nc.width = W;
  nc.height = H;
  const dg = dc.getContext('2d')!;
  const ng = nc.getContext('2d')!;
  PAINTERS.forEach((p, i) => {
    const cx = (i % ATLAS_COLS) * CELL;
    const cy = Math.floor(i / ATLAS_COLS) * CELL;
    dg.save();
    ng.save();
    dg.translate(cx, cy);
    ng.translate(cx, cy);
    dg.beginPath();
    dg.rect(0, 0, CELL, CELL);
    dg.clip();
    ng.beginPath();
    ng.rect(0, 0, CELL, CELL);
    ng.clip();
    p(dg, ng, mulberry32(100 + i));
    dg.restore();
    ng.restore();
  });
  const day = new THREE.CanvasTexture(dc);
  day.colorSpace = THREE.SRGBColorSpace;
  day.anisotropy = 8;
  day.generateMipmaps = true;
  const night = new THREE.CanvasTexture(nc);
  night.colorSpace = THREE.SRGBColorSpace;
  atlas = { day, night };
  return atlas;
}

/** Building material sampling the atlas cell given by attribute aStyle; uv in cell units (repeating). */
export function buildingMaterial(): THREE.MeshStandardMaterial {
  const { day, night } = facadeAtlas();
  const m = new THREE.MeshStandardMaterial({ map: day, emissiveMap: night, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1, roughness: 0.82, metalness: 0.05 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = envUniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aStyle;\nvarying float vStyle;\nvarying vec2 vCellUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvStyle = aStyle;\nvCellUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uNight;\nvarying float vStyle;\nvarying vec2 vCellUv;\nvec2 atlasUv(){ float st = floor(vStyle + 0.5); vec2 cell = vec2(mod(st, ${ATLAS_COLS}.0), floor(st / ${ATLAS_COLS}.0)); vec2 f = fract(vCellUv); f = 0.004 + f * 0.992; return vec2((cell.x + f.x) / ${ATLAS_COLS}.0, (${ATLAS_ROWS}.0 - 1.0 - cell.y + f.y) / ${ATLAS_ROWS}.0); }`)
      .replace(
        '#include <map_fragment>',
        `vec2 aUv = atlasUv(); vec2 gx = dFdx(vCellUv) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0); vec2 gy = dFdy(vCellUv) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0);
        vec4 sampledDiffuseColor = textureGrad(map, aUv, gx, gy);
        diffuseColor *= sampledDiffuseColor;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `vec4 emissiveColor = textureGrad(emissiveMap, aUv, gx, gy);
        totalEmissiveRadiance *= emissiveColor.rgb * uNight * 1.6;`,
      );
  };
  m.customProgramCacheKey = () => 'building-atlas';
  return m;
}

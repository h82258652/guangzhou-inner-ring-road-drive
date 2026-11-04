/** Race furniture: chequered start / finish lines painted across the carriageway and name tags over the rivals. */
import * as THREE from 'three';
import type { RoadNetwork } from '../road/Network';
import { newFrame } from '../road/Network';
import type { LineId } from '../shared/types';

let checker: THREE.CanvasTexture | null = null;

function checkerTexture() {
  if (checker) return checker;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 16; i++)
    for (let j = 0; j < 4; j++) {
      g.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4';
      g.fillRect(i * 4, j * 4, 4, 4);
    }
  checker = new THREE.CanvasTexture(c);
  checker.colorSpace = THREE.SRGBColorSpace;
  checker.magFilter = THREE.NearestFilter;
  checker.wrapS = THREE.RepeatWrapping;
  return checker;
}

/** A 2.4 m wide chequered band across the lanes at arc length `ls` of the line. */
export function chequeredLine(net: RoadNetwork, line: LineId, ls: number): THREE.Mesh {
  const { edge, s } = net.atLineS(line, ls);
  const f = newFrame();
  const half = (edge.lanesAt(s) * edge.laneWidth) / 2;
  const pos: number[] = [];
  const uv: number[] = [];
  const along = [-1.2, 1.2];
  for (const a of along)
    for (const d of [-half, half]) {
      edge.frame(Math.max(0, Math.min(edge.length, s + a)), d, f);
      pos.push(f.x, edge.yAt(s + a) + 0.03, f.z);
      // 0.6 m squares: 16 columns per texture repeat, 4 rows along the band
      uv.push((d + half) / 9.6, a < 0 ? 0 : 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // counter-clockwise seen from above
  g.setIndex([0, 1, 2, 1, 3, 2]);
  g.computeVertexNormals();
  const tex = checkerTexture();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  m.name = 'race-line';
  return m;
}

/** Floating name tag (a sprite) to put above a rival's car. */
export function nameTag(name: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(10,14,18,0.72)';
  g.beginPath();
  g.roundRect(4, 8, 248, 48, 14);
  g.fill();
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.beginPath();
  g.arc(32, 32, 11, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 28px "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';
  g.textBaseline = 'middle';
  g.fillText(name, 54, 33, 190);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(3.6, 0.9, 1);
  sprite.position.set(0, 2.6, 0);
  sprite.name = 'name-tag';
  return sprite;
}

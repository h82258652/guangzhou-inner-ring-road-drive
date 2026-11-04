/**
 * Road signs after GB 5768.2-2022 for urban expressways: green guide signs
 * (exit number, Chinese + English destinations, blue inlays for ordinary
 * streets, white inlays for expressways), confirmation signs for 内环路 A/B
 * lines, speed limit signs, speed-camera warnings and variable message signs.
 * Sign faces are canvas textures created lazily near the player.
 */
import * as THREE from 'three';
import type { Edge, RoadNetwork } from '../road/Network';
import { newFrame } from '../road/Network';
import type { DeckIndex } from '../road/Clearance';
import type { CameraFile, ExitFile, LineId, SignFile } from '../shared/types';
import { type CantileverLayout, type GantryLayout, layoutCantilever, layoutGantry, layoutPole, layoutUnderDeck, type PoleLayout, shifts } from './SignLayout';

const FONT = '"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",sans-serif';
/** top of the beam above the deck: guide sign gantries / variable message signs */
const GANTRY_TOP = 9.65;
const VMS_TOP = 9.05;
const GREEN = '#0b6e3c';
const EXPRESS_RE = /高架|放射线|高速|快速|隧道|大桥|内环/;

interface SignInstance {
  spec: SignFile;
  group: THREE.Group;
  faces: { mesh: THREE.Mesh; draw: (g: CanvasRenderingContext2D, w: number, h: number) => void; w: number; h: number }[];
  pos: THREE.Vector3;
  loaded: boolean;
}

export class Signs {
  readonly group = new THREE.Group();
  private items: SignInstance[] = [];
  private metal = new THREE.MeshStandardMaterial({ color: 0x9aa2a8, metalness: 0.7, roughness: 0.4 });
  private back = new THREE.MeshStandardMaterial({ color: 0x6d7378, metalness: 0.5, roughness: 0.6 });
  private placeholder = new THREE.MeshStandardMaterial({ color: 0x0b5e34, roughness: 0.6 });
  /** signs that found no clear spot for their supports and were left out */
  readonly skipped: SignFile[] = [];
  /** enforcement cameras that are actually in the scene (only those may flash) */
  readonly cameras: CameraFile[] = [];
  vmsText: (line: LineId | null) => string[] = () => ['内环路 畅通', '保持车距 安全驾驶'];

  constructor(
    readonly net: RoadNetwork,
    readonly decks: DeckIndex,
  ) {
    this.group.name = 'signs';
    for (const s of net.signs) {
      if (!net.edges[s.edge]) continue;
      const inst = this.create(s);
      if (inst) {
        this.items.push(inst);
        this.group.add(inst.group);
      } else this.skipped.push(s);
    }
    for (const c of net.cameras) {
      const e = net.edges[c.edge];
      if (!e) continue;
      const inst = this.createCameraGantry(e, c.s, c.kind);
      if (!inst) continue;
      this.cameras.push(c);
      this.items.push(inst);
      this.group.add(inst.group);
    }
  }

  /** Group placed in the road frame of a layout: +X along the road, +Z to the right. */
  private framed(edge: Edge, s: number, y: number) {
    const f = edge.frame(s, 0, newFrame());
    const g = new THREE.Group();
    g.position.set(f.x, y, f.z);
    g.rotation.y = -Math.atan2(f.tz, f.tx);
    return g;
  }

  /** Two posts on the outer barriers (feet on their decks) and a beam at `top`. */
  private gantryFrame(g: THREE.Group, L: GantryLayout, top: number, beam: [number, number], postR: [number, number], x = 0.3) {
    for (const p of [L.left, L.right]) {
      const h = top + beam[1] / 2 - (p.base - L.y);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(postR[0], postR[1], h, 8), this.metal);
      post.position.set(x, p.base - L.y + h / 2, p.d);
      g.add(post);
    }
    const span = L.right.d - L.left.d;
    const bm = new THREE.Mesh(new THREE.BoxGeometry(beam[0], beam[1], span + 0.3), this.metal);
    bm.position.set(x, top, (L.left.d + L.right.d) / 2);
    g.add(bm);
  }

  /** Single post with an arm over the road at `top` (beam centre height). */
  private cantileverFrame(g: THREE.Group, L: CantileverLayout, top: number, x = 0.3) {
    const h = top + 0.35;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, h, 8), this.metal);
    post.position.set(x, h / 2, L.post.d);
    g.add(post);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.55, L.reach + 0.3), this.metal);
    arm.position.set(x, top, L.post.d - (L.side * L.reach) / 2);
    g.add(arm);
  }

  /**
   * Enforcement camera gantry (电子警察 / 测速) with one camera per lane; under
   * an upper deck the cameras hang from its underside instead.
   */
  private createCameraGantry(edge: Edge, s0: number, kind: 'fixed' | 'section-start' | 'section-end'): SignInstance | null {
    const tries = shifts(6, 42, 42);
    const L =
      layoutGantry(this.net, this.decks, edge, s0, 6.8, tries) ??
      layoutCantilever(this.net, this.decks, edge, s0, 6.8, 2.3, 1, tries, 4, 9) ??
      layoutUnderDeck(this.net, this.decks, edge, s0, tries);
    if (!L) return null;
    const { edge: e, s } = L;
    const i = e.idx(s);
    const g = this.framed(e, s, L.y);
    const right = e.brAt(s) + 0.9;
    if ('left' in L) this.gantryFrame(g, L, 6.6, [0.35, 0.35], [0.18, 0.22]);
    else if ('reach' in L) this.cantileverFrame(g, L, 6.6);
    // per lane: camera height under the beam, or just below the deck above (null: no camera over that lane)
    const mount = (k: number, z: number): number | null => {
      if ('ceilings' in L) return L.ceilings[k] === null ? null : L.ceilings[k]! - 0.15;
      if ('reach' in L && !(L.side > 0 ? z > L.post.d - L.reach + 0.4 : z < L.post.d + L.reach - 0.4)) return null;
      return 6.6;
    };
    const camMat = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.5 });
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2, metalness: 0.5 });
    const lanes = Math.max(1, Math.round(e.lanes[i]));
    for (let k = 0; k < lanes; k++) {
      const z = e.laneCenter(s, k);
      const H = mount(k, z);
      if (H === null) continue;
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.32, 0.34), camMat);
      body.position.set(0.0, H - 0.4, z);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.11, 12), lensMat);
      lens.rotation.y = -Math.PI / 2;
      lens.position.set(-0.38, H - 0.4, z);
      const flash = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.5), camMat);
      flash.position.set(0.05, H - 0.4, z + 0.7);
      g.add(body, lens, flash);
      if ('ceilings' in L) {
        // bracket up to the deck above
        const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.1), this.metal);
        bracket.position.set(0.1, H - 0.05, z);
        g.add(bracket);
      }
    }
    const faces: SignInstance['faces'] = [];
    const H = 6.6;
    if (kind !== 'fixed' && !('ceilings' in L) && mount(0, right - 3.9) !== null) {
      const w = 3.4;
      const h = 1.5;
      const geo = new THREE.PlaneGeometry(w, h);
      geo.rotateY(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.placeholder);
      mesh.position.set(-0.05, H - 1.25, right - 2.2);
      g.add(mesh);
      faces.push({
        mesh,
        w,
        h,
        draw: (g2, W, H2) => {
          frame(g2, W, H2, '#1c4fb8');
          text(g2, kind === 'section-start' ? '区间测速起点' : '区间测速终点', W / 2, H2 * 0.38, H2 * 0.28, '#fff', 'center');
          text(g2, 'AVERAGE SPEED CHECK', W / 2, H2 * 0.72, H2 * 0.15, '#fff', 'center', false);
        },
      });
    }
    return { spec: { kind: 'camera', edge: e.id, s, line: e.line }, group: g, faces, pos: g.position.clone(), loaded: false };
  }

  private exitInfo(spec: SignFile): ExitFile | undefined {
    if (spec.exitEdge !== undefined) return this.net.exits.find((x) => x.edge === spec.exitEdge);
    return this.net.exits.find((x) => x.line === spec.line && x.code === spec.exitCode);
  }

  /** Where a sign's supports go (null: no clear spot nearby, the sign is left out). */
  layout(spec: SignFile): GantryLayout | CantileverLayout | PoleLayout | null {
    const e = this.net.edges[spec.edge];
    const s = spec.s;
    // a full gantry if there is room for it, otherwise a cantilever from the barrier on the sign's side
    const overhead = (top: number, tries: number[], prefer: -1 | 1, minReach: number, maxReach: number) =>
      layoutGantry(this.net, this.decks, e, s, top, tries) ?? layoutCantilever(this.net, this.decks, e, s, top, 4.1, prefer, tries, minReach, maxReach);
    const exitSide = (): -1 | 1 => (this.exitInfo(spec)?.side === 'left' ? -1 : 1);
    switch (spec.kind) {
      case 'exit-advance':
        return overhead(GANTRY_TOP, shifts(10, 120, 150), exitSide(), 5, 8.6);
      case 'exit-now':
        // keep it upstream of the diverge: the panel announces the exit lane
        return overhead(GANTRY_TOP, shifts(10, 20, 160), exitSide(), 5, 8.6);
      case 'confirm':
        return overhead(GANTRY_TOP, shifts(15, 220, 60, true), 1, 5, 7.4);
      case 'vms':
        return overhead(VMS_TOP, shifts(20, 240, 240, true), 1, 6, 9.4);
      case 'speed':
        return layoutPole(this.net, this.decks, e, s, 3.2, 1, shifts(10, 80, 50, true));
      case 'camera':
        return layoutPole(this.net, this.decks, e, s, 3.3, 1, shifts(10, 40, 100));
      case 'exit-gore': {
        const x = this.exitInfo(spec);
        // on the ramp, after the gore nose: on the barrier facing away from the main line
        return x ? layoutPole(this.net, this.decks, e, s, 3.5, x.side === 'right' ? 1 : -1, shifts(10, 80, 70, true), 1.35) : null;
      }
      default:
        return null;
    }
  }

  private create(spec: SignFile): SignInstance | null {
    const L = this.layout(spec);
    if (!L) return null;
    const { edge: e, s, y } = L;
    // local frame: +X along the road, +Z to the right; sign faces -X (towards drivers)
    const g = this.framed(e, s, y);
    const bl = e.blAt(s);
    const br = e.brAt(s);
    const faces: SignInstance['faces'] = [];
    const panel = (w: number, h: number, z: number, yC: number, draw: SignInstance['faces'][number]['draw']) => {
      const geo = new THREE.PlaneGeometry(w, h);
      geo.rotateY(-Math.PI / 2); // face -X
      const mesh = new THREE.Mesh(geo, this.placeholder);
      mesh.position.set(0, yC, z);
      const backGeo = new THREE.BoxGeometry(0.12, h, w);
      const backMesh = new THREE.Mesh(backGeo, this.back);
      backMesh.position.set(0.08, yC, z);
      g.add(backMesh, mesh);
      faces.push({ mesh, draw, w, h });
    };
    const gantry = (beamY: number) => {
      if ('left' in L) this.gantryFrame(g, L, beamY + 0.3, [0.5, 0.7], [0.22, 0.26]);
      else if ('reach' in L) this.cantileverFrame(g, L, beamY + 0.3);
    };
    /** panel width and lateral position: as designed on a gantry, shrunk to the arm next to its post on a cantilever */
    const fit = (w: number, z: number): [number, number] => {
      if (!('reach' in L)) return [w, z];
      const w2 = Math.min(w, L.reach - 0.3);
      return [w2, L.post.d - L.side * (w2 / 2 + 0.08)];
    };
    const pole = (height: number) => {
      if (!('post' in L)) return 0;
      // behind the panel, not through its face
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, height, 6), this.metal);
      post.position.set(0.2, height / 2, L.post.d);
      g.add(post);
      return L.post.d;
    };
    const line = spec.line;
    switch (spec.kind) {
      case 'exit-advance':
      case 'exit-now': {
        const x = this.exitInfo(spec);
        if (!x) return null;
        gantry(9.0);
        const right = x.side === 'right';
        const [w, z] = fit(8.2, right ? br - 8.2 / 2 + 0.3 : bl + 8.2 / 2 - 0.3);
        const h = (3.6 * w) / 8.2;
        const now = spec.kind === 'exit-now';
        panel(w, h, z, 9.0 - h / 2 + 0.25, (g2, W, H) => drawExitSign(g2, W, H, x, now ? null : spec.distanceText ?? '', right));
        // lane guidance panel over the through lanes (gantries only)
        if (now && 'left' in L) {
          const z2 = right ? bl + 3.2 : br - 3.2;
          panel(5.4, 2.6, z2, 9.0 - 1.05, (g2, W, H) => drawThroughSign(g2, W, H, x.line, right));
        }
        break;
      }
      case 'exit-gore': {
        const x = this.exitInfo(spec);
        if (!x) return null;
        const z = pole(3.2);
        panel(2.6, 1.3, z, 3.5, (g2, W, H) => drawGoreSign(g2, W, H, x));
        break;
      }
      case 'confirm': {
        gantry(9.0);
        const lineName = line ?? 'A';
        const next = this.upcomingExits(lineName, e, s, 2);
        const [w, z] = fit(7.0, br - 3.8);
        const h = (3.3 * w) / 7.0;
        panel(w, h, z, 9.25 - h / 2, (g2, W, H) => drawConfirmSign(g2, W, H, lineName, next));
        break;
      }
      case 'speed': {
        const z = pole(3.4);
        const disc = new THREE.CircleGeometry(0.62, 32);
        disc.rotateY(-Math.PI / 2);
        const mesh = new THREE.Mesh(disc, this.placeholder);
        mesh.position.set(-0.02, 3.2, z);
        const backDisc = new THREE.CircleGeometry(0.62, 32);
        backDisc.rotateY(Math.PI / 2);
        const backMesh = new THREE.Mesh(backDisc, this.back);
        backMesh.position.set(0.12, 3.2, z);
        g.add(mesh, backMesh);
        const speed = spec.speed ?? 60;
        faces.push({ mesh, w: 1.24, h: 1.24, draw: (g2, W, H) => drawSpeedSign(g2, W, H, speed) });
        break;
      }
      case 'camera': {
        const z = pole(3.4);
        panel(1.9, 1.25, z, 3.3, (g2, W, H) => drawCameraSign(g2, W, H));
        break;
      }
      case 'vms': {
        gantry(8.4);
        const [w, z] = fit(9, (bl + br) / 2);
        const h = (2.4 * w) / 9;
        panel(w, h, z, 8.65 - h / 2, (g2, W, H) => drawVms(g2, W, H, this.vmsText(line)));
        break;
      }
      default:
        return null;
    }
    g.traverse((o) => {
      (o as THREE.Mesh).castShadow = true;
    });
    return { spec, group: g, faces, pos: g.position.clone(), loaded: false };
  }

  private upcomingExits(line: LineId, e: Edge, s: number, count: number) {
    const ls = this.net.lineS(e, s) ?? 0;
    const L = this.net.lines[line].length;
    return this.net.exits
      .filter((x) => x.line === line && x.code)
      .map((x) => ({ x, d: (((x.s - ls) % L) + L) % L }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count);
  }

  /** Lazily create sign textures near the focus point; free far ones. */
  update(focus: THREE.Vector3) {
    for (const it of this.items) {
      const d = it.pos.distanceTo(focus);
      if (!it.loaded && d < 750) {
        for (const f of it.faces) {
          const c = document.createElement('canvas');
          const scale = 150;
          c.width = Math.min(2048, Math.round(f.w * scale));
          c.height = Math.min(1024, Math.round(f.h * scale));
          const g2 = c.getContext('2d')!;
          f.draw(g2, c.width, c.height);
          const tex = new THREE.CanvasTexture(c);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          f.mesh.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: new THREE.Color(1, 1, 1), emissiveMap: tex, emissiveIntensity: 0.08 });
        }
        it.loaded = true;
      } else if (it.loaded && d > 1000) {
        for (const f of it.faces) {
          const m = f.mesh.material as THREE.MeshStandardMaterial;
          m.map?.dispose();
          m.dispose();
          f.mesh.material = this.placeholder;
        }
        it.loaded = false;
      }
    }
  }

  /** Night: retro-reflective sheeting glows in headlights; approximate with emissive. */
  setNight(night: number) {
    for (const it of this.items) {
      if (!it.loaded) continue;
      for (const f of it.faces) {
        const m = f.mesh.material as THREE.MeshStandardMaterial;
        if (m !== this.placeholder) m.emissiveIntensity = 0.08 + night * 0.55;
      }
    }
  }

  refreshVms() {
    for (const it of this.items) {
      if (it.spec.kind !== 'vms' || !it.loaded) continue;
      it.loaded = false;
      for (const f of it.faces) f.mesh.material = this.placeholder;
    }
  }
}

/* ---------------- drawing ---------------- */

function frame(g: CanvasRenderingContext2D, W: number, H: number, bg: string, border = '#fff') {
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = border;
  g.lineWidth = Math.max(4, W * 0.008);
  const r = W * 0.012;
  g.strokeRect(r, r, W - 2 * r, H - 2 * r);
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', bold = true) {
  g.font = `${bold ? 'bold ' : ''}${Math.round(size)}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

function inlay(g: CanvasRenderingContext2D, name: string, x: number, y: number, size: number) {
  const express = EXPRESS_RE.test(name);
  g.font = `bold ${Math.round(size)}px ${FONT}`;
  const w = g.measureText(name).width + size * 0.6;
  const h = size * 1.35;
  g.fillStyle = express ? '#fff' : '#1c4fb8';
  g.fillRect(x, y - h / 2, w, h);
  if (!express) {
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.strokeRect(x + 3, y - h / 2 + 3, w - 6, h - 6);
  }
  text(g, name, x + size * 0.3, y + 2, size, express ? GREEN : '#fff');
  return w;
}

function arrow(g: CanvasRenderingContext2D, x: number, y: number, size: number, dir: 'up' | 'right' | 'left') {
  g.save();
  g.translate(x, y);
  g.rotate(dir === 'up' ? 0 : dir === 'right' ? Math.PI / 4 : -Math.PI / 4);
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(0, -size);
  g.lineTo(size * 0.55, -size * 0.35);
  g.lineTo(size * 0.18, -size * 0.35);
  g.lineTo(size * 0.18, size);
  g.lineTo(-size * 0.18, size);
  g.lineTo(-size * 0.18, -size * 0.35);
  g.lineTo(-size * 0.55, -size * 0.35);
  g.closePath();
  g.fill();
  g.restore();
}

function drawExitSign(g: CanvasRenderingContext2D, W: number, H: number, x: ExitFile, dist: string | null, right: boolean) {
  frame(g, W, H, GREEN);
  const u = H / 10;
  // exit number tab (ramps without a number only say "出口 EXIT")
  const tx = x.code ? W * 0.27 : W * 0.05;
  if (x.code) {
    g.fillStyle = '#fff';
    g.fillRect(W * 0.04, u * 0.6, W * 0.17, u * 1.9);
    text(g, x.code, W * 0.125, u * 1.6, u * 1.45, GREEN, 'center');
  }
  text(g, '出口', tx, u * 1.55, u * 1.2, '#fff');
  text(g, 'EXIT', tx + u * 2.7, u * 1.6, u * 0.9, '#fff');
  // destinations
  let yy = u * 4.0;
  x.names.slice(0, 2).forEach((n, k) => {
    inlay(g, n, W * 0.05, yy, u * 1.45);
    const en = x.namesEn[k];
    if (en) text(g, en, W * 0.05, yy + u * 1.3, u * 0.7, '#fff', 'left', false);
    yy += u * 2.9;
  });
  if (dist) text(g, dist, W * 0.95, H - u * 1.4, u * 1.55, '#fff', 'right');
  arrow(g, right ? W * 0.86 : W * 0.72, u * 3.6, u * 1.6, right ? 'right' : 'left');
}

function drawThroughSign(g: CanvasRenderingContext2D, W: number, H: number, line: LineId, exitRight: boolean) {
  frame(g, W, H, GREEN);
  const u = H / 8;
  ringShield(g, W * 0.17, H * 0.42, u * 2.2, line);
  text(g, `内环路 ${line}线`, W * 0.33, H * 0.36, u * 1.5, '#fff');
  text(g, line === 'A' ? 'Inner Ring Rd · A' : 'Inner Ring Rd · B', W * 0.33, H * 0.6, u * 0.8, '#fff', 'left', false);
  arrow(g, exitRight ? W * 0.12 : W * 0.88, H * 0.82, u * 0.9, 'up');
}

function drawGoreSign(g: CanvasRenderingContext2D, W: number, H: number, x: ExitFile) {
  frame(g, W, H, GREEN);
  text(g, '出口', W * 0.3, H * 0.35, H * 0.3, '#fff', 'center');
  text(g, 'EXIT', W * 0.3, H * 0.7, H * 0.2, '#fff', 'center');
  arrow(g, W * 0.75, H * 0.5, H * 0.3, x.side === 'right' ? 'right' : 'left');
}

function ringShield(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, line: LineId) {
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = GREEN;
  g.beginPath();
  g.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = r * 0.16;
  g.beginPath();
  g.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
  g.stroke();
  text(g, line, cx, cy + 2, r * 0.62, '#fff', 'center');
}

function drawConfirmSign(g: CanvasRenderingContext2D, W: number, H: number, line: LineId, next: { x: ExitFile; d: number }[]) {
  frame(g, W, H, GREEN);
  const u = H / 10;
  ringShield(g, W * 0.12, u * 2.6, u * 1.9, line);
  text(g, `内环路 ${line}线`, W * 0.23, u * 2.2, u * 1.5, '#fff');
  text(g, `Inner Ring Rd ${line} · ${line === 'A' ? '逆时针' : '顺时针'}`, W * 0.23, u * 3.6, u * 0.75, '#fff', 'left', false);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(W * 0.04, u * 4.7, W * 0.92, 3);
  let yy = u * 6.2;
  for (const { x, d } of next) {
    g.fillStyle = '#fff';
    g.fillRect(W * 0.05, yy - u * 0.8, W * 0.12, u * 1.6);
    text(g, x.code, W * 0.11, yy + 2, u * 1.0, GREEN, 'center');
    text(g, x.names[0], W * 0.2, yy, u * 1.15, '#fff');
    text(g, d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 100) * 100} m`, W * 0.95, yy, u * 1.15, '#fff', 'right');
    yy += u * 2.1;
  }
}

function drawSpeedSign(g: CanvasRenderingContext2D, W: number, H: number, speed: number) {
  g.clearRect(0, 0, W, H);
  const r = Math.min(W, H) / 2;
  g.fillStyle = '#d4161c';
  g.beginPath();
  g.arc(W / 2, H / 2, r * 0.99, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(W / 2, H / 2, r * 0.76, 0, Math.PI * 2);
  g.fill();
  text(g, String(speed), W / 2, H / 2 + 4, r * 0.85, '#111', 'center');
}

function drawCameraSign(g: CanvasRenderingContext2D, W: number, H: number) {
  frame(g, W, H, '#1c4fb8');
  // camera icon
  g.fillStyle = '#fff';
  g.fillRect(W * 0.08, H * 0.3, W * 0.22, H * 0.28);
  g.fillRect(W * 0.3, H * 0.36, W * 0.07, H * 0.16);
  g.fillRect(W * 0.16, H * 0.58, W * 0.05, H * 0.2);
  text(g, '测速拍照', W * 0.68, H * 0.38, H * 0.24, '#fff', 'center');
  text(g, 'SPEED CAMERA', W * 0.68, H * 0.7, H * 0.13, '#fff', 'center', false);
}

function drawVms(g: CanvasRenderingContext2D, W: number, H: number, lines: string[]) {
  g.fillStyle = '#0b0b0b';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#444';
  g.lineWidth = 8;
  g.strokeRect(4, 4, W - 8, H - 8);
  const u = H / lines.length;
  lines.forEach((l, k) => {
    g.font = `bold ${Math.round(u * 0.6)}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // LED dot effect
    g.fillStyle = k === 0 ? '#ffb000' : '#3bdc4b';
    g.fillText(l, W / 2, u * (k + 0.5));
  });
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
  for (let x = 0; x < W; x += 4) g.fillRect(x, 0, 1, H);
}


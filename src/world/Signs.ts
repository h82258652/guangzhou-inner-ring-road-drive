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
import type { ExitFile, LineId, SignFile } from '../shared/types';

const FONT = '"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",sans-serif';
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
  vmsText: (line: LineId | null) => string[] = () => ['内环路 畅通', '保持车距 安全驾驶'];

  constructor(readonly net: RoadNetwork) {
    this.group.name = 'signs';
    const f = newFrame();
    for (const s of net.signs) {
      const e = net.edges[s.edge];
      if (!e) continue;
      const inst = this.create(s, e, f);
      if (inst) {
        this.items.push(inst);
        this.group.add(inst.group);
      }
    }
    for (const c of net.cameras) {
      const e = net.edges[c.edge];
      if (!e) continue;
      const kind = c.kind;
      const inst = this.createCameraGantry(e, c.s, kind, f);
      this.items.push(inst);
      this.group.add(inst.group);
    }
  }

  /** Enforcement camera gantry (电子警察 / 测速) with one camera per lane. */
  private createCameraGantry(e: Edge, s: number, kind: 'fixed' | 'section-start' | 'section-end', f: ReturnType<typeof newFrame>): SignInstance {
    s = Math.max(0, Math.min(e.length, s));
    e.frame(s, 0, f);
    const i = e.idx(s);
    const g = new THREE.Group();
    g.position.set(f.x, e.y[i], f.z);
    g.rotation.y = -Math.atan2(f.tz, f.tx);
    const left = e.bl[i] - 0.9;
    const right = e.br[i] + 0.9;
    const H = 6.6;
    for (const z of [left, right]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, H, 8), this.metal);
      post.position.set(0.3, H / 2, z);
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, right - left), this.metal);
    beam.position.set(0.3, H, (left + right) / 2);
    g.add(beam);
    const camMat = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.5 });
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2, metalness: 0.5 });
    const lanes = Math.max(1, Math.round(e.lanes[i]));
    for (let k = 0; k < lanes; k++) {
      const z = e.laneCenter(s, k);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.32, 0.34), camMat);
      body.position.set(0.0, H - 0.4, z);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.11, 12), lensMat);
      lens.rotation.y = -Math.PI / 2;
      lens.position.set(-0.38, H - 0.4, z);
      const flash = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.5), camMat);
      flash.position.set(0.05, H - 0.4, z + 0.7);
      g.add(body, lens, flash);
    }
    const faces: SignInstance['faces'] = [];
    if (kind !== 'fixed') {
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

  private create(spec: SignFile, e: Edge, f: ReturnType<typeof newFrame>): SignInstance | null {
    const s = Math.max(0, Math.min(e.length, spec.s));
    e.frame(s, 0, f);
    const i = e.idx(s);
    const y = e.y[i];
    const heading = Math.atan2(f.tz, f.tx);
    const g = new THREE.Group();
    g.position.set(f.x, y, f.z);
    // local frame: +X along the road, +Z to the right; sign faces -X (towards drivers)
    g.rotation.y = -heading;
    const bl = e.bl[i];
    const br = e.br[i];
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
      const left = bl - 0.9;
      const right = br + 0.9;
      for (const z of [left, right]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, beamY + 0.6, 8), this.metal);
        post.position.set(0.3, (beamY + 0.6) / 2, z);
        g.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, right - left + 0.4), this.metal);
      beam.position.set(0.3, beamY + 0.3, (left + right) / 2);
      g.add(beam);
      return { left, right };
    };
    const line = spec.line;
    switch (spec.kind) {
      case 'exit-advance':
      case 'exit-now': {
        const x = this.exitInfo(spec);
        if (!x) return null;
        gantry(9.0);
        const w = 8.2;
        const h = 3.6;
        const right = x.side === 'right';
        const z = right ? br - w / 2 + 0.3 : bl + w / 2 - 0.3;
        const now = spec.kind === 'exit-now';
        panel(w, h, z, 9.0 - h / 2 + 0.25, (g2, W, H) => drawExitSign(g2, W, H, x, now ? null : spec.distanceText ?? '', right));
        // lane guidance panel over the through lanes
        if (now) {
          const z2 = right ? bl + 3.2 : br - 3.2;
          panel(5.4, 2.6, z2, 9.0 - 1.05, (g2, W, H) => drawThroughSign(g2, W, H, x.line, right));
        }
        break;
      }
      case 'exit-gore': {
        const x = this.exitInfo(spec);
        if (!x) return null;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.2, 6), this.metal);
        const z = x.side === 'right' ? br + 0.7 : bl - 0.7;
        post.position.set(0, 1.6, z);
        g.add(post);
        panel(2.6, 1.3, z, 3.5, (g2, W, H) => drawGoreSign(g2, W, H, x));
        break;
      }
      case 'confirm': {
        gantry(9.0);
        const lineName = line ?? 'A';
        const next = this.upcomingExits(lineName, e, s, 2);
        panel(7.0, 3.3, br - 3.8, 9.0 - 1.4, (g2, W, H) => drawConfirmSign(g2, W, H, lineName, next));
        break;
      }
      case 'speed': {
        const z = br + 0.75;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 6), this.metal);
        post.position.set(0, 1.7, z);
        g.add(post);
        const disc = new THREE.CircleGeometry(0.62, 32);
        disc.rotateY(-Math.PI / 2);
        const mesh = new THREE.Mesh(disc, this.placeholder);
        mesh.position.set(-0.02, 3.2, z);
        g.add(mesh);
        const speed = spec.speed ?? 60;
        faces.push({ mesh, w: 1.24, h: 1.24, draw: (g2, W, H) => drawSpeedSign(g2, W, H, speed) });
        break;
      }
      case 'camera': {
        const z = br + 0.75;
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 6), this.metal);
        post.position.set(0, 1.7, z);
        g.add(post);
        panel(1.9, 1.25, z, 3.3, (g2, W, H) => drawCameraSign(g2, W, H));
        break;
      }
      case 'vms': {
        gantry(8.4);
        panel(9, 2.4, (bl + br) / 2, 8.4 - 0.95, (g2, W, H) => drawVms(g2, W, H, this.vmsText(line)));
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


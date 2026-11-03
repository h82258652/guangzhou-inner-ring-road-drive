/** Minimap: rotating local map (or whole-ring overview) with both lines, exits and the player. */
import type { RoadNetwork } from '../road/Network';
import type { CityFile, LineId } from '../shared/types';

export class Minimap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  big = false;
  private paths: Record<LineId, Path2D>;
  private ramps: Path2D;
  private water: Path2D;

  constructor(
    readonly net: RoadNetwork,
    city: CityFile | null,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = 460;
    this.canvas.height = 460;
    this.el.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.paths = { A: new Path2D(), B: new Path2D() };
    for (const line of ['A', 'B'] as LineId[]) {
      const p = this.paths[line];
      let first = true;
      for (const e of net.lines[line].edges) {
        for (let i = 0; i < e.n; i += 4) {
          if (first) p.moveTo(e.x[i], e.z[i]);
          else p.lineTo(e.x[i], e.z[i]);
          first = false;
        }
      }
      p.closePath();
    }
    this.ramps = new Path2D();
    for (const e of net.edges) {
      if (e.kind !== 'ramp') continue;
      this.ramps.moveTo(e.x[0], e.z[0]);
      for (let i = 4; i < e.n; i += 4) this.ramps.lineTo(e.x[i], e.z[i]);
      this.ramps.lineTo(e.x[e.n - 1], e.z[e.n - 1]);
    }
    this.water = new Path2D();
    if (city) {
      for (const polys of city.water) {
        for (const flat of polys) {
          for (let k = 0; k < flat.length; k += 2) {
            const x = flat[k] / 10;
            const z = flat[k + 1] / 10;
            if (k === 0) this.water.moveTo(x, z);
            else this.water.lineTo(x, z);
          }
          this.water.closePath();
        }
      }
    }
  }

  toggle() {
    this.big = !this.big;
    this.el.classList.toggle('big', this.big);
  }

  draw(px: number, pz: number, heading: number, line: LineId | null, target?: { x: number; z: number } | null) {
    const g = this.g;
    const W = this.canvas.width;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.fillStyle = '#121a20';
    g.fillRect(0, 0, W, W);
    const scale = this.big ? W / 10500 : W / 1900;
    g.save();
    g.translate(W / 2, W / 2);
    if (!this.big) g.rotate(-heading - Math.PI / 2);
    g.scale(scale, scale);
    if (this.big) g.translate(-300, 0);
    else g.translate(-px, -pz);
    g.fillStyle = '#1f4a63';
    g.fill(this.water, 'evenodd');
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#6f7a82';
    g.lineWidth = 4 / scale;
    g.stroke(this.ramps);
    for (const l of ['B', 'A'] as LineId[]) {
      g.strokeStyle = l === 'A' ? '#e8423f' : '#2f7de1';
      g.lineWidth = ((l === line ? 8 : 5) / scale) * (this.big ? 0.8 : 1);
      g.stroke(this.paths[l]);
    }
    // exits of the current line
    if (line) {
      g.fillStyle = '#fff';
      g.font = `${Math.round(18 / scale)}px sans-serif`;
      for (const x of this.net.exits) {
        if (x.line !== line || !x.code) continue;
        const e = this.net.edges[x.edge];
        const ex = e.x[0];
        const ez = e.z[0];
        g.beginPath();
        g.arc(ex, ez, 6 / scale, 0, Math.PI * 2);
        g.fill();
        if (this.big) {
          g.fillStyle = '#ffd34d';
          g.fillText(x.code, ex + 8 / scale, ez - 8 / scale);
          g.fillStyle = '#fff';
        }
      }
    }
    if (target) {
      g.strokeStyle = '#ffd34d';
      g.lineWidth = 5 / scale;
      g.beginPath();
      g.arc(target.x, target.z, 18 / scale, 0, Math.PI * 2);
      g.stroke();
    }
    // player
    g.save();
    g.translate(px, pz);
    g.rotate(heading);
    const s = (this.big ? 26 : 18) / scale;
    g.fillStyle = '#ffd34d';
    g.strokeStyle = '#000';
    g.lineWidth = 2 / scale;
    g.beginPath();
    g.moveTo(s, 0);
    g.lineTo(-s * 0.7, s * 0.6);
    g.lineTo(-s * 0.35, 0);
    g.lineTo(-s * 0.7, -s * 0.6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.restore();
    // north arrow
    if (!this.big) {
      g.save();
      g.translate(W / 2, W / 2);
      g.rotate(-heading - Math.PI / 2);
      g.fillStyle = '#ff6b6b';
      g.font = 'bold 26px sans-serif';
      g.textAlign = 'center';
      g.fillText('N', 0, -W / 2 + 34);
      g.restore();
    }
  }
}

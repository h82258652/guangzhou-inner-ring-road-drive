/** Debug: builds the network and writes overview PNGs to scripts/.cache/debug. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildNetwork } from './lib/network';
import { solveElevation } from './lib/elevation';
import { DebugCanvas } from './lib/png';

const t0 = Date.now();
const net = buildNetwork();
console.log(`network: ${net.edges.length} edges, ${net.nodes.size} nodes, ${net.attachments.length} attachments (${Date.now() - t0} ms)`);
console.log(`line A ${net.lines.A.length.toFixed(0)} m, ${net.lines.A.edges.length} edges; line B ${net.lines.B.length.toFixed(0)} m, ${net.lines.B.edges.length} edges`);
const ramps = net.edges.filter((e) => e.kind === 'ramp');
console.log(`ramps: ${ramps.length}, total ${(ramps.reduce((s, e) => s + e.length, 0) / 1000).toFixed(1)} km`);
const t1 = Date.now();
const res = solveElevation(net);
console.log(`elevation solved (${Date.now() - t1} ms), clearance violations: ${res.violations}, solver max grade ${(res.maxGrade * 100).toFixed(1)}%`);

let maxGrade = 0;
for (const e of net.edges) {
  for (let i = 1; i < e.y.length; i++) maxGrade = Math.max(maxGrade, Math.abs(e.y[i] - e.y[i - 1]) / e.ds);
}
console.log('max grade', (maxGrade * 100).toFixed(1) + '%');

mkdirSync('scripts/.cache/debug', { recursive: true });
const views: [string, number, number, number, number, number][] = [
  ['overview', -5000, -3400, 3800, 3400, 2000],
  ['north-west', -3200, -3100, -800, -1300, 1600],
  ['east', 1200, -1000, 3600, 1600, 1600],
  ['south', -2500, 700, 1200, 3200, 1600],
];
const color = (y: number): [number, number, number] => {
  const t = Math.min(1, y / 25);
  return [Math.round(255 * t), Math.round(80 + 100 * (1 - t)), Math.round(255 * (1 - t))];
};
for (const [name, x0, z0, x1, z1, w] of views) {
  const h = Math.round((w * (z1 - z0)) / (x1 - x0));
  const c = new DebugCanvas(w, h, x0, z0, x1, z1);
  for (const e of net.edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1];
      const b = e.pts[i];
      c.line(a[0], a[1], b[0], b[1], color(e.y[i]), e.kind === 'main' ? 2 : 1);
      // bounds
      if (name !== 'overview') {
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1;
        const nx = -dz / l;
        const nz = dx / l;
        const colL: [number, number, number] = e.ol[i] >= 0 ? [0, 200, 0] : [60, 60, 60];
        const colR: [number, number, number] = e.or[i] >= 0 ? [0, 200, 0] : [60, 60, 60];
        c.dot(b[0] + nx * e.bl[i], b[1] + nz * e.bl[i], colL, 0);
        c.dot(b[0] + nx * e.br[i], b[1] + nz * e.br[i], colR, 0);
      }
    }
  }
  for (const n of net.nodes.values()) {
    if (n.in.length === 0) c.dot(n.p[0], n.p[1], [0, 160, 0], 3);
    if (n.out.length === 0) c.dot(n.p[0], n.p[1], [200, 0, 0], 3);
  }
  writeFileSync(`scripts/.cache/debug/${name}.png`, c.png());
}
console.log('debug images written');


/**
 * Vehicle-to-vehicle contacts: cars driven by the full dynamics (the player,
 * race opponents) are pushed out of traffic cars and out of each other, and
 * exchange momentum, so that vehicles never drive through one another.
 */
import { obbOverlap, type Box2 } from './Collision';
import type { Player } from './Player';
import type { Car } from '../traffic/Traffic';

export interface Contact {
  a: Player;
  b: Player | Car;
  /** closing speed along the contact normal (m/s) */
  impact: number;
}

const TRAFFIC_MASS = 1500;
const RESTITUTION = 0.25;

const boxOf = (p: Player): Box2 => ({ x: p.dyn.x, z: p.dyn.z, heading: p.dyn.psi, halfLength: p.halfLength - 0.1, halfWidth: p.halfWidth - 0.05 });

export function resolveContacts(bodies: Player[], cars: Car[]): Contact[] {
  const out: Contact[] = [];
  for (const p of bodies) {
    const dyn = p.dyn;
    // deck height from the road tracker (always current; a car on a ramp crossing above is not in the way)
    const py = p.tracker.y;
    for (const car of cars) {
      const dx = car.x - dyn.x;
      const dz = car.z - dyn.z;
      if (dx * dx + dz * dz > 200 || Math.abs(car.y - py) > 3) continue;
      const ov = obbOverlap(boxOf(p), { x: car.x, z: car.z, heading: car.heading, halfLength: car.len / 2 - 0.1, halfWidth: car.width / 2 - 0.05 });
      if (!ov) continue;
      // the driven car takes the whole correction (traffic follows its lane)
      dyn.x += ov.nx * ov.depth;
      dyn.z += ov.nz * ov.depth;
      const [vx, vz] = dyn.worldVelocity();
      const cvx = Math.cos(car.heading) * car.v;
      const cvz = Math.sin(car.heading) * car.v;
      const rel = (vx - cvx) * ov.nx + (vz - cvz) * ov.nz;
      if (rel >= 0) continue;
      const mP = dyn.spec.mass;
      const j = (-(1 + RESTITUTION) * rel) / (1 / mP + 1 / TRAFFIC_MASS);
      dyn.setWorldVelocity(vx + (j / mP) * ov.nx, vz + (j / mP) * ov.nz);
      const along = Math.cos(car.heading) * ov.nx + Math.sin(car.heading) * ov.nz;
      car.v = Math.max(0, car.v - (j / TRAFFIC_MASS) * along);
      car.bumped = 2.5;
      out.push({ a: p, b: car, impact: -rel });
    }
  }
  for (let i = 0; i < bodies.length; i++)
    for (let k = i + 1; k < bodies.length; k++) {
      const a = bodies[i];
      const b = bodies[k];
      if ((a.dyn.x - b.dyn.x) ** 2 + (a.dyn.z - b.dyn.z) ** 2 > 200 || Math.abs(a.tracker.y - b.tracker.y) > 3) continue;
      const ov = obbOverlap(boxOf(a), boxOf(b));
      if (!ov) continue;
      const ma = a.dyn.spec.mass;
      const mb = b.dyn.spec.mass;
      // split the correction by mass
      const wa = mb / (ma + mb);
      a.dyn.x += ov.nx * ov.depth * wa;
      a.dyn.z += ov.nz * ov.depth * wa;
      b.dyn.x -= ov.nx * ov.depth * (1 - wa);
      b.dyn.z -= ov.nz * ov.depth * (1 - wa);
      const [ax, az] = a.dyn.worldVelocity();
      const [bx, bz] = b.dyn.worldVelocity();
      const rel = (ax - bx) * ov.nx + (az - bz) * ov.nz;
      if (rel >= 0) continue;
      const j = (-(1 + RESTITUTION) * rel) / (1 / ma + 1 / mb);
      a.dyn.setWorldVelocity(ax + (j / ma) * ov.nx, az + (j / ma) * ov.nz);
      b.dyn.setWorldVelocity(bx - (j / mb) * ov.nx, bz - (j / mb) * ov.nz);
      out.push({ a, b, impact: -rel });
    }
  return out;
}

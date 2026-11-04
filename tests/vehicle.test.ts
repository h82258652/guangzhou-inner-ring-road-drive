import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildVehicleGeometry, VEHICLES, type VehicleKind } from '../src/vehicle/CarModel';

describe('licence plates', () => {
  for (const kind of Object.keys(VEHICLES) as VehicleKind[]) {
    it(`read left-to-right and face outwards on the ${kind}`, () => {
      const g = buildVehicleGeometry(VEHICLES[kind]).plate;
      const pos = g.getAttribute('position');
      const uv = g.getAttribute('uv');
      const idx = g.index!;
      const p = (i: number) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const up = new THREE.Vector3(0, 1, 0);
      let plates = 0;
      for (let t = 0; t < idx.count; t += 6) {
        // first triangle of each plate quad gives the visible side
        const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
        const normal = p(b).sub(p(a)).cross(p(c).sub(p(a))).normalize();
        const front = p(a).x > 0;
        // the visible side points away from the car: forwards for the front plate, backwards for the rear one
        expect(normal.x).toBeCloseTo(front ? 1 : -1, 5);
        // a viewer facing the plate looks along -normal; their right-hand side is (-normal) x up
        const right = normal.clone().negate().cross(up);
        const verts = [...new Set([0, 1, 2, 3, 4, 5].map((k) => idx.getX(t + k)))];
        const u0 = verts.find((i) => uv.getX(i) === 0 && uv.getY(i) === 0)!;
        const u1 = verts.find((i) => uv.getX(i) === 1 && uv.getY(i) === 0)!;
        expect(p(u1).sub(p(u0)).dot(right)).toBeGreaterThan(0.4);
        // text upright: v grows upwards
        const v1 = verts.find((i) => uv.getX(i) === 0 && uv.getY(i) === 1)!;
        expect(p(v1).y).toBeGreaterThan(p(u0).y);
        plates++;
      }
      expect(plates).toBe(2);
    });
  }
});

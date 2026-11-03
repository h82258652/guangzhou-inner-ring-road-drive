/** The player's car: dynamics + road tracking + visual model and lights. */
import * as THREE from 'three';
import { VehicleDynamics, type Controls, type VehicleSpec } from './Dynamics';
import { RoadTracker, type CollisionInfo } from './RoadTracker';
import type { Edge, RoadNetwork } from '../road/Network';
import { buildVehicleGeometry, drawPlate, randomPlate, VEHICLES, type VehicleKind } from './CarModel';
import { clamp, lerp } from '../shared/math';

export class Player {
  readonly dyn: VehicleDynamics;
  readonly tracker: RoadTracker;
  readonly group = new THREE.Group();
  readonly body = new THREE.Group();
  y = 0;
  pitch = 0;
  roll = 0;
  private bounce = 0;
  private bounceV = 0;
  readonly headlight: THREE.SpotLight;
  private tailMat: THREE.MeshBasicMaterial;
  private headMat: THREE.MeshBasicMaterial;
  readonly plate: string;
  braking = false;
  lightsOn = false;
  readonly halfLength: number;
  readonly halfWidth: number;
  lastCollision: CollisionInfo = { impact: 0, side: 0, scraping: false };

  constructor(
    readonly net: RoadNetwork,
    spec: VehicleSpec,
    kind: VehicleKind,
    paint: number,
    edge: Edge,
    s: number,
  ) {
    this.dyn = new VehicleDynamics(spec);
    this.tracker = new RoadTracker(net, edge, s);
    const geo = buildVehicleGeometry(VEHICLES[kind]);
    this.halfLength = geo.params.length / 2;
    this.halfWidth = geo.params.width / 2;
    const paintMat = new THREE.MeshPhysicalMaterial({ color: paint, roughness: 0.32, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.08 });
    const trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.4 });
    this.headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.85, 0.8), toneMapped: false });
    this.tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.02, 0.02), toneMapped: false });
    const p = randomPlate(Math.floor(Math.random() * 1e6));
    this.plate = p.text;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 80;
    drawPlate(c.getContext('2d')!, 0, 0, 256, 80, p.text, p.green);
    const plateTex = new THREE.CanvasTexture(c);
    plateTex.colorSpace = THREE.SRGBColorSpace;
    const plateMat = new THREE.MeshBasicMaterial({ map: plateTex });
    const meshes: [THREE.BufferGeometry, THREE.Material][] = [
      [geo.body, paintMat],
      [geo.trim, trimMat],
      [geo.head, this.headMat],
      [geo.tail, this.tailMat],
      [geo.plate, plateMat],
    ];
    for (const [g, m] of meshes) {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = m === paintMat || m === trimMat;
      mesh.receiveShadow = true;
      this.body.add(mesh);
    }
    this.group.add(this.body);
    this.headlight = new THREE.SpotLight(0xfff4e0, 0, 140, 0.52, 0.45, 1.4);
    this.headlight.position.set(2.0, 0.75, 0);
    this.headlight.target.position.set(30, -1.5, 0);
    this.group.add(this.headlight, this.headlight.target);
    this.placeAt(edge, s, 0, 0);
  }

  placeAt(edge: Edge, s: number, d: number, speed: number) {
    const f = { x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 1, grade: 0 };
    edge.frame(s, d, f);
    this.dyn.x = f.x;
    this.dyn.z = f.z;
    this.dyn.psi = Math.atan2(f.tz, f.tx);
    this.dyn.vx = speed;
    this.dyn.vy = 0;
    this.dyn.r = 0;
    this.dyn.steer = 0;
    this.dyn.gear = 1;
    this.tracker.edge = edge;
    this.tracker.s = s;
    this.tracker.d = d;
    this.y = f.y;
    this.syncVisual(0);
  }

  get speedKmh() {
    return this.dyn.vx * 3.6;
  }

  step(dt: number, controls: Controls) {
    const t = this.tracker;
    const e = t.edge;
    const i = e.idx(t.s);
    const roadHeading = Math.atan2(e.tz[i], e.tx[i]);
    const grade = e.gradeAt(t.s) * Math.cos(this.dyn.psi - roadHeading);
    this.dyn.step(dt, controls, grade);
    const dyn = this.dyn;
    const body = {
      x: dyn.x,
      z: dyn.z,
      psi: dyn.psi,
      halfWidth: this.halfWidth,
      halfLength: this.halfLength - 0.2,
      yawRate: dyn.r,
      getVel: () => dyn.worldVelocity(),
      setVel: (vx: number, vz: number) => dyn.setWorldVelocity(vx, vz),
    };
    const info = t.update(body);
    dyn.x = body.x;
    dyn.z = body.z;
    dyn.psi = body.psi;
    dyn.r = body.yawRate;
    if (t.terminal) {
      // the ramp ends at a surface street: stop gently
      dyn.vx *= 0.9;
      dyn.vy *= 0.9;
    }
    this.lastCollision = info;
    this.braking = controls.brake > 0.05 && dyn.gear !== -1;
    return info;
  }

  /** Visual update (after physics). */
  syncVisual(dt: number) {
    const t = this.tracker;
    const targetY = t.edge.yAt(t.s);
    this.y = targetY;
    // suspension: pitch from acceleration, roll from lateral acceleration, small bumps
    const k = clamp(dt * 6, 0, 1);
    this.pitch = lerp(this.pitch, clamp(this.dyn.ax * 0.005, -0.035, 0.035), k);
    this.roll = lerp(this.roll, clamp(-this.dyn.ay * 0.006, -0.05, 0.05), k);
    this.bounceV += (-this.bounce * 160 - this.bounceV * 14) * dt;
    this.bounce += this.bounceV * dt;
    const e = t.edge;
    const i = e.idx(t.s);
    const roadHeading = Math.atan2(e.tz[i], e.tx[i]);
    const gradePitch = Math.atan(e.gradeAt(t.s) * Math.cos(this.dyn.psi - roadHeading));
    this.group.position.set(this.dyn.x, this.y, this.dyn.z);
    this.group.rotation.set(0, -this.dyn.psi, 0);
    this.body.rotation.set(this.roll, 0, gradePitch + this.pitch, 'YXZ');
    this.body.position.y = this.bounce;
    this.tailMat.color.setRGB(this.braking ? 2.2 : this.lightsOn ? 0.9 : 0.35, 0.02, 0.02);
    this.headMat.color.setRGB(...((this.lightsOn ? [2.4, 2.35, 2.2] : [0.85, 0.85, 0.8]) as [number, number, number]));
    this.headlight.intensity = this.lightsOn ? 900 : 0;
  }

  kick(amount: number) {
    this.bounceV -= amount;
  }
}


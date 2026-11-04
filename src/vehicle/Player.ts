/** The player's car: dynamics + road tracking + visual model and lights. */
import * as THREE from 'three';
import { VehicleDynamics, type Controls, type VehicleSpec } from './Dynamics';
import { RoadTracker, type CollisionInfo } from './RoadTracker';
import type { Edge, RoadNetwork } from '../road/Network';
import { buildVehicleGeometry, drawPlate, indicatorMaterial, randomPlate, VEHICLES, type VehicleKind } from './CarModel';
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
  /** -1 left, 1 right, 0 off */
  signal: -1 | 0 | 1 = 0;
  /** both sides flashing */
  hazard = false;
  private signal3 = indicatorMaterial('uniform');
  private blink = 0;
  interior: THREE.Group;

  /**
   * opts.visual = false builds physics only (no meshes, textures or lights; for
   * tests); opts.headlight / opts.interior = false leave out the spot light and
   * the cockpit (AI-driven cars).
   */
  constructor(
    readonly net: RoadNetwork,
    spec: VehicleSpec,
    kind: VehicleKind,
    paint: number,
    edge: Edge,
    s: number,
    opts: { visual?: boolean; headlight?: boolean; interior?: boolean } = {},
  ) {
    this.dyn = new VehicleDynamics(spec);
    this.tracker = new RoadTracker(net, edge, s);
    const params = VEHICLES[kind];
    this.halfLength = params.length / 2;
    this.halfWidth = params.width / 2;
    this.headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.85, 0.8), toneMapped: false });
    this.tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.02, 0.02), toneMapped: false });
    const p = randomPlate(Math.floor(Math.random() * 1e6));
    this.plate = p.text;
    this.headlight = new THREE.SpotLight(0xfff4e0, 0, 140, 0.52, 0.45, 1.4);
    this.interior = new THREE.Group();
    this.group.add(this.body);
    if (opts.visual !== false) {
      const geo = buildVehicleGeometry(params);
      const paintMat = new THREE.MeshPhysicalMaterial({ color: paint, roughness: 0.32, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.08 });
      const trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.4 });
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
      this.body.add(new THREE.Mesh(geo.ind, this.signal3.material));
      if (opts.interior !== false) {
        this.interior = buildInterior(params.width);
        this.interior.visible = false;
        this.body.add(this.interior);
      }
      if (opts.headlight !== false) {
        this.headlight.position.set(2.0, 0.75, 0);
        this.headlight.target.position.set(30, -1.5, 0);
        this.group.add(this.headlight, this.headlight.target);
      }
    }
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
    this.blink += dt;
    const on = Math.floor(this.blink * 2.6) % 2 === 0 ? 1 : 0;
    this.signal3.uniforms.uL.value = this.hazard || this.signal < 0 ? on : 0;
    this.signal3.uniforms.uR.value = this.hazard || this.signal > 0 ? on : 0;
  }

  kick(amount: number) {
    this.bounceV -= amount;
  }

  /** Steering wheel follows the steering angle (cockpit view). */
  updateInterior() {
    const wheel = this.interior.getObjectByName('wheel');
    if (wheel) wheel.rotation.x = -this.dyn.steer * 9;
  }
}

/** Simple left-hand-drive cockpit: dashboard, steering wheel, A-pillars, mirror. */
function buildInterior(width: number): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.8 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6 });
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, width - 0.2), dark);
  dash.position.set(0.62, 0.93, 0);
  dash.rotation.z = -0.12;
  g.add(dash);
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.04, width - 0.22), trim);
  top.position.set(0.66, 1.03, 0);
  g.add(top);
  // instrument cluster hood
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.42, 16, 1, true, 0, Math.PI), dark);
  hood.rotation.set(Math.PI / 2, 0, Math.PI / 2);
  hood.position.set(0.42, 1.02, -0.38);
  g.add(hood);
  const wheelGroup = new THREE.Group();
  wheelGroup.name = 'wheel';
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 8, 28), dark);
  ring.rotation.y = Math.PI / 2;
  wheelGroup.add(ring);
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.34), trim);
  wheelGroup.add(spoke);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 12), trim);
  hub.rotation.z = Math.PI / 2;
  wheelGroup.add(hub);
  wheelGroup.position.set(0.25, 0.98, -0.38);
  wheelGroup.rotation.z = 0.35;
  g.add(wheelGroup);
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.62, 0.09), dark);
    pillar.position.set(0.66, 1.2, side * (width / 2 - 0.12));
    pillar.rotation.z = 0.95;
    g.add(pillar);
  }
  const header = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, width - 0.25), dark);
  header.position.set(0.38, 1.42, 0);
  g.add(header);
  const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.24), trim);
  mirror.position.set(0.42, 1.33, 0);
  g.add(mirror);
  return g;
}


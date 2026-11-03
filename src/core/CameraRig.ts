/** Driving cameras: chase, hood, cockpit (left-hand drive), far chase and cinematic. */
import * as THREE from 'three';
import { clamp, lerp } from '../shared/math';

export type CameraMode = 'chase' | 'far' | 'hood' | 'cockpit' | 'cinematic';
export const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'hood', 'cockpit', 'cinematic'];
export const CAMERA_NAMES: Record<CameraMode, string> = { chase: '追尾视角', far: '远景追尾', hood: '引擎盖视角', cockpit: '驾驶舱视角', cinematic: '电影视角' };

export class CameraRig {
  mode: CameraMode = 'chase';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private initialized = false;
  private cineTimer = 0;
  private cineAnchor = new THREE.Vector3();
  shake = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  next() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.initialized = false;
  }

  reset() {
    this.initialized = false;
  }

  /**
   * @param target car root (position + yaw), body for pitch/roll
   * @param speed m/s
   */
  update(dt: number, target: THREE.Object3D, body: THREE.Object3D, speed: number, lookBack: boolean) {
    const cam = this.camera;
    const yaw = -target.rotation.y;
    const fwd = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const right = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
    const p = target.position;
    const back = lookBack ? -1 : 1;
    let desiredPos: THREE.Vector3;
    let desiredLook: THREE.Vector3;
    let fov = 62;
    let stiff = 8;
    switch (this.mode) {
      case 'chase':
      case 'far': {
        const far = this.mode === 'far';
        const dist = (far ? 13 : 7.2) + clamp(speed, 0, 40) * (far ? 0.06 : 0.03);
        const h = far ? 4.4 : 2.35;
        desiredPos = p.clone().addScaledVector(fwd, -dist * back).add(new THREE.Vector3(0, h, 0));
        desiredLook = p.clone().addScaledVector(fwd, 4 * back).add(new THREE.Vector3(0, 1.1, 0));
        fov = 60 + clamp(speed * 0.25, 0, 10);
        stiff = 6;
        break;
      }
      case 'hood': {
        const local = new THREE.Vector3(0.6, 1.32, 0);
        desiredPos = local.applyMatrix4(body.matrixWorld);
        desiredLook = new THREE.Vector3(30 * back, 0.9, 0).applyMatrix4(body.matrixWorld);
        fov = 68;
        stiff = 60;
        break;
      }
      case 'cockpit': {
        // left-hand drive: driver sits on the left (-Z local)
        const local = new THREE.Vector3(-0.25, 1.18, -0.38);
        desiredPos = local.applyMatrix4(body.matrixWorld);
        desiredLook = new THREE.Vector3(30 * back, 0.85, -0.38).applyMatrix4(body.matrixWorld);
        fov = 72;
        stiff = 60;
        break;
      }
      case 'cinematic':
      default: {
        this.cineTimer -= dt;
        if (this.cineTimer <= 0 || this.cineAnchor.distanceTo(p) > 140) {
          this.cineTimer = 7;
          const side = Math.random() < 0.5 ? -1 : 1;
          this.cineAnchor
            .copy(p)
            .addScaledVector(fwd, 45 + speed * 2.5)
            .addScaledVector(right, side * (14 + Math.random() * 10))
            .add(new THREE.Vector3(0, 2 + Math.random() * 10, 0));
          this.initialized = false;
        }
        desiredPos = this.cineAnchor.clone();
        desiredLook = p.clone().add(new THREE.Vector3(0, 1, 0));
        fov = 40;
        stiff = 100;
      }
    }
    if (!this.initialized) {
      this.pos.copy(desiredPos);
      this.look.copy(desiredLook);
      this.initialized = true;
    } else {
      const k = 1 - Math.exp(-stiff * dt);
      this.pos.lerp(desiredPos, k);
      this.look.lerp(desiredLook, Math.min(1, k * 1.5));
    }
    cam.position.copy(this.pos);
    if (this.shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this.shake;
      cam.position.y += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 1.5);
    }
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = lerp(cam.fov, fov, Math.min(1, dt * 3));
      cam.updateProjectionMatrix();
    }
  }
}

/**
 * Vehicle dynamics: dynamic bicycle model with saturating tyre forces and a
 * friction circle, blended to a kinematic model at low speed; automatic
 * gearbox with torque curve; aero drag, rolling resistance and grade force.
 *
 * Frame: heading psi = atan2(dz, dx) in world XZ (+Z south). Positive yaw rate
 * and steering turn right. Body velocity: vx forward, vy to the right.
 */
import { clamp, lerp, smoothstep } from '../shared/math';

export interface VehicleSpec {
  mass: number;
  inertia: number;
  a: number; // CG -> front axle
  b: number; // CG -> rear axle
  cf: number; // front cornering stiffness N/rad
  cr: number;
  mu: number;
  maxSteer: number;
  wheelRadius: number;
  gears: number[];
  finalDrive: number;
  idleRpm: number;
  redline: number;
  peakTorque: number;
  dragCoef: number; // 0.5 * rho * Cd * A
  rollCoef: number;
  brakeForce: number;
  halfWidth: number;
  halfLength: number;
}

export const SEDAN: VehicleSpec = {
  mass: 1450,
  inertia: 2450,
  a: 1.22,
  b: 1.5,
  cf: 82000,
  cr: 90000,
  mu: 1.0,
  maxSteer: 0.6,
  wheelRadius: 0.32,
  gears: [3.6, 2.15, 1.45, 1.08, 0.86, 0.7],
  finalDrive: 3.9,
  idleRpm: 800,
  redline: 6500,
  peakTorque: 250,
  dragCoef: 0.38,
  rollCoef: 12,
  brakeForce: 15500,
  halfWidth: 0.92,
  halfLength: 2.35,
};

export const SUV: VehicleSpec = {
  ...SEDAN,
  mass: 1850,
  inertia: 3300,
  a: 1.3,
  b: 1.55,
  cf: 92000,
  cr: 98000,
  peakTorque: 320,
  dragCoef: 0.5,
  halfWidth: 0.96,
  halfLength: 2.4,
};

/** Race-mode tune: more power and grip, stronger brakes. */
export function raceTune(spec: VehicleSpec): VehicleSpec {
  return { ...spec, peakTorque: spec.peakTorque * 1.5, mu: spec.mu * 1.05, brakeForce: spec.brakeForce * 1.1, dragCoef: spec.dragCoef * 0.95 };
}

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1..1 (right positive)
  handbrake: boolean;
}

export class VehicleDynamics {
  x = 0;
  z = 0;
  psi = 0;
  vx = 0;
  vy = 0;
  r = 0;
  steer = 0;
  gear = 1; // 1..n, -1 reverse, 0 neutral
  rpm = 800;
  throttleOut = 0;
  /** slip magnitude for tyre squeal audio 0..1 */
  slip = 0;
  /** longitudinal / lateral acceleration for visual pitch/roll */
  ax = 0;
  ay = 0;
  /** extra grip multiplier (rain) */
  gripScale = 1;
  private shiftTimer = 0;
  private reverseHold = 0;

  constructor(public spec: VehicleSpec) {}

  get speed() {
    return this.vx;
  }

  /** Integrate one fixed step. grade = dy/ds along the car heading. */
  step(dt: number, c: Controls, grade: number) {
    const S = this.spec;
    const m = S.mass;
    const L = S.a + S.b;
    const v = this.vx;
    const absV = Math.abs(v);

    // speed sensitive steering with rate limit
    const steerLimit = S.maxSteer * lerp(1, 0.16, smoothstep(2, 32, absV));
    const target = clamp(c.steer, -1, 1) * steerLimit;
    const rate = 2.2 * steerLimit + 0.2;
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);

    // gear handling: reverse when stopped and holding brake
    let throttle = c.throttle;
    let brake = c.brake;
    if (this.gear > 0) {
      if (absV < 0.4 && brake > 0.5 && throttle < 0.05) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.45) {
          this.gear = -1;
          this.reverseHold = 0;
        }
      } else this.reverseHold = 0;
    } else if (this.gear === -1) {
      if (absV < 0.4 && throttle > 0.3) this.gear = 1;
      // in reverse the brake pedal drives backwards and throttle brakes
      const t = throttle;
      throttle = brake;
      brake = t;
    }

    // automatic gearbox
    const wheelRpm = (absV / (2 * Math.PI * S.wheelRadius)) * 60;
    if (this.gear > 0) {
      this.shiftTimer -= dt;
      const ratio = S.gears[this.gear - 1] * S.finalDrive;
      const rpm = wheelRpm * ratio;
      const upAt = lerp(2600, 6000, throttle);
      if (this.shiftTimer <= 0) {
        if (rpm > upAt && this.gear < S.gears.length) {
          this.gear++;
          this.shiftTimer = 0.45;
        } else if (this.gear > 1) {
          const lowerRpm = wheelRpm * S.gears[this.gear - 2] * S.finalDrive;
          if (rpm < 1300 || (throttle > 0.85 && lowerRpm < 5200 && rpm < 3200)) {
            this.gear--;
            this.shiftTimer = 0.35;
          }
        }
      }
    }
    const gearRatio = this.gear > 0 ? S.gears[this.gear - 1] : this.gear === -1 ? 3.3 : 0;
    const engineRpm = Math.max(S.idleRpm, wheelRpm * gearRatio * S.finalDrive);
    const shifting = this.shiftTimer > 0.2;
    this.rpm += (clamp(engineRpm + (absV < 1 ? throttle * 2500 : 0), S.idleRpm, S.redline + 200) - this.rpm) * Math.min(1, dt * 12);
    const torque = this.torqueAt(this.rpm) * (shifting ? 0.25 : 1);
    let fDrive = 0;
    if (gearRatio && this.rpm < S.redline) fDrive = (torque * gearRatio * S.finalDrive * 0.88 * throttle) / S.wheelRadius;
    if (this.gear === -1) fDrive = -fDrive;
    this.throttleOut = throttle;

    // resistive forces
    const fDrag = S.dragCoef * v * absV;
    const fRoll = S.rollCoef * v;
    const fGrade = m * 9.81 * Math.sin(Math.atan(grade));
    let fBrake = 0;
    if (absV > 0.05) fBrake = -Math.sign(v) * brake * S.brakeForce;
    if (c.handbrake && absV > 0.05) fBrake -= Math.sign(v) * 4500;

    const muEff = S.mu * this.gripScale;
    const fzF = (m * 9.81 * S.b) / L;
    const fzR = (m * 9.81 * S.a) / L;
    let fx = fDrive + fBrake - fDrag - fRoll - fGrade;
    // ABS / traction: total longitudinal force limited by friction
    const maxLong = muEff * m * 9.81;
    fx = clamp(fx, -maxLong, maxLong);

    // standstill: brakes hold the car
    if (absV < 0.3 && fDrive === 0 && (brake > 0.05 || c.handbrake)) {
      this.vx *= Math.max(0, 1 - dt * 12);
      this.vy *= Math.max(0, 1 - dt * 12);
      this.r *= Math.max(0, 1 - dt * 12);
      this.integratePose(dt);
      this.slip = 0;
      return;
    }

    // lateral dynamics
    const dyn = smoothstep(2.5, 6, absV);
    let dvx: number;
    let dvy = 0;
    let dr = 0;
    if (dyn > 0) {
      const sv = Math.max(absV, 1.5);
      const sgn = v >= 0 ? 1 : -1;
      const alphaF = Math.atan2(this.vy + S.a * this.r, sv) - this.steer * sgn;
      const alphaR = Math.atan2(this.vy - S.b * this.r, sv);
      // friction circle: longitudinal usage reduces lateral grip
      const longUseF = Math.min(0.95, Math.abs(fBrake * 0.65) / (muEff * fzF + 1));
      const longUseR = Math.min(0.95, Math.abs(fDrive * 0 + fBrake * 0.35 + (c.handbrake ? 4500 : 0)) / (muEff * fzR + 1));
      const maxF = muEff * fzF * Math.sqrt(1 - longUseF * longUseF);
      const maxR = muEff * fzR * Math.sqrt(1 - longUseR * longUseR) * (c.handbrake ? 0.45 : 1);
      let fyF = -S.cf * alphaF;
      let fyR = -S.cr * alphaR;
      // smooth saturation
      fyF = maxF * Math.tanh(fyF / maxF);
      fyR = maxR * Math.tanh(fyR / maxR);
      this.slip = clamp(Math.max(Math.abs(alphaF), Math.abs(alphaR)) * 5 - 0.35, 0, 1) * smoothstep(5, 12, absV);
      const cosD = Math.cos(this.steer);
      const sinD = Math.sin(this.steer);
      dvx = (fx - fyF * sinD) / m + this.vy * this.r;
      dvy = (fyR + fyF * cosD) / m - this.vx * this.r;
      dr = (S.a * fyF * cosD - S.b * fyR) / S.inertia;
      this.ay = (fyR + fyF * cosD) / m;
    } else {
      dvx = fx / m;
      this.slip = 0;
      this.ay = 0;
    }
    this.ax = dvx;
    this.vx += dvx * dt;
    if (dyn > 0) {
      this.vy += dvy * dt;
      this.r += dr * dt;
    }
    // blend towards the kinematic model at low speed
    const rKin = (this.vx * Math.tan(this.steer)) / L;
    this.r = lerp(rKin, this.r, dyn);
    this.vy = lerp(0, this.vy, dyn);
    // avoid creeping when braking to a stop
    if (brake > 0.05 && Math.abs(this.vx) < 0.15 && fDrive === 0) this.vx = 0;
    this.integratePose(dt);
  }

  private integratePose(dt: number) {
    const c = Math.cos(this.psi);
    const s = Math.sin(this.psi);
    // body -> world: forward (c, s), right (-s, c)
    this.x += (this.vx * c - this.vy * s) * dt;
    this.z += (this.vx * s + this.vy * c) * dt;
    this.psi += this.r * dt;
  }

  torqueAt(rpm: number) {
    const S = this.spec;
    const t = rpm / S.redline;
    // broad plateau between ~2500 and 5000 rpm
    const shape = 0.55 + 0.45 * Math.sin(Math.min(1, t * 1.35) * Math.PI * 0.5) - Math.max(0, t - 0.85) * 1.2;
    return S.peakTorque * clamp(shape, 0.2, 1);
  }

  /** World-space velocity. */
  worldVelocity(): [number, number] {
    const c = Math.cos(this.psi);
    const s = Math.sin(this.psi);
    return [this.vx * c - this.vy * s, this.vx * s + this.vy * c];
  }

  setWorldVelocity(wx: number, wz: number) {
    const c = Math.cos(this.psi);
    const s = Math.sin(this.psi);
    this.vx = wx * c + wz * s;
    this.vy = -wx * s + wz * c;
  }
}

/** Keyboard, gamepad and touch input mapped to driving controls. */
import { clamp } from '../shared/math';
import type { Controls } from '../vehicle/Dynamics';

export type InputAction = 'camera' | 'pause' | 'horn' | 'lights' | 'reset' | 'signalLeft' | 'signalRight' | 'map' | 'lookBack' | 'hud';

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<InputAction>();
  private steerKb = 0;
  readonly controls: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  horn = false;
  lookBack = false;
  touch = { throttle: 0, brake: 0, steer: 0 };
  usingTouch = false;
  sensitivity = 1;
  private gpPrev: boolean[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (!this.keys.has(e.code)) this.onPress(e.code);
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onPress(code: string) {
    const map: Record<string, InputAction> = {
      KeyC: 'camera',
      Escape: 'pause',
      KeyP: 'pause',
      KeyL: 'lights',
      KeyR: 'reset',
      KeyQ: 'signalLeft',
      KeyE: 'signalRight',
      KeyM: 'map',
      KeyH: 'hud',
    };
    const a = map[code];
    if (a) this.pressed.add(a);
  }

  /** Returns and clears a one-shot action. */
  consume(a: InputAction): boolean {
    const had = this.pressed.has(a);
    this.pressed.delete(a);
    return had;
  }
  trigger(a: InputAction) {
    this.pressed.add(a);
  }

  update(dt: number) {
    const k = this.keys;
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');
    // keyboard steering ramps smoothly and recentres
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = target === 0 ? 3.2 : Math.sign(target) !== Math.sign(this.steerKb) ? 4.5 : 2.2 * this.sensitivity;
    this.steerKb += clamp(target - this.steerKb, -rate * dt, rate * dt);
    let throttle = up ? 1 : 0;
    let brake = down ? 1 : 0;
    let steer = this.steerKb;
    const handbrake = k.has('Space');
    this.horn = k.has('KeyB');
    this.lookBack = k.has('KeyV');

    // gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0;
      if (Math.abs(ax) > 0.08) steer = Math.sign(ax) * Math.pow((Math.abs(ax) - 0.08) / 0.92, 1.4);
      const rt = gp.buttons[7]?.value ?? 0;
      const lt = gp.buttons[6]?.value ?? 0;
      if (rt > 0.02) throttle = Math.max(throttle, rt);
      if (lt > 0.02) brake = Math.max(brake, lt);
      const btn = (i: number) => !!gp.buttons[i]?.pressed;
      const edge = (i: number, a: InputAction) => {
        if (btn(i) && !this.gpPrev[i]) this.pressed.add(a);
      };
      edge(3, 'camera');
      edge(9, 'pause');
      edge(1, 'reset');
      edge(14, 'signalLeft');
      edge(15, 'signalRight');
      if (btn(2)) this.horn = true;
      this.gpPrev = gp.buttons.map((b) => b.pressed);
      if (btn(0)) brake = Math.max(brake, 0);
      break;
    }
    if (this.usingTouch) {
      throttle = Math.max(throttle, this.touch.throttle);
      brake = Math.max(brake, this.touch.brake);
      if (Math.abs(this.touch.steer) > 0.02) steer = this.touch.steer;
    }
    this.controls.throttle = throttle;
    this.controls.brake = brake;
    this.controls.steer = clamp(steer, -1, 1);
    this.controls.handbrake = handbrake;
  }
}


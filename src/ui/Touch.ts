/** On-screen touch controls (steering pad, throttle, brake, camera). */
import type { Input } from '../core/Input';

export class TouchControls {
  readonly el: HTMLDivElement;

  constructor(
    root: HTMLElement,
    readonly input: Input,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'touch';
    this.el.innerHTML = `<div class="pad steer">◀ 转向 ▶</div><div class="pad gas">油门</div><div class="pad brk">刹车</div><div class="pad btn" data-a="camera">视角</div>`;
    root.appendChild(this.el);
    const steer = this.el.querySelector('.steer') as HTMLElement;
    const setSteer = (e: PointerEvent) => {
      const r = steer.getBoundingClientRect();
      input.touch.steer = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    };
    steer.addEventListener('pointerdown', (e) => {
      steer.setPointerCapture(e.pointerId);
      setSteer(e);
    });
    steer.addEventListener('pointermove', (e) => {
      if (e.buttons || e.pointerType === 'touch') setSteer(e);
    });
    steer.addEventListener('pointerup', () => (input.touch.steer = 0));
    steer.addEventListener('pointercancel', () => (input.touch.steer = 0));
    const hold = (sel: string, key: 'throttle' | 'brake') => {
      const el = this.el.querySelector(sel) as HTMLElement;
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture(e.pointerId);
        input.touch[key] = 1;
      });
      const up = () => (input.touch[key] = 0);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    hold('.gas', 'throttle');
    hold('.brk', 'brake');
    (this.el.querySelector('[data-a="camera"]') as HTMLElement).addEventListener('pointerdown', () => input.trigger('camera'));
    window.addEventListener(
      'touchstart',
      () => {
        input.usingTouch = true;
      },
      { once: true, passive: true },
    );
  }

  show(on: boolean) {
    this.el.classList.toggle('on', on && this.input.usingTouch);
  }
}

/** Heads-up display: speedometer, speed limit, line badge, section, next exit, guidance, stats, toasts. */
import type { LineId } from '../shared/types';

/** Race information shown instead of the trip panels. */
export interface RaceHudState {
  rank: number;
  total: number;
  /** race clock (s); negative during the countdown */
  clock: number;
  remaining: number;
  distance: number;
  /** standings: name, gap to the player in metres (positive = ahead), finished */
  board: { name: string; gap: number; me: boolean; color: number; finished: boolean }[];
  warning: string | null;
}

export interface HudState {
  speedKmh: number;
  rpm: number;
  gear: number;
  /** speed limit; null when limits do not apply (races) */
  limit: number | null;
  line: LineId | null;
  onRamp: boolean;
  section: string;
  nextExit: { code: string; name: string; dist: number; side: 'left' | 'right' } | null;
  guidance: string | null;
  stats: string;
  signal: -1 | 0 | 1;
  hazard: boolean;
  fps: number;
  lightsOn: boolean;
  camName: string;
  race?: RaceHudState | null;
}

export class Hud {
  readonly el: HTMLDivElement;
  private speedo: HTMLCanvasElement;
  private sg: CanvasRenderingContext2D;
  private limitEl: HTMLDivElement;
  private badge: HTMLDivElement;
  private sectionEl: HTMLDivElement;
  private nextEl: HTMLDivElement;
  private guideEl: HTMLDivElement;
  private statsEl: HTMLDivElement;
  private toastsEl: HTMLDivElement;
  private flashEl: HTMLDivElement;
  private signalsEl: HTMLDivElement;
  private fpsEl: HTMLDivElement;
  private raceEl: HTMLDivElement;
  private countEl: HTMLDivElement;
  private lastKey = '';
  private lastCount = '';
  private blink = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud hidden';
    this.el.innerHTML = `
      <div class="topleft">
        <div class="linebadge"></div>
        <div class="section"></div>
        <div class="nextexit hidden"></div>
      </div>
      <div class="guidance"></div>
      <div class="stats"></div>
      <div class="toasts"></div>
      <div class="limit">60</div>
      <div class="signals"><span>◀</span><span>▶</span></div>
      <div class="speedo"><canvas width="420" height="420"></canvas></div>
      <div class="racepanel hidden"></div>
      <div class="countdown hidden"></div>
      <div class="fps"></div>`;
    root.appendChild(this.el);
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'flash';
    root.appendChild(this.flashEl);
    this.speedo = this.el.querySelector('.speedo canvas') as HTMLCanvasElement;
    this.sg = this.speedo.getContext('2d')!;
    this.limitEl = this.el.querySelector('.limit') as HTMLDivElement;
    this.badge = this.el.querySelector('.linebadge') as HTMLDivElement;
    this.sectionEl = this.el.querySelector('.section') as HTMLDivElement;
    this.nextEl = this.el.querySelector('.nextexit') as HTMLDivElement;
    this.guideEl = this.el.querySelector('.guidance') as HTMLDivElement;
    this.statsEl = this.el.querySelector('.stats') as HTMLDivElement;
    this.toastsEl = this.el.querySelector('.toasts') as HTMLDivElement;
    this.signalsEl = this.el.querySelector('.signals') as HTMLDivElement;
    this.fpsEl = this.el.querySelector('.fps') as HTMLDivElement;
    this.raceEl = this.el.querySelector('.racepanel') as HTMLDivElement;
    this.countEl = this.el.querySelector('.countdown') as HTMLDivElement;
  }

  show(on: boolean) {
    this.el.classList.toggle('hidden', !on);
  }

  toast(text: string, kind: 'bad' | 'info' | 'warn' = 'bad', ms = 2600) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'info' ? ' info' : kind === 'warn' ? ' warn' : '');
    t.textContent = text;
    this.toastsEl.appendChild(t);
    while (this.toastsEl.children.length > 3) this.toastsEl.firstChild!.remove();
    setTimeout(() => t.remove(), ms);
  }

  flash() {
    this.flashEl.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
  }

  update(s: HudState, dt: number) {
    this.drawSpeedo(s);
    this.limitEl.classList.toggle('hidden', s.limit === null);
    if (s.limit !== null) {
      this.limitEl.textContent = String(s.limit);
      this.limitEl.classList.toggle('over', s.speedKmh > s.limit * 1.1 + 1);
    }
    this.updateRace(s.race ?? null);
    const key = `${s.line}|${s.onRamp}|${s.section}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const color = s.line === 'A' ? 'var(--a-line)' : s.line === 'B' ? 'var(--b-line)' : '#777';
      this.badge.innerHTML = s.line
        ? `<div class="ring" style="background:${color}">${s.line}</div><div><div class="t1">内环路 ${s.line}线</div><div class="t2">${s.line === 'A' ? '逆时针 · Counter-clockwise' : '顺时针 · Clockwise'}${s.onRamp ? ' · 匝道' : ''}</div></div>`
        : `<div class="ring" style="background:#777">匝</div><div><div class="t1">匝道</div><div class="t2">Ramp</div></div>`;
      this.sectionEl.innerHTML = `${escapeHtml(s.section || '内环路')}<small>路段</small>`;
    }
    if (s.nextExit) {
      this.nextEl.classList.remove('hidden');
      const d = s.nextExit.dist;
      const ds = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`;
      this.nextEl.innerHTML = `<span class="code">${escapeHtml(s.nextExit.code)}</span>${escapeHtml(s.nextExit.name)}${s.nextExit.side === 'left' ? ' ↖左侧' : ''}<span class="dist">${ds}</span>`;
    } else this.nextEl.classList.add('hidden');
    if (s.guidance) {
      this.guideEl.style.display = 'block';
      this.guideEl.textContent = s.guidance;
    } else this.guideEl.style.display = 'none';
    if (!s.race) this.statsEl.innerHTML = s.stats;
    this.blink += dt;
    const on = Math.floor(this.blink * 2.6) % 2 === 0;
    const spans = this.signalsEl.querySelectorAll('span');
    spans[0].classList.toggle('on', (s.signal === -1 || s.hazard) && on);
    spans[1].classList.toggle('on', (s.signal === 1 || s.hazard) && on);
    this.fpsEl.textContent = `${Math.round(s.fps)} FPS · ${s.camName}${s.lightsOn ? ' · 大灯开' : ''}`;
  }

  /** Race panel (position, clock, distance to go), standings in place of the trip stats, countdown. */
  private updateRace(r: RaceHudState | null) {
    this.raceEl.classList.toggle('hidden', !r);
    this.el.classList.toggle('racing', !!r);
    if (!r) {
      this.countEl.classList.add('hidden');
      this.lastCount = '';
      return;
    }
    const time = r.clock < 0 ? '0:00.0' : fmtClock(r.clock);
    const togo = r.remaining >= 1000 ? `${(r.remaining / 1000).toFixed(2)} km` : `${Math.round(r.remaining)} m`;
    const pct = Math.max(0, Math.min(100, (1 - r.remaining / r.distance) * 100));
    this.raceEl.innerHTML = `<div class="pos"><b>${r.rank}</b><span>/${r.total}</span><small>名次</small></div><div class="info"><div class="clock">${time}</div><div class="togo">剩余 ${togo}</div><div class="bar"><div style="width:${pct.toFixed(1)}%"></div></div></div>${r.warning ? `<div class="warn">${escapeHtml(r.warning)}</div>` : ''}`;
    this.statsEl.innerHTML = r.board
      .map((b, k) => {
        const gap = b.me ? '' : b.finished ? '完赛' : `${b.gap > 0 ? '+' : '−'}${Math.abs(b.gap) >= 1000 ? `${(Math.abs(b.gap) / 1000).toFixed(1)} km` : `${Math.round(Math.abs(b.gap))} m`}`;
        const dot = `<i style="background:#${b.color.toString(16).padStart(6, '0')}"></i>`;
        return `<div class="standing${b.me ? ' me' : ''}"><span class="k">${k + 1}</span>${dot}<span class="n">${escapeHtml(b.name)}</span><span class="g">${gap}</span></div>`;
      })
      .join('');
    const count = r.clock < 0 ? String(Math.ceil(-r.clock)) : r.clock < 1.2 ? 'GO!' : '';
    if (count !== this.lastCount) {
      this.lastCount = count;
      this.countEl.textContent = count;
      this.countEl.classList.toggle('hidden', !count);
      this.countEl.classList.toggle('go', count === 'GO!');
      if (count) this.countEl.animate([{ transform: 'translate(-50%, -50%) scale(1.6)', opacity: 0.2 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }], { duration: 300, easing: 'ease-out' });
    }
  }

  private drawSpeedo(s: HudState) {
    const g = this.sg;
    const W = this.speedo.width;
    const c = W / 2;
    g.clearRect(0, 0, W, W);
    // dial
    g.fillStyle = 'rgba(10,14,18,0.78)';
    g.beginPath();
    g.arc(c, c, c - 4, 0, Math.PI * 2);
    g.fill();
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    // race cars are tuned for more than the city scale
    const maxV = s.race ? 240 : 160;
    const ang = (v: number) => a0 + (a1 - a0) * Math.min(1, v / maxV);
    // rpm arc (inner)
    g.lineWidth = 10;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.arc(c, c, c - 58, a0, a1);
    g.stroke();
    const rpmF = Math.min(1, s.rpm / 7000);
    g.strokeStyle = s.rpm > 6000 ? '#ff4d4d' : '#3ccf7e';
    g.beginPath();
    g.arc(c, c, c - 58, a0, a0 + (a1 - a0) * rpmF);
    g.stroke();
    // limit zone marker
    if (s.limit !== null) {
      g.strokeStyle = 'rgba(255,60,60,0.85)';
      g.lineWidth = 6;
      g.beginPath();
      g.arc(c, c, c - 22, ang(s.limit), ang(maxV));
      g.stroke();
    }
    // ticks
    g.strokeStyle = '#dfe6ec';
    g.fillStyle = '#dfe6ec';
    g.font = 'bold 22px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const step = maxV > 160 ? 20 : 10;
    for (let v = 0; v <= maxV; v += step) {
      const a = ang(v);
      const major = v % (step * 2) === 0;
      const r0 = c - (major ? 34 : 28);
      g.lineWidth = major ? 4 : 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      g.lineTo(c + Math.cos(a) * (c - 16), c + Math.sin(a) * (c - 16));
      g.stroke();
      if (major) g.fillText(String(v), c + Math.cos(a) * (c - 84), c + Math.sin(a) * (c - 84));
    }
    // needle
    const a = ang(Math.abs(s.speedKmh));
    g.strokeStyle = '#ff5a3c';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(c - Math.cos(a) * 20, c - Math.sin(a) * 20);
    g.lineTo(c + Math.cos(a) * (c - 30), c + Math.sin(a) * (c - 30));
    g.stroke();
    g.fillStyle = '#ff5a3c';
    g.beginPath();
    g.arc(c, c, 12, 0, Math.PI * 2);
    g.fill();
    // digital
    g.fillStyle = '#fff';
    g.font = 'bold 64px sans-serif';
    g.fillText(String(Math.round(Math.abs(s.speedKmh))), c, c + 70);
    g.font = '20px sans-serif';
    g.fillStyle = '#9aa7b3';
    g.fillText('km/h', c, c + 112);
    g.font = 'bold 30px sans-serif';
    g.fillStyle = '#ffd34d';
    g.fillText(s.gear === -1 ? 'R' : s.gear === 0 ? 'N' : `D${s.gear}`, c, c - 64);
  }
}

function fmtClock(t: number) {
  // round first, so that 59.97 s shows as 1:00.0 rather than 0:60.0
  const tenths = Math.round(t * 10);
  const m = Math.floor(tenths / 600);
  return `${m}:${((tenths - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

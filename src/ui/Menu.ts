/** Main menu, pause menu, help and result screens. */
import type { RoadNetwork } from '../road/Network';
import type { GameOptions, Quality, Settings } from '../core/Settings';
import type { LineId } from '../shared/types';
import { escapeHtml } from './Hud';

export interface StartPoint {
  id: string;
  label: string;
}

export function startPoints(net: RoadNetwork, line: LineId): StartPoint[] {
  const out: StartPoint[] = [];
  const L = net.lines[line].length;
  const seen = new Set<string>();
  for (let s = 0; s < L - 300; s += 1500) {
    const loc = net.atLineS(line, s + 40);
    const name = net.nameAt(loc.edge, loc.s) || '内环路';
    const label = s === 0 ? `主线 · ${name}（广州站）` : `主线 · ${name}`;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ id: `main:${Math.round(s + 40)}`, label });
  }
  net.entrances.forEach((en, i) => {
    if (en.line !== line) return;
    out.push({ id: `ramp:${i}`, label: `入口 · ${en.name}${en.side === 'left' ? '（左侧汇入）' : ''}` });
  });
  return out;
}

function seg(name: string, value: string, items: [string, string, string?][]) {
  return `<div class="seg" data-name="${name}">${items
    .map(([v, label, cls]) => `<button data-v="${v}" class="${v === value ? 'on' : ''} ${cls ?? ''}">${label}</button>`)
    .join('')}</div>`;
}

export class Menu {
  readonly el: HTMLDivElement;
  onStart: (o: GameOptions) => void = () => {};
  onSettings: (s: Partial<Settings>) => void = () => {};

  constructor(
    readonly root: HTMLElement,
    readonly net: RoadNetwork,
    public settings: Settings,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'overlay menu hidden';
    root.appendChild(this.el);
  }

  showMain() {
    const o = this.settings.options;
    const starts = startPoints(this.net, o.line);
    if (!starts.find((s) => s.id === o.start)) o.start = starts[0].id;
    const exits = this.net.exits.filter((x) => x.line === o.line && x.code).sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1)));
    if (!exits.find((x) => x.code === o.destination)) o.destination = exits[Math.min(6, exits.length - 1)]?.code ?? '';
    this.el.innerHTML = `
      <div class="card">
        <h1><span class="shield">环</span>广州内环路</h1>
        <div class="tagline">基于 OpenStreetMap 真实数据还原的内环路驾驶模拟。<br/>A线逆时针 · B线顺时针 · 全长约 23.4 km · 限速 60 km/h</div>
        <div class="field"><label>线路</label>${seg('line', o.line, [
          ['A', 'A线 · 逆时针', 'lineA'],
          ['B', 'B线 · 顺时针', 'lineB'],
        ])}</div>
        <div class="field"><label>模式</label>${seg('mode', o.mode, [
          ['free', '自由驾驶'],
          ['trip', '行程模式'],
          ['lap', '计圈挑战'],
        ])}</div>
        <div class="field"><label>起点</label><select data-name="start">${starts
          .map((s) => `<option value="${s.id}" ${s.id === o.start ? 'selected' : ''}>${escapeHtml(s.label)}</option>`)
          .join('')}</select></div>
        <div class="field ${o.mode === 'trip' ? '' : 'hidden'}" data-dest><label>终点出口</label><select data-name="destination">${exits
          .map((x) => `<option value="${x.code}" ${x.code === o.destination ? 'selected' : ''}>${x.code} ${escapeHtml(x.names.join(' / '))}${x.side === 'left' ? '（左侧出口）' : ''}</option>`)
          .join('')}</select></div>
        <div class="field"><label>时间</label>${seg('time', o.time, [
          ['dawn', '清晨'],
          ['day', '白天'],
          ['dusk', '黄昏'],
          ['night', '夜晚'],
        ])}</div>
        <div class="field"><label>天气</label>${seg('weather', o.weather, [
          ['clear', '晴'],
          ['cloudy', '阴'],
          ['rain', '雨'],
        ])}</div>
        <div class="field"><label>车流</label>${seg('traffic', o.traffic, [
          ['sparse', '稀疏'],
          ['normal', '正常'],
          ['rush', '早晚高峰'],
        ])}</div>
        <div class="field"><label>车型</label>${seg('car', o.car, [
          ['sedan', '轿车'],
          ['taxi', '出租车'],
          ['suv', 'SUV'],
        ])}</div>
        <div class="field"><label title="低画质会减少城市建筑数量（刷新页面后生效）">画质</label>${seg('quality', this.settings.quality, [
          ['low', '低'],
          ['medium', '中'],
          ['high', '高'],
        ])}</div>
        <button class="primary" data-act="start">开 始 驾 驶</button>
        <div class="row"><button class="ghost" data-act="help">操作说明</button></div>
        <div class="credits">地图数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 贡献者（ODbL）· 纹理 Poly Haven（CC0）· 高程 AWS Terrain Tiles · 本游戏为 GPL-3.0 开源项目，场景为近似还原，请勿用于实际导航。</div>
      </div>`;
    this.el.classList.remove('hidden');
    this.wire();
  }

  private wire() {
    const o = this.settings.options;
    this.el.querySelectorAll<HTMLDivElement>('.seg').forEach((segEl) => {
      const name = segEl.dataset.name!;
      segEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
        b.addEventListener('click', () => {
          const v = b.dataset.v!;
          if (name === 'quality') {
            this.settings.quality = v as Quality;
            this.onSettings({ quality: v as Quality });
          } else (o as unknown as Record<string, string>)[name] = v;
          if (name === 'line' || name === 'mode') this.showMain();
          else {
            segEl.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          }
        }),
      );
    });
    this.el.querySelectorAll<HTMLSelectElement>('select').forEach((sel) =>
      sel.addEventListener('change', () => {
        (o as unknown as Record<string, string>)[sel.dataset.name!] = sel.value;
      }),
    );
    this.el.querySelector('[data-act="start"]')?.addEventListener('click', () => {
      this.hide();
      this.onStart({ ...o });
    });
    this.el.querySelector('[data-act="help"]')?.addEventListener('click', () => this.showHelp(() => this.showMain()));
  }

  showHelp(back: () => void) {
    this.el.innerHTML = `<div class="card"><h1>操作说明</h1><div class="help">
      <kbd>W</kbd>/<kbd>↑</kbd> 油门　<kbd>S</kbd>/<kbd>↓</kbd> 刹车（停稳后长按倒车）<br/>
      <kbd>A</kbd>/<kbd>D</kbd> 或 <kbd>←</kbd>/<kbd>→</kbd> 转向　<kbd>空格</kbd> 手刹<br/>
      <kbd>Q</kbd>/<kbd>E</kbd> 左/右转向灯（变道前请打灯）　<kbd>X</kbd> 双闪<br/>
      <kbd>C</kbd> 切换视角　<kbd>V</kbd> 回头看　<kbd>L</kbd> 大灯　<kbd>B</kbd> 喇叭<br/>
      <kbd>M</kbd> 全图　<kbd>R</kbd> 回到车道　<kbd>Esc</kbd> 暂停<br/>
      支持手柄（RT 油门 / LT 刹车 / 左摇杆转向）和触屏。<br/><br/>
      <b>拟真规则</b>：内环路限速 60 km/h，弯道与匝道 30–40 km/h；沿线设有定点测速与区间测速；
      驶过导流线、压实线变道、碰撞护栏都会被记录。部分出入口位于<b>左侧</b>，请留意指路标志。
      驶入出口匝道到达地面道路即完成行程，可选择换线继续。
    </div><button class="primary" data-act="back">返 回</button></div>`;
    this.el.classList.remove('hidden');
    this.el.querySelector('[data-act="back"]')!.addEventListener('click', back);
  }

  showPause(actions: { resume: () => void; restart: () => void; menu: () => void }) {
    this.el.innerHTML = `<div class="card"><h1>暂停</h1>
      <button class="primary" data-act="resume">继 续</button>
      <div class="row"><button class="ghost" data-act="restart">重新开始</button><button class="ghost" data-act="menu">主菜单</button></div>
      <div class="field"><label>音量</label><input type="range" min="0" max="1" step="0.05" value="${this.settings.volume}" data-act="vol" style="width:100%"/></div>
      <div class="field"><label>画质</label>${seg('quality', this.settings.quality, [
        ['low', '低'],
        ['medium', '中'],
        ['high', '高'],
      ])}</div>
      <div class="row"><button class="ghost" data-act="help">操作说明</button></div></div>`;
    this.el.classList.remove('hidden');
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    q('[data-act="resume"]').addEventListener('click', actions.resume);
    q('[data-act="restart"]').addEventListener('click', actions.restart);
    q('[data-act="menu"]').addEventListener('click', actions.menu);
    q('[data-act="help"]').addEventListener('click', () => this.showHelp(() => this.showPause(actions)));
    (q('[data-act="vol"]') as HTMLInputElement).addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      this.settings.volume = v;
      this.onSettings({ volume: v });
    });
    this.el.querySelectorAll<HTMLButtonElement>('.seg[data-name="quality"] button').forEach((b) =>
      b.addEventListener('click', () => {
        this.settings.quality = b.dataset.v as Quality;
        this.onSettings({ quality: this.settings.quality });
        this.el.querySelectorAll('.seg[data-name="quality"] button').forEach((x) => x.classList.toggle('on', x === b));
      }),
    );
  }

  showResult(title: string, rows: [string, string][], actions: { again: () => void; menu: () => void; extra?: { label: string; fn: () => void }[] }) {
    this.el.innerHTML = `<div class="card result"><h2>${escapeHtml(title)}</h2><table>${rows
      .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
      .join('')}</table>
      ${(actions.extra ?? []).map((x, i) => `<button class="primary" data-x="${i}">${escapeHtml(x.label)}</button>`).join('')}
      <div class="row"><button class="ghost" data-act="again">再来一次</button><button class="ghost" data-act="menu">主菜单</button></div></div>`;
    this.el.classList.remove('hidden');
    (this.el.querySelector('[data-act="again"]') as HTMLElement).addEventListener('click', actions.again);
    (this.el.querySelector('[data-act="menu"]') as HTMLElement).addEventListener('click', actions.menu);
    (actions.extra ?? []).forEach((x, i) => (this.el.querySelector(`[data-x="${i}"]`) as HTMLElement).addEventListener('click', x.fn));
  }

  hide() {
    this.el.classList.add('hidden');
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }
}

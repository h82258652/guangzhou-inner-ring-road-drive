/** Application shell: renderer, loading, world construction, menus and the game loop. */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { fetchJson } from './core/Loader';
import { Input } from './core/Input';
import { CameraRig, CAMERA_NAMES } from './core/CameraRig';
import { loadSettings, QUALITY, saveSettings, TIME_HOURS, type GameOptions, type Settings } from './core/Settings';
import { type Edge, RoadNetwork, newFrame } from './road/Network';
import { buildRoads, type RoadVisuals } from './road/RoadBuilder';
import { DeckIndex } from './road/Clearance';
import { Environment } from './world/Environment';
import { envUniforms, roadMaterials, setAnisotropy } from './world/Materials';
import { buildCity, ensureTrees, type CityVisuals } from './world/City';
import { buildLandmarks, type LandmarkVisuals } from './world/Landmarks';
import { Signs } from './world/Signs';
import { Player } from './vehicle/Player';
import { type Controls, raceTune, SEDAN, SUV } from './vehicle/Dynamics';
import { resolveContacts } from './vehicle/Contacts';
import { TAXI_COLOR } from './vehicle/CarModel';
import { fmtRaceTime, Race } from './race/Race';
import { chequeredLine, nameTag } from './race/RaceVisuals';
import { Traffic, type PlayerProxy } from './traffic/Traffic';
import { Hud, type RaceHudState } from './ui/Hud';
import { Minimap } from './ui/Minimap';
import { Menu } from './ui/Menu';
import { Session } from './game/Session';
import { AudioEngine } from './audio/AudioEngine';
import { TouchControls } from './ui/Touch';
import type { CityFile, LineId, NetworkFile } from './shared/types';
import { clamp } from './shared/math';

const FIXED_DT = 1 / 120;
const JOINT_SPACING = 96;

type State = 'loading' | 'menu' | 'driving' | 'paused' | 'ended';

export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.3, 30000);
  readonly input = new Input();
  readonly rig: CameraRig;
  readonly audio = new AudioEngine();
  settings: Settings = loadSettings();
  env!: Environment;
  net!: RoadNetwork;
  decks!: DeckIndex;
  cityData: CityFile | null = null;
  roads!: RoadVisuals;
  city: CityVisuals | null = null;
  landmarks: LandmarkVisuals | null = null;
  signs!: Signs;
  traffic!: Traffic;
  player: Player | null = null;
  hud!: Hud;
  minimap!: Minimap;
  menu!: Menu;
  touch!: TouchControls;
  session: Session | null = null;
  state: State = 'loading';
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private loadingEl: HTMLElement;
  private acc = 0;
  private last = performance.now();
  private fpsAvg = 60;
  private cullTimer = 0;
  private attractS = 600;
  private attractLine: LineId = 'A';
  private lastJoint = { edge: -1, k: -1 };
  private f = newFrame();
  private lastOptions: GameOptions | null = null;
  private carHitCooldown = 0;
  race: Race | null = null;
  private raceObjects: THREE.Object3D[] = [];
  private raceEnding = false;
  /** controls while waiting on the grid */
  private readonly gridHold: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: true };

  constructor(readonly root: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: QUALITY[this.settings.quality].antialias, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'gl';
    root.appendChild(this.renderer.domElement);
    setAnisotropy(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.rig = new CameraRig(this.camera);
    this.loadingEl = document.createElement('div');
    this.loadingEl.className = 'overlay loading';
    this.loadingEl.innerHTML = `<h1>广州内环路</h1><div class="sub">GUANGZHOU INNER RING ROAD · A线 / B线</div><div class="bar"><div></div></div><div class="status">载入中…</div>`;
    root.appendChild(this.loadingEl);
    window.addEventListener('resize', () => this.resize());
  }

  private status(text: string, frac: number) {
    (this.loadingEl.querySelector('.status') as HTMLElement).textContent = text;
    (this.loadingEl.querySelector('.bar > div') as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
  }

  showFatal(err: Error) {
    this.loadingEl.classList.remove('hidden');
    this.status('出错了：' + err.message, 1);
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[this.settings.quality].pixelRatio));
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async start() {
    this.resize();
    const base = import.meta.env.BASE_URL + 'data/';
    const progress = { net: 0, city: 0 };
    const report = () => this.status(`下载地图数据… ${((progress.net + progress.city) / 1e6).toFixed(1)} MB`, 0.04 + 0.36 * Math.min(1, (progress.net + progress.city) / 9e6));
    const [netData, cityData] = await Promise.all([
      fetchJson<NetworkFile>(base + 'network.json', (l) => {
        progress.net = l;
        report();
      }),
      fetchJson<CityFile>(base + 'city.json', (l) => {
        progress.city = l;
        report();
      }).catch((e) => {
        console.warn('city data unavailable', e);
        return null;
      }),
    ]);
    this.net = new RoadNetwork(netData);
    this.decks = new DeckIndex(this.net);
    this.cityData = cityData;
    this.status('生成高架、匝道与标线…', 0.45);
    await frame();
    this.env = new Environment(this.scene, this.renderer);
    roadMaterials();
    this.roads = buildRoads(this.net, this.decks);
    this.scene.add(this.roads.group);
    if (cityData) {
      this.status('生成城市建筑与珠江…', 0.62);
      await frame();
      const q = QUALITY[this.settings.quality];
      this.city = buildCity(cityData, { trees: q.trees, infill: q.infill, decks: this.decks });
      this.scene.add(this.city.group);
      this.status('生成地标…', 0.82);
      await frame();
      this.landmarks = buildLandmarks(cityData.landmarks, this.city.terrain);
      this.scene.add(this.landmarks.group);
    } else {
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), new THREE.MeshStandardMaterial({ color: 0x7c7f78, roughness: 1 }));
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      this.scene.add(ground);
    }
    this.status('布置交通标志与车流…', 0.9);
    await frame();
    this.signs = new Signs(this.net, this.decks);
    this.scene.add(this.signs.group);
    this.traffic = new Traffic(this.net);
    this.scene.add(this.traffic.group);
    this.hud = new Hud(this.root);
    this.minimap = new Minimap(this.net, cityData);
    this.hud.el.appendChild(this.minimap.el);
    this.touch = new TouchControls(this.root, this.input);
    this.menu = new Menu(this.root, this.net, this.settings);
    this.menu.onStart = (o) => this.begin(o);
    this.menu.onSettings = (s) => this.applySettings(s);
    this.applyQuality();
    this.env.set(TIME_HOURS[this.settings.options.time], this.settings.options.weather);
    this.traffic.density = this.settings.options.traffic;
    this.traffic.populate('A', this.attractS);
    this.status('完成', 1);
    this.loadingEl.classList.add('hidden');
    (window as unknown as { __game: unknown }).__game = this;
    this.toMenu();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /* ---------------- settings ---------------- */

  private applySettings(s: Partial<Settings>) {
    Object.assign(this.settings, s);
    saveSettings(this.settings);
    if (s.quality) this.applyQuality();
    if (s.volume !== undefined) this.audio.setVolume(s.volume);
  }

  private applyQuality() {
    const q = QUALITY[this.settings.quality];
    this.resize();
    this.renderer.shadowMap.enabled = q.shadows;
    this.env.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    this.env.sun.shadow.map?.dispose();
    (this.env.sun.shadow as unknown as { map: null }).map = null;
    this.env.drawDistance = q.drawDistance;
    this.camera.far = q.drawDistance * 6;
    this.camera.updateProjectionMatrix();
    if (this.city && this.cityData && q.trees) ensureTrees(this.city, this.cityData, this.decks);
    if (this.city) for (const t of this.city.treeChunks) t.visible = q.trees;
    if (q.bloom && !this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.45, 0.9);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      this.resize();
    } else if (!q.bloom && this.composer) {
      this.composer.dispose();
      this.composer = null;
      this.bloom = null;
    }
    this.env.apply();
    this.audio.setVolume(this.settings.volume);
  }

  /* ---------------- game flow ---------------- */

  private toMenu() {
    this.state = 'menu';
    this.hud.show(false);
    this.touch.show(false);
    if (this.player) {
      this.scene.remove(this.player.group);
      this.player = null;
    }
    this.clearRace();
    this.session = null;
    this.rig.mode = 'cinematic';
    this.rig.reset();
    this.audio.suspend(true);
    this.menu.showMain();
  }

  private resolveStart(o: GameOptions): { edge: Edge; s: number; d: number; v: number } {
    if (o.start.startsWith('ramp:')) {
      const en = this.net.entrances[Number(o.start.slice(5))];
      if (en) {
        let e = this.net.edges[en.edge];
        for (let k = 0; k < 6 && e.pred.length === 1 && e.pred[0].kind === 'ramp'; k++) e = e.pred[0];
        const s = Math.min(6, e.length * 0.2);
        return { edge: e, s, d: e.laneCenter(s, 0), v: 8 };
      }
    }
    const s = o.start.startsWith('main:') ? Number(o.start.slice(5)) : 40;
    const loc = this.net.atLineS(o.line, s);
    const lanes = Math.max(1, Math.round(loc.edge.lanesAt(loc.s)));
    return { edge: loc.edge, s: loc.s, d: loc.edge.laneCenter(loc.s, Math.min(1, lanes - 1)), v: 11 };
  }

  begin(o: GameOptions) {
    // started from the menu, the pause menu or a result screen ("再来一次")
    this.menu.hide();
    this.lastOptions = o;
    this.settings.options = { ...o };
    saveSettings(this.settings);
    this.audio.init();
    this.audio.suspend(false);
    this.env.set(TIME_HOURS[o.time], o.weather);
    if (this.player) this.scene.remove(this.player.group);
    this.clearRace();
    const racing = o.mode === 'race';
    const start = this.resolveStart(o);
    const paint = o.car === 'taxi' ? TAXI_COLOR : o.car === 'suv' ? 0x2a2d31 : 0xc8ccd2;
    const spec = o.car === 'suv' ? SUV : SEDAN;
    const grip = o.weather === 'rain' ? 0.72 : 1;
    this.player = new Player(this.net, racing ? raceTune(spec) : spec, o.car, paint, start.edge, start.s);
    this.player.placeAt(start.edge, start.s, start.d, start.v);
    this.player.dyn.gripScale = grip;
    this.player.lightsOn = this.env.night > 0.4 || o.weather === 'rain';
    this.scene.add(this.player.group);
    this.session = new Session(this.net, o, this.signs.cameras);
    this.traffic.density = o.traffic;
    const ls = this.net.lineS(start.edge, start.s);
    this.traffic.populate(o.line, ls ?? 0);
    if (racing) this.setupRace(o, ls ?? 0, grip);
    this.signs.vmsText = (line) => this.vmsMessage(line, o);
    this.signs.refreshVms();
    this.rig.mode = 'chase';
    this.rig.reset();
    this.hud.show(true);
    this.touch.show(this.input.usingTouch);
    this.state = 'driving';
    if (racing) this.hud.toast(`竞速模式 · ${(this.race!.distance / 1000).toFixed(1)} km · 无视交通法规`, 'warn', 3000);
    else this.hud.toast(`内环路 ${o.line}线 · ${o.line === 'A' ? '逆时针' : '顺时针'} · 限速 60`, 'info', 3000);
  }

  /** Starting grid with the AI rivals, start / finish lines, a clear road ahead of the grid. */
  private setupRace(o: GameOptions, startS: number, grip: number) {
    const lights = this.player!.lightsOn;
    this.race = new Race(this.net, { line: o.line, startS, length: o.raceLength, rivals: o.raceRivals, level: o.raceLevel, gripScale: grip }, this.player!, (kind, color, edge, s, name) => {
      const spec = raceTune(kind === 'suv' || kind === 'mpv' ? SUV : SEDAN);
      const car = new Player(this.net, spec, kind, color, edge, s, { headlight: false, interior: false });
      car.dyn.gripScale = grip;
      car.lightsOn = lights;
      car.group.add(nameTag(name, color));
      this.scene.add(car.group);
      this.raceObjects.push(car.group);
      return car;
    });
    this.traffic.clearLine(o.line, startS - 160, startS + 260);
    const marks = [chequeredLine(this.net, o.line, startS)];
    if (Math.abs(this.race.distance - this.race.L) > 1) marks.push(chequeredLine(this.net, o.line, this.race.finishS));
    for (const m of marks) {
      this.scene.add(m);
      this.raceObjects.push(m);
    }
  }

  private clearRace() {
    for (const o of this.raceObjects) {
      this.scene.remove(o);
      o.traverse((c) => {
        if (c instanceof THREE.Mesh) c.geometry.dispose();
        const mat = (c as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          m.dispose();
        }
      });
    }
    this.raceObjects = [];
    this.race = null;
    this.raceEnding = false;
  }

  /** Results of a race (the player finished, or left the ring). */
  private endRace(dnf: string | null) {
    const race = this.race;
    if (!race || !this.session || this.state === 'ended') return;
    this.state = 'ended';
    this.audio.suspend(true);
    const rank = race.rankOf(race.player);
    const title = dnf ?? `${rank === 1 ? '冠军！' : `第 ${rank} 名`} · ${fmtRaceTime(race.player.finish ?? race.clock)}`;
    const rows: [string, string][] = [...race.results(), ['最高速度', `${this.session.maxSpeed.toFixed(0)} km/h`], ['碰撞护栏 / 车辆', `${this.session.barrierHits} / ${this.session.carHits}`]];
    this.menu.showResult(title, rows, {
      again: () => this.lastOptions && this.begin(this.lastOptions),
      menu: () => this.toMenu(),
    });
  }

  private vmsMessage(line: LineId | null, o: GameOptions): string[] {
    const l = line ?? o.line;
    if (o.weather === 'rain') return [`内环路${l}线 雨天路滑`, '减速慢行 保持车距'];
    if (o.traffic === 'rush') return [`内环路${l}线 车多缓行`, '请勿随意变道'];
    return [`内环路${l}线 道路畅通`, '限速60 安全驾驶'];
  }

  private pause() {
    if (this.state !== 'driving') return;
    this.state = 'paused';
    this.audio.suspend(true);
    this.menu.showPause({
      resume: () => {
        this.menu.hide();
        this.audio.suspend(false);
        this.state = 'driving';
      },
      restart: () => {
        this.menu.hide();
        if (this.lastOptions) this.begin(this.lastOptions);
      },
      menu: () => this.toMenu(),
    });
  }

  private endSession(title: string, reason: string, exitEdge?: Edge | null) {
    if (!this.session) return;
    this.state = 'ended';
    this.audio.suspend(true);
    const rows = this.session.summary();
    const extra: { label: string; fn: () => void }[] = [];
    if (reason !== 'lap' && this.player) {
      for (const line of ['A', 'B'] as LineId[]) {
        extra.push({ label: `就近上内环路 ${line}线 继续`, fn: () => this.rejoin(line) });
      }
    }
    void exitEdge;
    this.menu.showResult(title, rows, {
      again: () => this.lastOptions && this.begin(this.lastOptions),
      menu: () => this.toMenu(),
      extra,
    });
  }

  /** Switch lines: start from the entrance ramp nearest to the current position. */
  private rejoin(line: LineId) {
    if (!this.player || !this.lastOptions) return;
    const p = this.player.group.position;
    let best = -1;
    let bd = Infinity;
    this.net.entrances.forEach((en, i) => {
      if (en.line !== line) return;
      let e = this.net.edges[en.edge];
      for (let k = 0; k < 6 && e.pred.length === 1 && e.pred[0].kind === 'ramp'; k++) e = e.pred[0];
      const d = (e.x[0] - p.x) ** 2 + (e.z[0] - p.z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const o = { ...this.lastOptions, line, start: best >= 0 ? `ramp:${best}` : 'main:40', mode: this.lastOptions.mode === 'lap' ? ('free' as const) : this.lastOptions.mode };
    this.menu.hide();
    this.begin(o);
  }

  /** Debug helper for automated checks: coarse grid of average screen colours (hex), top row first. */
  debugPixels(cols = 8, rows = 6): string[] {
    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
      const row: string[] = [];
      for (let c = 0; c < cols; c++) {
        let R = 0;
        let G = 0;
        let B = 0;
        let n = 0;
        const x0 = Math.floor((c * w) / cols);
        const x1 = Math.floor(((c + 1) * w) / cols);
        const y0 = h - Math.floor(((r + 1) * h) / rows);
        const y1 = h - Math.floor((r * h) / rows);
        for (let y = y0; y < y1; y += 4)
          for (let x = x0; x < x1; x += 4) {
            const k = (y * w + x) * 4;
            R += buf[k];
            G += buf[k + 1];
            B += buf[k + 2];
            n++;
          }
        const hx = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
        row.push(hx(R) + hx(G) + hx(B));
      }
      out.push(row.join(' '));
    }
    return out;
  }

  /** Debug: fraction of screen pixels that change when an object is hidden, and their bounding box (0..1). */
  debugCoverage(obj: THREE.Object3D) {
    const read = () => {
      this.renderer.render(this.scene, this.camera);
      const gl = this.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return { buf, w, h };
    };
    const a = read();
    const vis = obj.visible;
    obj.visible = false;
    const b = read();
    obj.visible = vis;
    let n = 0;
    let x0 = 1;
    let x1 = 0;
    let y0 = 1;
    let y1 = 0;
    for (let y = 0; y < a.h; y += 2)
      for (let x = 0; x < a.w; x += 2) {
        const k = (y * a.w + x) * 4;
        if (Math.abs(a.buf[k] - b.buf[k]) + Math.abs(a.buf[k + 1] - b.buf[k + 1]) + Math.abs(a.buf[k + 2] - b.buf[k + 2]) > 24) {
          n++;
          x0 = Math.min(x0, x / a.w);
          x1 = Math.max(x1, x / a.w);
          y0 = Math.min(y0, 1 - y / a.h);
          y1 = Math.max(y1, 1 - y / a.h);
        }
      }
    return { fraction: n / ((a.w / 2) * (a.h / 2)), box: [x0, y0, x1, y1].map((v) => v.toFixed(2)) };
  }

  /* ---------------- loop ---------------- */

  private tick() {
    const now = performance.now();
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = Math.min(dt, 0.1);
    this.fpsAvg = this.fpsAvg * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.input.update(dt);
    if (this.state === 'driving' && this.player && this.session) this.drive(dt);
    else if (this.state === 'menu') this.attract(dt);
    else if (this.state === 'paused' || this.state === 'ended') {
      if (this.input.consume('pause') && this.state === 'paused') {
        this.menu.hide();
        this.audio.suspend(false);
        this.state = 'driving';
      }
    }
    // world updates
    const focus = this.player && this.state !== 'menu' ? this.player.group.position : this.camera.position;
    this.env.update(dt, focus);
    this.landmarks?.update(dt);
    this.signs.update(focus);
    this.signs.setNight(this.env.night);
    const lamp = this.roads.lampHeads.material as THREE.MeshStandardMaterial;
    lamp.emissiveIntensity = this.env.night * 4;
    this.cullTimer -= dt;
    if (this.cullTimer <= 0) {
      this.cullTimer = 0.3;
      this.cull();
    }
    if (this.bloom) this.bloom.strength = 0.15 + this.env.night * 0.55;
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  private attract(dt: number) {
    // cinematic camera flying along the ring behind the menu
    this.attractS += dt * 16;
    const loc = this.net.atLineS(this.attractLine, this.attractS);
    const f = loc.edge.frame(loc.s, 0, this.f);
    const ahead = this.net.atLineS(this.attractLine, this.attractS + 60);
    const fa = ahead.edge.frame(ahead.s, 0, newFrame());
    const y = loc.edge.yAt(loc.s);
    const t = performance.now() / 1000;
    this.camera.position.set(f.x + f.nx * (14 + Math.sin(t * 0.1) * 6), y + 9 + Math.sin(t * 0.07) * 4, f.z + f.nz * (14 + Math.sin(t * 0.1) * 6));
    this.camera.lookAt(fa.x, ahead.edge.yAt(ahead.s) + 2, fa.z);
    this.traffic.update(dt, null, this.camera.position);
    this.traffic.render(this.env.night);
  }

  private drive(dt: number) {
    const player = this.player!;
    const session = this.session!;
    const input = this.input;
    if (input.consume('pause')) {
      this.pause();
      return;
    }
    if (input.consume('camera')) {
      this.rig.next();
      this.hud.toast(CAMERA_NAMES[this.rig.mode], 'info', 1200);
    }
    if (input.consume('lights')) player.lightsOn = !player.lightsOn;
    if (input.consume('map')) this.minimap.toggle();
    if (input.consume('signalLeft')) session.toggleSignal(-1);
    if (input.consume('signalRight')) session.toggleSignal(1);
    if (input.consume('hazard')) {
      player.hazard = !player.hazard;
      this.hud.toast(player.hazard ? '危险报警闪光灯（双闪）开启' : '双闪关闭', 'info', 1200);
    }
    if (input.consume('hud')) this.hud.el.classList.toggle('hidden');
    if (input.consume('reset')) this.resetToLane();

    if (this.autopilot) this.autopilotControls();
    const race = this.race;
    // on the grid the cars are held until the start
    const controls = race && race.state === 'countdown' ? this.gridHold : input.controls;
    race?.plan(dt, this.traffic.cars);
    // physics
    this.acc += dt;
    let steps = 0;
    let impact = 0;
    while (this.acc >= FIXED_DT && steps < 12) {
      const info = player.step(FIXED_DT, controls);
      race?.stepCars(FIXED_DT);
      impact = Math.max(impact, info.impact);
      this.acc -= FIXED_DT;
      steps++;
    }
    const t = player.tracker;
    // traffic + vehicle collisions
    const heading = player.dyn.psi;
    const rivals = race ? race.rivals.map((r) => r.car) : [];
    this.traffic.update(dt, proxyOf(player), player.group.position, rivals.map(proxyOf));
    let carImpact = 0;
    for (const c of resolveContacts([player, ...rivals], this.traffic.cars)) if (c.a === player || c.b === player) carImpact = Math.max(carImpact, c.impact);
    this.carHitCooldown -= dt;
    if (carImpact > 1.2 && this.carHitCooldown <= 0) {
      this.carHitCooldown = 2;
      session.carHits++;
      if (session.rules) this.hud.toast('与其他车辆发生碰撞', 'bad');
    }
    if (impact > 1.5 || carImpact > 1.5) {
      this.audio.crash(Math.max(impact, carImpact));
      this.rig.shake = Math.min(0.6, Math.max(impact, carImpact) * 0.05);
      player.kick(Math.max(impact, carImpact) * 0.15);
    }
    // expansion joints on viaducts
    const e = t.edge;
    if (e.struct[e.idx(t.s)] > 0) {
      const k = Math.floor((t.s - JOINT_SPACING / 2) / JOINT_SPACING);
      if (this.lastJoint.edge === e.id && k !== this.lastJoint.k && Math.abs(player.dyn.vx) > 3) {
        this.audio.joint(player.dyn.vx);
        player.kick(0.25 + Math.abs(player.dyn.vx) * 0.012);
      }
      this.lastJoint = { edge: e.id, k };
    } else this.lastJoint = { edge: e.id, k: -9 };

    player.signal = session.signal;
    player.interior.visible = this.rig.mode === 'cockpit';
    player.updateInterior();
    player.syncVisual(dt);
    player.group.updateMatrixWorld(true);
    for (const r of rivals) r.syncVisual(dt);
    this.rig.update(dt, player.group, player.body, player.dyn.vx, input.lookBack);
    this.traffic.render(this.env.night);

    // rules & session
    const events = session.update(dt, {
      edge: t.edge,
      s: t.s,
      d: t.d,
      speed: player.dyn.vx,
      gear: player.dyn.gear,
      impact,
      terminal: t.terminal,
    });
    for (const ev of events) {
      if (ev.type === 'toast') this.hud.toast(ev.text!, ev.kind);
      else if (ev.type === 'flash') {
        this.hud.flash();
        this.audio.shutter();
      } else if (ev.type === 'chime') this.audio.chime();
      else if (ev.type === 'end') {
        // in a race, reaching the end of an exit ramp means leaving the race
        if (race) setTimeout(() => this.race === race && this.endRace('已驶离赛道 · 未完赛'), 900);
        else setTimeout(() => this.session === session && this.endSession(ev.end!.title, ev.end!.reason), 900);
      }
    }
    if (race) this.raceEvents(dt, race);
    // HUD
    const nx = race ? null : session.nextExit(t.edge, t.s);
    this.hud.update(
      {
        speedKmh: player.speedKmh,
        rpm: player.dyn.rpm,
        gear: player.dyn.gear,
        limit: race ? null : t.edge.speedAt(t.s),
        line: t.edge.kind === 'main' ? t.edge.line : null,
        onRamp: t.edge.kind === 'ramp',
        section: this.net.nameAt(t.edge, t.s),
        nextExit: nx ? { code: nx.x.code, name: nx.x.names[0], dist: nx.dist, side: nx.x.side } : null,
        guidance: race ? null : session.guidance(t.edge, t.s, t.d),
        stats: session.stats(),
        signal: session.signal,
        hazard: player.hazard,
        fps: this.fpsAvg,
        lightsOn: player.lightsOn,
        camName: CAMERA_NAMES[this.rig.mode],
        race: race ? this.raceHud(race) : null,
      },
      dt,
    );
    const dest = session.destination ? this.net.edges[session.destination.edge] : null;
    const others = race ? race.rivals.map((r) => ({ x: r.car.dyn.x, z: r.car.dyn.z, color: r.color })) : [];
    this.minimap.draw(player.dyn.x, player.dyn.z, heading, t.edge.line ?? session.line, dest ? { x: dest.x[0], z: dest.z[0] } : null, others);
    this.audio.update(dt, {
      rpm: player.dyn.rpm,
      throttle: player.dyn.throttleOut,
      speed: player.dyn.vx,
      slip: player.dyn.slip,
      scraping: player.lastCollision.scraping,
      horn: input.horn,
      rain: this.env.weather === 'rain',
      signal: session.signal !== 0 || player.hazard,
    });
  }

  /** Race clock, standings and messages; the result screen once the player has crossed the line. */
  private raceEvents(dt: number, race: Race) {
    for (const ev of race.update(dt)) {
      if (ev.type === 'go') {
        this.audio.chime();
        this.hud.toast('出发！', 'info', 1200);
      } else if (ev.type === 'overtake' && ev.name) this.hud.toast(`超越 ${ev.name} · 第 ${ev.rank} 名`, 'info', 1500);
      else if (ev.type === 'overtaken' && ev.name) this.hud.toast(`被 ${ev.name} 超越 · 第 ${ev.rank} 名`, 'warn', 1500);
      else if (ev.type === 'finish') {
        this.audio.chime();
        this.hud.toast(`冲线！第 ${ev.rank} 名`, 'info', 2500);
      }
    }
    if (race.state === 'done' && !this.raceEnding) {
      this.raceEnding = true;
      setTimeout(() => this.race === race && this.endRace(null), 2500);
    }
  }

  private raceHud(race: Race): RaceHudState {
    const me = race.player;
    const t = me.car.tracker;
    let warning: string | null = null;
    if (t.edge.kind !== 'main' || t.edge.line !== race.setup.line) warning = '已驶离赛道 · 按 R 返回';
    else if (race.state === 'racing' && me.car.dyn.vx > 3 && Math.cos(me.car.dyn.psi - t.roadHeading()) < -0.3) warning = '逆行！';
    return {
      rank: race.rankOf(me),
      total: race.entrants.length,
      clock: me.finish ?? race.clock,
      remaining: race.remaining,
      distance: race.distance,
      board: race.standings().map((en) => ({ name: en.name, gap: en.progress - me.progress, me: en === me, color: en.color, finished: en.finish !== null })),
      warning,
    };
  }

  /** Debug/demo autopilot (window.__game.autopilot = true): pure pursuit along the current lane. */
  autopilot = false;
  autopilotLane = 1;
  private autopilotControls() {
    const p = this.player!;
    const d = p.dyn;
    const t = p.tracker;
    const ld = 7 + Math.max(0, d.vx) * 0.7;
    let e: Edge | null = t.edge;
    let s = t.s + ld;
    while (e && s > e.length) {
      s -= e.length;
      e = e.succ.find((n) => n.kind === e!.kind && (n.line === e!.line || e!.kind === 'ramp')) ?? e.succ[0] ?? null;
    }
    if (!e) return;
    const lanes = Math.max(1, Math.round(e.lanesAt(s)));
    const fr = e.frame(s, e.laneCenter(s, Math.min(this.autopilotLane, lanes - 1)), newFrame());
    const ang = Math.atan2(fr.z - d.z, fr.x - d.x) - d.psi;
    const alpha = Math.atan2(Math.sin(ang), Math.cos(ang));
    const L = d.spec.a + d.spec.b;
    const delta = Math.atan2(2 * L * Math.sin(alpha), ld);
    const steerLimit = d.spec.maxSteer * (1 - 0.84 * Math.min(1, Math.max(0, (Math.abs(d.vx) - 2) / 30)));
    let target = Math.min(60, t.edge.speedAt(Math.min(t.edge.length, t.s + 40)) + 2) / 3.6;
    const fx = Math.cos(d.psi);
    const fz = Math.sin(d.psi);
    for (const car of this.traffic.cars) {
      const dx = car.x - d.x;
      const dz = car.z - d.z;
      const fwd = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx;
      if (fwd > 0 && fwd < 70 && Math.abs(lat) < 2 && Math.abs(car.y - p.y) < 3) target = Math.min(target, Math.max(0, car.v + (fwd - 12) * 0.35));
    }
    const err = target - d.vx;
    const c = this.input.controls;
    c.throttle = clamp(err * 0.6, 0, 1);
    c.brake = clamp(-err * 0.5, 0, 1);
    c.steer = clamp(delta / steerLimit, -1, 1);
  }

  private resetToLane() {
    const p = this.player!;
    const t = p.tracker;
    const e = t.edge;
    const race = this.race;
    if (race && (e.kind !== 'main' || e.line !== race.setup.line || Math.cos(p.dyn.psi - t.roadHeading()) < 0)) {
      // back onto the race line where the player had got to, facing the right way
      race.respawn(race.player);
      this.rig.reset();
      return;
    }
    const lanes = Math.max(1, Math.round(e.lanesAt(t.s)));
    const k = clamp(e.laneIndex(t.s, t.d), 0, lanes - 1);
    p.placeAt(e, t.s, e.laneCenter(t.s, k), 0);
    this.rig.reset();
  }

  private cull() {
    const cam = this.camera.position;
    const q = QUALITY[this.settings.quality];
    const far = q.drawDistance + 350;
    const visit = (o: THREE.Object3D, dist: number) => {
      const c = o.userData.center as THREE.Vector3 | undefined;
      if (!c) return;
      const dx = c.x - cam.x;
      const dz = c.z - cam.z;
      o.visible = dx * dx + dz * dz < dist * dist;
    };
    for (const ch of this.roads.group.children) visit(ch, far);
    if (this.city) {
      for (const ch of this.city.chunks) visit(ch, far);
      if (q.trees) for (const t of this.city.treeChunks) visit(t, 900);
    }
    envUniforms.uTime.value += 0;
  }
}

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r(null)));
}

/** How the traffic sees a car driven by the full dynamics. */
function proxyOf(p: Player): PlayerProxy {
  const t = p.tracker;
  return { edge: t.edge, s: t.s, d: t.d, v: Math.max(0, p.dyn.vx), len: p.halfLength * 2, width: p.halfWidth * 2, x: p.dyn.x, z: p.dyn.z, heading: p.dyn.psi };
}


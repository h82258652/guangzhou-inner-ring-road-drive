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
import { Environment } from './world/Environment';
import { envUniforms, roadMaterials, setAnisotropy } from './world/Materials';
import { buildCity, type CityVisuals } from './world/City';
import { buildLandmarks, type LandmarkVisuals } from './world/Landmarks';
import { Signs } from './world/Signs';
import { Player } from './vehicle/Player';
import { SEDAN, SUV } from './vehicle/Dynamics';
import { obbOverlap } from './vehicle/Collision';
import { TAXI_COLOR } from './vehicle/CarModel';
import { Traffic, type PlayerProxy } from './traffic/Traffic';
import { Hud } from './ui/Hud';
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
    this.cityData = cityData;
    this.status('生成高架、匝道与标线…', 0.45);
    await frame();
    this.env = new Environment(this.scene, this.renderer);
    roadMaterials();
    this.roads = buildRoads(this.net);
    this.scene.add(this.roads.group);
    if (cityData) {
      this.status('生成城市建筑与珠江…', 0.62);
      await frame();
      const q = QUALITY[this.settings.quality];
      this.city = buildCity(cityData, { trees: q.trees, infill: true });
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
    this.signs = new Signs(this.net);
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
    this.lastOptions = o;
    this.settings.options = { ...o };
    saveSettings(this.settings);
    this.audio.init();
    this.audio.suspend(false);
    this.env.set(TIME_HOURS[o.time], o.weather);
    if (this.player) this.scene.remove(this.player.group);
    const start = this.resolveStart(o);
    const paint = o.car === 'taxi' ? TAXI_COLOR : o.car === 'suv' ? 0x2a2d31 : 0xc8ccd2;
    this.player = new Player(this.net, o.car === 'suv' ? SUV : SEDAN, o.car, paint, start.edge, start.s);
    this.player.placeAt(start.edge, start.s, start.d, start.v);
    this.player.dyn.gripScale = o.weather === 'rain' ? 0.72 : 1;
    this.player.lightsOn = this.env.night > 0.4 || o.weather === 'rain';
    this.scene.add(this.player.group);
    this.session = new Session(this.net, o);
    this.traffic.density = o.traffic;
    const ls = this.net.lineS(start.edge, start.s);
    this.traffic.populate(o.line, ls ?? 0);
    this.signs.vmsText = (line) => this.vmsMessage(line, o);
    this.signs.refreshVms();
    this.rig.mode = 'chase';
    this.rig.reset();
    this.hud.show(true);
    this.touch.show(this.input.usingTouch);
    this.state = 'driving';
    this.hud.toast(`内环路 ${o.line}线 · ${o.line === 'A' ? '逆时针' : '顺时针'} · 限速 60`, 'info', 3000);
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
    if (input.consume('hud')) this.hud.el.classList.toggle('hidden');
    if (input.consume('reset')) this.resetToLane();

    if (this.autopilot) this.autopilotControls();
    // physics
    this.acc += dt;
    let steps = 0;
    let impact = 0;
    while (this.acc >= FIXED_DT && steps < 12) {
      const info = player.step(FIXED_DT, input.controls);
      impact = Math.max(impact, info.impact);
      this.acc -= FIXED_DT;
      steps++;
    }
    const t = player.tracker;
    // traffic + vehicle collisions
    const heading = player.dyn.psi;
    const proxy: PlayerProxy = {
      edge: t.edge,
      s: t.s,
      d: t.d,
      v: Math.max(0, player.dyn.vx),
      len: player.halfLength * 2,
      width: player.halfWidth * 2,
      x: player.dyn.x,
      z: player.dyn.z,
      heading,
    };
    this.traffic.update(dt, proxy, player.group.position);
    const carImpact = this.carCollisions();
    this.carHitCooldown -= dt;
    if (carImpact > 0 && this.carHitCooldown <= 0) {
      this.carHitCooldown = 2;
      session.carHits++;
      this.hud.toast('与其他车辆发生碰撞', 'bad');
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
        setTimeout(() => this.endSession(ev.end!.title, ev.end!.reason), 900);
      }
    }
    // HUD
    const limit = t.edge.speedAt(t.s);
    const nx = session.nextExit(t.edge, t.s);
    this.hud.update(
      {
        speedKmh: player.speedKmh,
        rpm: player.dyn.rpm,
        gear: player.dyn.gear,
        limit,
        line: t.edge.kind === 'main' ? t.edge.line : null,
        onRamp: t.edge.kind === 'ramp',
        section: this.net.nameAt(t.edge, t.s),
        nextExit: nx ? { code: nx.x.code, name: nx.x.names[0], dist: nx.dist, side: nx.x.side } : null,
        guidance: session.guidance(t.edge, t.s, t.d),
        stats: session.stats(),
        signal: session.signal,
        fps: this.fpsAvg,
        lightsOn: player.lightsOn,
        camName: CAMERA_NAMES[this.rig.mode],
      },
      dt,
    );
    const dest = session.destination ? this.net.edges[session.destination.edge] : null;
    this.minimap.draw(player.dyn.x, player.dyn.z, heading, t.edge.line ?? session.line, dest ? { x: dest.x[0], z: dest.z[0] } : null);
    this.audio.update(dt, {
      rpm: player.dyn.rpm,
      throttle: player.dyn.throttleOut,
      speed: player.dyn.vx,
      slip: player.dyn.slip,
      scraping: player.lastCollision.scraping,
      horn: input.horn,
      rain: this.env.weather === 'rain',
      signal: session.signal !== 0,
    });
  }

  private carCollisions(): number {
    const player = this.player!;
    const dyn = player.dyn;
    const pBox = { x: dyn.x, z: dyn.z, heading: dyn.psi, halfLength: player.halfLength - 0.1, halfWidth: player.halfWidth - 0.05 };
    let worst = 0;
    for (const car of this.traffic.cars) {
      const dx = car.x - dyn.x;
      const dz = car.z - dyn.z;
      if (dx * dx + dz * dz > 200) continue;
      if (Math.abs(car.y - player.y) > 3) continue;
      const ov = obbOverlap(pBox, { x: car.x, z: car.z, heading: car.heading, halfLength: car.len / 2 - 0.1, halfWidth: car.width / 2 - 0.05 });
      if (!ov) continue;
      // separate (player takes most of the correction)
      dyn.x += ov.nx * ov.depth;
      dyn.z += ov.nz * ov.depth;
      const [vx, vz] = dyn.worldVelocity();
      const cvx = Math.cos(car.heading) * car.v;
      const cvz = Math.sin(car.heading) * car.v;
      const rel = (vx - cvx) * ov.nx + (vz - cvz) * ov.nz;
      if (rel < 0) {
        const mP = player.dyn.spec.mass;
        const mC = 1500;
        const j = (-(1 + 0.25) * rel) / (1 / mP + 1 / mC);
        dyn.setWorldVelocity(vx + (j / mP) * ov.nx, vz + (j / mP) * ov.nz);
        const along = Math.cos(car.heading) * ov.nx + Math.sin(car.heading) * ov.nz;
        car.v = Math.max(0, car.v - (j / mC) * along);
        car.bumped = 2.5;
        if (car.bumped > 0 && Math.abs(rel) > 1.2 && worst === 0) worst = Math.abs(rel);
      }
    }
    return worst;
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


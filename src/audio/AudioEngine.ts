/** Synthesised vehicle and environment audio with the Web Audio API (no samples). */
import { clamp } from '../shared/math';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engOsc: OscillatorNode[] = [];
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private tyreGain!: GainNode;
  private scrapeGain!: GainNode;
  private hornGain!: GainNode;
  private rainGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  volume = 0.7;
  private signalTimer = 0;

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.98 * b + 0.02 * w; // brownish
      d[i] = w * 0.6 + b * 2.5;
    }
    const noise = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start();
      return s;
    };

    // engine
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 2;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    for (const [type, mul, gain] of [
      ['sawtooth', 1, 0.5],
      ['square', 0.5, 0.35],
      ['triangle', 2, 0.25],
    ] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 40 * mul;
      (o as OscillatorNode & { mul?: number }).mul = mul;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(shaper);
      o.start();
      this.engOsc.push(o);
    }
    shaper.connect(this.engFilter).connect(this.engGain).connect(this.master);

    // wind + road noise
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 400;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise().connect(this.windFilter).connect(this.windGain).connect(this.master);

    // tyre squeal
    const tf = ctx.createBiquadFilter();
    tf.type = 'bandpass';
    tf.frequency.value = 1150;
    tf.Q.value = 6;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    noise().connect(tf).connect(this.tyreGain).connect(this.master);

    // barrier scrape
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 2600;
    sf.Q.value = 1.5;
    this.scrapeGain = ctx.createGain();
    this.scrapeGain.gain.value = 0;
    noise().connect(sf).connect(this.scrapeGain).connect(this.master);

    // horn (two-tone)
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    for (const f of [415, 498]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const hf = ctx.createBiquadFilter();
      hf.type = 'lowpass';
      hf.frequency.value = 2200;
      o.connect(hf).connect(this.hornGain);
      o.start();
    }
    this.hornGain.connect(this.master);

    // rain
    const rf = ctx.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 900;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    noise().connect(rf).connect(this.rainGain).connect(this.master);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  suspend(on: boolean) {
    if (!this.ctx) return;
    if (on) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  update(dt: number, p: { rpm: number; throttle: number; speed: number; slip: number; scraping: boolean; horn: boolean; rain: boolean; signal: boolean }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const f0 = (p.rpm / 60) * 2; // 4-cylinder firing frequency
    for (const o of this.engOsc) o.frequency.setTargetAtTime(f0 * ((o as OscillatorNode & { mul?: number }).mul ?? 1), t, 0.03);
    this.engFilter.frequency.setTargetAtTime(300 + p.throttle * 2200 + p.rpm * 0.12, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.06 + p.throttle * 0.1 + (p.rpm / 7000) * 0.05, t, 0.08);
    const v = Math.abs(p.speed);
    this.windFilter.frequency.setTargetAtTime(250 + v * 35, t, 0.2);
    this.windGain.gain.setTargetAtTime(clamp((v / 30) ** 2 * 0.22, 0, 0.35), t, 0.2);
    this.tyreGain.gain.setTargetAtTime(clamp(p.slip, 0, 1) * 0.22, t, 0.05);
    this.scrapeGain.gain.setTargetAtTime(p.scraping && v > 2 ? clamp(v / 20, 0.1, 0.5) : 0, t, 0.04);
    this.hornGain.gain.setTargetAtTime(p.horn ? 0.12 : 0, t, 0.02);
    this.rainGain.gain.setTargetAtTime(p.rain ? 0.12 : 0, t, 0.5);
    if (p.signal) {
      this.signalTimer -= dt;
      if (this.signalTimer <= 0) {
        this.signalTimer = 0.38;
        this.click(1800, 0.03, 0.08);
      }
    }
  }

  private click(freq: number, dur: number, gain: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  /** Expansion joint "ka-dunk" on viaducts. */
  joint(speed: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = clamp(Math.abs(speed) / 25, 0.15, 1);
    for (const [delay, f] of [
      [0, 75],
      [Math.min(0.12, 2.7 / Math.max(Math.abs(speed), 3)), 65],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, ctx.currentTime + delay);
      o.frequency.exponentialRampToValueAtTime(35, ctx.currentTime + delay + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.setValueAtTime(0.35 * v, ctx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.16);
      o.connect(g).connect(this.master);
      o.start(ctx.currentTime + delay);
      o.stop(ctx.currentTime + delay + 0.2);
    }
  }

  crash(impact: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900 + impact * 200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(clamp(impact / 8, 0.15, 1), ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    s.connect(f).connect(g).connect(this.master);
    s.start();
    s.stop(ctx.currentTime + 0.5);
  }

  shutter() {
    this.click(2600, 0.05, 0.12);
    setTimeout(() => this.click(2000, 0.04, 0.1), 70);
  }

  chime() {
    const ctx = this.ctx;
    if (!ctx) return;
    [880, 1320].forEach((f, k) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      const t0 = ctx.currentTime + k * 0.18;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.setValueAtTime(0.12, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
      o.connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + 0.65);
    });
  }
}

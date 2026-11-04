/** Minimal PNG encoder/decoder (8-bit RGB/RGBA, non-interlaced) for debug images and DEM tiles. */
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePNG(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

export function decodePNG(buf: Buffer): { w: number; h: number; channels: number; data: Uint8Array } {
  let off = 8;
  let w = 0;
  let h = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('only 8-bit PNG supported');
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels) throw new Error('unsupported PNG color type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * channels);
  const bpp = channels;
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      switch (ft) {
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      out[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

/** Simple RGB canvas for debug drawing in world coordinates. */
export class DebugCanvas {
  readonly rgb: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    readonly x0: number,
    readonly z0: number,
    readonly x1: number,
    readonly z1: number,
  ) {
    this.rgb = new Uint8Array(w * h * 3).fill(255);
  }
  px(x: number, z: number): [number, number] {
    return [Math.round(((x - this.x0) / (this.x1 - this.x0)) * (this.w - 1)), Math.round(((z - this.z0) / (this.z1 - this.z0)) * (this.h - 1))];
  }
  set(i: number, j: number, c: [number, number, number]) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return;
    const k = (j * this.w + i) * 3;
    this.rgb[k] = c[0];
    this.rgb[k + 1] = c[1];
    this.rgb[k + 2] = c[2];
  }
  line(ax: number, az: number, bx: number, bz: number, c: [number, number, number], th = 1) {
    const [x0, y0] = this.px(ax, az);
    const [x1, y1] = this.px(bx, bz);
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= n; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / n);
      const y = Math.round(y0 + ((y1 - y0) * s) / n);
      for (let dx = -th + 1; dx < th; dx++) for (let dy = -th + 1; dy < th; dy++) this.set(x + dx, y + dy, c);
    }
  }
  dot(x: number, z: number, c: [number, number, number], r = 3) {
    const [i, j] = this.px(x, z);
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) this.set(i + dx, j + dy, c);
  }
  png() {
    return encodePNG(this.w, this.h, this.rgb);
  }
}

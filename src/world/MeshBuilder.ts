import * as THREE from 'three';

/** Accumulates triangles (positions, normals, uvs, colors, extra attribute) and produces a BufferGeometry. */
export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  extra: number[] = [];
  idx: number[] = [];
  useColor = false;
  useExtra = false;

  get vertexCount() {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c?: THREE.Color, e?: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    if (c) {
      this.useColor = true;
      this.col.push(c.r, c.g, c.b);
    } else this.col.push(1, 1, 1);
    if (e !== undefined) {
      this.useExtra = true;
      this.extra.push(e);
    } else this.extra.push(0);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    // a-b-c-d counter-clockwise when seen from the front
    this.idx.push(a, b, c, a, c, d);
  }

  build(extraName = 'aExtra'): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.useColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.useExtra) g.setAttribute(extraName, new THREE.Float32BufferAttribute(this.extra, 1));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Groups geometry builders by spatial chunk and material key. */
export class ChunkedBuilder {
  readonly chunks = new Map<string, Map<string, MeshBuilder>>();
  constructor(readonly size = 500) {}
  get(x: number, z: number, mat: string): MeshBuilder {
    const key = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
    let m = this.chunks.get(key);
    if (!m) this.chunks.set(key, (m = new Map()));
    let b = m.get(mat);
    if (!b) m.set(mat, (b = new MeshBuilder()));
    return b;
  }
  /** Creates meshes in a group; materials looked up by key. */
  toGroup(materials: Record<string, THREE.Material>, extraName = 'aExtra', opts: { shadows?: Record<string, boolean> } = {}): THREE.Group {
    const group = new THREE.Group();
    for (const [key, mats] of this.chunks) {
      const chunk = new THREE.Group();
      chunk.name = 'chunk:' + key;
      for (const [mat, b] of mats) {
        const g = b.build(extraName);
        if (!g) continue;
        const mesh = new THREE.Mesh(g, materials[mat]);
        mesh.name = mat;
        const sh = opts.shadows?.[mat] ?? false;
        mesh.castShadow = sh;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        chunk.add(mesh);
      }
      const [cx, cz] = key.split(',').map(Number);
      chunk.userData.center = new THREE.Vector3((cx + 0.5) * this.size, 0, (cz + 0.5) * this.size);
      group.add(chunk);
    }
    return group;
  }
}

/** Data schema shared between the build pipeline (scripts/) and the game (src/). */
import type { LatLon } from './geo';

export type LineId = 'A' | 'B';

/** Run-length encoded per-sample attribute: [startSampleIndex, value] pairs, sorted. */
export type Rle<T> = [number, T][];

export const STRUCT_GROUND = 0;
export const STRUCT_VIADUCT = 1;
export const STRUCT_WATER_BRIDGE = 2;

export interface LineInfo {
  id: LineId;
  name: string;
  direction: 'ccw' | 'cw';
  length: number;
  /** main edges in driving order starting at s = 0 (Guangzhou Railway Station) */
  edges: number[];
}

export interface EdgeFile {
  id: number;
  kind: 'main' | 'ramp';
  line: LineId | null;
  from: number;
  to: number;
  /** arc length along the line at the start of this edge (main edges only) */
  lineS0: number | null;
  /** sample spacing in metres */
  ds: number;
  length: number;
  laneWidth: number;
  /** centreline samples */
  x: number[];
  y: number[];
  z: number[];
  /** fractional lane count per sample */
  lanes: number[];
  /** drivable bounds relative to the centreline (left negative, right positive) */
  bl: number[];
  br: number[];
  /** neighbour edge across the left/right bound (-1 = barrier) */
  ol: Rle<number>;
  or: Rle<number>;
  /** structure type per sample */
  struct: Rle<number>;
  /** noise barrier on the right / left side */
  noiseR: Rle<number>;
  noiseL: Rle<number>;
  /** speed limit km/h */
  speed: Rle<number>;
  /** road section name shown on the HUD */
  names: Rle<string>;
  /** OSM way ids that this edge was built from (for debugging) */
  ways: number[];
}

export interface NodeFile {
  id: number;
  x: number;
  y: number;
  z: number;
  in: number[];
  out: number[];
  /** terminal: ramp ends at a surface street / radial road */
  terminal?: { kind: 'exit' | 'entrance'; name: string };
}

export interface ExitFile {
  line: LineId;
  code: string;
  /** arc length along the line where the exit ramp diverges */
  s: number;
  side: 'left' | 'right';
  edge: number;
  /** sign text: main destinations (Chinese) */
  names: string[];
  /** English / pinyin names */
  namesEn: string[];
  /** terminal node ids reachable via this exit */
  terminals: number[];
}

export interface EntranceFile {
  line: LineId;
  /** arc length along the line where the entrance ramp merges */
  s: number;
  side: 'left' | 'right';
  /** ramp edge that merges into the line */
  edge: number;
  /** source terminal node (start of the ramp chain) */
  startNode: number;
  name: string;
}

export type SignKind = 'exit-advance' | 'exit-gore' | 'exit-now' | 'confirm' | 'speed' | 'camera' | 'vms';

export interface SignFile {
  kind: SignKind;
  edge: number;
  /** arc length along the edge */
  s: number;
  line: LineId | null;
  exitCode?: string;
  distanceText?: string;
  speed?: number;
  text?: string[];
}

export interface CameraFile {
  line: LineId;
  edge: number;
  s: number;
  lineS: number;
  limit: number;
  kind: 'fixed' | 'section-start' | 'section-end';
  sectionId?: number;
}

export interface NetworkFile {
  version: number;
  origin: LatLon;
  generated: string;
  attribution: string;
  lines: Record<LineId, LineInfo>;
  edges: EdgeFile[];
  nodes: NodeFile[];
  exits: ExitFile[];
  entrances: EntranceFile[];
  signs: SignFile[];
  cameras: CameraFile[];
}

/* ---------------- City ---------------- */

/** Quantised polygon: flat [x0,z0,x1,z1,...] in decimetres. */
export type QPoly = number[];

export interface BuildingRec {
  /** footprint outer ring (decimetres) */
  p: QPoly;
  /** height in metres */
  h: number;
  /** facade style index */
  s: number;
  /** min height (for building parts lifted above ground) */
  m?: number;
}

export interface CityFile {
  version: number;
  bounds: [number, number, number, number];
  buildings: BuildingRec[];
  /** distant skyline buildings */
  skyline: BuildingRec[];
  /** roads: [kind, widthMetres, flat polyline (dm)] */
  roads: [number, number, number[]][];
  water: QPoly[][];
  green: [number, QPoly][];
  rail: number[][];
  trees: number[];
  landmarks: LandmarkRec[];
  terrain: TerrainRec | null;
}

export interface LandmarkRec {
  id: string;
  name: string;
  x: number;
  z: number;
  h: number;
}

export interface TerrainRec {
  /** world-space bounds [minX, minZ, maxX, maxZ] */
  bounds: [number, number, number, number];
  w: number;
  h: number;
  /** heights in decimetres, row-major (z rows), base64 of Int16Array */
  data: string;
}

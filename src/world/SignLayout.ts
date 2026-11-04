/**
 * Placement of sign supports. Gantries span their carriageway plus any deck
 * running alongside at the same level (diverging ramps, the opposite
 * carriageway), with the posts standing on the outer barriers; pole-mounted
 * signs stand on a barrier. A position that would put a post into a roadway,
 * or a post / beam / panel through a deck above, is moved along the road.
 */
import { type Edge, type RoadFrame, type RoadNetwork, newFrame } from '../road/Network';
import type { DeckIndex } from '../road/Clearance';

/** lateral distance from a deck bound to the axis of a post standing on its barrier */
export const POST_OFFSET = 0.38;
const MAX_SPAN = 48;

export interface Post {
  /** lateral offset in the frame of the sign's edge */
  d: number;
  /** height of the post foot (top of the deck it stands on) */
  base: number;
  deck: Edge;
}

export interface GantryLayout {
  edge: Edge;
  s: number;
  y: number;
  left: Post;
  right: Post;
  /** distance moved from the requested position */
  shift: number;
}

export interface PoleLayout {
  edge: Edge;
  s: number;
  y: number;
  post: Post;
  side: -1 | 1;
  shift: number;
}

/** Single post on one barrier with an arm reaching `reach` metres over the carriageway (F-type support). */
export interface CantileverLayout extends PoleLayout {
  reach: number;
}

/**
 * Search order 0, ±step, ±2·step, … limited to `ahead` metres downstream and
 * `back` metres upstream; upstream candidates come first unless `aheadFirst`.
 */
export function shifts(step: number, ahead: number, back: number, aheadFirst = false): number[] {
  const out = [0];
  for (let k = step; k <= Math.max(ahead, back) + 1e-6; k += step) {
    for (const v of aheadFirst ? [k, -k] : [-k, k]) if ((v > 0 && v <= ahead) || (v < 0 && -v <= back)) out.push(v);
  }
  return out;
}

/** Position after moving `shift` metres along the line (main edges) or along the edge (ramps). */
function locate(net: RoadNetwork, edge: Edge, s: number, shift: number): { edge: Edge; s: number } | null {
  if (!shift) return { edge, s: Math.max(0, Math.min(edge.length, s)) };
  if (edge.kind === 'main' && edge.line) return net.atLineS(edge.line, net.lineS(edge, s)! + shift);
  const s2 = s + shift;
  if (s2 < 2 || s2 > edge.length - 2) return null;
  return { edge, s: s2 };
}

/** Outer limit of the decks at this level on one side, probing outwards from the edge's bound. */
function spanSide(idx: DeckIndex, e: Edge, s: number, f: RoadFrame, y: number, side: number): Post | null {
  const own = side > 0 ? e.brAt(s) : e.blAt(s);
  let last = own;
  let deck = e;
  let base = y;
  for (let d = own + side * 0.1; Math.abs(d - last) < 1.3; d += side * 0.1) {
    if (Math.abs(d - own) > MAX_SPAN) return null;
    for (const h of idx.at(f.x + f.nx * d, f.z + f.nz * d)) {
      if (h.edge === e || Math.abs(h.y - y) > 2.5) continue;
      last = d;
      deck = h.edge;
      base = h.y;
      break;
    }
  }
  return { d: last + side * POST_OFFSET, base, deck };
}

/**
 * Gantry near (edge, s) whose beam top is `beamTop` above the deck; null if no
 * clear spot exists within the given shifts.
 */
export function layoutGantry(net: RoadNetwork, idx: DeckIndex, edge: Edge, s: number, beamTop: number, tries: number[]): GantryLayout | null {
  const f = newFrame();
  for (const shift of tries) {
    const loc = locate(net, edge, s, shift);
    if (!loc) continue;
    const { edge: e, s: ss } = loc;
    e.frame(ss, 0, f);
    const y = e.yAt(ss);
    const right = spanSide(idx, e, ss, f, y, 1);
    const left = spanSide(idx, e, ss, f, y, -1);
    if (!right || !left || right.d - left.d > MAX_SPAN) continue;
    const top = y + beamTop;
    let ok = true;
    for (const p of [left, right]) {
      if (!idx.clear(f.x + f.nx * p.d, f.z + f.nz * p.d, 0.27, p.base, top + 0.45, [p.deck])) ok = false;
    }
    // beam (and the panels hanging from it) must not meet a deck above or alongside
    for (let d = left.d; ok && d <= right.d; d += 1.2) {
      if (!idx.clear(f.x + f.nx * d, f.z + f.nz * d, 0.45, top - 1.1, top + 0.6)) ok = false;
    }
    if (ok) return { edge: e, s: ss, y, left, right, shift };
  }
  return null;
}

/**
 * Cantilever sign support where a full gantry does not fit (typically on the
 * lower deck of a double-deck section, where the upper deck covers part of
 * the carriageway): the arm reaches as far over the road as the space above
 * allows, at most `maxReach` and at least `minReach` metres.
 */
export function layoutCantilever(
  net: RoadNetwork,
  idx: DeckIndex,
  edge: Edge,
  s: number,
  top: number,
  panelDrop: number,
  prefer: -1 | 1,
  tries: number[],
  minReach: number,
  maxReach: number,
): CantileverLayout | null {
  const f = newFrame();
  for (const shift of tries) {
    const loc = locate(net, edge, s, shift);
    if (!loc) continue;
    const { edge: e, s: ss } = loc;
    const i = e.idx(ss);
    const y = e.yAt(ss);
    e.frame(ss, 0, f);
    for (const side of [prefer, -prefer] as (-1 | 1)[]) {
      if ((side > 0 ? e.or[i] : e.ol[i]) >= 0) continue;
      const d0 = (side > 0 ? e.brAt(ss) : e.blAt(ss)) + side * POST_OFFSET;
      if (!idx.clear(f.x + f.nx * d0, f.z + f.nz * d0, 0.27, y, y + top + 0.45, [e])) continue;
      // reach inwards while the arm and the panel below it stay clear
      let reach = 0;
      while (reach < maxReach) {
        const d = d0 - side * (reach + 0.5);
        if (!idx.clear(f.x + f.nx * d, f.z + f.nz * d, 0.45, y + top - panelDrop, y + top + 0.6)) break;
        reach += 0.5;
      }
      if (reach >= minReach) return { edge: e, s: ss, y, post: { d: d0, base: y, deck: e }, side, shift, reach };
    }
  }
  return null;
}

/** Equipment hung from the underside of the deck above (lower level of a double-deck section). */
export interface UnderDeckLayout {
  edge: Edge;
  s: number;
  y: number;
  /** per lane: height of the upper deck's underside above this deck, null where there is open sky */
  ceilings: (number | null)[];
  shift: number;
}

/**
 * Spot under an upper deck for cameras that cannot have a gantry of their own:
 * the lanes the upper deck covers (at a height between `minH` and `maxH`)
 * get their camera hung from its underside. Prefers spots where it covers most lanes.
 */
export function layoutUnderDeck(net: RoadNetwork, idx: DeckIndex, edge: Edge, s: number, tries: number[], minH = 4.8, maxH = 8): UnderDeckLayout | null {
  const f = newFrame();
  let best: UnderDeckLayout | null = null;
  let bestCount = 0;
  for (const shift of tries) {
    const loc = locate(net, edge, s, shift);
    if (!loc) continue;
    const { edge: e, s: ss } = loc;
    const y = e.yAt(ss);
    const lanes = Math.max(1, Math.round(e.lanesAt(ss)));
    const ceilings: (number | null)[] = [];
    for (let k = 0; k < lanes; k++) {
      e.frame(ss, e.laneCenter(ss, k), f);
      // the drawn underside straight above the lane (the girder soffit rises towards the deck edges)
      const c = idx.soffit(f.x, f.z, y + 1) - y;
      ceilings.push(c >= minH && c <= maxH ? c : null);
    }
    const count = ceilings.filter((c) => c !== null).length;
    if (count > bestCount) {
      bestCount = count;
      best = { edge: e, s: ss, y, ceilings, shift };
      if (count === lanes) break;
    }
  }
  return best;
}

/**
 * Pole-mounted sign (panel of radius ~`panelR` centred `top` above the deck)
 * on a barrier, preferring side `prefer`; null if no clear spot is found.
 */
export function layoutPole(net: RoadNetwork, idx: DeckIndex, edge: Edge, s: number, top: number, prefer: -1 | 1, tries: number[], panelR = 0.7): PoleLayout | null {
  const f = newFrame();
  for (const shift of tries) {
    const loc = locate(net, edge, s, shift);
    if (!loc) continue;
    const { edge: e, s: ss } = loc;
    const i = e.idx(ss);
    const y = e.yAt(ss);
    for (const side of [prefer, -prefer] as (-1 | 1)[]) {
      // open sides (gore areas) have no barrier to stand on
      if ((side > 0 ? e.or[i] : e.ol[i]) >= 0) continue;
      const d = (side > 0 ? e.brAt(ss) : e.blAt(ss)) + side * POST_OFFSET;
      e.frame(ss, d, f);
      if (!idx.clear(f.x, f.z, 0.12, y, y + top + 0.2, [e])) continue;
      // the panel may overhang the shoulder of its own carriageway, but nothing else
      if (!idx.clear(f.x, f.z, panelR, y + top - 1.3, y + top + 0.3, [e], [e])) continue;
      return { edge: e, s: ss, y, post: { d, base: y, deck: e }, side, shift };
    }
  }
  return null;
}

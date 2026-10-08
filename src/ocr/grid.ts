/**
 * Finding a nonogram's grid in a screenshot, from its lines.
 *
 * This works from *edges* (where one row of pixels differs from the next), not from lines as
 * such: a line between two empty cells has an edge on each side, but next to a filled cell, it
 * merges into the fill, leaving only the edge on the empty side. Either way, there's an edge
 * within half a line's width of its center. (Between two filled cells, there's often nothing.)
 *
 * In a screenshot, a grid line's edges are each in exactly one row of pixels, all the way along;
 * that's what makes them easy to find, and what fails for a photo, where they wander.
 *
 * What the screenshots we have show about the lines' positions:
 * - Every line, thin or heavy (usually, every fifth), is centered on one evenly spaced lattice.
 *   (So the cells beside a heavy line are smaller; the spacing doesn't change.) The spacing
 *   needn't be a whole number of pixels.
 * - The border is drawn inside the grid: its *outer* edge is on the lattice.
 * So the lattice is only used to say which line is which; the cells' bounds come from each
 * line's own edges.
 *
 * Everything here works on horizontal lines; vertical lines are found the same way, in the
 * transposed picture.
 */

import type { Bounds } from './bounds.ts';
import { type Raster, transpose } from './raster.ts';

/** How different (in any of R, G, B) two pixels must be to make an edge. */
const EDGE_THRESHOLD = 10;
/** Gaps in a run of edge that are bridged. (WebP and JPEG make edges ragged, and where cells
 * are drawn as tiles, the gaps between them cross each tile's edge, often with rounded corners
 * either side.) */
const RUN_GAP = 20;
/** How much of a run must actually be edge. */
const RUN_DENSITY = 0.5;
/** The shortest run of edge that might be part of a grid line. (Digits are shorter.) */
const MIN_RUN = 50;
/** The smallest cell size, in pixels, worth trying. */
const MIN_PITCH = 10;
/** How many lattice lines in a row can be missing. */
const MAX_MISSES = 2;
/** The fewest cells across a grid. */
const MIN_CELLS = 4;
/** The most cells across a grid. */
const MAX_CELLS = 60;
/** The fraction of a grid's edge that must have an edge on it. */
const FULL = 0.9;

/** The edges between adjacent rows of pixels. Boundary `b` is between rows `b` and `b + 1`. */
export type Edges = {
  /** How long each boundary is (the picture's width). */
  along: number;
  /** How many boundaries there are (one fewer than the picture's height). */
  count: number;
  /** Whether there's an edge at each point: `mask[b * along + x]`. */
  mask: Uint8Array;
  /** The runs of edge along each boundary, as `[start, end, covered]` triples: from `start` to
   * (not including) `end`, with an edge at `covered` of those points. */
  runs: number[][];
};

/** The edges in `raster`, for finding horizontal lines (for vertical ones, transpose it). An edge
 * is where a pixel is more than `EDGE_THRESHOLD` different from the one below, and at least as
 * different as the pixels just above and below are, if they change the same way (darker or
 * lighter). */
export function edges(raster: Raster): Edges {
  const { width, height, data } = raster;
  const count = height - 1;
  // How different each pixel is from the one below, signed by whether it gets brighter.
  const diff = new Int16Array(count * width);
  for (let b = 0; b < count; b++) {
    for (let x = 0; x < width; x++) {
      const i = (b * width + x) * 3;
      const j = i + width * 3;
      const [dr, dg, db] = [
        data[j]! - data[i]!,
        data[j + 1]! - data[i + 1]!,
        data[j + 2]! - data[i + 2]!,
      ];
      const d = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
      diff[b * width + x] = dr + dg + db >= 0 ? d : -d;
    }
  }
  // Only the strongest of a blurry edge's boundaries counts (but ties all do). (Compared only
  // with edges the same way: a thin line's two edges are a boundary apart.)
  const mask = new Uint8Array(count * width);
  const weaker = (d: number, other: number) =>
    Math.sign(d) === Math.sign(other) && Math.abs(other) > Math.abs(d);
  for (let b = 0; b < count; b++) {
    for (let x = 0; x < width; x++) {
      const i = b * width + x;
      const d = diff[i]!;
      if (
        Math.abs(d) > EDGE_THRESHOLD &&
        (b === 0 || !weaker(d, diff[i - width]!)) &&
        (b === count - 1 || !weaker(d, diff[i + width]!))
      ) {
        mask[i] = 1;
      }
    }
  }
  const runs: number[][] = [];
  for (let b = 0; b < count; b++) {
    const row: number[] = [];
    let start = -1;
    let last = -1;
    let covered = 0;
    for (let x = 0; x <= width; x++) {
      const on = x < width && mask[b * width + x] === 1;
      if (on) {
        if (start < 0) start = x;
        last = x;
        covered++;
      } else if (start >= 0 && (x === width || x - last > RUN_GAP)) {
        row.push(start, last + 1, covered);
        start = -1;
        covered = 0;
      }
    }
    runs.push(row);
  }
  return { along: width, count, mask, runs };
}

/** How much edge there is at each boundary, counting only runs at least `minRun` long (and
 * mostly edge), and only within `[from, to)` along it. */
export function profile(
  e: Edges,
  from = 0,
  to = e.along,
  minRun = MIN_RUN
): Float64Array {
  const p = new Float64Array(e.count);
  for (let b = 0; b < e.count; b++) {
    const row = e.runs[b]!;
    let total = 0;
    for (let i = 0; i < row.length; i += 3) {
      const [start, end, covered] = [row[i]!, row[i + 1]!, row[i + 2]!];
      const density = covered / (end - start);
      if (end - start < minRun || density < RUN_DENSITY) continue;
      total += density * Math.max(0, Math.min(end, to) - Math.max(start, from));
    }
    p[b] = total;
  }
  return p;
}

/** A least-squares fit of `x = intercept + slope * k`, to points added one at a time. (The
 * slope needs points at two different `k`s, at least.) */
function linearFit() {
  let [sk, skk, sx, skx, count] = [0, 0, 0, 0, 0];
  return {
    add(k: number, x: number) {
      [sk, skk, sx, skx, count] = [
        sk + k,
        skk + k * k,
        sx + x,
        skx + k * x,
        count + 1,
      ];
    },
    get count() {
      return count;
    },
    get slope() {
      return (count * skx - sk * sx) / (count * skk - sk * sk);
    },
    get intercept() {
      return (sx - this.slope * sk) / count;
    },
  };
}

/** Evenly spaced positions: `phase + k * pitch`, for `k` from `first` to `last`. */
export type Lattice = {
  pitch: number;
  phase: number;
  first: number;
  last: number;
  score: number;
};

/**
 * The likeliest lattices of lines in `p`: long runs of evenly spaced peaks. A lattice of half
 * the real spacing misses every other line, and one of five times the spacing (just the heavy
 * lines) is short, so the real one scores best. But other things can be evenly spaced too (a
 * patterned background, say), so this returns a few.
 */
export function lattices(p: Float64Array, max = 3): Lattice[] {
  // The peaks, at their edge's position (boundary `b` is at `b + 1`).
  const pos: number[] = [];
  const weight: number[] = [];
  for (let b = 0; b < p.length; b++) {
    const v = p[b]!;
    if (
      v > 0 &&
      (b === 0 || v >= p[b - 1]!) &&
      (b === p.length - 1 || v > p[b + 1]!)
    ) {
      pos.push(b + 1);
      weight.push(Math.sqrt(v));
    }
  }
  const n = pos.length;
  if (n < 2) return [];
  const meanWeight = weight.reduce((a, b) => a + b, 0) / n;
  const maxPitch = p.length / MIN_CELLS;
  // The peak nearest `x`, within `tol`.
  const nearest = (x: number, tol: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pos[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    for (const i of [lo - 1, lo]) {
      if (i >= 0 && i < n && Math.abs(pos[i]! - x) <= tol) {
        if (best < 0 || Math.abs(pos[i]! - x) < Math.abs(pos[best]! - x))
          best = i;
      }
    }
    return best;
  };

  const found: Lattice[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = pos[j]! - pos[i]!;
      if (d > maxPitch) break;
      if (d < MIN_PITCH || seen.has(i * n + j)) continue;
      const tol = Math.max(2, 0.07 * d);
      // Fit the lattice as lines are found.
      const fit = linearFit();
      fit.add(0, pos[i]!);
      fit.add(1, pos[j]!);
      let score = weight[i]! + weight[j]!;
      let [lo, hi] = [0, 1];
      for (const dir of [1, -1]) {
        let prev = dir === 1 ? j : i;
        let misses = 0;
        for (let k = dir === 1 ? 2 : -1; ; k += dir) {
          const x = fit.intercept + fit.slope * k;
          if (x < 0 || x > p.length + 1) break;
          const hit = nearest(x, tol);
          if (hit < 0 || hit === prev) {
            if (++misses > MAX_MISSES) break;
            continue;
          }
          misses = 0;
          if (dir === 1) seen.add(prev * n + hit);
          else seen.add(hit * n + prev);
          prev = hit;
          fit.add(k, pos[hit]!);
          score += weight[hit]!;
          if (dir === 1) hi = k;
          else lo = k;
        }
      }
      const gaps = hi - lo + 1 - fit.count;
      found.push({
        pitch: fit.slope,
        phase: fit.intercept,
        first: lo,
        last: hi,
        score: score - 0.5 * meanWeight * gaps,
      });
    }
  }
  found.sort((x, y) => y.score - x.score);
  // The best few that aren't the same lattice as a better one.
  const distinct: Lattice[] = [];
  for (const l of found) {
    if (distinct.length >= max) break;
    const same = distinct.some((m) => {
      if (Math.abs(l.pitch - m.pitch) > 0.04 * m.pitch) return false;
      const shift = (((l.phase - m.phase) % m.pitch) + m.pitch) % m.pitch;
      return Math.min(shift, m.pitch - shift) <= m.pitch / 4;
    });
    if (!same) distinct.push(l);
  }
  return distinct;
}

/**
 * A grid line, as measured. `lead` is its first row of pixels and `trail` one past its last,
 * so a cell's inside runs from one line's `trail` to the next one's `lead`. (Where only one
 * side of a line shows, they're equal, at that edge.)
 */
export type Line = {
  lead: number;
  trail: number;
  center: number;
  width: number;
  /** Whether there were any edges there at all (if not, it's where the lattice says). */
  found: boolean;
};

/** The lines at each of the lattice's positions from `from` to `to`, measured from `p`. */
export function measure(
  p: Float64Array,
  lattice: Lattice,
  from: number,
  to: number
): Line[] {
  const lines: Line[] = [];
  for (let k = from; k <= to; k++) {
    lines.push(measureAt(p, lattice.phase + k * lattice.pitch, lattice.pitch));
  }
  return lines;
}

/** The line around `x`: the outermost strong edges within a third of a cell of it. */
function measureAt(p: Float64Array, x: number, pitch: number): Line {
  const lo = Math.max(0, Math.ceil(x - pitch / 3) - 1);
  const hi = Math.min(p.length - 1, Math.floor(x + pitch / 3) - 1);
  let max = 0;
  for (let b = lo; b <= hi; b++) max = Math.max(max, p[b]!);
  if (max === 0) {
    const at = Math.round(x);
    return { lead: at, trail: at, center: at, width: 0, found: false };
  }
  let lead = -1;
  let trail = -1;
  for (let b = lo; b <= hi; b++) {
    if (p[b]! >= 0.3 * max) {
      if (lead < 0) lead = b + 1;
      trail = b + 1;
    }
  }
  return {
    lead,
    trail,
    center: (lead + trail) / 2,
    width: trail - lead,
    found: true,
  };
}

/** Refit the lattice to the lines' centers, so that it's centered on them. (Leaving out the
 * outermost lines found, which might be the border, drawn inside the grid, off the lattice.) */
function recenter(lattice: Lattice, lines: Line[], from: number): Lattice {
  const found = lines.flatMap((line, i) =>
    line.found ? [[from + i, line.center] as const] : []
  );
  const fit = linearFit();
  for (const [k, x] of found.length >= 4 ? found.slice(1, -1) : found)
    fit.add(k, x);
  if (fit.count < 2) return lattice;
  return { ...lattice, pitch: fit.slope, phase: fit.intercept };
}

/** The fraction of `[from, to)` along `line` that has an edge on it (or within `margin` of it). */
export function coverage(
  e: Edges,
  line: Line,
  from: number,
  to: number,
  margin = 0
): number {
  from = Math.max(0, Math.round(from));
  to = Math.min(e.along, Math.round(to));
  if (to <= from) return 0;
  // (Boundary `b` is at `b + 1`; allow a pixel either side.)
  const b0 = Math.max(0, Math.floor(line.lead - margin) - 2);
  const b1 = Math.min(e.count - 1, Math.ceil(line.trail + margin));
  let covered = 0;
  for (let x = from; x < to; x++) {
    for (let b = b0; b <= b1; b++) {
      if (e.mask[b * e.along + x] === 1) {
        covered++;
        break;
      }
    }
  }
  return covered / (to - from);
}

/** The middle of the cell between two lines (not its ends, where lines cross, or a cell drawn
 * as a tile has rounded corners). */
function between(a: Line, b: Line): [number, number] {
  const [from, to] =
    a.trail < b.lead ? [a.trail, b.lead] : [a.center, b.center];
  const end = 0.2 * (to - from);
  return [from + end, to - end];
}

/** `[first, last]` line indices along each axis. */
export type Rectangle = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

/**
 * The biggest rectangle of cells whose border has an edge all the way around, and whose inside
 * lines mostly do. (The border always has an edge, on the outside, even next to a filled cell;
 * the inside lines are hidden between filled cells.)
 *
 * The clues might be in boxes that carry the grid's lines on to the left (for the row clues) and
 * up (for the column clues), and so be part of the biggest rectangle. That's told by which lines
 * reach furthest: the grid's vertical lines carry on up through the column clues' boxes, but the
 * row clues' boxes' lines don't, and vice versa. So, from the left, columns whose lines don't
 * carry on up when the rest do are row clues, and likewise for the rows at the top.
 */
export function rectangle(
  eh: Edges,
  ev: Edges,
  h: Line[],
  v: Line[],
  pitch: number
): { full: Rectangle; grid: Rectangle } | undefined {
  const m = h.length;
  const n = v.length;
  // covH[k][j]: horizontal line `k` across the cells between vertical lines `j` and `j + 1`.
  const covH = h.map((line) =>
    v
      .slice(0, -1)
      .map((_, j) => coverage(eh, line, ...between(v[j]!, v[j + 1]!)))
  );
  const covV = v.map((line) =>
    h
      .slice(0, -1)
      .map((_, k) => coverage(ev, line, ...between(h[k]!, h[k + 1]!)))
  );
  // Sums over rectangles of `rows`, as `sum(r0, r1, c0, c1)`: over `[r0, r1)` and `[c0, c1)`.
  const sums = (rows: number[][], f: (c: number) => number) => {
    const width = (rows[0]?.length ?? 0) + 1;
    const pre: number[][] = [new Array<number>(width).fill(0)];
    rows.forEach((row, r) => {
      const out = [0];
      row.forEach((c, i) =>
        out.push(out[i]! + pre[r]![i + 1]! - pre[r]![i]! + f(c))
      );
      pre.push(out);
    });
    return (r0: number, r1: number, c0: number, c1: number) =>
      pre[r1]![c1]! - pre[r0]![c1]! - pre[r1]![c0]! + pre[r0]![c0]!;
  };
  const fullH = sums(covH, (c) => (c >= FULL ? 1 : 0));
  const fullV = sums(covV, (c) => (c >= FULL ? 1 : 0));
  const sumH = sums(covH, (c) => c);
  const sumV = sums(covV, (c) => c);
  // Whether a line has an edge all the way across the cells `[from, to)`.
  const full = (
    f: (r0: number, r1: number, c0: number, c1: number) => number,
    line: number,
    from: number,
    to: number
  ) => f(line, line + 1, from, to) === to - from;
  // How much `line` carries on across the cell `at`. (Allowing it to wander a little: clue boxes
  // can be rounded, and only roughly lined up with the grid's lines.)
  const reach = (horizontal: boolean, line: number, at: number) => {
    const [lines, across, e] = horizontal ? [h, v, eh] : [v, h, ev];
    if (at < 0 || at + 1 >= across.length) return 0;
    const margin = Math.max(2, pitch / 4);
    return coverage(
      e,
      lines[line]!,
      ...between(across[at]!, across[at + 1]!),
      margin
    );
  };

  // (Each line must have an edge all the way along its side of the rectangle, so as soon as one
  // doesn't, a longer side won't either.)
  let best: Rectangle | undefined;
  let bestArea = 0;
  for (let top = 0; top < m; top++) {
    // There must be room for the column clues above.
    if (h[top]!.center < 0.8 * pitch) continue;
    for (let left = 0; left < n; left++) {
      if (v[left]!.center < 0.8 * pitch) continue;
      for (
        let bottom = top + MIN_CELLS;
        bottom < m && bottom - top <= MAX_CELLS;
        bottom++
      ) {
        if (!full(fullV, left, top, bottom)) break;
        for (
          let right = left + MIN_CELLS;
          right < n && right - left <= MAX_CELLS;
          right++
        ) {
          if (
            !full(fullH, top, left, right) ||
            !full(fullH, bottom, left, right)
          ) {
            break;
          }
          const area = (bottom - top) * (right - left);
          if (area <= bestArea || !full(fullV, right, top, bottom)) continue;
          const inside =
            sumH(top + 1, bottom, left, right) +
            sumV(left + 1, right, top, bottom);
          const segments =
            (bottom - top - 1) * (right - left) +
            (right - left - 1) * (bottom - top);
          if (inside < 0.5 * segments) continue;
          // Most of the lines shouldn't carry on past the grid's right or bottom edge: that's
          // more lattice than grid.
          if (
            fullH(top, bottom + 1, right, right + 1) > (bottom - top + 1) / 2 ||
            fullV(left, right + 1, bottom, bottom + 1) > (right - left + 1) / 2
          ) {
            continue;
          }
          best = { top, bottom, left, right };
          bestArea = area;
        }
      }
    }
  }
  if (!best) return undefined;

  // The first of the lines from `first` to `last` from which on most carry on across `at`, if
  // the ones before clearly don't.
  const firstReaching = (
    horizontal: boolean,
    first: number,
    last: number,
    at: number
  ) => {
    for (let i = first; i <= last - MIN_CELLS; i++) {
      const r = reach(horizontal, i, at);
      if (r < FULL) {
        if (r < 0.3) continue;
        return first;
      }
      let count = 0;
      for (let j = i; j <= last; j++)
        if (reach(horizontal, j, at) >= FULL) count++;
      return count >= 0.8 * (last - i + 1) ? i : first;
    }
    return first;
  };
  return {
    full: best,
    grid: {
      ...best,
      top: firstReaching(true, best.top, best.bottom, best.left - 1),
      left: firstReaching(false, best.left, best.right, best.top - 1),
    },
  };
}

export type Grid = {
  /** The number of rows and columns of cells. */
  rows: number;
  cols: number;
  /** The horizontal lines, top to bottom (`rows + 1` of them), and the vertical ones. */
  horizontal: Line[];
  vertical: Line[];
  /** The spacing of the horizontal lines (so, a cell's height) and of the vertical ones (its
   * width). */
  pitch: { h: number; v: number };
  /** How straight the horizontal and vertical lines are (see `straightness`), and whether that's
   * straight enough for a screenshot. (A photo of a screen can be nearly straight, and still
   * work.) */
  straightness: { h: number; v: number };
  pixelPerfect: boolean;
};

export type Debug = {
  /** The lattices tried, horizontal and vertical. */
  lattices: { h: Lattice[]; v: Lattice[] };
  /** All the lines of the lattices chosen (or, if no grid was found, the likeliest ones), and the
   * rectangles found among them (before and after leaving out clue boxes). */
  allLines?: { h: Line[]; v: Line[] };
  rectangle?: { full: Rectangle; grid: Rectangle };
  /** The grid found from where the clues are (see `bounds.ts`), within the full rectangle, and
   * whether it was convincing enough to use. */
  byClues?: Bounds & { used: boolean };
};

export type GridResult =
  | {
      ok: true;
      grid: Grid;
      /** The biggest rectangle of cells, which can include clues (in boxes that carry on the
       * grid's lines, or on graph paper), and the grid made of any rectangle within it (with
       * `top`, etc. counting lines from its own). */
      outer: Grid;
      within: (r: Rectangle) => Grid;
      debug: Debug;
    }
  | { ok: false; reason: string; debug: Debug };

/** One axis's worth of what's needed to find the grid. */
type Axis = { edges: Edges; profile: Float64Array; lattices: Lattice[] };

function axis(raster: Raster): Axis {
  const e = edges(raster);
  const p = profile(e);
  return { edges: e, profile: p, lattices: lattices(p, 4) };
}

/**
 * How straight the lines from `first` to `last` are: the fraction of them that are in the same
 * place (within a pixel, or so) at either end, in the first and last thirds of `[from, to)`. In a
 * screenshot, that's all of them; in a photo, the lines wander.
 */
export function straightness(
  e: Edges,
  lattice: Lattice,
  first: number,
  last: number,
  from: number,
  to: number
): number {
  const third = (to - from) / 3;
  const a = measure(profile(e, from, from + third, 1), lattice, first, last);
  const b = measure(profile(e, to - third, to, 1), lattice, first, last);
  let straight = 0;
  let found = 0;
  a.forEach((la, i) => {
    const lb = b[i]!;
    if (!la.found || !lb.found) return;
    found++;
    // (A filled cell beside the line hides one of its edges, moving its center by up to half
    // its width.)
    if (Math.abs(la.center - lb.center) <= 1 + Math.max(la.width, lb.width) / 2)
      straight++;
  });
  return found === 0 ? 0 : straight / found;
}

/** The spacing of `lines`, fitted to the centers of all but the first and last (which, if
 * they're the border, are drawn inside the grid, off the lattice). */
function spacing(lines: Line[], fallback: number): number {
  const fit = linearFit();
  for (let k = 1; k < lines.length - 1; k++) {
    if (lines[k]!.found) fit.add(k, lines[k]!.center);
  }
  return fit.count < 2 ? fallback : fit.slope;
}

/** Where `lattice` reaches: from one line before its first to one after its last. */
function extent(lattice: Lattice): [number, number] {
  return [
    lattice.phase + (lattice.first - 1) * lattice.pitch,
    lattice.phase + (lattice.last + 1) * lattice.pitch,
  ];
}

/**
 * The lines of `lattice`, from one before its first to one after its last, centered, where the
 * lattice across them reaches. (They're found from long runs of edge, but measured from all of
 * them: a cell drawn as a tile has rounded corners, which break up its edges.)
 */
function latticeLines(
  a: Axis,
  lattice: Lattice,
  across: Lattice
): { lattice: Lattice; lines: Line[] } {
  const from = lattice.first - 1;
  const to = lattice.last + 1;
  const rough = measure(a.profile, lattice, from, to);
  const centered = recenter(lattice, rough, from);
  // Shift the indices so that line 0 is the first one.
  const shifted = {
    ...centered,
    phase: centered.phase + from * centered.pitch,
    first: 0,
    last: to - from,
  };
  const p = profile(a.edges, ...extent(across), 1);
  return { lattice: shifted, lines: measure(p, shifted, 0, to - from) };
}

/**
 * The grid in `raster`. Each pair of the likeliest lattices, across and down, that could be
 * square cells is tried, and the strongest pair that has a grid in it wins.
 */
export function findGrid(raster: Raster): GridResult {
  if (raster.width < 2 || raster.height < 2) {
    return {
      ok: false,
      reason: 'picture too small',
      debug: { lattices: { h: [], v: [] } },
    };
  }
  const h = axis(raster);
  const v = axis(transpose(raster));
  const debug: Debug = { lattices: { h: h.lattices, v: v.lattices } };
  if (h.lattices.length === 0 || v.lattices.length === 0) {
    return { ok: false, reason: 'no evenly spaced straight lines', debug };
  }

  const pairs = h.lattices
    .flatMap((hl) => v.lattices.map((vl) => [hl, vl] as const))
    .filter(
      ([hl, vl]) =>
        Math.abs(hl.pitch - vl.pitch) <= 0.05 * Math.max(hl.pitch, vl.pitch)
    )
    .sort((a, b) => b[0].score + b[1].score - (a[0].score + a[1].score));
  for (const [hl, vl] of pairs) {
    const hs = latticeLines(h, hl, vl);
    const vs = latticeLines(v, vl, hl);
    const pitch = (hs.lattice.pitch + vs.lattice.pitch) / 2;
    debug.allLines ??= { h: hs.lines, v: vs.lines };
    const rect = rectangle(h.edges, v.edges, hs.lines, vs.lines, pitch);
    if (!rect) continue;
    // The grid of lines `top` to `bottom` and `left` to `right`, measured again, looking only
    // where the grid is (not at, say, the edges of clue boxes beside it).
    const build = ({ top, bottom, left, right }: Rectangle): Grid => {
      const [x0, x1] = [vs.lines[left]!.center, vs.lines[right]!.center];
      const [y0, y1] = [hs.lines[top]!.center, hs.lines[bottom]!.center];
      const horizontal = measure(
        profile(h.edges, x0, x1, 1),
        hs.lattice,
        top,
        bottom
      );
      const vertical = measure(
        profile(v.edges, y0, y1, 1),
        vs.lattice,
        left,
        right
      );
      const straight = {
        h: straightness(h.edges, hs.lattice, top, bottom, x0, x1),
        v: straightness(v.edges, vs.lattice, left, right, y0, y1),
      };
      return {
        rows: bottom - top,
        cols: right - left,
        horizontal,
        vertical,
        pitch: {
          h: spacing(horizontal, hs.lattice.pitch),
          v: spacing(vertical, vs.lattice.pitch),
        },
        straightness: straight,
        pixelPerfect: Math.min(straight.h, straight.v) >= 0.85,
      };
    };
    const { full } = rect;
    debug.allLines = { h: hs.lines, v: vs.lines };
    debug.rectangle = rect;
    return {
      ok: true,
      grid: build(rect.grid),
      outer: build(full),
      within: (r) =>
        build({
          top: full.top + r.top,
          bottom: full.top + r.bottom,
          left: full.left + r.left,
          right: full.left + r.right,
        }),
      debug,
    };
  }
  return { ok: false, reason: 'no grid among the lines', debug };
}

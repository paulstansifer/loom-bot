/**
 * A photo of a paper puzzle, straightened: resampled through the mesh (`mesh.ts`) so that its
 * cells are squares `CELL` pixels on a side, its lines straight and evenly spaced, as in a
 * screenshot. Past the grid, it reaches to where the clues are, above it and to its left.
 */

import type { Grid, Line } from '../grid.ts';
import type { Raster } from '../raster.ts';
import type { PaperGrid } from './mesh.ts';

/** A cell's size in the straightened picture. */
export const CELL = 32;
/** How many points of the mesh are worked out per cell, each way; points between them are
 * interpolated. */
const MESH_STEPS = 8;
/** The most cells, as a fraction of the grid's size, that the clues can reach out from it. */
const MOST_CLUES = 0.6;
/** Half a line's width, in the straightened picture. (Photos blur lines a little.) */
const LINE_HALF = 1.5;
/** The most times the straightened picture is put right by where its lines are, and how far
 * off (in pixels) they can all be to leave it. */
const CORRECTIONS = 3;
const SETTLED = 1;
/** What's past the edge of the photo. */
const PAPER = [255, 255, 255];

export type Straightened = {
  raster: Raster;
  /** The grid, in the straightened picture. */
  grid: Grid;
  /** How many cells there are left of the grid, and above it. */
  margin: { left: number; top: number };
};

export function straighten(photo: Raster, paper: PaperGrid): Straightened {
  const { rows, cols, point } = paper;
  // As far out as the clues could be, but not much past the photo's edge.
  const reach = (
    toward: (k: number) => { x: number; y: number },
    most: number
  ) => {
    let k = 0;
    while (k < most) {
      const p = toward(k + 1);
      const off = Math.max(-p.x, -p.y, p.x - photo.width, p.y - photo.height);
      if (off > 0) break;
      k++;
    }
    return k;
  };
  const left = reach((k) => point(-k, rows / 2), Math.ceil(MOST_CLUES * cols));
  const top = reach((k) => point(cols / 2, -k), Math.ceil(MOST_CLUES * rows));
  const [right, bottom] = [1, 1];

  const cellsAcross = left + cols + right;
  const cellsDown = top + rows + bottom;
  const width = cellsAcross * CELL;
  const height = cellsDown * CELL;

  // The mesh's points, every `1 / MESH_STEPS` of a cell.
  const mw = cellsAcross * MESH_STEPS + 1;
  const mh = cellsDown * MESH_STEPS + 1;
  const mesh: Lattice = {
    w: mw,
    h: mh,
    x: new Float32Array(mw * mh),
    y: new Float32Array(mw * mh),
  };
  for (let j = 0; j < mh; j++) {
    for (let i = 0; i < mw; i++) {
      const p = point(i / MESH_STEPS - left, j / MESH_STEPS - top);
      mesh.x[j * mw + i] = p.x;
      mesh.y[j * mw + i] = p.y;
    }
  }

  // Straightened, then again, put right by where its lines turned out to be, until they're
  // where they should be. (Each time only sees so far, and holds what it sees past where a line
  // can be seen, so a line far off at its end takes a few times.)
  const bounds = { left, top, right: left + cols, bottom: top + rows };
  let lattice = mesh;
  let { raster, outside } = render(photo, lattice, width, height);
  flatten(raster, outside);
  for (let pass = 0; pass < CORRECTIONS; pass++) {
    const offsets = lineOffsets(raster, {
      left: 0,
      top: 0,
      right: cellsAcross,
      bottom: cellsDown,
    });
    const most = Math.max(
      ...[...offsets.v, ...offsets.h].flatMap((line) => [...line].map(Math.abs))
    );
    if (most < SETTLED) break;
    lattice = corrected(lattice, offsets);
    ({ raster, outside } = render(photo, lattice, width, height));
    flatten(raster, outside);
  }

  const lines = (first: number, count: number): Line[] =>
    Array.from({ length: count + 1 }, (_, k) => {
      const center = (first + k) * CELL;
      return {
        lead: Math.round(center - LINE_HALF),
        trail: Math.round(center + LINE_HALF),
        center,
        width: 2 * LINE_HALF,
        found: true,
      };
    });
  const grid: Grid = {
    rows,
    cols,
    horizontal: lines(top, rows),
    vertical: lines(left, cols),
    pitch: { h: CELL, v: CELL },
    straightness: { h: 1, v: 1 },
    pixelPerfect: false,
  };
  unrule(raster, bounds);
  return { raster, grid, margin: { left, top } };
}

/** How far either side of a line's middle (in pixels) its ink is erased, and how far out the
 * paper must be, for it to be only the line there. */
const RULE_HALF = 2;
const RULE_CLEAR = 4;
/** How dark a point must be (0 to 1) to be ink, here. */
const RULE_INK = 0.25;
/** How much of a line's length past the grid must be inked, narrowly, for it to be a ruled
 * line (solid or dashed), and not digits that happen to be there. */
const RULED = 0.4;
/** The longest dash (as a fraction of a cell). */
const DASH = 0.4;

/**
 * Erases ruled lines past the grid, in place: the lines between clues, solid or dashed, carried
 * on from the grid's (some puzzles' clues are on graph paper). Dashes would otherwise be taken
 * for "1"s. Where each line should be, past the grid, it's erased wherever it's narrow (paper
 * either side), if it's there for much of its length, so a digit across it is left.
 */
export function unrule(
  raster: Raster,
  grid: { left: number; top: number; right: number; bottom: number }
): void {
  const { width, height, data } = raster;
  const dark = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = (y * width + x) * 3;
    return 1 - Math.min(data[i]!, data[i + 1]!, data[i + 2]!) / 255 >= RULE_INK;
  };
  // Whether the line through `at` (vertical, or horizontal) is narrow ink at `a` along it.
  const narrow = (vertical: boolean, at: number, a: number) => {
    const ink = (d: number) => (vertical ? dark(at + d, a) : dark(a, at + d));
    let on = false;
    for (let d = -RULE_HALF; d <= RULE_HALF; d++) on ||= ink(d);
    return on && !ink(-RULE_CLEAR) && !ink(RULE_CLEAR);
  };
  const erase = (vertical: boolean, at: number, a: number) => {
    for (let d = -RULE_HALF; d <= RULE_HALF; d++) {
      const [x, y] = vertical ? [at + d, a] : [a, at + d];
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      data.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  };
  // Each line, over the stretches of it past the grid.
  const each = (
    vertical: boolean,
    count: number,
    stretches: (k: number) => [number, number][]
  ) => {
    for (let k = 0; k <= count; k++) {
      const at = k * CELL;
      const along = stretches(k).flatMap(([from, to]) =>
        Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)
      );
      if (along.length === 0) continue;
      const inked = along.filter((a) => narrow(vertical, at, a));
      if (inked.length < RULED * along.length) continue;
      // Runs of it as long as a dash, or longer than a cell (solid); a digit's stroke along it,
      // in between, is left.
      let start = 0;
      for (let i = 1; i <= inked.length; i++) {
        if (i < inked.length && inked[i]! === inked[i - 1]! + 1) continue;
        const run = inked.slice(start, i);
        if (run.length <= DASH * CELL || run.length >= CELL)
          for (const a of run) erase(vertical, at, a);
        start = i;
      }
    }
  };
  const [x0, x1] = [grid.left * CELL, grid.right * CELL];
  const [y0, y1] = [grid.top * CELL, grid.bottom * CELL];
  // Past the grid, where clues are: lines across the clues beside the grid's rows, and above
  // and below its columns. (Not in the corners, where there are no clues.)
  const inside = (at: number, from: number, to: number) =>
    at > from + RULE_CLEAR && at < to - RULE_CLEAR;
  each(true, Math.floor(width / CELL), (k) =>
    inside(k * CELL, x0, x1)
      ? [
          [0, y0 - RULE_CLEAR],
          [y1 + RULE_CLEAR, height],
        ]
      : [[y0, y1]]
  );
  each(false, Math.floor(height / CELL), (k) =>
    inside(k * CELL, y0, y1)
      ? [
          [0, x0 - RULE_CLEAR],
          [x1 + RULE_CLEAR, width],
        ]
      : [[x0, x1]]
  );
}

/** Points in the photo, at evenly spaced points of the straightened picture: `MESH_STEPS` to a
 * cell, `w` across and `h` down. */
type Lattice = { w: number; h: number; x: Float32Array; y: Float32Array };

/** Where `m` puts the point `(fx, fy)` (in its own steps), interpolated, and extrapolated past
 * its edges. */
function latticeAt(
  m: Lattice,
  fx: number,
  fy: number
): { x: number; y: number } {
  const i0 = Math.max(0, Math.min(Math.floor(fx), m.w - 2));
  const j0 = Math.max(0, Math.min(Math.floor(fy), m.h - 2));
  const ax = fx - i0;
  const ay = fy - j0;
  const k = j0 * m.w + i0;
  const at = (a: Float32Array) =>
    (a[k]! * (1 - ax) + a[k + 1]! * ax) * (1 - ay) +
    (a[k + m.w]! * (1 - ax) + a[k + m.w + 1]! * ax) * ay;
  return { x: at(m.x), y: at(m.y) };
}

/** The photo, resampled at the points `m` gives, `width` by `height`; and which pixels are past
 * the photo's edge. Each pixel is the average of 2 by 2 points in it (the photo can be finer
 * than this). */
function render(
  photo: Raster,
  m: Lattice,
  width: number,
  height: number
): { raster: Raster; outside: Uint8Array } {
  const data = new Uint8Array(width * height * 3);
  const outside = new Uint8Array(width * height);
  const step = CELL / MESH_STEPS;
  const d = photo.data;
  const rgb = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgb.fill(0);
      let missed = 0;
      for (const dy of [0.25, 0.75]) {
        for (const dx of [0.25, 0.75]) {
          const p = latticeAt(m, (x + dx) / step, (y + dy) / step);
          if (
            p.x < 0 ||
            p.y < 0 ||
            p.x > photo.width - 1 ||
            p.y > photo.height - 1
          ) {
            for (let c = 0; c < 3; c++) rgb[c]! += PAPER[c]!;
            missed++;
            continue;
          }
          const x0 = Math.min(Math.floor(p.x), photo.width - 2);
          const y0 = Math.min(Math.floor(p.y), photo.height - 2);
          const ax = p.x - x0;
          const ay = p.y - y0;
          const i = (y0 * photo.width + x0) * 3;
          const j = i + photo.width * 3;
          for (let c = 0; c < 3; c++) {
            rgb[c]! +=
              (d[i + c]! * (1 - ax) + d[i + 3 + c]! * ax) * (1 - ay) +
              (d[j + c]! * (1 - ax) + d[j + 3 + c]! * ax) * ay;
          }
        }
      }
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(rgb[c]! / 4);
      if (missed > 0) outside[y * width + x] = 1;
    }
  }
  return { raster: { width, height, data }, outside };
}

/** How far (as a fraction of a cell) either side of where a line should be it's looked for. */
const LOOK = 0.2;
/** How much darker than its surroundings (the lowest quarter of them) a line must be. */
const LINE_INK = 0.15;
/** How much of its length a line must be seen along to count. (Past the grid, there may be no
 * lines, but there are digits.) */
const MIN_SEEN = 0.3;
/** How far, in pixels, a line's offset in one cell can be from the median of the cells around it
 * along the line (3 each way), before it's taken for something else (a digit's stroke). */
const OFFSET_SLOP = 2;

/**
 * Where each line is, against where it should be, in a straightened picture: for each vertical
 * line from `left` to `right`, its offset (in pixels, + is right) beside each cell down the
 * picture; for each horizontal line from `top` to `bottom`, its offset (+ is down) beside each
 * cell across. Where a line isn't seen (under a fill, or past where it's printed), it's
 * interpolated along the line, or held from its ends; a line not seen at all takes its
 * neighbor's.
 */
export type Offsets = {
  left: number;
  top: number;
  /** `v[k - left][b]`, and `h[k - top][b]`. */
  v: Float32Array[];
  h: Float32Array[];
};

export function lineOffsets(
  raster: Raster,
  lines: { left: number; top: number; right: number; bottom: number }
): Offsets {
  const { width, height, data } = raster;
  const ink = (x: number, y: number) => {
    const i = (y * width + x) * 3;
    return 1 - Math.max(data[i]!, data[i + 1]!, data[i + 2]!) / 255;
  };
  const reach = Math.round(LOOK * CELL);
  // The offset of the line across `at`, beside cell `b`, or NaN.
  const measure = (vertical: boolean, at: number, b: number): number => {
    const p: number[] = [];
    for (let d = -reach; d <= reach; d++) {
      let sum = 0;
      let n = 0;
      for (let a = b * CELL; a < (b + 1) * CELL; a++) {
        const [x, y] = vertical ? [at + d, a] : [a, at + d];
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        sum += ink(x, y);
        n++;
      }
      p.push(n > 0 ? sum / n : 0);
    }
    let peak = 0;
    for (let i = 1; i < p.length; i++) if (p[i]! > p[peak]!) peak = i;
    const low = [...p].sort((q, r) => q - r)[p.length >> 2]!;
    if (p[peak]! - low < LINE_INK || peak === 0 || peak === p.length - 1)
      return NaN;
    const [l, c, r] = [p[peak - 1]!, p[peak]!, p[peak + 1]!];
    const curve = l - 2 * c + r;
    return peak - reach + (curve < 0 ? (l - r) / (2 * curve) : 0);
  };
  const along = (
    vertical: boolean,
    from: number,
    to: number,
    bands: number
  ) => {
    const found: Float32Array[] = [];
    for (let k = from; k <= to; k++) {
      const raw = Array.from({ length: bands }, (_, b) =>
        measure(vertical, k * CELL, b)
      );
      // Not where it's far off the line around it.
      const kept = raw.map((v, b) => {
        if (Number.isNaN(v)) return v;
        const near = raw
          .slice(Math.max(0, b - 3), b + 4)
          .filter((w) => !Number.isNaN(w))
          .sort((q, r) => q - r);
        return Math.abs(v - near[near.length >> 1]!) <= OFFSET_SLOP ? v : NaN;
      });
      // Not a line at all, if it's seen so little (digits that happen to be there).
      const seen = kept.filter((v) => !Number.isNaN(v)).length;
      found.push(
        seen >= MIN_SEEN * bands
          ? fillGaps(kept)
          : new Float32Array(bands).fill(NaN)
      );
    }
    // Lines not seen at all take their nearest neighbor's.
    for (let pass = 0; pass < found.length; pass++) {
      for (let k = 0; k < found.length; k++) {
        if (!Number.isNaN(found[k]![0]!)) continue;
        const near =
          found[k - 1] && !Number.isNaN(found[k - 1]![0]!)
            ? found[k - 1]
            : found[k + 1] && !Number.isNaN(found[k + 1]![0]!)
              ? found[k + 1]
              : undefined;
        if (near) found[k] = Float32Array.from(near);
      }
    }
    return found.map((f) =>
      Number.isNaN(f[0]!) ? new Float32Array(bands) : f
    );
  };
  return {
    left: lines.left,
    top: lines.top,
    v: along(true, lines.left, lines.right, Math.floor(height / CELL)),
    h: along(false, lines.top, lines.bottom, Math.floor(width / CELL)),
  };
}

/** `values`, with NaNs filled in: between two values, linearly; past the last ones, held. All
 * NaN if there are none. */
function fillGaps(values: number[]): Float32Array {
  const out = Float32Array.from(values);
  const known = values.flatMap((v, i) => (Number.isNaN(v) ? [] : [i]));
  if (known.length === 0) return out;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i]!)) continue;
    const after = known.find((k) => k > i);
    const before = [...known].reverse().find((k) => k < i);
    if (before === undefined) out[i] = values[after!]!;
    else if (after === undefined) out[i] = values[before]!;
    else
      out[i] =
        values[before]! +
        ((values[after]! - values[before]!) * (i - before)) / (after - before);
  }
  return out;
}

/** The offset at point `a` across lines (in cells), `b` along them (in cells), from the
 * offsets of the lines either side, interpolated between cells, and held past the ends. */
function offsetAt(
  lines: Float32Array[],
  first: number,
  a: number,
  b: number
): number {
  const along = (line: Float32Array) => {
    const f = Math.max(0, Math.min(line.length - 1, b - 0.5));
    const i = Math.min(Math.floor(f), line.length - 2);
    if (i < 0) return line[0]!;
    return line[i]! + (line[i + 1]! - line[i]!) * (f - i);
  };
  const k = Math.max(0, Math.min(lines.length - 1, a - first));
  const k0 = Math.min(Math.floor(k), lines.length - 2);
  if (k0 < 0) return along(lines[0]!);
  return (
    along(lines[k0]!) + (along(lines[k0 + 1]!) - along(lines[k0]!)) * (k - k0)
  );
}

/** `m`, with each point moved to where the lines say its content is. */
function corrected(m: Lattice, offsets: Offsets): Lattice {
  const out: Lattice = {
    w: m.w,
    h: m.h,
    x: new Float32Array(m.x.length),
    y: new Float32Array(m.y.length),
  };
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++) {
      const [u, v] = [i / MESH_STEPS, j / MESH_STEPS];
      const dx = offsetAt(offsets.v, offsets.left, u, v) / CELL;
      const dy = offsetAt(offsets.h, offsets.top, v, u) / CELL;
      const p = latticeAt(m, (u + dx) * MESH_STEPS, (v + dy) * MESH_STEPS);
      out.x[j * m.w + i] = p.x;
      out.y[j * m.w + i] = p.y;
    }
  }
  return out;
}

/** How far below the paper's fitted color (as a fraction of it) a cell's brightest can be and
 * still be paper, not a fill. */
const BELOW_PAPER = 0.12;

/**
 * Evens out the light and color on `raster` (straightened), in place, so that the paper is white:
 * each channel is divided by the paper's color there. That's a smooth surface (quadratic, in x
 * and y) fitted to each cell's brightest, leaving out cells well below it (filled ones, even
 * where most of a picture is filled with marker), and what's past the photo's edge.
 */
export function flatten(raster: Raster, outside: Uint8Array): void {
  const { width, height, data } = raster;
  const bw = Math.ceil(width / CELL);
  const bh = Math.ceil(height / CELL);
  // Each cell's brightest (by the sum of its channels), and where it is.
  const blocks: { x: number; y: number; rgb: number[] }[] = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let best = -1;
      let rgb = [0, 0, 0];
      for (let y = by * CELL; y < Math.min(height, (by + 1) * CELL); y++) {
        for (let x = bx * CELL; x < Math.min(width, (bx + 1) * CELL); x++) {
          if (outside[y * width + x]) continue;
          const i = (y * width + x) * 3;
          const sum = data[i]! + data[i + 1]! + data[i + 2]!;
          if (sum > best)
            [best, rgb] = [sum, [data[i]!, data[i + 1]!, data[i + 2]!]];
        }
      }
      if (best >= 0)
        blocks.push({
          x: (bx + 0.5) / bw - 0.5,
          y: (by + 0.5) / bh - 0.5,
          rgb,
        });
    }
  }
  const terms = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];
  const evaluate = (coef: number[], x: number, y: number) =>
    terms(x, y).reduce((sum, t, k) => sum + t * coef[k]!, 0);
  const surfaces = [0, 1, 2].map((c) => {
    // To begin with, the brighter half (paper is rarely less than half the picture).
    const middle = [...blocks.map((b) => b.rgb[c]!)].sort((p, q) => p - q)[
      blocks.length >> 1
    ]!;
    let kept = blocks.filter((b) => b.rgb[c]! >= middle);
    let coef = fitSurface(kept.map((b) => [...terms(b.x, b.y), b.rgb[c]!]));
    for (let round = 0; round < 4; round++) {
      const next = blocks.filter(
        (b) => b.rgb[c]! >= (1 - BELOW_PAPER) * evaluate(coef, b.x, b.y)
      );
      if (next.length < 6) break;
      kept = next;
      coef = fitSurface(kept.map((b) => [...terms(b.x, b.y), b.rgb[c]!]));
    }
    return coef;
  });
  for (let y = 0; y < height; y++) {
    const fy = (y + 0.5) / height - 0.5;
    for (let x = 0; x < width; x++) {
      const fx = (x + 0.5) / width - 0.5;
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const paper = Math.max(1, evaluate(surfaces[c]!, fx, fy));
        data[i + c] = Math.min(255, Math.round((255 * data[i + c]!) / paper));
      }
    }
  }
}

/** The least-squares fit of each row's last value by its others. */
function fitSurface(rows: number[][]): number[] {
  const n = rows[0]!.length - 1;
  const a = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (const row of rows) {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c <= n; c++) a[r]![c]! += row[r]! * row[c]!;
    }
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const p = a[col]![col]!;
    if (Math.abs(p) < 1e-9) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / p;
      for (let c = col; c <= n; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map((row, r) => (Math.abs(row[r]!) < 1e-9 ? 0 : row[n]! / row[r]!));
}

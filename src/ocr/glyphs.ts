/**
 * Finding the glyphs (digits, mostly) of each lane's clues, once the grid is known.
 *
 * Each column's clues are above it, between its two lines carried on upward, and each row's are
 * left of it. Within a lane, the background is whatever color is commonest nearby; ink is
 * anything different enough from it. The glyphs are the connected blobs of ink in a run outward
 * from the grid, each no further from the last than about a cell's width. (Further out, there's
 * likely a title, or buttons.)
 */

import type { Grid } from './grid.ts';
import type { Raster } from './raster.ts';

export type RGB = [number, number, number];

export type Glyph = {
  /** Its bounds in the picture: from `x0` to (not including) `x1`, and the same for `y`. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** How much ink there is at each pixel within those bounds, from 0 to 1, row by row. */
  ink: Float32Array;
  /** How different its ink is from the background (in the most different of R, G, B): lower
   * for a dimmed clue. */
  contrast: number;
  /** The color of its ink. */
  color: RGB;
  /** Whether it seems to be crossed out: found under lines of another color. (Its ink is then
   * only its own color's, so it has gaps where the lines cross it.) */
  struck: boolean;
};

/** Each column's glyphs, and each row's, in reading order (top to bottom, then left to right). */
export type LaneGlyphs = { columns: Glyph[][]; rows: Glyph[][] };

/** How different (in any of R, G, B) from the background a blob's ink must be, at its
 * strongest, to count. */
const INK_THRESHOLD = 40;
/** How different from the background a pixel must be to join a blob, at first. */
const FAINT = 16;
/** How much of its contrast a pixel must have to be part of a glyph. */
const INK_FRACTION = 0.4;
/** How far apart (in RGB) two inks must be to be told apart: digits from lines crossing them
 * out. */
const INK_COLORS_APART = 80;
/** How different (in any of R, G, B) the background on one side of a point must be from the
 * background around it to be another background (the top of a clue box, say), and not just a
 * gradient. */
const BACKGROUND_CHANGE = 24;
/** How wide a line of another color crossing a glyph can be, and still be seen through. */
const BRIDGE = 4;
/** The narrowest a glyph can be, and the shortest, as fractions of the picture's typical glyph
 * height. (A "1" is never a sliver: the narrowest seen is 0.3 of its height, and no digit is
 * shorter than 0.87 of the typical one. Slivers are bits of lines and boxes, or of a digit's
 * shadow.) */
const MIN_WIDTH = 0.2;
const MIN_HEIGHT = 0.6;
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

/** The glyphs in front of each of `grid`'s lanes. */
export function findGlyphs(raster: Raster, grid: Grid): LaneGlyphs {
  const { horizontal: h, vertical: v } = grid;
  const pitch = (grid.pitch.h + grid.pitch.v) / 2;
  const columnLanes: Lane[] = [];
  for (let i = 0; i < grid.cols; i++) {
    columnLanes.push({
      vertical: true,
      length: h[0]!.lead,
      start: v[i]!.trail,
      width: v[i + 1]!.lead - v[i]!.trail,
    });
  }
  const rowLanes: Lane[] = [];
  for (let j = 0; j < grid.rows; j++) {
    rowLanes.push({
      vertical: false,
      length: v[0]!.lead,
      start: h[j]!.trail,
      width: h[j + 1]!.lead - h[j]!.trail,
    });
  }
  const columns = columnLanes.map((lane) => laneGlyphs(raster, lane, pitch));
  const rows = rowLanes.map((lane) => laneGlyphs(raster, lane, pitch));

  const heights = [...columns, ...rows]
    .flatMap((f) => f.glyphs)
    .map((g) => g.y1 - g.y0)
    .sort((p, q) => p - q);
  const typical = heights[Math.floor(heights.length / 2)] ?? 0;
  const big = (g: Glyph) => bigEnough(g, typical);
  for (const f of [...columns, ...rows]) {
    f.glyphs = f.glyphs.filter(big);
    f.spare = f.spare.filter(big);
  }

  const columnStep = stackStep(columnLanes, columns);
  return {
    columns: columns.map((f, i) =>
      fillSlots(
        columnLanes[i]!,
        f,
        nearestOffset(columnLanes, columns),
        columnStep,
        typical
      )
    ),
    rows: rows.map((f, i) =>
      fillSlots(
        rowLanes[i]!,
        f,
        nearestOffset(rowLanes, rows),
        undefined,
        typical
      )
    ),
  };
}

/** Whether `g` isn't a sliver or a speck, given the picture's `typical` glyph height. */
export function bigEnough(g: Glyph, typical: number): boolean {
  return (
    g.x1 - g.x0 >= MIN_WIDTH * typical && g.y1 - g.y0 >= MIN_HEIGHT * typical
  );
}

/** What's found in a lane: its glyphs, in reading order, and others that might be glyphs too
 * (too faint, or too far out), in case the layout says there should be one where they are. */
type Found = { glyphs: Glyph[]; spare: Glyph[] };

/** How far `g`'s middle is from the grid, along `lane`. */
function along(lane: Lane, g: Glyph): number {
  return lane.length - (lane.vertical ? (g.y0 + g.y1) / 2 : (g.x0 + g.x1) / 2);
}

/** How far `g`'s middle is from the middle of `lane`, across it. */
function across(lane: Lane, g: Glyph): number {
  const middle = lane.vertical ? (g.x0 + g.x1) / 2 : (g.y0 + g.y1) / 2;
  return middle - (lane.start + lane.width / 2);
}

/** How far the clue nearest the grid usually is from it. (The clues are aligned against the
 * grid, so it's about the same in every lane.) */
function nearestOffset(lanes: Lane[], found: Found[]): number {
  const offsets = found.flatMap((f, i) =>
    f.glyphs.length === 0
      ? []
      : [Math.min(...f.glyphs.map((g) => along(lanes[i]!, g)))]
  );
  return median(offsets);
}

/** How far apart the lines of a column's clues are stacked, or `undefined` if there aren't
 * enough stacked to say. */
function stackStep(lanes: Lane[], found: Found[]): number | undefined {
  const steps = found.flatMap((f, i) => {
    const lines = textLines(f.glyphs).map((line) => along(lanes[i]!, line[0]!));
    lines.sort((p, q) => p - q);
    return lines.slice(1).map((d, k) => d - lines[k]!);
  });
  return steps.length < 3 ? undefined : median(steps);
}

/**
 * The lane's glyphs, with spare ones added where a glyph is missing from where the layout says
 * one should be. Going outward from the grid, by `step` (or only the nearest place, without one),
 * an empty place gets the spare glyph there, if there is one (in the middle of the lane, and about
 * the size of a digit). Past the outermost glyph, it stops at the first place without one.
 */
function fillSlots(
  lane: Lane,
  found: Found,
  offset: number,
  step: number | undefined,
  typical: number
): Glyph[] {
  const tolerance = 0.5 * typical;
  const spare = found.spare.filter((g) => {
    const tall = (g.y1 - g.y0) / typical;
    return (
      Math.abs(across(lane, g)) < 0.25 * lane.width &&
      tall > 0.75 &&
      tall < 1.33
    );
  });
  const at = (list: Glyph[], k: number) =>
    list.find(
      (g) => Math.abs(along(lane, g) - offset - k * (step ?? 0)) < tolerance
    );
  const outermost = found.glyphs.reduce(
    (m, g) =>
      Math.max(m, step ? Math.round((along(lane, g) - offset) / step) : 0),
    -1
  );
  const added: Glyph[] = [];
  for (let k = 0; k < 100; k++) {
    if (k > 0 && !step) break;
    if (at(found.glyphs, k)) continue;
    const g = at(spare, k);
    if (g) added.push(g);
    else if (k > outermost) break;
  }
  const glyphs = [...found.glyphs, ...added];
  // A row's clues are in one line, even if some (say, two-digit numbers, condensed) are smaller.
  return lane.vertical
    ? textLines(glyphs).flat()
    : glyphs.sort((p, q) => p.x0 - q.x0);
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const sorted = [...v].sort((p, q) => p - q);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * A strip of the picture in front of a lane, measured along it (`a`, from the picture's edge to
 * the grid, or from `begin`) and across it (`c`). A column's lane is `vertical`: `a` is `y`, and
 * `c` is `x` from `start`. A row's is the other way around.
 */
export type Lane = {
  vertical: boolean;
  begin?: number;
  length: number;
  start: number;
  width: number;
};

/** A connected blob of ink, in a lane's coordinates. */
type Blob = {
  label: number;
  a0: number;
  a1: number;
  c0: number;
  c1: number;
  pixels: number;
  touchesSide: boolean;
  /** Whether it was found under something else drawn over it, in another color. */
  struck?: boolean;
};

/** Every glyph-shaped blob in `lane`, however faint, and wherever it is along it. (For telling
 * where clues are, in a strip across both clues and grid.) */
export function stripGlyphs(
  raster: Raster,
  lane: Lane,
  pitch: number
): Glyph[] {
  const { glyphs, spare } = laneGlyphs(raster, lane, pitch);
  return [...glyphs, ...spare];
}

function laneGlyphs(raster: Raster, lane: Lane, pitch: number): Found {
  const { length, width } = lane;
  if (length <= 0 || width <= 2) return { glyphs: [], spare: [] };
  const begin = lane.begin ?? 0;
  const xy = (a: number, c: number): [number, number] =>
    lane.vertical ? [lane.start + c, begin + a] : [begin + a, lane.start + c];
  const pixel = (a: number, c: number): number => {
    const [x, y] = xy(a, c);
    return (y * raster.width + x) * 3;
  };

  const background = backgrounds(raster, lane, pixel, pitch);
  // How different each pixel is from the background (whichever is closer).
  const diff = new Uint8Array(length * width);
  for (let a = 0; a < length; a++) {
    const bgs = background[a]!;
    for (let c = 0; c < width; c++) {
      const i = pixel(a, c);
      diff[a * width + c] = Math.min(
        ...bgs.map((bg) =>
          Math.max(
            Math.abs(raster.data[i]! - bg[0]),
            Math.abs(raster.data[i + 1]! - bg[1]),
            Math.abs(raster.data[i + 2]! - bg[2])
          )
        )
      );
    }
  }

  // First, blobs of anything at all different from the background; then, each of those cut up
  // again, at a threshold relative to its own contrast (so that a dimmed clue is cut the same
  // way as the rest, and faint fringes don't join neighboring digits). A blob that can't be a
  // glyph might be glyphs crossed out in another color, joined up by the lines through them.
  const coarse = new Int32Array(length * width);
  const fine = new Int32Array(length * width);
  const all = { a0: 0, a1: length, c0: 0, c1: width };
  const candidates: Blob[] = [];
  // (Too faint to count as ink, unless the layout says there's a glyph missing there.)
  const faint: Blob[] = [];
  let nextLabel = 1;
  for (const blob of connect(coarse, all, width, (p) => diff[p]! > FAINT, 1)) {
    const contrast = percentile(blobValues(blob, coarse, width, diff), 0.95);
    if (contrast <= FAINT) continue;
    const cut = INK_FRACTION * contrast;
    const inBlob = (p: number) => coarse[p] === blob.label && diff[p]! > cut;
    const parts = connect(fine, blob, width, inBlob, nextLabel);
    nextLabel += parts.length;
    const good = parts.filter((b) => isGlyph(b, pitch));
    if (contrast <= INK_THRESHOLD) {
      faint.push(...good);
      continue;
    }
    if (good.length === parts.length) {
      candidates.push(...good);
      continue;
    }
    candidates.push(...good);
    // (Only what's left over: the glyphs already found aren't found again.)
    const found = new Set(good.map((b) => b.label));
    const struck = byColor(
      raster,
      blob,
      width,
      pixel,
      (p) => inBlob(p) && !found.has(fine[p]!),
      fine,
      nextLabel,
      pitch
    );
    nextLabel += struck.labels;
    candidates.push(...struck.glyphs);
  }
  // Outward from the grid, until there's a gap of more than a cell.
  candidates.sort((p, q) => q.a1 - p.a1);
  const kept: Blob[] = [];
  let frontier = length;
  let k = 0;
  for (; k < candidates.length; k++) {
    const b = candidates[k]!;
    if (frontier - b.a1 > pitch) break;
    kept.push(b);
    frontier = Math.min(frontier, b.a0);
  }

  const asGlyph = (b: Blob) => glyph(raster, lane, b, fine, diff, xy);
  return {
    glyphs: kept.map(asGlyph),
    spare: [...faint, ...candidates.slice(k)].map(asGlyph),
  };
}

/**
 * The background colors that might be at each point along `lane`: the commonest color across its
 * middle half, over about a cell's length around that point; and, if they're clearly different,
 * ending there, and starting there. (The middle, since a lane's sides can be the gaps between
 * clue boxes. The ones to either side, for where one background meets another, say, at the top
 * of a clue box: there, over a cell's length around it, the other one can be commoner. Only if
 * they're clearly different, since in a gradient, a faint digit can be nearly the same as the
 * background a little way off. And nothing shorter than a cell: over a third of one, the
 * commonest color can be a bold digit's.)
 */
function backgrounds(
  raster: Raster,
  lane: Lane,
  pixel: (a: number, c: number) => number,
  pitch: number
): RGB[][] {
  const block = Math.max(4, Math.round(pitch / 3));
  const blocks = Math.ceil(lane.length / block);
  type Bin = { n: number; r: number; g: number; b: number };
  const histograms: Map<number, Bin>[] = [];
  const [c0, c1] = [
    Math.floor(lane.width / 4),
    Math.ceil((3 * lane.width) / 4),
  ];
  for (let k = 0; k < blocks; k++) {
    const hist = new Map<number, Bin>();
    for (let a = k * block; a < Math.min(lane.length, (k + 1) * block); a++) {
      for (let c = c0; c < c1; c++) {
        const i = pixel(a, c);
        const [r, g, b] = [
          raster.data[i]!,
          raster.data[i + 1]!,
          raster.data[i + 2]!,
        ];
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        let bin = hist.get(key);
        if (!bin) hist.set(key, (bin = { n: 0, r: 0, g: 0, b: 0 }));
        bin.n++;
        bin.r += r;
        bin.g += g;
        bin.b += b;
      }
    }
    histograms.push(hist);
  }
  const commonest = (hist: Map<number, Bin>): RGB => {
    let best: Bin = { n: 1, r: 0, g: 0, b: 0 };
    for (const bin of hist.values()) if (bin.n > best.n) best = bin;
    return [best.r / best.n, best.g / best.n, best.b / best.n];
  };
  /** The commonest color over blocks `from` to `to` (inclusive). */
  const over = (from: number, to: number): RGB => {
    const merged = new Map<number, Bin>();
    for (let j = Math.max(0, from); j <= Math.min(blocks - 1, to); j++) {
      for (const [key, bin] of histograms[j]!) {
        const m = merged.get(key);
        if (!m) merged.set(key, { ...bin });
        else {
          m.n += bin.n;
          m.r += bin.r;
          m.g += bin.g;
          m.b += bin.b;
        }
      }
    }
    return commonest(merged);
  };
  const colors: RGB[][] = [];
  for (let k = 0; k < blocks; k++) {
    const around = over(k - 1, k + 1);
    const sides = [over(k - 2, k), over(k, k + 2)].filter(
      (c) => colorDiff(c, around) > BACKGROUND_CHANGE
    );
    colors.push([around, ...sides]);
  }
  return Array.from(
    { length: lane.length },
    (_, a) => colors[Math.floor(a / block)]!
  );
}

/**
 * The 8-connected blobs of pixels in `region` of a lane that are `ink`, labeled (in `labels`)
 * from `first`.
 */
function connect(
  labels: Int32Array,
  region: { a0: number; a1: number; c0: number; c1: number },
  width: number,
  ink: (p: number) => boolean,
  first: number
): Blob[] {
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let a = region.a0; a < region.a1; a++) {
    for (let c = region.c0; c < region.c1; c++) {
      const start = a * width + c;
      if (labels[start] !== 0 || !ink(start)) continue;
      const blob: Blob = {
        label: first + blobs.length,
        a0: Infinity,
        a1: -Infinity,
        c0: Infinity,
        c1: -Infinity,
        pixels: 0,
        touchesSide: false,
      };
      labels[start] = blob.label;
      stack.push(start);
      while (stack.length > 0) {
        const p = stack.pop()!;
        const pa = Math.floor(p / width);
        const pc = p - pa * width;
        blob.pixels++;
        blob.a0 = Math.min(blob.a0, pa);
        blob.a1 = Math.max(blob.a1, pa + 1);
        blob.c0 = Math.min(blob.c0, pc);
        blob.c1 = Math.max(blob.c1, pc + 1);
        if (pc === 0 || pc === width - 1) blob.touchesSide = true;
        for (let da = -1; da <= 1; da++) {
          for (let dc = -1; dc <= 1; dc++) {
            const [na, nc] = [pa + da, pc + dc];
            if (na < region.a0 || na >= region.a1) continue;
            if (nc < region.c0 || nc >= region.c1) continue;
            const q = na * width + nc;
            if (labels[q] !== 0 || !ink(q)) continue;
            labels[q] = blob.label;
            stack.push(q);
          }
        }
      }
      blobs.push(blob);
    }
  }
  return blobs;
}

/** Whether `blob` could be a glyph: not touching the lane's sides, no longer than a cell and a
 * half, and not just a speck. */
function isGlyph(blob: Blob, pitch: number): boolean {
  return (
    !blob.touchesSide &&
    blob.a1 - blob.a0 <= 1.5 * pitch &&
    blob.pixels >= 4 &&
    Math.max(blob.a1 - blob.a0, blob.c1 - blob.c0) >= 0.12 * pitch
  );
}

/** The values in `of` of `blob`'s pixels. */
function blobValues(
  blob: Blob,
  labels: Int32Array,
  width: number,
  of: Uint8Array
): number[] {
  const out: number[] = [];
  for (let a = blob.a0; a < blob.a1; a++) {
    for (let c = blob.c0; c < blob.c1; c++) {
      if (labels[a * width + c] === blob.label) out.push(of[a * width + c]!);
    }
  }
  return out;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((p, q) => p - q);
  return sorted[Math.floor(fraction * (sorted.length - 1))]!;
}

/**
 * The glyphs in `blob` (whose `ink` pixels aren't glyphs as they are), if its ink is in two
 * colors and the pixels of one of them are glyphs: say, digits crossed out with lines of another
 * color, which join them up. Labels them in `labels` from `first`, and returns how many labels
 * that used.
 */
function byColor(
  raster: Raster,
  blob: Blob,
  width: number,
  pixel: (a: number, c: number) => number,
  ink: (p: number) => boolean,
  labels: Int32Array,
  first: number,
  pitch: number
): { glyphs: Blob[]; labels: number } {
  const colors = new Map<number, RGB>();
  for (let a = blob.a0; a < blob.a1; a++) {
    for (let c = blob.c0; c < blob.c1; c++) {
      if (!ink(a * width + c)) continue;
      const i = pixel(a, c);
      colors.set(a * width + c, [
        raster.data[i]!,
        raster.data[i + 1]!,
        raster.data[i + 2]!,
      ]);
    }
  }
  // Three clusters, since the lines' anti-aliased fringes, and the digits', can be a color of
  // their own.
  const centers = kMeans([...colors.values()], 3);
  const apart = centers.some((p) =>
    centers.some((q) => dist(p, q) >= INK_COLORS_APART)
  );
  if (!apart) return { glyphs: [], labels: 0 };
  const nearest = (rgb: RGB) => {
    let best = 0;
    centers.forEach((c, k) => {
      if (dist(rgb, c) < dist(rgb, centers[best]!)) best = k;
    });
    return best;
  };
  const cluster = new Map<number, number>();
  for (const [p, rgb] of colors) cluster.set(p, nearest(rgb));
  // Each color's pixels, as blobs, each in a scratch labeling (so that the losers' don't stay).
  // Pixels of other colors between two of its own, close together, count as its own: they're
  // where a line crosses a digit's stroke.
  let best: Blob[] = [];
  let bestPixels = 0;
  let bestLabels: Int32Array | undefined;
  for (let k = 0; k < centers.length; k++) {
    const sees = (a: number, c: number, da: number, dc: number) => {
      for (let t = 1; t <= BRIDGE; t++) {
        const [na, nc] = [a + t * da, c + t * dc];
        if (na < blob.a0 || na >= blob.a1 || nc < blob.c0 || nc >= blob.c1)
          return false;
        const there = cluster.get(na * width + nc);
        if (there === undefined) return false;
        if (there === k) return true;
      }
      return false;
    };
    const mine = (p: number) => {
      const here = cluster.get(p);
      if (here === undefined) return false;
      if (here === k) return true;
      const a = Math.floor(p / width);
      const c = p - a * width;
      return DIRECTIONS.some(
        ([da, dc]) => sees(a, c, da, dc) && sees(a, c, -da, -dc)
      );
    };
    const scratch = new Int32Array(labels.length);
    const parts = connect(scratch, blob, width, mine, first);
    const good = parts.filter((b) => isGlyph(b, pitch));
    const pixels = good.reduce((sum, b) => sum + b.pixels, 0);
    if (pixels > bestPixels) {
      [best, bestPixels, bestLabels] = [good, pixels, scratch];
    }
  }
  if (!bestLabels) return { glyphs: [], labels: 0 };
  const kept = new Set(best.map((b) => b.label));
  for (let a = blob.a0; a < blob.a1; a++) {
    for (let c = blob.c0; c < blob.c1; c++) {
      const l = bestLabels[a * width + c]!;
      if (kept.has(l)) labels[a * width + c] = l;
    }
  }
  for (const b of best) b.struck = true;
  const used = best.reduce((m, b) => Math.max(m, b.label - first + 1), 0);
  return { glyphs: best, labels: used };
}

/** How different two colors are, in the most different of R, G, B. */
function colorDiff(p: RGB, q: RGB): number {
  return Math.max(
    Math.abs(p[0] - q[0]),
    Math.abs(p[1] - q[1]),
    Math.abs(p[2] - q[2])
  );
}

function dist(p: RGB, q: RGB): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** `k` clusters of `colors` (by k-means, started from colors far apart), as their centers. Fewer,
 * if there aren't that many different colors. */
function kMeans(colors: RGB[], k: number): RGB[] {
  if (colors.length === 0) return [];
  let centers: RGB[] = [colors[0]!];
  while (centers.length < k) {
    let far = colors[0]!;
    let farD = 0;
    for (const c of colors) {
      const d = Math.min(...centers.map((m) => dist(c, m)));
      if (d > farD) [far, farD] = [c, d];
    }
    if (farD === 0) break;
    centers.push(far);
  }
  for (let round = 0; round < 8; round++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const c of colors) {
      let best = 0;
      centers.forEach((m, j) => {
        if (dist(c, m) < dist(c, centers[best]!)) best = j;
      });
      const s = sums[best]!;
      s[0]! += c[0];
      s[1]! += c[1];
      s[2]! += c[2];
      s[3]! += 1;
    }
    centers = sums
      .filter((s) => s[3]! > 0)
      .map(([r, g, b, n]) => [r! / n!, g! / n!, b! / n!]);
  }
  return centers;
}

/** `blob` as a glyph, in the picture's coordinates. Its ink includes the faint fringe around it
 * (but not other blobs'). */
function glyph(
  raster: Raster,
  lane: Lane,
  blob: Blob,
  labels: Int32Array,
  diff: Uint8Array,
  xy: (a: number, c: number) => [number, number]
): Glyph {
  const { width } = lane;
  // The contrast is a high percentile of the blob's own pixels (not the maximum, which can be a
  // compression artifact).
  const own: number[] = [];
  for (let a = blob.a0; a < blob.a1; a++) {
    for (let c = blob.c0; c < blob.c1; c++) {
      if (labels[a * width + c] === blob.label) own.push(diff[a * width + c]!);
    }
  }
  own.sort((p, q) => p - q);
  const contrast = own[Math.floor(0.9 * (own.length - 1))]!;

  const [xa, ya] = xy(blob.a0, blob.c0);
  const [xb, yb] = xy(blob.a1 - 1, blob.c1 - 1);
  const [x0, x1, y0, y1] = [xa, xb + 1, ya, yb + 1];
  const w = x1 - x0;
  const ink = new Float32Array(w * (y1 - y0));
  const color: RGB = [0, 0, 0];
  let colored = 0;
  for (let a = blob.a0; a < blob.a1; a++) {
    for (let c = blob.c0; c < blob.c1; c++) {
      const l = labels[a * width + c];
      if (l !== blob.label && (l !== 0 || blob.struck)) continue;
      const d = diff[a * width + c]!;
      const [x, y] = xy(a, c);
      ink[(y - y0) * w + (x - x0)] = Math.min(1, d / contrast);
      if (d >= contrast) {
        const i = (y * raster.width + x) * 3;
        color[0] += raster.data[i]!;
        color[1] += raster.data[i + 1]!;
        color[2] += raster.data[i + 2]!;
        colored++;
      }
    }
  }
  return {
    x0,
    y0,
    x1,
    y1,
    ink,
    contrast,
    color: color.map((v) => v / Math.max(1, colored)) as RGB,
    struck: blob.struck ?? false,
  };
}

/** `glyphs` in lines of text (of glyphs whose heights overlap by at least half), top to bottom,
 * each left to right. */
export function textLines(glyphs: Glyph[]): Glyph[][] {
  const byTop = [...glyphs].sort((p, q) => p.y0 - q.y0);
  const lines: Glyph[][] = [];
  for (const g of byTop) {
    const line = lines.find((l) =>
      l.some((o) => {
        const overlap = Math.min(o.y1, g.y1) - Math.max(o.y0, g.y0);
        return overlap >= 0.5 * Math.min(o.y1 - o.y0, g.y1 - g.y0);
      })
    );
    if (line) line.push(g);
    else lines.push([g]);
  }
  return lines.map((l) => l.sort((p, q) => p.x0 - q.x0));
}

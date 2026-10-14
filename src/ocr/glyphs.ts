/**
 * Finding the glyphs (digits, mostly) of each lane's clues, once the grid is known.
 *
 * Each column's clues are above it, between its two lines carried on upward, and each row's are
 * left of it. Within a lane, the background is whatever color is commonest nearby (or, for a
 * clue in a box of its own, the box's color); ink is anything different enough from it. The
 * glyphs are the connected blobs of ink in a run outward from the grid, each no further from the
 * last than about a cell's width. (Further out, there's likely a title, or buttons.)
 */

import type { Grid } from './grid.ts';
import type { Raster } from './raster.ts';
import { SCREENSHOT, type Settings } from './settings.ts';

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
/** A glyph past a gap more than this many times the usual one, and further off-center than this
 * fraction of its lane's width, is a stray (see `dropStrays`). */
const STRAY_GAP = 2;
const STRAY_OFFSET = 0.15;
/** An X crossing out a clue's cell (see `crossedCells`): how far its length can be from a whole
 * number of cells, how close (as a fraction of a cell) its ink must come to each point along its
 * diagonals, and at what fraction of them. */
const CELL_SLACK = 0.25;
const X_REACH = 0.08;
const X_COVERAGE = 0.9;
/** How much of a blob's contrast its ink must have to be strong (not an anti-aliased edge). */
const STRONG_INK = 0.8;
/** A box of its own behind a clue (see `findBoxes`): how close (in any of R, G, B) to the color
 * where it starts a pixel must be to be part of it; the least it can be across, and the most, as
 * fractions of a cell; how much of its bounds it and what it encloses must fill; and how much it
 * must fill by itself. */
const BOX_FLAT = 32;
const BOX_MIN = 0.6;
const BOX_MAX = 1.5;
const BOX_SOLID = 0.75;
const BOX_OWN = 0.6;
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

/** The glyphs in front of each of `grid`'s lanes. */
export function findGlyphs(
  raster: Raster,
  grid: Grid,
  settings: Settings = SCREENSHOT
): LaneGlyphs {
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
    .filter((h) => h >= settings.typicalFrom * pitch)
    .sort((p, q) => p - q);
  const typical = heights[Math.floor(heights.length / 2)] ?? 0;
  const big = (g: Glyph) => bigEnough(g, typical);
  for (const f of [...columns, ...rows]) {
    f.glyphs = f.glyphs.filter(big);
    f.spare = f.spare.filter(big);
  }
  dropStrays(columnLanes, columns);
  dropStrays(rowLanes, rows);

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

/** How far `g`'s near end, and its far end, are from the grid, along `lane`. */
function reach(lane: Lane, g: Glyph): [number, number] {
  return lane.vertical
    ? [lane.length - g.y1, lane.length - g.y0]
    : [lane.length - g.x1, lane.length - g.x0];
}

/**
 * Moves each lane's glyphs, from the first stray outward, to its spares. A stray is past a gap
 * more than `STRAY_GAP` times the usual one between glyphs (in lanes of that direction), and
 * further off-center than `STRAY_OFFSET` of the lane's width (compared with the usual glyph's
 * offset, since some apps don't center the clues). Clues are neither: sample 24's "FILLS 103/144"
 * above a column's clues, and a bit of sample 29's background left of a row's, are both. Neither
 * by itself is enough: real clues are as far apart in some samples, and two-digit numbers in
 * narrow columns are as far off-center.
 */
function dropStrays(lanes: Lane[], found: Found[]): void {
  const walks = found.map((f, i) => {
    const lane = lanes[i]!;
    const sorted = [...f.glyphs].sort(
      (p, q) => reach(lane, p)[0] - reach(lane, q)[0]
    );
    let frontier = -Infinity;
    return sorted.map((g) => {
      const [near, far] = reach(lane, g);
      const gap = near - frontier;
      frontier = Math.max(frontier, far);
      return { g, gap, offset: across(lane, g) / lane.width };
    });
  });
  const gaps = walks.flatMap((w) =>
    w.slice(1).flatMap(({ gap }) => (gap > 0 ? [gap] : []))
  );
  if (gaps.length === 0) return;
  const usualGap = median(gaps);
  const usualOffset = median(walks.flat().map(({ offset }) => offset));
  walks.forEach((w, i) => {
    const n = w.findIndex(
      ({ gap, offset }, k) =>
        k > 0 &&
        gap > STRAY_GAP * usualGap &&
        Math.abs(offset - usualOffset) > STRAY_OFFSET
    );
    if (n < 0) return;
    const strays = new Set(w.slice(n).map(({ g }) => g));
    const f = found[i]!;
    f.glyphs = f.glyphs.filter((g) => !strays.has(g));
    f.spare.push(...strays);
  });
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
  /** The ends, along the lane, of the box it's in, if it's in a box of its own. */
  box?: [number, number];
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

  // Inside a box of its own, a clue's background is the box. (And the box isn't the background
  // of anything outside it.)
  const boxes = findBoxes(raster, lane, pixel, pitch);
  const background = backgrounds(
    raster,
    lane,
    pixel,
    pitch,
    (a, c) => boxes.of[a * width + c] !== 0
  );
  // How different each pixel is from the background (whichever is closer).
  const diff = new Uint8Array(length * width);
  for (let a = 0; a < length; a++) {
    const around = background[a]!;
    for (let c = 0; c < width; c++) {
      const i = pixel(a, c);
      const box = boxes.of[a * width + c]!;
      const bgs = box === 0 ? around : [boxes.boxes[box - 1]!.color];
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
    // (Its color, where its ink is strong.)
    const strong = (p: number): RGB | undefined => {
      if (diff[p]! < STRONG_INK * contrast) return undefined;
      const a = Math.floor(p / width);
      const i = pixel(a, p - a * width);
      return [raster.data[i]!, raster.data[i + 1]!, raster.data[i + 2]!];
    };
    for (const part of parts) {
      if (isGlyph(part, pitch)) continue;
      const crosses = crossedCells(part, fine, width, strong, nextLabel, pitch);
      nextLabel += crosses.length;
      good.push(...crosses);
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
  // Outward from the grid, until there's a gap of more than a cell. (A glyph in a box of its own
  // reaches as far as its box does: the boxes are what's spaced out.)
  for (const b of candidates) {
    const box = boxes.of[firstPixel(b, fine, width)]!;
    if (box !== 0) b.box = boxes.boxes[box - 1]!.ends;
  }
  const ends = (b: Blob) => b.box ?? [b.a0, b.a1];
  candidates.sort((p, q) => ends(q)[1] - ends(p)[1]);
  const kept: Blob[] = [];
  let frontier = length;
  let k = 0;
  for (; k < candidates.length; k++) {
    const b = candidates[k]!;
    if (frontier - ends(b)[1] > pitch) break;
    kept.push(b);
    frontier = Math.min(frontier, ends(b)[0]);
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
 * commonest color can be a bold digit's. Even over a cell, it can be, on a textured background,
 * whose color is spread over many shades, beside a bold "10" filling a cell of its own (sample
 * 12, whose crossed-out "10"s were lost that way). So the color to either side has to be the
 * commonest over two cells, too, as another background would be.)
 *
 * Pixels that `skip` says are in a box of their own (see `findBoxes`) don't count: such a box is
 * the background of what's in it, and of nothing else. Where they leave nothing to count, the
 * background is that of the nearest place that has something.
 */
function backgrounds(
  raster: Raster,
  lane: Lane,
  pixel: (a: number, c: number) => number,
  pitch: number,
  skip: (a: number, c: number) => boolean
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
        if (skip(a, c)) continue;
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
  /** The commonest color over blocks `from` to `to` (inclusive), or over as many more either
   * side as it takes to find any. */
  const over = (from: number, to: number): RGB => {
    const merged = new Map<number, Bin>();
    const add = (j: number) => {
      if (j < 0 || j >= blocks) return;
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
    };
    for (let j = from; j <= to; j++) add(j);
    for (let more = 1; merged.size === 0 && more < blocks; more++) {
      add(from - more);
      add(to + more);
    }
    return commonest(merged);
  };
  const colors: RGB[][] = [];
  for (let k = 0; k < blocks; k++) {
    const around = over(k - 1, k + 1);
    // (Only where there's room for that: at the end of a lane, both windows would be cut short
    // to the same few pixels of digit.)
    const sides: RGB[] = [];
    const side = (c: RGB, longer: RGB) => {
      if (
        colorDiff(c, around) > BACKGROUND_CHANGE &&
        colorDiff(c, longer) <= BACKGROUND_CHANGE
      )
        sides.push(c);
    };
    if (k >= 5) side(over(k - 2, k), over(k - 5, k));
    if (k + 5 < blocks) side(over(k, k + 2), over(k, k + 5));
    colors.push([around, ...sides]);
  }
  return Array.from(
    { length: lane.length },
    (_, a) => colors[Math.floor(a / block)]!
  );
}

/** A box of its own behind a clue: its color, and its ends along the lane. */
type Box = { color: RGB; ends: [number, number] };

/**
 * The boxes in `lane` that each hold a clue of their own, as in sample 34, whose clues are white
 * on black squares, a little apart, on white: `of` says which box (counting from 1) each pixel is
 * in, or 0. With boxes about a cell long and gaps between them, which color is commonest changes
 * from place to place, so the background can't be told that way. But a box encloses its clue,
 * and a clue never encloses its background.
 *
 * A box is an area of one flat color, about a cell across both ways, that with what it encloses
 * (the clue) nearly fills its bounds, and by itself fills most of them (a bold "0" encloses its
 * middle too, but it's narrower than that, and mostly not ink). Past both its ends there has to be
 * another color: where the clues are in cells that carry on the grid's lines (samples 12 and
 * 19), each cell is such an area, but past the line at its end is another just like it, and it's
 * no different from the background.
 */
function findBoxes(
  raster: Raster,
  lane: Lane,
  pixel: (a: number, c: number) => number,
  pitch: number
): { of: Int32Array; boxes: Box[] } {
  const { length, width } = lane;
  const of = new Int32Array(length * width);
  const boxes: Box[] = [];
  const [least, most] = [BOX_MIN * pitch, BOX_MAX * pitch];
  if (width < least) return { of, boxes };
  // (The lane's pixels, copied out: this looks at each of them several times.)
  const colors = new Uint8Array(length * width * 3);
  for (let a = 0; a < length; a++) {
    for (let c = 0; c < width; c++) {
      const i = pixel(a, c);
      colors.set(raster.data.subarray(i, i + 3), (a * width + c) * 3);
    }
  }
  const rgb = (p: number): RGB => [
    colors[p * 3]!,
    colors[p * 3 + 1]!,
    colors[p * 3 + 2]!,
  ];
  // Areas of one color: 4-connected, so that what they enclose is sealed in.
  const area = new Int32Array(length * width);
  const stack: number[] = [];
  let label = 0;
  let [r, g, b] = [0, 0, 0];
  const join = (q: number) => {
    if (
      area[q] !== 0 ||
      Math.abs(colors[q * 3]! - r) > BOX_FLAT ||
      Math.abs(colors[q * 3 + 1]! - g) > BOX_FLAT ||
      Math.abs(colors[q * 3 + 2]! - b) > BOX_FLAT
    )
      return;
    area[q] = label;
    stack.push(q);
  };
  for (let start = 0; start < area.length; start++) {
    if (area[start] !== 0) continue;
    [r, g, b] = rgb(start);
    label++;
    let [a0, a1, c0, c1] = [Infinity, -Infinity, Infinity, -Infinity];
    const sum = [0, 0, 0];
    let pixels = 0;
    area[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const pa = Math.floor(p / width);
      const pc = p - pa * width;
      pixels++;
      sum[0]! += colors[p * 3]!;
      sum[1]! += colors[p * 3 + 1]!;
      sum[2]! += colors[p * 3 + 2]!;
      if (pa < a0) a0 = pa;
      if (pa >= a1) a1 = pa + 1;
      if (pc < c0) c0 = pc;
      if (pc >= c1) c1 = pc + 1;
      if (pc + 1 < width) join(p + 1);
      if (pa + 1 < length) join(p + width);
      if (pc > 0) join(p - 1);
      if (pa > 0) join(p - width);
    }
    const [long, wide] = [a1 - a0, c1 - c0];
    if (long < least || long > most || wide < least || wide > most) continue;
    const size = long * wide;
    if (pixels < BOX_OWN * size) continue;
    const color = sum.map((v) => v / pixels) as RGB;

    // What it encloses: whatever else is in its bounds that can't be reached from their edge.
    const outside = new Uint8Array(size);
    const at = (a: number, c: number) => (a - a0) * wide + (c - c0);
    const reach = (a: number, c: number) => {
      if (a < a0 || a >= a1 || c < c0 || c >= c1) return;
      if (area[a * width + c] === label || outside[at(a, c)] !== 0) return;
      outside[at(a, c)] = 1;
      stack.push(a * width + c);
    };
    for (let a = a0; a < a1; a++) {
      reach(a, c0);
      reach(a, c1 - 1);
    }
    for (let c = c0; c < c1; c++) {
      reach(a0, c);
      reach(a1 - 1, c);
    }
    while (stack.length > 0) {
      const p = stack.pop()!;
      const pa = Math.floor(p / width);
      const pc = p - pa * width;
      for (let da = -1; da <= 1; da++)
        for (let dc = -1; dc <= 1; dc++) reach(pa + da, pc + dc);
    }
    const enclosed: number[] = [];
    const ink = { a0: Infinity, a1: -Infinity, c0: Infinity, c1: -Infinity };
    let inked = 0;
    for (let a = a0; a < a1; a++) {
      for (let c = c0; c < c1; c++) {
        const p = a * width + c;
        if (area[p] === label || outside[at(a, c)] !== 0) continue;
        enclosed.push(p);
        if (colorDiff(rgb(p), color) <= INK_THRESHOLD) continue;
        inked++;
        ink.a0 = Math.min(ink.a0, a);
        ink.a1 = Math.max(ink.a1, a + 1);
        ink.c0 = Math.min(ink.c0, c);
        ink.c1 = Math.max(ink.c1, c + 1);
      }
    }
    if (pixels + enclosed.length < BOX_SOLID * size) continue;
    // (As `isGlyph` has it: not just a speck.)
    if (inked < 4) continue;
    if (Math.max(ink.a1 - ink.a0, ink.c1 - ink.c0) < 0.12 * pitch) continue;

    // Past each end, mostly another color. (One end can be the lane's, but not both: a lane
    // that's all one area has a background, not a box.)
    const beyond = Math.max(3, Math.round(pitch / 5));
    const another = (from: number, to: number) => {
      let [same, all] = [0, 0];
      for (let a = Math.max(0, from); a < Math.min(length, to); a++) {
        for (let c = c0; c < c1; c++) {
          all++;
          if (colorDiff(rgb(a * width + c), color) <= BOX_FLAT) same++;
        }
      }
      return all === 0 ? undefined : same < 0.5 * all;
    };
    const past = [
      another(a0 - 1 - beyond, a0 - 1),
      another(a1 + 1, a1 + 1 + beyond),
    ];
    if (past.includes(false) || !past.includes(true)) continue;

    boxes.push({ color, ends: [a0, a1] });
    for (let a = a0; a < a1; a++) {
      for (let c = c0; c < c1; c++) {
        const p = a * width + c;
        if (area[p] === label || outside[at(a, c)] === 0) of[p] = boxes.length;
      }
    }
  }
  return { of, boxes };
}

/** One of `blob`'s pixels. */
function firstPixel(blob: Blob, labels: Int32Array, width: number): number {
  for (let a = blob.a0; a < blob.a1; a++) {
    for (let c = blob.c0; c < blob.c1; c++) {
      if (labels[a * width + c] === blob.label) return a * width + c;
    }
  }
  return blob.a0 * width + blob.c0;
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

/**
 * The cells that `blob` (which can't be a glyph as it is) crosses out, each as a blob of its own,
 * labeled in `labels` from `first`. Some apps (sample 19) cross out a clue with an X from corner
 * to corner of its cell, in place of the clue. It touches the lane's sides, and joins the X's in
 * the cells beside it. So a blob across the lane, and a whole number of cells long, is cut into
 * cells, and each one whose ink runs along both its diagonals is an X.
 */
function crossedCells(
  blob: Blob,
  labels: Int32Array,
  width: number,
  strong: (p: number) => RGB | undefined,
  first: number,
  pitch: number
): Blob[] {
  const length = blob.a1 - blob.a0;
  const n = Math.round(length / pitch);
  if (n < 1 || Math.abs(length - n * pitch) > CELL_SLACK * pitch) return [];
  if (blob.c0 > 0 || blob.c1 < width) return [];
  const reach = Math.max(2, Math.round(X_REACH * pitch));
  const crosses: Blob[] = [];
  for (let k = 0; k < n; k++) {
    const [a0, a1] = [
      blob.a0 + Math.round((k * length) / n),
      blob.a0 + Math.round(((k + 1) * length) / n),
    ];
    const near = (a: number, c: number) => {
      for (let da = -reach; da <= reach; da++) {
        for (let dc = -reach; dc <= reach; dc++) {
          const [na, nc] = [Math.round(a) + da, Math.round(c) + dc];
          if (na < a0 || na >= a1 || nc < 0 || nc >= width) continue;
          if (labels[na * width + nc] === blob.label) return true;
        }
      }
      return false;
    };
    let along = 0;
    const steps = 16;
    for (let s = 0; s <= steps; s++) {
      const t = 0.1 + (0.8 * s) / steps;
      const a = a0 + t * (a1 - a0 - 1);
      if (near(a, t * (width - 1)) && near(a, (1 - t) * (width - 1))) along++;
    }
    if (along < X_COVERAGE * (steps + 1)) continue;
    // And its ink is all one color. (Otherwise, it's likely drawn over a digit, as in sample 15,
    // whose X's are red, and `byColor` can find the digit. Only the strong ink counts, since the
    // anti-aliased edges of a black X are gray.)
    const colors: RGB[] = [];
    for (let a = a0; a < a1; a++) {
      for (let c = 0; c < width; c++) {
        if (labels[a * width + c] !== blob.label) continue;
        const color = strong(a * width + c);
        if (color) colors.push(color);
      }
    }
    const centers = kMeans(colors, 2);
    if (
      centers.length > 1 &&
      dist(centers[0]!, centers[1]!) >= INK_COLORS_APART
    )
      continue;
    const cross: Blob = {
      label: first + crosses.length,
      a0: Infinity,
      a1: -Infinity,
      c0: Infinity,
      c1: -Infinity,
      pixels: 0,
      touchesSide: true,
    };
    for (let a = a0; a < a1; a++) {
      for (let c = 0; c < width; c++) {
        if (labels[a * width + c] !== blob.label) continue;
        labels[a * width + c] = cross.label;
        cross.pixels++;
        cross.a0 = Math.min(cross.a0, a);
        cross.a1 = Math.max(cross.a1, a + 1);
        cross.c0 = Math.min(cross.c0, c);
        cross.c1 = Math.max(cross.c1, c + 1);
      }
    }
    crosses.push(cross);
  }
  return crosses;
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

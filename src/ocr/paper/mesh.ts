/**
 * Finding a printed nonogram's grid in a photo, from its heavy lines.
 *
 * Printed grids have a heavy line every fifth line (and around the border), and they're darker
 * than anything the person draws, other than a heavily scribbled fill. So they're found first:
 * the lines (`lines.ts`) that are clearly heavier than the lines around them, and are about five
 * cells apart. Their crossings make a coarse mesh, which is fine enough to follow the page's
 * curl and the camera's perspective. Each block between them is cut evenly into cells (5 by 5,
 * except, perhaps, at the grid's edges).
 *
 * The mesh is also extrapolated past the grid, to where the clues are: the heavy lines usually
 * carry on through them.
 */

import type { Raster } from '../raster.ts';
import { inkMap, shrink, transposeInk, type Ink } from './ink.ts';
import {
  chains,
  crossings,
  fitCurve,
  type Chain,
  type Crossing,
  type Curve,
  type Strip,
} from './lines.ts';

/** How much heavier than the lines around it a chain must be to be a heavy line. */
const HEAVY = 1.5;
/** The fewest crossings a heavy line's chain can have. */
const MIN_HEAVY_CROSSINGS = 4;
/** The fewest crossings a chain must have to count as a line when measuring cells. */
const MIN_LINE_CROSSINGS = 6;
/** How far apart, in pixels, two chains can be (on average, where one's curve meets the
 * other's crossings) and be the same line. */
const SAME_LINE = 3;
/** How much darker than the paper either side (`SIDE` pixels away) a point must be to count as
 * on a line, and how much of a heavy line must be. */
const INKED = 0.05;
const SIDE = 5;
const CONTINUOUS = 0.8;
/** How much of a thin line must be. (Less: they're fainter, and a marker fill beside them
 * makes them hard to tell from it. Digits in a row, or a dashed line, are about half.) */
const LINE_CONTINUOUS = 0.7;
/** How well supported a line making a short block at the grid's edge must be, compared with the
 * other heavy lines. */
const PARTIAL_SUPPORT = 0.6;
/** How near (as a fraction of a cell) a line must be found to where it's expected, and how many
 * of the lines between two heavy lines must be. */
const MATCH = 0.2;
const MATCHED = 0.6;
/** The cells in a block. */
const BLOCK = 5;

/** The lines of one direction (horizontal, or vertical in the transposed picture), and the heavy
 * ones among them. */
export type Family = {
  strips: Strip[];
  chains: Chain[];
  /** The heavy lines' curves, merged from chains, in order. */
  heavy: Curve[];
  /** The crossings on chains that are long and unbroken enough to be printed lines (not rows of
   * digits, or dashed lines). */
  onLines: Set<Crossing>;
};

export type PaperGrid = {
  rows: number;
  cols: number;
  /** Where the point `u` cells across and `v` down from the grid's top left corner is, in the
   * picture. (Past the grid, where the clues are, it's extrapolated.) */
  point: (u: number, v: number) => { x: number; y: number };
  /** The heavy lines used, at each one's number of cells from the top (or left). */
  heavy: { h: number[]; v: number[] };
};

export type PaperDebug = {
  /** The factor the picture was shrunk by, to work on. Everything else here is in the shrunk
   * picture's pixels (vertical lines' curves as `x = at(y)`). */
  factor: number;
  h?: Family;
  v?: Family;
  /** The heavy lines chosen. */
  chosen?: { h: Curve[]; v: Curve[] };
};

export type PaperResult =
  | { ok: true; grid: PaperGrid; debug: PaperDebug }
  | { ok: false; reason: string; debug: PaperDebug };

/** The heavy-looking chains merged into lines: each chain, longest first, joins a line it lies
 * along, or starts one. */
function heavyCurves(cs: Chain[]): Curve[] {
  const heavy = cs
    .filter(
      (c) => c.heaviness >= HEAVY && c.crossings.length >= MIN_HEAVY_CROSSINGS
    )
    .sort((a, b) => b.crossings.length - a.crossings.length);
  const lines: { points: Chain['crossings']; curve: Curve }[] = [];
  for (const chain of heavy) {
    const line = lines.find((l) => {
      const off =
        chain.crossings.reduce(
          (sum, c) => sum + Math.abs(c.y - l.curve.at(c.x)),
          0
        ) / chain.crossings.length;
      return off <= SAME_LINE;
    });
    if (line) {
      line.points = [...line.points, ...chain.crossings];
      line.curve = fitCurve(line.points);
    } else {
      lines.push({ points: chain.crossings, curve: fitCurve(chain.crossings) });
    }
  }
  return lines.map((l) => l.curve);
}

/**
 * How much of `c`, from end to end, is darker than beside it. A printed line is unbroken (but
 * for where it's covered by a fill), where a column of digits that happen to line up has gaps
 * between them.
 */
export function continuity(m: Ink, c: Curve): number {
  const at = (x: number, y: number) =>
    y >= 0 && y < m.height ? m.ink[y * m.width + x]! : 0;
  let inked = 0;
  let total = 0;
  for (let x = Math.ceil(c.from); x <= c.to; x++) {
    if (x < 0 || x >= m.width) continue;
    const y0 = Math.round(c.at(x));
    let on = 0;
    for (let d = -1; d <= 1; d++) on = Math.max(on, at(x, y0 + d));
    const beside = Math.min(at(x, y0 - SIDE), at(x, y0 + SIDE));
    total++;
    if (on - beside >= INKED) inked++;
  }
  return total === 0 ? 0 : inked / total;
}

export function family(m: Ink): Family {
  const strips = crossings(m);
  const cs = chains(strips);
  const heavy = heavyCurves(cs).filter((c) => continuity(m, c) >= CONTINUOUS);
  const onLines = new Set(
    cs
      .filter(
        (c) =>
          c.crossings.length >= MIN_LINE_CROSSINGS &&
          continuity(m, fitCurve(c.crossings)) >= LINE_CONTINUOUS
      )
      .flatMap((c) => c.crossings)
  );
  return { strips, chains: cs, heavy, onLines };
}

/**
 * How many cells there are between curves `a` and `b` (with `a` above), if it's clear: the most
 * that would put lines where they're found. Cutting the space between them evenly into `k`
 * cells puts `k - 1` lines between them; in each strip that both reach, each of those that has
 * a line found near it counts. Twice as many cells puts half its lines where there are none, so
 * the right number matches far better than any bigger one. (Not 1, which has nothing between to
 * check.)
 */
export function cellsBetween(
  f: Family,
  a: Curve,
  b: Curve
): number | undefined {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  const matched = new Array<number>(2 * BLOCK + 1).fill(0);
  const tried = new Array<number>(2 * BLOCK + 1).fill(0);
  for (const strip of f.strips) {
    const x = (strip.from + strip.to) / 2;
    if (x < from || x > to) continue;
    const [top, bottom] = [a.at(x), b.at(x)];
    if (bottom <= top) continue;
    const ys = strip.crossings
      .filter((c) => f.onLines.has(c) && c.y > top && c.y < bottom)
      .map((c) => c.y);
    for (let k = 2; k <= 2 * BLOCK; k++) {
      const cell = (bottom - top) / k;
      for (let m = 1; m < k; m++) {
        const y = top + m * cell;
        tried[k]!++;
        if (ys.some((q) => Math.abs(q - y) <= MATCH * cell)) matched[k]!++;
      }
    }
  }
  for (let k = 2 * BLOCK; k >= 2; k--) {
    if (tried[k]! > 0 && matched[k]! >= MATCHED * tried[k]!) return k;
  }
  return undefined;
}

/**
 * The heavy lines that make the grid, with how many cells each is from the first. From each
 * heavy line, it goes each way to the next heavy line a block (5 cells) on, or two blocks (one
 * heavy line missed). The last line either way can be less than a block on (a grid that isn't a
 * multiple of 5), if there's nothing beyond it. The start that collects the most support wins:
 * a scribbled fill can make a thin line look heavy, and starting from it goes nowhere.
 */
function gridLines(
  f: Family
): { curves: Curve[]; cells: number[] } | undefined {
  const all = f.heavy.filter((c) => c.support >= MIN_HEAVY_CROSSINGS);
  if (all.length < 2) return undefined;
  // In order, at the middle of where they all are.
  const mid = all.map((c) => (c.from + c.to) / 2).sort((p, q) => p - q)[
    all.length >> 1
  ]!;
  all.sort((p, q) => p.at(mid) - q.at(mid));
  const most = Math.max(...all.map((c) => c.support));
  const memo = new Map<string, ReturnType<typeof cellsBetween>>();
  const between = (i: number, j: number) => {
    const key = `${i},${j}`;
    if (!memo.has(key)) memo.set(key, cellsBetween(f, all[i]!, all[j]!));
    return memo.get(key);
  };

  const from = (start: number) => {
    const chosen: { line: number; cells: number }[] = [
      { line: start, cells: 0 },
    ];
    for (const dir of [1, -1]) {
      let current = start;
      let at = 0;
      for (;;) {
        let next: { line: number; cells: number } | undefined;
        let partial: { line: number; cells: number } | undefined;
        for (let j = current + dir; j >= 0 && j < all.length; j += dir) {
          const whole = dir === 1 ? between(current, j) : between(j, current);
          if (whole === undefined) continue;
          const support = all[j]!.support;
          if (whole === BLOCK || whole === 2 * BLOCK) {
            if (!next || support > all[next.line]!.support)
              next = { line: j, cells: whole };
          } else if (
            whole > 0 &&
            whole < BLOCK &&
            !partial &&
            support >= PARTIAL_SUPPORT * most
          ) {
            partial = { line: j, cells: whole };
          }
        }
        const step = next ?? partial;
        if (!step) break;
        at += dir * step.cells;
        chosen.push({ line: step.line, cells: at });
        current = step.line;
        if (!next) break;
      }
    }
    return chosen;
  };

  let best: { line: number; cells: number }[] = [];
  let bestScore = 0;
  for (let start = 0; start < all.length; start++) {
    const chosen = from(start);
    if (chosen.length < 2) continue;
    const score = chosen.reduce((sum, c) => sum + all[c.line]!.support, 0);
    if (score > bestScore) [best, bestScore] = [chosen, score];
  }
  if (best.length < 2) return undefined;
  best.sort((p, q) => p.cells - q.cells);
  const first = best[0]!.cells;
  return {
    curves: best.map((c) => all[c.line]!),
    cells: best.map((c) => c.cells - first),
  };
}

/** Where horizontal curve `h` (`y = h.at(x)`) meets vertical curve `v` (`x = v.at(y)`). */
function meet(h: Curve, v: Curve, guess: number): { x: number; y: number } {
  let x = guess;
  let y = h.at(x);
  for (let k = 0; k < 20; k++) {
    const nx = v.at(y);
    y = h.at(nx);
    if (Math.abs(nx - x) < 0.01) {
      x = nx;
      break;
    }
    x = nx;
  }
  return { x, y };
}

/** The block `cells` falls in, among lines at `at` (cell counts, in order), and how far
 * through it (0 to 1, or beyond, past the ends). */
function locate(at: number[], cells: number): { k: number; f: number } {
  let k = 0;
  while (k < at.length - 2 && cells >= at[k + 1]!) k++;
  return { k, f: (cells - at[k]!) / (at[k + 1]! - at[k]!) };
}

export function findPaperGrid(raster: Raster): PaperResult {
  const { raster: small, factor } = shrink(raster);
  const debug: PaperDebug = { factor };
  const ink = inkMap(small);
  const h = family(ink);
  const v = family(transposeInk(ink));
  debug.h = h;
  debug.v = v;
  const rows = gridLines(h);
  const cols = gridLines(v);
  if (!rows || !cols)
    return { ok: false, reason: 'no heavy lines a block apart', debug };
  if (
    rows.cells[rows.cells.length - 1]! < BLOCK ||
    cols.cells[cols.cells.length - 1]! < BLOCK
  )
    return { ok: false, reason: 'less than a block of cells', debug };
  debug.chosen = { h: rows.curves, v: cols.curves };

  // The mesh: where each heavy line meets each other one.
  const guessX = (cols.curves[0]!.from + cols.curves[0]!.to) / 2;
  const corners = rows.curves.map((hc) =>
    cols.curves.map((vc) => meet(hc, vc, vc.at(hc.at(guessX))))
  );

  // A Coons patch in each block: it follows the heavy lines along all four sides.
  const point = (u: number, w: number) => {
    const { k: j, f: s } = locate(cols.cells, u);
    const { k: i, f: t } = locate(rows.cells, w);
    const [top, bottom] = [rows.curves[i]!, rows.curves[i + 1]!];
    const [left, right] = [cols.curves[j]!, cols.curves[j + 1]!];
    const p00 = corners[i]![j]!;
    const p10 = corners[i]![j + 1]!;
    const p01 = corners[i + 1]![j]!;
    const p11 = corners[i + 1]![j + 1]!;
    const along = (c: Curve, a: number, b: number, f: number) => {
      const x = a + (b - a) * f;
      return { x, y: c.at(x) };
    };
    const across = (c: Curve, a: number, b: number, f: number) => {
      const y = a + (b - a) * f;
      return { x: c.at(y), y };
    };
    const ct = along(top, p00.x, p10.x, s);
    const cb = along(bottom, p01.x, p11.x, s);
    const cl = across(left, p00.y, p01.y, t);
    const cr = across(right, p10.y, p11.y, t);
    const corner = (q: 'x' | 'y') =>
      (1 - s) * (1 - t) * p00[q] +
      s * (1 - t) * p10[q] +
      (1 - s) * t * p01[q] +
      s * t * p11[q];
    const coons = (q: 'x' | 'y') =>
      (1 - t) * ct[q] + t * cb[q] + (1 - s) * cl[q] + s * cr[q] - corner(q);
    // (A shrunk pixel's middle is in the middle of the pixels it was made from.)
    const unshrink = (a: number) => (a + 0.5) * factor - 0.5;
    return { x: unshrink(coons('x')), y: unshrink(coons('y')) };
  };

  return {
    ok: true,
    grid: {
      rows: rows.cells[rows.cells.length - 1]!,
      cols: cols.cells[cols.cells.length - 1]!,
      point,
      heavy: { h: rows.cells, v: cols.cells },
    },
    debug,
  };
}

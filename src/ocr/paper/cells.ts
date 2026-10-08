/**
 * Reading the state of a straightened photo of paper's grid: which cells are filled in, crossed
 * out, or not decided yet.
 *
 * On paper, the person fills a cell however they like (pencil shading, marker, a scribble), and
 * marks one off with an X, small or from corner to corner, or a dot, in whatever they have. So
 * cells aren't grouped by how they look, as in a screenshot (`../cells.ts`), but by how much of
 * each is inked: hardly any of an undecided cell, some of a crossed-out one, and most of a filled
 * one. Where crossed-out and filled divide differs from photo to photo (a fat marker X covers
 * more than half the cell), so it's wherever best splits the cells that have ink.
 */

import type { State } from '../cells.ts';
import type { Grid } from '../grid.ts';
import type { Raster } from '../raster.ts';

/** How far into a cell from its lines (as a fraction of its size) is looked at. */
const MARGIN = 0.15;
/** How dark (0 to 1, in the darkest channel, so colored marker counts) a point must be to be
 * ink. */
const INK = 0.25;
/** A cell with less of it inked than this is undecided. */
const BLANK = 0.03;
/** How far apart the crossed-out and filled cells' average coverage must be, for there to be
 * both. (Otherwise, they're all one or the other.) */
const APART = 0.3;
/** If they're all one, what coverage makes them filled. */
const MOSTLY = 0.5;

/** How much of each cell (row by row) is inked. */
export function coverage(raster: Raster, grid: Grid): number[] {
  const { width, data } = raster;
  const out: number[] = [];
  for (let r = 0; r < grid.rows; r++) {
    const [top, bottom] = [
      grid.horizontal[r]!.center,
      grid.horizontal[r + 1]!.center,
    ];
    for (let c = 0; c < grid.cols; c++) {
      const [left, right] = [
        grid.vertical[c]!.center,
        grid.vertical[c + 1]!.center,
      ];
      const [y0, y1] = inside(top, bottom);
      const [x0, x1] = inside(left, right);
      let inked = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 3;
          const ink = 1 - Math.min(data[i]!, data[i + 1]!, data[i + 2]!) / 255;
          n++;
          if (ink > INK) inked++;
        }
      }
      out.push(n === 0 ? 0 : inked / n);
    }
  }
  return out;
}

function inside(from: number, to: number): [number, number] {
  const m = MARGIN * (to - from);
  return [Math.round(from + m), Math.round(to - m)];
}

/** The threshold that best splits `values` in two (Otsu's), and the two sides' averages. */
function otsu(values: number[]): { t: number; low: number; high: number } {
  const sorted = [...values].sort((p, q) => p - q);
  const total = sorted.reduce((s, v) => s + v, 0);
  let best = { t: sorted[0]!, low: 0, high: total / sorted.length, score: -1 };
  let below = 0;
  for (let i = 1; i < sorted.length; i++) {
    below += sorted[i - 1]!;
    if (sorted[i] === sorted[i - 1]) continue;
    const [n0, n1] = [i, sorted.length - i];
    const [m0, m1] = [below / n0, (total - below) / n1];
    const score = n0 * n1 * (m1 - m0) ** 2;
    if (score > best.score)
      best = { t: (sorted[i - 1]! + sorted[i]!) / 2, low: m0, high: m1, score };
  }
  return best;
}

export function readPaperCells(
  raster: Raster,
  grid: Grid
): { states: State[] } {
  const cover = coverage(raster, grid);
  const inked = cover.filter((c) => c >= BLANK);
  let filledFrom = MOSTLY;
  if (inked.length >= 2) {
    const split = otsu(inked);
    if (split.high - split.low >= APART) filledFrom = split.t;
    else {
      // All one kind.
      const mean = inked.reduce((s, v) => s + v, 0) / inked.length;
      filledFrom = mean >= MOSTLY ? BLANK : Infinity;
    }
  }
  return {
    states: cover.map((c) =>
      c < BLANK ? 'undecided' : c >= filledFrom ? 'filled' : 'crossed'
    ),
  };
}

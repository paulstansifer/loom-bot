/**
 * Telling where the grid is within a bigger rectangle of cells, from where the clues are: for
 * when the clues are drawn in cells of their own, carrying on the grid's lines (sample 19), or
 * on graph paper ruled at the grid's spacing (sample 12).
 *
 * Every lane has at least one clue (if only a 0), and the clues are pushed up against the grid.
 * So the cell just outside the grid's edge has a digit in it in nearly every lane, and no cell
 * inside it ever does. (Marks crossing out cells do, but they're told from digits by naming.)
 * Clues can be on any side: sample 12 has them on all four.
 */

import { cluster, look, meanLook } from './cluster.ts';
import { bigEnough, type Glyph, stripGlyphs } from './glyphs.ts';
import {
  findGrid,
  type Grid,
  type GridResult,
  type Rectangle,
} from './grid.ts';
import { isDigit, name } from './names.ts';
import type { Raster } from './raster.ts';

/** How far a group's look can be from the nearest template, and still be named a digit.
 * (Further, it's likely bits of something else.) */
const MAX_DISTANCE = 0.3;
/** How much a digit inside the grid counts against it, against one just outside its edge. */
const INSIDE_PENALTY = 2;
/** The fraction of a side's lanes that must have a digit just outside it for there to be clues
 * there. */
const CLUED = 0.6;
/** The fewest cells across a grid. */
const MIN_CELLS = 4;

/** Which cells of `outer` (row by row) have digits in them. Each cell is looked at by itself,
 * inside its lines, so that nothing joins up across cells: lines crossing out a clue, say, with
 * the grid's border. */
export function digitCells(raster: Raster, outer: Grid): boolean[][] {
  const { horizontal: h, vertical: v, rows, cols } = outer;
  const pitch = (outer.pitch.h + outer.pitch.v) / 2;
  const found: { glyph: Glyph; i: number; j: number }[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const lane = {
        vertical: false,
        begin: v[j]!.trail,
        length: v[j + 1]!.lead - v[j]!.trail,
        start: h[i]!.trail,
        width: h[i + 1]!.lead - h[i]!.trail,
      };
      for (const glyph of stripGlyphs(raster, lane, pitch)) {
        found.push({ glyph, i, j });
      }
    }
  }
  const heights = found
    .map(({ glyph: g }) => g.y1 - g.y0)
    .sort((p, q) => p - q);
  const typical = heights[Math.floor(heights.length / 2)] ?? 0;
  const glyphs = found.filter(({ glyph }) => bigEnough(glyph, typical));

  const looks = glyphs.map(({ glyph }) => look(glyph));
  const groups = cluster(looks, 0.12);
  const count = Math.max(-1, ...groups) + 1;
  const members: number[][] = Array.from({ length: count }, () => []);
  groups.forEach((k, i) => members[k]!.push(i));
  const digit = members.map((m) => {
    const n = name(meanLook(m.map((i) => looks[i]!)));
    return isDigit(n) && n.d <= MAX_DISTANCE;
  });

  const cells = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false)
  );
  glyphs.forEach(({ i, j }, k) => {
    if (digit[groups[k]!]) cells[i]![j] = true;
  });
  return cells;
}

/** A rectangle of cells, and how many lanes have a digit just outside each side of it, and how
 * many digits are inside. */
export type Bounds = {
  rect: Rectangle;
  outside: number;
  inside: number;
  sides: { before: number; after: number; above: number; below: number };
};

/**
 * The rectangle of `cells` (with `top`, etc. counting lines) that best fits the digits around
 * it: the most lanes with a digit just outside an edge, less `INSIDE_PENALTY` for each digit
 * inside. `undefined` if no lane has one outside.
 *
 * A side is only brought in from the edge of `cells` to where there are clues: digits just
 * outside it in `CLUED` of its lanes. Otherwise, one thing in the grid that looks like a digit
 * brings a side in to just short of it: one of sample 33's filled cells, in column 11 of 25, did,
 * since a digit outside counts for the rectangle, and one inside against it.
 */
export function boundsByDigits(cells: boolean[][]): Bounds | undefined {
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  // all(r0, r1, c0, c1): how many digits in rows `[r0, r1)` and columns `[c0, c1)`.
  const pre: number[][] = [new Array<number>(cols + 1).fill(0)];
  cells.forEach((row, r) => {
    const out = [0];
    row.forEach((d, c) =>
      out.push(out[c]! + pre[r]![c + 1]! - pre[r]![c]! + (d ? 1 : 0))
    );
    pre.push(out);
  });
  const all = (r0: number, r1: number, c0: number, c1: number) =>
    pre[r1]![c1]! - pre[r0]![c1]! - pre[r1]![c0]! + pre[r0]![c0]!;

  let best: Bounds | undefined;
  let bestScore = 0;
  for (let top = 0; top + MIN_CELLS <= rows; top++) {
    for (let bottom = top + MIN_CELLS; bottom <= rows; bottom++) {
      const tall = CLUED * (bottom - top);
      for (let left = 0; left + MIN_CELLS <= cols; left++) {
        const before = left > 0 ? all(top, bottom, left - 1, left) : 0;
        if (left > 0 && before < tall) continue;
        for (let right = left + MIN_CELLS; right <= cols; right++) {
          const after = right < cols ? all(top, bottom, right, right + 1) : 0;
          const above = top > 0 ? all(top - 1, top, left, right) : 0;
          const below =
            bottom < rows ? all(bottom, bottom + 1, left, right) : 0;
          const wide = CLUED * (right - left);
          if (
            (right < cols && after < tall) ||
            (top > 0 && above < wide) ||
            (bottom < rows && below < wide)
          )
            continue;
          const outside = before + after + above + below;
          const inside = all(top, bottom, left, right);
          // (Ties go to the bigger rectangle: a side with no clues goes as far as the lines.)
          const area = (bottom - top) * (right - left);
          const score = outside - INSIDE_PENALTY * inside + area * 1e-6;
          if (score > bestScore) {
            bestScore = score;
            best = {
              rect: { top, bottom, left, right },
              outside,
              inside,
              sides: { before, after, above, below },
            };
          }
        }
      }
    }
  }
  return best;
}

/** The grid in `raster`: from its lines, and then, if there are clues within the biggest
 * rectangle of cells, from where they are. */
export function findPuzzle(raster: Raster): GridResult {
  return gridByClues(raster, findGrid(raster));
}

/**
 * The grid in `result`, found again from where the clues are, if they're inside its outer
 * rectangle. (If they aren't, there are no digits there, and the grid stands.)
 */
export function gridByClues(raster: Raster, result: GridResult): GridResult {
  if (!result.ok) return result;
  const found = boundsByDigits(digitCells(raster, result.outer));
  if (!found) return result;
  const used = convincing(found);
  const debug = { ...result.debug, byClues: { ...found, used } };
  if (!used) return { ...result, debug };
  return { ...result, grid: result.within(found.rect), debug };
}

/** Whether `b` has clues just outside it in most lanes, on one side at least. (Not, say, a
 * rectangle as big as `cells`, with nothing outside it.) */
export function convincing(b: Bounds): boolean {
  const { top, bottom, left, right } = b.rect;
  const { before, after, above, below } = b.sides;
  return (
    Math.max(before, after) >= CLUED * (bottom - top) ||
    Math.max(above, below) >= CLUED * (right - left)
  );
}

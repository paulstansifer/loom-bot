/**
 * Reading the state of the grid: which cells the person has filled in, crossed out, or not
 * decided yet. (A port of number-loom's `cells.rs`, changed for what the samples showed.)
 *
 * How an app draws each of those differs from app to app, but within one picture, every filled
 * cell looks like every other, and so on. So the cells are sorted into groups that look alike,
 * and what each group means comes from how it looks:
 *
 * - A group with something drawn on it (an X, a dot) is crossed-out cells.
 * - The color behind those marks is what an undecided cell looks like. (With no marks at all,
 *   it's the commonest cell.)
 * - A plain group far from that color, however it differs (darker in light mode, lighter in dark
 *   mode, another hue), is filled.
 *
 * This doesn't need the clues, which matters because the more of a puzzle is solved, the more
 * of its clues are likely to be crossed out.
 */

import { anything, fromColor } from '../solve/cell.ts';
import { gather } from '../solve/grid.ts';
import { exhaustLine } from '../solve/line.ts';
import type { Puzzle } from '../solve/puzzle.ts';
import type { Grid } from './grid.ts';
import type { Raster } from './raster.ts';

export type State = 'filled' | 'crossed' | 'undecided';

/** Each cell's look is its middle, shrunk to this many pixels on a side. */
const SIZE = 8;
/** How far from a cell's middle (as a fraction of its width) its look goes. It stays clear of
 * the grid's lines, and of the counters some apps print in a cell's corner. */
const HALF = 0.3;
/** How far apart (in RGB, 0 to 1, root mean square over the look) two looks can be to be in the
 * same group, to begin with. */
const NEAR = 0.08;
/** The most groups. (More, and the looks are gradients, so `NEAR` is made looser.) */
const MOST_GROUPS = 16;
/** A group with this much of its look unlike the color around its edges has a mark on it. */
const MARKED = 0.08;
/** Groups of cells whose colors are this close (RGB, 0 to 1) are one family. */
const NEAR_COLOR = 0.12;
/** How much more a family with marks on it counts, against one without. */
const MARKED_BONUS = 1.5;

/** A look is `SIZE * SIZE` pixels of RGB, 0 to 1. */
type Look = Float32Array;

export type CellsReading = {
  /** Each cell's state, row by row. */
  states: State[];
  /** Each cell's group, and each group's meaning. */
  groups: number[];
  meaning: State[];
  /** Each group's average look, and whether it has a mark on it. */
  looks: Look[];
  marked: boolean[];
};

/** Each cell's look, row by row. */
export function cellLooks(raster: Raster, grid: Grid): Look[] {
  const { horizontal: h, vertical: v, rows, cols } = grid;
  const out: Look[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const x = (v[j]!.trail + v[j + 1]!.lead) / 2;
      const y = (h[i]!.trail + h[i + 1]!.lead) / 2;
      out.push(look(raster, x, y, HALF * grid.pitch.v, HALF * grid.pitch.h));
    }
  }
  return out;
}

function look(
  raster: Raster,
  x: number,
  y: number,
  halfX: number,
  halfY: number
): Look {
  const { width, height, data } = raster;
  const sums = new Float32Array(SIZE * SIZE * 3);
  const counts = new Float32Array(SIZE * SIZE);
  const x0 = x - halfX;
  const y0 = y - halfY;
  for (let py = Math.floor(y0); py <= Math.floor(y + halfY); py++) {
    if (py < 0 || py >= height) continue;
    const by = Math.min(SIZE - 1, Math.floor(((py - y0) / (2 * halfY)) * SIZE));
    for (let px = Math.floor(x0); px <= Math.floor(x + halfX); px++) {
      if (px < 0 || px >= width) continue;
      const bx = Math.min(
        SIZE - 1,
        Math.floor(((px - x0) / (2 * halfX)) * SIZE)
      );
      const at = (py * width + px) * 3;
      const bin = by * SIZE + bx;
      for (let c = 0; c < 3; c++) sums[bin * 3 + c]! += data[at + c]! / 255;
      counts[bin]!++;
    }
  }
  for (let i = 0; i < sums.length; i++)
    sums[i]! /= Math.max(counts[Math.floor(i / 3)]!, 1);
  return sums;
}

/** The root mean square difference between two looks, per value. */
function distance(a: Look, b: Look): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(sum / a.length);
}

/**
 * Groups of looks within `near` of the group's average, and each look's group. The first look
 * to be far from every group starts a new one, and then everything is moved to its nearest
 * group (twice), so the order doesn't matter much.
 */
export function group(looks: Look[], near = NEAR): number[] {
  for (;;) {
    const centers: Look[] = [];
    let assign = looks.map((l) => {
      let best = -1;
      let bestDistance = near;
      centers.forEach((c, i) => {
        const d = distance(l, c);
        if (d < bestDistance) [best, bestDistance] = [i, d];
      });
      if (best < 0) centers.push(Float32Array.from(l));
      return best < 0 ? centers.length - 1 : best;
    });
    if (centers.length > MOST_GROUPS) {
      near *= 1.5;
      continue;
    }
    for (let round = 0; round < 2; round++) {
      const means = averages(looks, assign, centers.length);
      assign = looks.map((l) => {
        let best = 0;
        for (let i = 1; i < means.length; i++)
          if (distance(l, means[i]!) < distance(l, means[best]!)) best = i;
        return best;
      });
    }
    return assign;
  }
}

function averages(looks: Look[], assign: number[], k: number): Look[] {
  const sums = Array.from(
    { length: k },
    () => new Float32Array(SIZE * SIZE * 3)
  );
  const counts = new Array<number>(k).fill(0);
  looks.forEach((l, n) => {
    const g = assign[n]!;
    counts[g]!++;
    for (let i = 0; i < l.length; i++) sums[g]![i]! += l[i]!;
  });
  return sums.map((s, g) => s.map((v) => v / Math.max(counts[g]!, 1)));
}

/** The color at the middles of a look's edges (neither an X, corner to corner, nor a dot, in
 * the middle, reaches there), in RGB. */
function edgeColor(l: Look): [number, number, number] {
  const spots: number[] = [];
  for (const edge of [0, SIZE - 1])
    for (const i of [SIZE / 2 - 1, SIZE / 2])
      spots.push(edge * SIZE + i, i * SIZE + edge);
  return [0, 1, 2].map((c) => {
    const values = spots.map((s) => l[s * 3 + c]!).sort((p, q) => p - q);
    return (values[3]! + values[4]!) / 2;
  }) as [number, number, number];
}

/**
 * How much of a look's middle differs from its edges' color: the root mean square of the
 * difference. Only the middle counts: a counter in a cell's corner (sample 26) isn't a mark.
 */
function markedness(l: Look): number {
  const edge = edgeColor(l);
  const [from, to] = [SIZE / 4, (3 * SIZE) / 4];
  let sum = 0;
  for (let y = from; y < to; y++)
    for (let x = from; x < to; x++)
      for (let c = 0; c < 3; c++)
        sum += (l[(y * SIZE + x) * 3 + c]! - edge[c]!) ** 2;
  return Math.sqrt(sum / ((to - from) ** 2 * 3));
}

/** A look's typical color: its median pixel, per channel. */
function typicalColor(l: Look): [number, number, number] {
  return [0, 1, 2].map((c) => {
    const values: number[] = [];
    for (let p = 0; p < SIZE * SIZE; p++) values.push(l[p * 3 + c]!);
    values.sort((a, b) => a - b);
    return values[values.length >> 1]!;
  }) as [number, number, number];
}

function colorDistance(
  a: [number, number, number],
  b: [number, number, number]
): number {
  return Math.sqrt(
    ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) / 3
  );
}

/** What each group of looks means. */
export function meanings(
  looks: Look[],
  groups: number[]
): { meaning: State[]; looks: Look[]; marked: boolean[] } {
  const k = Math.max(-1, ...groups) + 1;
  const means = averages(looks, groups, k);
  const counts = new Array<number>(k).fill(0);
  for (const g of groups) counts[g]!++;
  const marked = means.map((m) => markedness(m) > MARKED);
  const meaning = marked.map<State>((m) => (m ? 'crossed' : 'undecided'));

  // Groups whose colors are close are one family: lighting makes a gradient of undecided cells
  // (a photo's vignette), and a highlighted row or column is a shade off. A marked group's color
  // is what's behind its mark. The undecided cells are the biggest family, with a bonus for one
  // that has marks on it, since the marks mean the cells there could be undecided, and a
  // filled color can be as common (sample 15). Every other plain group is filled, whatever its
  // hue (sample 7's fills come in three).
  const colors = means.map((m, g) =>
    marked[g] ? edgeColor(m) : typicalColor(m)
  );
  const family = means.map((_, g) => g);
  const root = (g: number): number =>
    family[g] === g ? g : (family[g] = root(family[g]!));
  for (let g = 0; g < k; g++)
    for (let h = 0; h < g; h++)
      if (colorDistance(colors[g]!, colors[h]!) < NEAR_COLOR)
        family[root(g)] = root(h);
  const weight = new Map<number, number>();
  means.forEach((_, g) => {
    const r = root(g);
    weight.set(
      r,
      (weight.get(r) ?? 0) + counts[g]! * (marked[g] ? MARKED_BONUS : 1)
    );
  });
  const undecided = [...weight].sort((p, q) => q[1] - p[1])[0]![0];
  means.forEach((_, g) => {
    if (!marked[g] && root(g) !== undecided) meaning[g] = 'filled';
  });
  return { meaning, looks: means, marked };
}

export function readCells(raster: Raster, grid: Grid): CellsReading {
  const all = cellLooks(raster, grid);
  const groups = group(all);
  const { meaning, looks, marked } = meanings(all, groups);
  return {
    states: groups.map((g) => meaning[g]!),
    groups,
    meaning,
    looks,
    marked,
  };
}

/** A reading's states as text: `#` filled, `x` crossed out, `.` undecided. */
export function cellsText(states: State[], cols: number): string {
  const ch = { filled: '#', crossed: 'x', undecided: '.' } as const;
  const lines: string[] = [];
  for (let i = 0; i < states.length; i += cols)
    lines.push(
      states
        .slice(i, i + cols)
        .map((s) => ch[s])
        .join('')
    );
  return lines.join('\n');
}

/** States as the solver's cells: filled is color 1, crossed out is the background, color 0. */
export function stateCells(states: State[]): Uint32Array {
  return Uint32Array.from(states, (s) =>
    s === 'filled' ? fromColor(1) : s === 'crossed' ? fromColor(0) : anything(2)
  );
}

/** The lanes (rows, then columns) where no arrangement of the clues fits the decided cells. */
export function contradicted(puzzle: Puzzle, cells: Uint32Array): number[] {
  const out: number[] = [];
  puzzle.lanes.forEach((clues, lane) => {
    if (!exhaustLine(clues, gather(puzzle, lane, cells), [])) out.push(lane);
  });
  return out;
}

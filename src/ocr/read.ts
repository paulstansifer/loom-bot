/**
 * Reading the clues, from glyphs to numbers: each lane's glyphs (`glyphs.ts`), grouped by how they
 * look (`cluster.ts`), each group named by the nearest template (`names.ts`), and each lane's
 * glyphs grouped into numbers (`numbers.ts`).
 */

import { cluster, look, meanLook } from './cluster.ts';
import { findGlyphs, type Glyph } from './glyphs.ts';
import type { Grid } from './grid.ts';
import { name, type Naming } from './names.ts';
import { numbers } from './numbers.ts';
import type { Raster } from './raster.ts';

/** How close two glyphs' looks must be to be grouped (see `DEVELOPING.md`). */
export const THRESHOLD = 0.12;

export type Reading = {
  grid: Grid;
  /** Every glyph, columns' first. */
  glyphs: Glyph[];
  /** Each glyph's group, each group's glyphs (by index into `glyphs`), and each group's name. */
  groups: number[];
  members: number[][];
  names: Naming[];
  /**
   * Each column's clues, top to bottom, and each row's, left to right. A number with a glyph named
   * "x" in it (a mark crossing out a cell, not a digit) is `NaN`.
   */
  columns: number[][];
  rows: number[][];
  /** Each lane's numbers, as the glyphs (by index into `glyphs`) they're made of. */
  numberGlyphs: { columns: number[][][]; rows: number[][][] };
};

export function readClues(
  raster: Raster,
  grid: Grid,
  threshold = THRESHOLD
): Reading {
  const lanes = findGlyphs(raster, grid);
  const glyphs = [...lanes.columns, ...lanes.rows].flat();
  const looks = glyphs.map(look);
  const groups = cluster(looks, threshold);
  const members: number[][] = Array.from(
    { length: Math.max(-1, ...groups) + 1 },
    () => []
  );
  groups.forEach((k, i) => members[k]!.push(i));
  const names = members.map((m) => name(meanLook(m.map((i) => looks[i]!))));

  const index = new Map(glyphs.map((g, i) => [g, i]));
  const laneNumbers = numbers(lanes);
  const indices = (found: Glyph[][][]) =>
    found.map((lane) => lane.map((n) => n.map((g) => index.get(g)!)));
  const numberGlyphs = {
    columns: indices(laneNumbers.columns),
    rows: indices(laneNumbers.rows),
  };
  return {
    grid,
    glyphs,
    groups,
    members,
    names,
    ...cluesNamed(numberGlyphs, groups, names),
    numberGlyphs,
  };
}

/** Each lane's clues, with each group of glyphs named as `names` says. A number with a glyph
 * named "x" in it is `NaN`. */
export function cluesNamed(
  numberGlyphs: Reading['numberGlyphs'],
  groups: number[],
  names: Naming[]
): { columns: number[][]; rows: number[][] } {
  const read = (found: number[][][]) =>
    found.map((lane) =>
      lane.map((n) => Number(n.map((i) => names[groups[i]!]!.name).join('')))
    );
  return { columns: read(numberGlyphs.columns), rows: read(numberGlyphs.rows) };
}

/** Whether a reading makes sense, without knowing what it should have been. */
export type Consistency = {
  /** The total of the columns' clues, and of the rows'. They should be equal. */
  columnTotal: number;
  rowTotal: number;
  /** Lanes whose clues (with a cell between each) don't fit in them, or have an "x" in them. */
  misfits: number;
  /** Lanes with no clues. Some can be empty, but not most. */
  empty: number;
  /** How sure the naming was: the least margin to the next template, of any group. */
  margin: number;
  consistent: boolean;
};

/** No more than this fraction of the lanes can be empty. */
const MOST_EMPTY = 0.2;

export function consistency(reading: Reading): Consistency {
  const { grid, columns, rows } = reading;
  const total = (lanes: number[][]) =>
    lanes.flat().reduce((sum, n) => sum + (Number.isNaN(n) ? 0 : n), 0);
  const misfitsIn = (lanes: number[][], length: number) =>
    lanes.filter(
      (l) =>
        l.some(Number.isNaN) ||
        l.reduce((sum, n) => sum + n, 0) + l.length - 1 > length
    ).length;
  const [columnTotal, rowTotal] = [total(columns), total(rows)];
  const misfits = misfitsIn(columns, grid.rows) + misfitsIn(rows, grid.cols);
  const empty = [...columns, ...rows].filter((l) => l.length === 0).length;
  return {
    columnTotal,
    rowTotal,
    misfits,
    empty,
    margin: Math.min(...reading.names.map((n) => n.margin)),
    consistent:
      columnTotal === rowTotal &&
      misfits === 0 &&
      empty <= MOST_EMPTY * (columns.length + rows.length),
  };
}

/** A lane's clues as text. No clues reads the same as a single 0, and `NaN` is `?`. */
export function cluesText(clues: number[]): string {
  return clues.length === 0
    ? '0'
    : clues.map((n) => (Number.isNaN(n) ? '?' : String(n))).join(' ');
}

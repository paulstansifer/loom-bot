/**
 * Second thoughts about what groups of glyphs are, where the clues as read don't make sense.
 *
 * Some apps cross out clues in the digits' own color (sample 12), so that `glyphs.ts` can't see
 * it. A crossed-out digit looks different from the plain one, so it's a group of its own, but its
 * name is likely wrong: a struck "1" looks like a "4", a struck "2" like an "8". Someone who's
 * crossed out a clue has usually finished its block, so the grid says what it was (`repair.ts`).
 *
 * And some digits are named wrong, but their second-nearest template is right: sample 19's tiny
 * "6"s look more like a "0", and so does sample 24's one "8" (by 0.001).
 *
 * So a group is taken to be crossed out, or renamed to its second-nearest template, if that makes
 * the clues make more sense: fewer lanes that the grid contradicts, or that don't fit, and the
 * rows' and columns' totals agreeing. Each group changed costs a little, so that groups aren't
 * changed for no reason (taking every group as crossed out would agree with a finished grid
 * perfectly).
 *
 * Only where the clues as read don't make sense, though. If they fit, their totals agree, and
 * they have a solution, they're almost certainly right, and what the grid contradicts is the
 * person's mistakes: sample 33's clues are read right, but its grid has some 50 cells wrong, in
 * 14 lanes, and taking the "1"s as crossed out agreed with it better.
 *
 * `readWithGrid` puts it all together: the clues as read, the grid's state, these second
 * thoughts, and the clues that couldn't be read worked out from the grid.
 */

import { blackAndWhite } from '../solve/puzzle.ts';
import { solve } from '../solve/solve.ts';
import { contradicted, type State, stateCells } from './cells.ts';
import type { Grid } from './grid.ts';
import type { Naming } from './names.ts';
import type { Raster } from './raster.ts';
import {
  cluesNamed,
  fits,
  readClues,
  type Reading,
  THRESHOLD,
} from './read.ts';
import { repair } from './repair.ts';
import { SCREENSHOT, type Settings } from './settings.ts';

/**
 * The clues read from `raster` (as `settings` say), with second thoughts from the grid's state, and those that
 * couldn't be read worked out from it; the grid's state; and how many clues were worked out.
 * `timed` runs each step, to time it.
 */
export function readWithGrid(
  raster: Raster,
  grid: Grid,
  timed: <T>(what: string, f: () => T) => T = (_, f) => f(),
  settings: Settings = SCREENSHOT
): { reading: Reading; states: State[]; filled: number } {
  const read = timed('clues', () =>
    readClues(raster, grid, THRESHOLD, settings)
  );
  const { states } = timed('cells', () => settings.readCells(raster, grid));
  const explained = timed(
    'groups',
    () => explainGroups(read, states, grid.cols, settings.renameGroups).reading
  );
  const fixed = repair(explained.columns, explained.rows, states, grid.cols);
  return {
    reading: { ...explained, columns: fixed.columns, rows: fixed.rows },
    states,
    filled: fixed.filled,
  };
}

/** What taking a group as crossed out costs, against a lane that doesn't make sense, and what
 * renaming one costs. (Renaming costs less: if it's as good, it's better to have read a clue than
 * to have worked it out from the grid.) */
const STRIKE_COST = 0.5;
const RENAME_COST = 0.4;
/** What the totals not agreeing costs. */
const TOTALS = 2;
/** How long to look for a solution to the clues as read, to tell whether they make sense. (If
 * that's not long enough, they get second thoughts.) */
const SOLVE_TIME_MS = 250;

/** Whether clues make sense by themselves: they fit, their totals agree, and they have a
 * solution. */
export function sound(columns: number[][], rows: number[][]): boolean {
  const total = (lanes: number[][]) =>
    lanes.flat().reduce((sum, n) => sum + n, 0);
  if (
    !columns.every((l) => fits(l, rows.length)) ||
    !rows.every((l) => fits(l, columns.length)) ||
    total(columns) !== total(rows)
  )
    return false;
  const answer = solve(blackAndWhite(rows, columns), {
    timeLimitMs: SOLVE_TIME_MS,
  });
  return answer.kind !== 'no-solution' && answer.kind !== 'out-of-time';
}

/** How little sense clues make, given the grid's state: lower is better. */
export function nonsense(
  columns: number[][],
  rows: number[][],
  states: State[],
  cols: number
): number {
  const height = states.length / cols;
  const fixed = repair(columns, rows, states, cols);
  const fits = (lane: number[], length: number) =>
    !lane.some(Number.isNaN) &&
    lane.reduce((sum, n) => sum + n, 0) + lane.length - 1 <= length;
  const rowsOk = fixed.rows.map((l) => fits(l, cols));
  const columnsOk = fixed.columns.map((l) => fits(l, height));
  const ok = [...rowsOk, ...columnsOk];
  const puzzle = blackAndWhite(
    fixed.rows.map((l, i) => (rowsOk[i] ? l : [])),
    fixed.columns.map((l, i) => (columnsOk[i] ? l : []))
  );
  const broken = contradicted(puzzle, stateCells(states)).filter(
    (lane) => ok[lane]
  ).length;
  const total = (lanes: number[][]) =>
    lanes.flat().reduce((sum, n) => sum + (Number.isNaN(n) ? 0 : n), 0);
  const totals = total(fixed.columns) === total(fixed.rows) ? 0 : TOTALS;
  return broken + ok.filter((x) => !x).length + totals;
}

/**
 * `reading`, with the groups that seem to be crossed out named "x", and those that seem to be
 * misnamed named by their second-nearest template, and its clues read again that way. (The clues
 * are as read, not yet worked out from the grid.) Clues that make sense as read are left alone.
 */
export function explainGroups(
  reading: Reading,
  states: State[],
  cols: number,
  rename = true
): { reading: Reading; struck: number[]; renamed: number[] } {
  const names = [...reading.names];
  const struck: number[] = [];
  const renamed: number[] = [];
  const asRead = cluesNamed(reading.numberGlyphs, reading.groups, names);
  if (sound(asRead.columns, asRead.rows)) return { reading, struck, renamed };
  const score = (ns: Naming[], cost: number) => {
    const { columns, rows } = cluesNamed(
      reading.numberGlyphs,
      reading.groups,
      ns
    );
    return nonsense(columns, rows, states, cols) + cost;
  };
  let cost = 0;
  let best = score(names, cost);
  for (;;) {
    let change: { group: number; name: string; score: number } | undefined;
    names.forEach((n, group) => {
      // (A group named "x" from the start is a mark crossing out a cell.)
      if (n.name === 'x') return;
      if (struck.includes(group) || renamed.includes(group)) return;
      for (const name of ['x', rename ? n.next : undefined]) {
        if (name === undefined) continue;
        const tried = [...names];
        tried[group] = { ...n, name };
        const s = score(
          tried,
          cost + (name === 'x' ? STRIKE_COST : RENAME_COST)
        );
        if (s < (change?.score ?? best)) change = { group, name, score: s };
      }
    });
    if (!change) break;
    names[change.group] = { ...names[change.group]!, name: change.name };
    const strike = change.name === 'x';
    (strike ? struck : renamed).push(change.group);
    cost += strike ? STRIKE_COST : RENAME_COST;
    best = change.score;
  }
  if (struck.length + renamed.length === 0) return { reading, struck, renamed };
  return {
    reading: {
      ...reading,
      names,
      ...cluesNamed(reading.numberGlyphs, reading.groups, names),
    },
    struck,
    renamed,
  };
}

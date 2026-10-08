/**
 * Telling which groups of glyphs are crossed-out clues, where the app crosses them out in the
 * digits' own color (sample 12), so that `glyphs.ts` can't see it. A crossed-out digit looks
 * different from the plain one, so it's a group of its own, but its name is likely wrong: a
 * struck "1" looks like a "4", a struck "2" like an "8".
 *
 * Someone who's crossed out a clue has usually finished its block, so the grid says what it was
 * (`repair.ts`). So a group is taken to be crossed out if treating it as unreadable, and working
 * its clues out from the grid, makes the clues make more sense: fewer lanes that the grid
 * contradicts, or that don't fit, and the rows' and columns' totals agreeing. Each group taken
 * as crossed out costs a little, so that groups aren't for no reason (taking every group as
 * crossed out would agree with a finished grid perfectly).
 */

import { blackAndWhite } from '../solve/puzzle.ts';
import { contradicted, type State, stateCells } from './cells.ts';
import type { Naming } from './names.ts';
import { cluesNamed, type Reading } from './read.ts';
import { repair } from './repair.ts';

/** What taking a group as crossed out costs, against a lane that doesn't make sense. */
const COST = 0.5;
/** What the totals not agreeing costs. */
const TOTALS = 2;

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
 * `reading`, with the groups that seem to be crossed out named "x", and its clues read again
 * that way. (The clues are as read, not yet worked out from the grid.)
 */
export function explainStrikes(
  reading: Reading,
  states: State[],
  cols: number
): { reading: Reading; struck: number[] } {
  const names = [...reading.names];
  const score = (ns: Naming[], struck: number) => {
    const { columns, rows } = cluesNamed(
      reading.numberGlyphs,
      reading.groups,
      ns
    );
    return nonsense(columns, rows, states, cols) + COST * struck;
  };
  const struck: number[] = [];
  let best = score(names, 0);
  for (;;) {
    let change: { group: number; score: number } | undefined;
    names.forEach((n, group) => {
      if (n.name === 'x') return;
      const tried = [...names];
      tried[group] = { ...n, name: 'x' };
      const s = score(tried, struck.length + 1);
      if (s < (change?.score ?? best)) change = { group, score: s };
    });
    if (!change) break;
    names[change.group] = { ...names[change.group]!, name: 'x' };
    struck.push(change.group);
    best = change.score;
  }
  if (struck.length === 0) return { reading, struck };
  return {
    reading: {
      ...reading,
      names,
      ...cluesNamed(reading.numberGlyphs, reading.groups, names),
    },
    struck,
  };
}

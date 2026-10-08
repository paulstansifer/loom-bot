/**
 * Working out the clues that couldn't be read (that are "blotted", `NaN`, usually because
 * they've been crossed out) from the grid. Someone who's crossed out a clue has usually finished
 * its block, so the grid says what it was. (A port of number-loom's `repair.rs`, without its
 * dimmed clues or backup readings.)
 *
 * In each lane with blotted clues:
 *
 * - If every cell is decided, the clues are the lane's blocks (however many clues were read).
 * - Otherwise, from each end, each finished block is matched with the next clue, up to the first
 *   undecided cell. (A block that runs into undecided cells might not be finished, but if its
 *   clue is blotted, it probably is.) A clue that disagrees with its block is left as it is: the
 *   person might have made a mistake.
 * - Blotted clues left in the middle are matched, in order, with the finished blocks there
 *   whose lengths don't match any clue that could be read; or, failing that, with all the
 *   finished blocks; or with all the blocks: whichever there are the right number of (and leave
 *   room for the clues on either side).
 *
 * Then, if only one blotted clue is left in the whole puzzle, the totals say what it is: the
 * rows and the columns fill the same number of cells.
 */

import type { State } from './cells.ts';

type Block = [start: number, end: number];

/** The blocks of filled cells in `cells[from..to]`. */
function blocks(cells: State[], from: number, to: number): Block[] {
  const out: Block[] = [];
  let i = from;
  while (i < to) {
    if (cells[i] === 'filled') {
      let end = i;
      while (end < to && cells[end] === 'filled') end++;
      out.push([i, end]);
      i = end;
    } else i++;
  }
  return out;
}

/** Whether nothing more can be added to the block: it's crossed out (or at the edge) on both
 * sides. */
function finished(cells: State[], [start, end]: Block): boolean {
  return (
    (start === 0 || cells[start - 1] === 'crossed') &&
    (end === cells.length || cells[end] === 'crossed')
  );
}

/**
 * Match blocks with clues from the start of the lane, up to the first undecided cell, filling
 * in blotted clues. Returns where the cells not accounted for start, and how many clues were
 * used; or `undefined` if there are more blocks than clues.
 */
function walk(
  clues: number[],
  cells: State[]
): { at: number; used: number } | undefined {
  let [i, k] = [0, 0];
  for (;;) {
    while (cells[i] === 'crossed') i++;
    if (cells[i] !== 'filled') return { at: i, used: k };
    let end = i;
    while (cells[end] === 'filled') end++;
    if (k >= clues.length) return undefined;
    const length = end - i;
    if (cells[end] === 'undecided') {
      // It may not be finished, but if its clue has been crossed out, it probably is.
      if (!Number.isNaN(clues[k]!)) return { at: i, used: k };
      clues[k] = length;
      return { at: end, used: k + 1 };
    }
    if (Number.isNaN(clues[k]!)) clues[k] = length;
    [i, k] = [end, k + 1];
  }
}

/** `clues`, with as many of its blotted clues worked out from `cells` as possible. */
export function repairLane(clues: number[], cells: State[]): number[] {
  if (!clues.some(Number.isNaN) || cells.length === 0) return clues;
  if (!cells.includes('undecided'))
    return blocks(cells, 0, cells.length).map(([s, e]) => e - s);
  const repaired = [...clues];
  const n = repaired.length;
  const forwards = walk(repaired, cells);
  if (!forwards) return clues;
  // And from the other end, with the clues that are left.
  const { at: from, used: before } = forwards;
  const backwards = repaired.slice(before).reverse();
  const backwardsWalk = walk(backwards, [...cells].reverse());
  if (!backwardsWalk) return clues;
  backwards.reverse();
  repaired.splice(before, backwards.length, ...backwards);
  const to = cells.length - backwardsWalk.at;
  const after = backwardsWalk.used;

  const middle = repaired.slice(before, n - after);
  const blotted = middle.flatMap((c, i) => (Number.isNaN(c) ? [i] : []));
  if (blotted.length === 0) return repaired;
  const known = middle.filter((c) => !Number.isNaN(c));
  const all = blocks(cells, from, to);
  const done = all.filter((b) => finished(cells, b));
  const unknown = done.filter(([s, e]) => !known.includes(e - s));
  // The clues before and after each one have to fit on either side of its block.
  const room = (cs: number[]) =>
    cs.reduce((sum, c) => sum + (Number.isNaN(c) ? 2 : c + 1), 0);
  const fits = (chosen: Block[]) =>
    blotted.every(
      (i, j) =>
        room(middle.slice(0, i)) <= chosen[j]![0] - from &&
        room(middle.slice(i + 1)) <= to - chosen[j]![1]
    );
  const chosen = [unknown, done, all].find(
    (candidates) => candidates.length === blotted.length && fits(candidates)
  );
  if (chosen) {
    blotted.forEach((i, j) => {
      repaired[before + i] = chosen[j]![1] - chosen[j]![0];
    });
  }
  return repaired;
}

export type Repaired = {
  columns: number[][];
  rows: number[][];
  /** How many blotted clues were worked out. */
  filled: number;
};

/**
 * The clues, with the blotted ones worked out from the grid (`states`, row by row, of `cols`
 * columns) where possible.
 */
export function repair(
  columns: number[][],
  rows: number[][],
  states: State[],
  cols: number
): Repaired {
  const height = states.length / cols;
  const column = (c: number) =>
    Array.from({ length: height }, (_, r) => states[r * cols + c]!);
  const row = (r: number) => states.slice(r * cols, (r + 1) * cols);
  const out = {
    columns: columns.map((clues, c) => repairLane(clues, column(c))),
    rows: rows.map((clues, r) => repairLane(clues, row(r))),
  };

  const blottedIn = (lanes: number[][]) =>
    lanes.flatMap((clues, l) =>
      clues.flatMap((c, i) => (Number.isNaN(c) ? [[l, i] as const] : []))
    );
  const total = (lanes: number[][]) =>
    lanes.flat().reduce((sum, c) => sum + (Number.isNaN(c) ? 0 : c), 0);
  // If there's only one blotted clue left, it's whatever makes the totals agree (if that fits).
  const inColumns = blottedIn(out.columns);
  const inRows = blottedIn(out.rows);
  if (inColumns.length + inRows.length === 1) {
    const [lanes, only, length, missing] =
      inColumns.length === 1
        ? ([
            out.columns,
            inColumns[0]!,
            height,
            total(out.rows) - total(out.columns),
          ] as const)
        : ([
            out.rows,
            inRows[0]!,
            cols,
            total(out.columns) - total(out.rows),
          ] as const);
    const clues = lanes[only[0]]!;
    const others = total([clues]);
    if (missing > 0 && others + missing + clues.length - 1 <= length)
      clues[only[1]] = missing;
  }
  const left = (lanes: number[][]) => blottedIn(lanes).length;
  return {
    ...out,
    filled: left(columns) + left(rows) - left(out.columns) - left(out.rows),
  };
}

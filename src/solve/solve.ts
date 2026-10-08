/**
 * Solving a puzzle as well as can be done in a few seconds. (This is `find_answer` in the Rust
 * bot's `guidance.rs`.)
 */

import { knownColor } from './cell.ts';
import { lineLogicSolve } from './grid.ts';
import type { Puzzle } from './puzzle.ts';
import { search } from './search.ts';

/**
 * How the answer was found. `ambiguous`: more than one picture fits the clues, so only what they
 * all agree on is known. `out-of-time`: the search ran out of time, so only what line logic
 * found is known.
 */
export type Answer =
  | {
      kind: 'line-logic' | 'search' | 'ambiguous' | 'out-of-time';
      /** Each cell's color (`y * width + x`), or -1 where it isn't known. */
      cells: Int8Array;
      /** How many guesses the search made. */
      guesses: number;
    }
  | { kind: 'no-solution' };

/** Line logic, and then, if that doesn't finish the job, a search for up to `timeLimitMs`. */
export function solve(puzzle: Puzzle, { timeLimitMs = 2000 } = {}): Answer {
  const { outcome, state } = lineLogicSolve(puzzle);
  if (typeof outcome === 'object') return { kind: 'no-solution' };
  if (state.cellsLeft === 0)
    return { kind: 'line-logic', cells: colors(state.grid), guesses: 0 };

  const lineLogic = colors(state.grid);
  const searched = search(puzzle, state, { timeLimitMs });
  if (searched === 'no-solution') return { kind: 'no-solution' };
  if (searched === 'out-of-time')
    return { kind: 'out-of-time', cells: lineLogic, guesses: 0 };
  return {
    kind: searched.cellsLeft === 0 ? 'search' : 'ambiguous',
    cells: colors(searched.grid),
    guesses: searched.guesses,
  };
}

function colors(grid: Uint32Array): Int8Array {
  return Int8Array.from(grid, knownColor);
}

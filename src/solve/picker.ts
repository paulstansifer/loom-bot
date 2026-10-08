/**
 * Which guess the search makes next. (This is `conprop_picker.rs`.)
 *
 * Every (unknown cell, color it could be) is ranked two ways, and the picks alternate between
 * them: by how long the unfixed clues through the cell are (long clues are constraining), and by
 * how much the cell's lanes disagree about how likely the color is.
 */

import {
  BACKGROUND,
  canBe,
  colorsOf,
  isKnown,
  isKnownToBe,
  unknownButCanBe,
} from './cell.ts';
import { allFixedClues } from './grid.ts';
import type { Clue, Puzzle } from './puzzle.ts';

/** A guess: that `cell` is `color`. */
export type Pick = { cell: number; color: number };

/**
 * Per (cell, color), at `cell * colors + color`: the clue lengths through it, and the range of
 * probabilities its lanes give it.
 */
export type PickScores = {
  clueLen: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
};

export function newPickScores(cells: number, colors: number): PickScores {
  return {
    clueLen: new Float64Array(cells * colors),
    // An empty range, which the first probability widens to a point.
    lo: new Float64Array(cells * colors).fill(Infinity),
    hi: new Float64Array(cells * colors).fill(-Infinity),
  };
}

/** A seeded random number generator (mulberry32), in place of Rust's `StdRng`. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export class Picker {
  /** Every pick remaining, as `cell * colors + color`. */
  private candidates: number[];
  /** Parallel to `candidates`: whether it's been picked already. */
  private taken: Uint8Array;
  /** Indices into `candidates`, best first, by clue length and by disagreement. */
  private byClueLen: number[] = [];
  private byDisagreement: number[] = [];
  private clueLenNext = 0;
  private disagreementNext = 0;
  private clueLenTurn = true;
  private picksMade = 0;

  private constructor(candidates: number[]) {
    this.candidates = candidates;
    this.taken = new Uint8Array(candidates.length);
  }

  /** `vsids` is the search's activity score per (cell, color), at `cell * colors + color`. */
  static fromSituation(
    puzzle: Puzzle,
    grid: Uint32Array,
    vsids: Float64Array,
    random: () => number
  ): Picker {
    const candidates: number[] = [];
    grid.forEach((cell, idx) => {
      if (isKnown(cell)) return;
      for (const color of colorsOf(cell))
        candidates.push(idx * puzzle.colors + color);
    });
    // Shuffled, so that ties go a random way.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    const picker = new Picker(candidates);
    picker.rescore(puzzle, grid, vsids);
    return picker;
  }

  pick(
    puzzle: Puzzle,
    grid: Uint32Array,
    vsids: Float64Array
  ): Pick | undefined {
    this.picksMade++;
    // Rescoring seems to have no substantial effect either way, but it might help in tough cases.
    if (this.picksMade % 5 === 0) this.rescore(puzzle, grid, vsids);

    // The best pick not yet taken, alternating between the two rankings. (Both hold every
    // candidate, so if one runs dry, everything's been taken.)
    for (;;) {
      const idx = this.clueLenTurn
        ? this.byClueLen[this.clueLenNext++]
        : this.byDisagreement[this.disagreementNext++];
      if (idx === undefined) return undefined;
      if (this.taken[idx]) continue;
      this.taken[idx] = 1;
      this.clueLenTurn = !this.clueLenTurn;
      const pick = this.candidates[idx]!;
      return {
        cell: Math.floor(pick / puzzle.colors),
        color: pick % puzzle.colors,
      };
    }
  }

  private rescore(puzzle: Puzzle, grid: Uint32Array, vsids: Float64Array) {
    const { colors } = puzzle;
    this.candidates = this.candidates.filter(
      (pick, i) =>
        !this.taken[i] &&
        unknownButCanBe(grid[Math.floor(pick / colors)]!, pick % colors)
    );
    this.taken = new Uint8Array(this.candidates.length);

    const fixed = allFixedClues(puzzle, grid);
    const scores = newPickScores(grid.length, colors);
    puzzle.lanes.forEach((clues, lane) =>
      scoreLane(puzzle, lane, clues, fixed, grid, scores)
    );

    // Best first. Ties go to the higher index, as a Rust `BinaryHeap<(Score, usize)>` pops them.
    const rank = (score: (pick: number) => number): number[] => {
      const scored = this.candidates.map(score);
      return this.candidates
        .map((_, i) => i)
        .sort((a, b) => scored[b]! - scored[a]! || b - a);
    };
    // Longest first:
    this.byClueLen = rank((pick) => scores.clueLen[pick]! + vsids[pick]! * 0.5);
    // Widest disagreement first:
    this.byDisagreement = rank(
      (pick) => scores.hi[pick]! - scores.lo[pick]! + vsids[pick]! * 0.05
    );
    this.clueLenNext = 0;
    this.disagreementNext = 0;
    this.clueLenTurn = true;
  }
}

/**
 * Add the length of each color's longest unfixed clue in `lane` to its cells' `clueLen` (the
 * background's is the longest of any color's). Widen each cell's probability range for each
 * color to include what this lane implies.
 */
export function scoreLane(
  puzzle: Puzzle,
  lane: number,
  clues: Clue[],
  fixed: number[][],
  grid: Uint32Array,
  scores: PickScores
) {
  const { colors } = puzzle;
  const maxClue = new Map<number, number>();
  const colorCount = new Array<number>(colors).fill(0);
  clues.forEach((clue, i) => {
    colorCount[clue.color]! += clue.count;
    // Only clues that aren't fixed count for length.
    if (!fixed[lane]!.includes(i))
      maxClue.set(
        clue.color,
        Math.max(maxClue.get(clue.color) ?? 0, clue.count)
      );
  });

  const cells = puzzle.laneCells[lane]!;
  // The background gets whatever's left.
  colorCount[BACKGROUND] = cells.length - colorCount.reduce((a, b) => a + b, 0);
  // Where each color could be, but isn't known to be.
  const denominator = new Array<number>(colors).fill(0);
  for (const cell of cells)
    for (let color = 0; color < colors; color++) {
      if (isKnownToBe(grid[cell]!, color)) colorCount[color]!--;
      else if (canBe(grid[cell]!, color)) denominator[color]!++;
    }

  // Each lane contributes its longest unfixed clue.
  let maxLen = 0;
  for (const [color, len] of maxClue) {
    for (const cell of cells) scores.clueLen[cell * colors + color]! += len;
    maxLen = Math.max(maxLen, len);
  }
  for (const cell of cells)
    scores.clueLen[cell * colors + BACKGROUND]! += maxLen;

  // Each lane widens the range of implied probabilities.
  for (let color = 0; color < colors; color++) {
    if (denominator[color] === 0) continue;
    const prob = colorCount[color]! / denominator[color]!;
    for (const cell of cells) {
      const at = cell * colors + color;
      scores.lo[at] = Math.min(scores.lo[at]!, prob);
      scores.hi[at] = Math.max(scores.hi[at]!, prob);
    }
  }
}

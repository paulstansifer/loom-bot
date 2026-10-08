/**
 * Guidance for someone partway through a puzzle: what they've got wrong, and where to look next.
 * (This is the Rust bot's `guidance.rs`.)
 *
 * First, the answer (or as much of it as can be found), to find the mistakes. Then, with the
 * mistakes erased, the lanes that settle cells by themselves (each considered against the grid
 * as it is, not after the others have had their say). Failing that, a guess that line logic can
 * show to be wrong.
 */

import { hasProgress } from '../formats/partialCells.ts';
import {
  bwPalette,
  type ColorInfo,
  shareUrl,
  squarePicture,
} from '../formats/woven.ts';
import {
  anything,
  BACKGROUND,
  fromColor,
  isKnown,
  knownColor,
} from '../solve/cell.ts';
import { gather, SolveState } from '../solve/grid.ts';
import { exhaustLine } from '../solve/line.ts';
import { type Pick, Picker, seededRandom } from '../solve/picker.ts';
import type { Puzzle } from '../solve/puzzle.ts';
import { type Answer, solve } from '../solve/solve.ts';

/** How long to search for the answer, where line logic doesn't find all of it. */
const SEARCH_TIME_MS = 2000;
/** How many guesses to try, when nothing else turns anything up. */
const GUESSES = 200;
/** How many of those that lead to a contradiction are enough. */
const CONTRADICTIONS = 5;

/** How the answer was found (see `solve`). */
export type Solved = Exclude<Answer['kind'], 'no-solution'>;

/** A lane that, by itself, settles some cells the person hasn't. */
export type LineHint = {
  lane: number;
  /** Each cell, and what it has to be. */
  resolves: [number, number][];
};

export type Next =
  /** Every cell is decided (and none wrongly). */
  | { kind: 'done' }
  /**
   * Lanes that settle cells by themselves, the one that settles the most first. `partial` (only
   * for color puzzles): no lane settles a cell by itself, but between them, they rule out some
   * colors, and with those ruled out (perhaps over a few rounds), these lanes settle cells.
   */
  | { kind: 'lines'; hints: LineHint[]; partial: boolean }
  /**
   * For each, supposing the cell is the color leads (by line logic) to a contradiction. In the
   * order the search would have guessed them.
   */
  | { kind: 'contradictions'; guesses: Pick[] }
  /** None of the guesses tried led anywhere. */
  | { kind: 'stuck' }
  /**
   * These lanes can't be completed as they stand. (Mistakes are only caught where the answer is
   * known, so this is possible when it isn't all known.)
   */
  | { kind: 'broken'; lanes: number[] };

export type GuidanceReport = {
  solved: Solved;
  /** What's known of the answer: all of it, unless `solved` says otherwise. */
  answer: Uint32Array;
  /** How many cells the person filled in. */
  filledCells: number;
  /** The cells the person has got wrong. */
  errors: number[];
  /** Where to go from here, once the errors are erased. */
  next: Next;
  /** A link that opens the puzzle in the web app, to solve from the beginning. */
  startUrl?: string;
  /** Like `startUrl`, but with the person's progress (with the errors erased) filled in. */
  progressUrl?: string;
};

/**
 * Guidance for someone who's gotten as far as `grid` in `puzzle`, or `'no-solution'` if the
 * clues have none. `palette` is how the puzzle's colors look, for the links.
 */
export function guidance(
  puzzle: Puzzle,
  grid: Uint32Array,
  palette: ColorInfo[] = bwPalette()
): GuidanceReport | 'no-solution' {
  const found = solve(puzzle, { timeLimitMs: SEARCH_TIME_MS });
  if (found.kind === 'no-solution') return found.kind;
  const solved = found.kind;
  const everything = anything(puzzle.colors);
  const answer = Uint32Array.from(found.cells, (c) =>
    c < 0 ? everything : fromColor(c)
  );
  const allKnown = solved === 'line-logic' || solved === 'search';
  const solution = squarePicture(
    puzzle.width,
    puzzle.height,
    found.cells,
    palette
  );
  const report: GuidanceReport = {
    solved,
    answer,
    filledCells: 0,
    errors: [],
    next: { kind: 'done' },
  };
  if (allKnown) report.startUrl = shareUrl({ solution });

  grid = Uint32Array.from(grid);
  grid.forEach((mine, cell) => {
    if (isKnown(mine)) report.filledCells++;
    // (A mistake is ruling out the answer.)
    if ((mine & answer[cell]!) === 0) {
      report.errors.push(cell);
      grid[cell] = everything;
    }
  });

  if (
    allKnown &&
    !grid.every(isKnown) &&
    hasProgress(
      grid,
      palette.map((ci) => ci.color)
    )
  )
    report.progressUrl = shareUrl({ solution, inProgress: grid });

  if (grid.every(isKnown)) {
    // Where the answer isn't all known, agreeing with it doesn't mean agreeing with the clues.
    const scrubbed = scrubLanes(puzzle, grid);
    report.next =
      'broken' in scrubbed
        ? { kind: 'broken', lanes: scrubbed.broken }
        : { kind: 'done' };
  } else {
    report.next = nextStep(puzzle, grid);
  }
  return report;
}

/**
 * What every lane says about `grid`, each by itself: the lanes that settle cells (the one that
 * settles the most first), and `grid` with everything every lane rules out ruled out. Or the
 * lanes that can't be completed (or that disagree with each other).
 */
function scrubLanes(
  puzzle: Puzzle,
  grid: Uint32Array
): { hints: LineHint[]; narrowed: Uint32Array } | { broken: number[] } {
  const narrowed = Uint32Array.from(grid);
  const hints: LineHint[] = [];
  const broken: number[] = [];
  puzzle.lanes.forEach((clues, lane) => {
    const before = gather(puzzle, lane, grid);
    const after = Uint32Array.from(before);
    if (!exhaustLine(clues, after, [])) {
      broken.push(lane);
      return;
    }
    const resolves: [number, number][] = [];
    puzzle.laneCells[lane]!.forEach((cell, i) => {
      if (!isKnown(before[i]!) && isKnown(after[i]!))
        resolves.push([cell, knownColor(after[i]!)]);
      const both = narrowed[cell]! & after[i]!;
      if (both === 0) broken.push(lane);
      else narrowed[cell] = both;
    });
    if (resolves.length > 0) hints.push({ lane, resolves });
  });
  if (broken.length > 0)
    return { broken: broken.filter((lane, i) => broken[i - 1] !== lane) };
  hints.sort((a, b) => b.resolves.length - a.resolves.length);
  return { hints, narrowed };
}

function nextStep(puzzle: Puzzle, grid: Uint32Array): Next {
  // (In black and white, ruling out a color settles the cell, so there's nothing partial.)
  const inColor = puzzle.colors > 2;
  let partial = false;
  for (;;) {
    const scrubbed = scrubLanes(puzzle, grid);
    if ('broken' in scrubbed) return { kind: 'broken', lanes: scrubbed.broken };
    if (scrubbed.hints.length > 0)
      return { kind: 'lines', hints: scrubbed.hints, partial };
    if (!inColor || scrubbed.narrowed.every((cell, i) => cell === grid[i]))
      break;
    grid = scrubbed.narrowed;
    partial = true;
  }
  return guess(puzzle, grid);
}

/** Try the guesses the search would make first, until enough lead to contradictions. */
function guess(puzzle: Puzzle, grid: Uint32Array): Next {
  const stalled = SolveState.start(puzzle, Uint32Array.from(grid));
  // Line logic has nothing to add (that's why we're guessing), but with this out of the way,
  // each guess only has to revisit the lanes it bears on.
  const outcome = stalled.run();
  if (typeof outcome === 'object')
    return { kind: 'broken', lanes: [outcome.contradiction] };

  const noHistory = new Float64Array(stalled.grid.length * puzzle.colors);
  const picker = Picker.fromSituation(
    puzzle,
    stalled.grid,
    noHistory,
    seededRandom(0)
  );
  const contradictions: Pick[] = [];
  for (
    let tried = 0;
    tried < GUESSES && contradictions.length < CONTRADICTIONS;
    tried++
  ) {
    const pick = picker.pick(puzzle, stalled.grid, noHistory);
    if (!pick) break;
    const supposing = stalled.clone();
    if (
      supposing.learn(pick.cell, pick.color) === 'contradiction' ||
      typeof supposing.run() === 'object'
    )
      contradictions.push(pick);
  }
  return contradictions.length === 0
    ? { kind: 'stuck' }
    : { kind: 'contradictions', guesses: contradictions };
}

/** `R3C5`: a cell's row and column, from 1. */
function coordLabel(puzzle: Puzzle, cell: number): string {
  return `R${Math.floor(cell / puzzle.width) + 1}C${(cell % puzzle.width) + 1}`;
}

/** `R3` or `C5`: a lane, from 1. (Rows come first.) */
function laneLabel(puzzle: Puzzle, lane: number): string {
  return lane < puzzle.height ? `R${lane + 1}` : `C${lane - puzzle.height + 1}`;
}

/**
 * Emits a Markdown message about the puzzle. `repairs` is how many clues couldn't be read, and
 * were worked out from the grid instead. `operator` is the Reddit username (without the `u/`) of
 * whoever runs the bot, for the sign-off.
 *
 * Unlike everything else here, this is human-written (in the Rust bot); LLMs should add TODOs if
 * necessary, but not change any text.
 */
export function guidanceToMessage(
  puz: Puzzle,
  g: GuidanceReport,
  repairs: number,
  operator?: string
): string {
  let res = '';

  const likeWhat = {
    ambiguous: ' with multiple solutions.',
    'line-logic': ', solvable with line logic.',
    search: ', only solvable with trial-and-error.',
    'out-of-time': ', which I was unable to solve!',
  }[g.solved];
  // Fortunately, numbers <80 that start with a vowel sound aren't a multiple of five, so we're unlikely to
  // need to say "an".
  res += `This looks like a ${puz.width}x${puz.height} puzzle${likeWhat} `;
  if (repairs > 0) {
    const pl = repairs === 1 ? '' : 's';
    res += `(OCR failed for ${repairs} clue${pl}, but they could be extracted from the grid.) `;
  }
  if (g.errors.length > 0) {
    const pl = g.errors.length === 1 ? '' : 's';
    res += '\n'; // Want to start this on its own line.
    res += `If I read the grid correctly, there are ${g.errors.length} mistake${pl} to remove: >!`;
    res += g.errors
      .slice(0, 5)
      .map((error) => coordLabel(puz, error))
      .join(', ');
    if (g.errors.length > 5) res += `, and ${g.errors.length - 5} more`;
    res += '!<\n';
  } else if (g.next.kind === 'done') {
    res += {
      'line-logic': 'You solved it correctly!\n',
      search: 'You solved it correctly!!\n',
      ambiguous: 'You found one of its solutions!\n',
      'out-of-time': 'Nonetheless, you solved it!\n',
    }[g.solved];
  } else if (g.filledCells > 0) {
    const percent = ((g.filledCells / g.answer.length) * 100).toFixed(1);
    if (g.solved === 'line-logic' || g.solved === 'search') {
      res += `You've solved ${percent}% of the puzzle correctly.\n`;
    } else {
      res += `You've filled in ${percent}% of the puzzle.\n`;
    }
  }
  res += '\n\n';

  if (g.startUrl) {
    res += `[Start from scratch](${g.startUrl})`;
    if (g.progressUrl) res += ` or [continue from here](${g.progressUrl})`;
    res += ' in [Number Loom](https://paul-stansifer.itch.io/number-loom).\n\n';
  }

  const next = g.next;
  switch (next.kind) {
    case 'done':
      break; // handled above
    case 'lines': {
      const lhes = next.hints;
      if (lhes.length === 1) {
        res += 'There is one lane ';
      } else {
        res += `There are ${lhes.length} lanes `;
      }
      res += 'you can progress with line logic';
      if (next.partial) {
        res += ' (but only if you cross-reference color information)';
      }
      if (lhes.length > 5) {
        res += " (here's the first five)";
      }
      res += ':\n\n';
      for (const lh of lhes.slice(0, 5)) {
        const pl = lh.resolves.length === 1 ? '' : 's';
        res += ` * >!${laneLabel(puz, lh.lane)}, which can resolve ${lh.resolves.length} cell${pl}!<\n`;
      }
      break;
    }
    case 'contradictions': {
      const cons = next.guesses;
      if (cons.length === 1) {
        res += 'There is at least one cell ';
      } else {
        res += `There are at least ${cons.length} cells `;
      }
      res += 'that can be guessed and disproven:\n\n';
      for (const { cell, color } of cons) {
        const loc = coordLabel(puz, cell);
        const colorStr = color === BACKGROUND ? 'background' : 'colored-in'; // currently, we don't handle multicolor puzzles
        res += ` * >!${loc} can't be ${colorStr}!<\n`;
      }
      break;
    }
    case 'stuck':
      if (g.solved === 'search') {
        res +=
          "This puzzle probably requires nested guesses at this point. It's quite hard!\n";
      } else {
        res += "There's also no obvious way to make progress.\n";
      }
      break;
    case 'broken':
      res +=
        'The current grid is already contradictory in the following lanes:\n\n';
      for (const badLane of next.lanes.slice(0, 5)) {
        res += ` * ${laneLabel(puz, badLane)}\n`;
      }
      break;
  }

  // (Without an operator to name, there's no sign-off.)
  if (operator) {
    res += `\n\n^(This is a bot, operated by [u/${operator}](https://www.reddit.com/user/${operator}/))`;
  }

  return res;
}

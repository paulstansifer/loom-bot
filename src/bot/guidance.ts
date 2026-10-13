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
  /** How many cells the OP filled in. */
  filledCells: number;
  /** The cells the OP has got wrong. */
  errors: number[];
  /** Where to go from here, once the errors are erased. */
  next: Next;
  /** A link that opens the puzzle in the web app, to solve from the beginning. */
  startUrl?: string;
  /** Like `startUrl`, but with the OP's progress (with the errors erased) filled in. */
  progressUrl?: string;
  /** Whether the puzzle was read from a photo of paper, straightened (dewarped) to read it,
   * rather than from a screenshot. */
  dewarped: boolean;
};

/**
 * Guidance for someone who's gotten as far as `grid` in `puzzle`, or `'no-solution'` if the
 * clues have none. `palette` is how the puzzle's colors look, for the links. `dewarped` says
 * whether the puzzle was read from a photo of paper, straightened.
 */
export function guidance(
  puzzle: Puzzle,
  grid: Uint32Array,
  palette: ColorInfo[] = bwPalette(),
  dewarped = false
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
    dewarped,
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

/** `3 cells`, `1 cell`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** At most this many of a list are shown. */
const SHOWN = 5;

/** A Markdown bullet list. */
function bullets(items: string[]): string {
  return items.map((item) => ` * ${item}\n`).join('');
}

/** Reddit spoiler markup. */
function spoiler(text: string): string {
  return `>!${text}!<`;
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
  const likeWhat = {
    ambiguous: ' with multiple solutions.',
    'line-logic': ', solvable with line logic.',
    search: ', only solvable with trial-and-error.',
    'out-of-time': ', which I was unable to solve!',
  }[g.solved];
  // Fortunately, numbers <80 that start with a vowel sound aren't a multiple of five, so we're unlikely to
  // need to say "an".
  const intro = `This looks like a ${puz.width}x${puz.height} puzzle${likeWhat} `;
  const ocr =
    repairs > 0
      ? `(OCR failed for ${count(repairs, 'clue')}, but ${repairs == 1 ? 'it' : 'they'} could be extracted from the grid.) `
      : '';

  const progress = (): string => {
    if (g.errors.length > 0) {
      const shown = g.errors.slice(0, SHOWN).map((e) => coordLabel(puz, e));
      const more =
        g.errors.length > SHOWN ? `, and ${g.errors.length - SHOWN} more` : '';
      // (Want to start this on its own line.)
      return `\nIf I read the grid correctly, there are ${count(g.errors.length, 'mistake')} to remove: ${spoiler(shown.join(', ') + more)}\n`;
    }
    if (g.next.kind === 'done') {
      return `${
        {
          'line-logic': 'You solved it correctly!',
          search: 'You solved it correctly!!',
          ambiguous: 'You found one of its solutions!',
          'out-of-time': 'Nonetheless, you solved it!',
        }[g.solved]
      }\n`;
    }
    if (g.filledCells > 0) {
      const percent = ((g.filledCells / g.answer.length) * 100).toFixed(1);
      return g.solved === 'line-logic' || g.solved === 'search'
        ? `You've solved ${percent}% of the puzzle correctly.\n`
        : `You've filled in ${percent}% of the puzzle.\n`;
    }
    return '';
  };

  const links = g.startUrl
    ? `[Start from scratch](${g.startUrl})` +
      (g.progressUrl ? ` or [continue from here](${g.progressUrl})` : '') +
      ' in [Number Loom](https://paul-stansifer.itch.io/number-loom).\n\n'
    : '';

  // (Without an operator to name, there's no sign-off.)
  const signOff = operator
    ? `\n\n^(I am [a bot](https://github.com/paulstansifer/loom-bot), operated by [u/${operator}](https://www.reddit.com/user/${operator}/). Reply '!delete' to delete this message or '!optout' to not receive it in the future.)`
    : '';

  return `${intro}${ocr}${progress()}\n\n${links}${nextSteps(puz, g)}${signOff}`;
}

/** The part of the message about where to go from here. */
function nextSteps(puz: Puzzle, g: GuidanceReport): string {
  const next = g.next;
  switch (next.kind) {
    case 'done':
      return ''; // handled above
    case 'lines': {
      const n = next.hints.length;
      const subject = n === 1 ? 'There is one lane' : `There are ${n} lanes`;
      const crossRef = next.partial
        ? ' (but only if you cross-reference color information)'
        : '';
      const first = n > SHOWN ? " (here's the first five)" : '';
      const hints = next.hints
        .slice(0, SHOWN)
        .map((lh) =>
          spoiler(
            `${laneLabel(puz, lh.lane)}, which can resolve ${count(lh.resolves.length, 'cell')}`
          )
        );
      return `${subject} you can progress with line logic${crossRef}${first}:\n\n${bullets(hints)}`;
    }
    case 'contradictions': {
      const n = next.guesses.length;
      const subject =
        n === 1
          ? 'There is at least one cell'
          : `There are at least ${n} cells`;
      const guesses = next.guesses.map(({ cell, color }) => {
        // (Currently, we don't handle multicolor puzzles.)
        const colorStr = color === BACKGROUND ? 'background' : 'colored-in';
        return spoiler(`${coordLabel(puz, cell)} can't be ${colorStr}`);
      });
      return `${subject} that can be guessed and disproven:\n\n${bullets(guesses)}`;
    }
    case 'stuck':
      return g.solved === 'search'
        ? "This puzzle probably requires nested guesses at this point. It's quite hard!\n"
        : "There's also no obvious way to make progress.\n";
    case 'broken': {
      const lanes = next.lanes.slice(0, SHOWN).map((l) => laneLabel(puz, l));
      return `The current grid is already contradictory in the following lanes:\n\n${bullets(lanes)}`;
    }
  }
}

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromWoven, APP_URL } from '../formats/woven.ts';
import {
  anything,
  BACKGROUND,
  canBe,
  fromColor,
  isKnown,
  knownColor,
} from '../solve/cell.ts';
import { type Puzzle, makePuzzle, puzzleFromPicture } from '../solve/puzzle.ts';
import {
  guidance,
  type GuidanceReport,
  guidanceToMessage,
} from './guidance.ts';

const BLACK = 1;

/** The puzzle whose answer is `rows` (`#` for black, `.` for white). */
function puzzle(rows: string[]): Puzzle {
  return puzzleFromPicture(
    2,
    rows.map((r) => [...r].map((ch) => (ch === '#' ? BLACK : BACKGROUND)))
  );
}

/** `#` filled in, `x` crossed out, `.` undecided. */
function progress(rows: string[]): Uint32Array {
  return Uint32Array.from(
    rows.flatMap((r) => [...r]),
    (ch) =>
      ch === '#'
        ? fromColor(BLACK)
        : ch === 'x'
          ? fromColor(BACKGROUND)
          : anything(2)
  );
}

function cell(p: Puzzle, x: number, y: number): number {
  return y * p.width + x;
}

function report(p: Puzzle, rows: string[]): GuidanceReport {
  const g = guidance(p, progress(rows));
  assert.notEqual(g, 'no-solution');
  return g as GuidanceReport;
}

const SPIRAL = ['#####', '#....', '#.###', '#...#', '#####'];

void test('lanes that settle the most come first', () => {
  const g = report(puzzle(SPIRAL), [
    '.....',
    '.....',
    '.....',
    '.....',
    '.....',
  ]);
  assert.equal(g.solved, 'line-logic');
  assert.deepEqual(g.errors, []);
  assert.equal(g.next.kind, 'lines');
  if (g.next.kind !== 'lines') return;
  // (Several lanes settle all five.)
  assert.equal(g.next.hints[0]!.resolves.length, 5);
  assert.equal(g.next.hints[1]!.resolves.length, 5);
  const counts = g.next.hints.map((h) => h.resolves.length);
  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => b - a)
  );
});

void test('mistakes are found and erased', () => {
  const p = puzzle(SPIRAL);
  const g = report(p, ['#####', 'x#xxx', '#x###', '#xxx#', '#####']);
  assert.deepEqual(g.errors, [cell(p, 0, 1), cell(p, 1, 1)]);
  assert.equal(g.next.kind, 'lines');
  if (g.next.kind !== 'lines') return;
  // Row 2 ("1") could be either of them, but each column settles its own.
  const resolves = g.next.hints
    .flatMap((h) => h.resolves)
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(resolves, [
    [cell(p, 0, 1), BLACK],
    [cell(p, 1, 1), BACKGROUND],
  ]);
});

void test('finished', () => {
  const g = report(puzzle(['##.', '.#.', '.##']), ['##x', 'x#x', 'x##']);
  assert.deepEqual(g.errors, []);
  assert.equal(g.next.kind, 'done');
  assert.equal(g.progressUrl, undefined);
});

/** The document a link from `guidance` opens. */
function openLink(url: string) {
  assert.ok(url.startsWith(`${APP_URL}#`));
  return fromWoven(url.slice(APP_URL.length + 1));
}

void test('the link opens the same puzzle', () => {
  const g = report(puzzle(SPIRAL), [
    '.....',
    '.....',
    '.....',
    '.....',
    '.....',
  ]);
  const doc = openLink(g.startUrl!);
  assert.deepEqual(doc.solution.cells, Array.from(g.answer, knownColor));
  assert.equal(doc.inProgress, undefined);
  // (There's nothing to show yet.)
  assert.equal(g.progressUrl, undefined);
});

void test('the progress link has the mistakes erased', () => {
  const g = report(puzzle(SPIRAL), [
    '#####',
    'x#...',
    '.....',
    '.....',
    '.....',
  ]);
  const doc = openLink(g.progressUrl!);
  assert.deepEqual(doc.solution.cells, Array.from(g.answer, knownColor));
  const decided = (grid: ArrayLike<number>) =>
    Array.from(grid, (c) => (isKnown(c) ? knownColor(c) : undefined));
  assert.deepEqual(
    decided(doc.inProgress!),
    decided(progress(['#####', '.....', '.....', '.....', '.....']))
  );
});

void test('guesses that go wrong', () => {
  const p = puzzle([
    '###..#.',
    '.....#.',
    '.####..',
    '...#..#',
    '.##...#',
    '....##.',
    '..####.',
  ]);
  // As far as line logic gets.
  const grid = progress([
    '###xx..',
    'xxxxx..',
    'x.###.x',
    'xxx#x..',
    'x##xx..',
    'xxxx##x',
    'x.###.x',
  ]);
  const g = guidance(p, grid);
  assert.notEqual(g, 'no-solution');
  if (g === 'no-solution') return;
  assert.equal(g.solved, 'search');
  assert.equal(g.next.kind, 'contradictions');
  if (g.next.kind !== 'contradictions') return;
  assert.ok(g.next.guesses.length >= 1 && g.next.guesses.length <= 5);
  for (const { cell: c, color } of g.next.guesses) {
    assert.ok(!isKnown(grid[c]!));
    assert.ok(!canBe(g.answer[c]!, color));
  }
});

void test('nothing to go on in an ambiguous puzzle', () => {
  // Either diagonal fits.
  const g = report(puzzle(['#.', '.#']), ['..', '..']);
  assert.equal(g.solved, 'ambiguous');
  assert.deepEqual(g.errors, []);
  assert.equal(g.startUrl, undefined);
  assert.equal(g.progressUrl, undefined);
  assert.equal(g.next.kind, 'stuck');
});

void test('filled in but wrong in an ambiguous puzzle', () => {
  // Nothing's known of the answer, so nothing counts as a mistake, but the clues disagree.
  const g = report(puzzle(['#.', '.#']), ['##', '##']);
  assert.equal(g.solved, 'ambiguous');
  assert.deepEqual(g.errors, []);
  assert.equal(g.next.kind, 'broken');
});

void test('contradictory clues', () => {
  // The rows fill two cells; the columns, one.
  const p = makePuzzle(
    2,
    [[{ color: BLACK, count: 2 }], []],
    [[{ color: BLACK, count: 1 }], []]
  );
  assert.equal(guidance(p, progress(['..', '..'])), 'no-solution');
});

void test('the message', () => {
  const p = puzzle(SPIRAL);
  const g = report(p, ['#####', 'x#...', '.....', '.....', '.....']);
  const message = guidanceToMessage(p, g, 0, 'someone');
  assert.ok(
    message.startsWith(
      'This looks like a 5x5 puzzle, solvable with line logic. \n'
    )
  );
  assert.ok(message.includes('there are 2 mistakes to remove: >!R2C1, R2C2!<'));
  assert.ok(
    message.includes(
      `[Start from scratch](${g.startUrl}) or [continue from here](`
    )
  );
  assert.ok(message.includes(' * >!'));
  assert.ok(
    message.endsWith(
      "[u/someone](https://www.reddit.com/user/someone/). Reply '!delete' to delete this message or '!optout' to not receive it in the future.)"
    )
  );
  assert.ok(!guidanceToMessage(p, g, 0).includes('This is a bot'));
});

void test('says whether the puzzle was read from a straightened photo', () => {
  const p = puzzle(SPIRAL);
  const blank = progress(SPIRAL.map((r) => '.'.repeat(r.length)));
  const fromScreenshot = guidance(p, blank);
  const fromPaper = guidance(p, blank, undefined, true);
  assert.ok(fromScreenshot !== 'no-solution' && fromPaper !== 'no-solution');
  assert.equal(fromScreenshot.dewarped, false);
  assert.equal(fromPaper.dewarped, true);
});

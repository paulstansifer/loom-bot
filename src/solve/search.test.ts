import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKGROUND,
  type Cell,
  anything,
  canBe,
  fromColor,
  isKnown,
  isKnownToBe,
  without,
} from './cell.ts';
import { type TrailReason, SolveState, lineLogicSolve } from './grid.ts';
import {
  type Clue,
  type Puzzle,
  makePuzzle,
  puzzleFromPicture,
  singleLane,
} from './puzzle.ts';
import { ConpropState, conpropSolve, deduction } from './search.ts';

const C1 = 1;
const C2 = 2;

/** Three colors and no clues at all, so nothing narrows a cell except what a test says to. */
function scratchPuzzle(): Puzzle {
  return singleLane(3, 4, []);
}

/**
 * A search holding one nogood over `literals` (each saying its cell is that mask), an empty
 * trail, and a blank grid.
 */
function scratchState(
  puzzle: Puzzle,
  literals: [number, Cell][]
): ConpropState {
  const state = new ConpropState(puzzle, SolveState.start(puzzle));
  state.nogoods.push({ notAllTrue: new Map(literals), falseCount: 0 });
  for (const [cell] of literals) state.nogoodsByCell[cell]!.push(0);
  return state;
}

/** `scratchState`, with each literal saying its cell is one color. */
function colorState(
  puzzle: Puzzle,
  literals: [number, number][]
): ConpropState {
  return scratchState(
    puzzle,
    literals.map(([cell, color]) => [cell, fromColor(color)])
  );
}

/**
 * Learn one fact, recording it on the trail the way the search does. It's blamed on lane 0 (the
 * only lane these puzzles have) by default, though nothing here derives it.
 */
function learnOntoTrail(
  s: ConpropState,
  cell: number,
  is: boolean,
  color: number,
  reason: TrailReason = { kind: 'lane', lane: 0 }
) {
  s.trail.push({
    cell,
    old: s.state.grid[cell]!,
    level: s.guesses.length,
    reason,
  });
  assert.equal(
    s.state.learn(cell, color, is),
    'new',
    `meant to learn something about ${cell}`
  );
}

/** Make a guess the way the search does: note where it lands on the trail, then learn it. */
function guessOntoTrail(s: ConpropState, cell: number, color: number) {
  s.guesses.push({ trailIdx: s.trail.length, color });
  learnOntoTrail(s, cell, true, color, { kind: 'guess' });
}

void test('nogood counters track the trail one entry at a time', () => {
  // `updateNogoodCounters(n)` means "describe the grid after the first `n` entries": `n` is a
  // length, not an index. Getting that wrong by one is invisible until a nogood fires a step
  // early or late, so this pins every edge of it.
  const puzzle = scratchPuzzle();
  // "cell 0 isn't 1, or cell 1 isn't 1, or cell 3 isn't the background."
  const s = colorState(puzzle, [
    [0, C1],
    [1, C1],
    [3, BACKGROUND],
  ]);
  // One entry each, with a cell the nogood doesn't mention (2) in the middle, so a range that
  // runs one too far can't hide behind a hit.
  learnOntoTrail(s, 0, true, C1);
  learnOntoTrail(s, 2, true, C2);
  learnOntoTrail(s, 1, true, C1);
  learnOntoTrail(s, 3, true, BACKGROUND);
  const count = () => s.nogoods[0]!.falseCount;

  assert.equal(count(), 0); // Nothing folded in yet.
  s.updateNogoodCounters(0); // An empty range changes nothing.
  assert.equal(count(), 0);
  assert.equal(s.nogoodsUpdatedTo, 0);

  s.updateNogoodCounters(1); // takes in entry 0 (cell 0), and stops before entry 1
  assert.equal(count(), 1, 'one entry in, only cell 0 should have counted');
  assert.equal(s.nogoodsUpdatedTo, 1);
  s.updateNogoodCounters(2); // entry 1 is cell 2, which the nogood doesn't mention
  assert.equal(count(), 1);
  s.updateNogoodCounters(4); // entries 2 and 3, in one jump
  assert.equal(count(), 3);
  assert.equal(s.nogoodsUpdatedTo, 4);

  // Rewinding walks the same range the other way. It reads the grid as it stands, so it has to
  // happen before `unwind` puts the cells back.
  s.updateNogoodCounters(2);
  assert.equal(
    count(),
    1,
    'rewinding to 2 should undo entries 2 and 3, and no more'
  );
  assert.equal(s.nogoodsUpdatedTo, 2);
  s.updateNogoodCounters(0);
  assert.equal(count(), 0);
  assert.equal(s.nogoodsUpdatedTo, 0);
});

void test('a cell narrowed over several entries counts once', () => {
  const s = colorState(scratchPuzzle(), [[0, C1]]);
  const count = () => s.nogoods[0]!.falseCount;

  // {background, 1, 2} minus 2 is still unknown, so this settles nothing and counts for nothing.
  learnOntoTrail(s, 0, false, C2);
  assert.ok(!isKnown(s.state.grid[0]!));
  s.updateNogoodCounters(1);
  assert.equal(count(), 0, "cell 0 wasn't known yet after the first narrowing");

  // The second entry is where the cell lands on a color.
  learnOntoTrail(s, 0, true, C1);
  s.updateNogoodCounters(2);
  assert.equal(count(), 1);

  // Rewinding takes it back out once, not once per entry...
  s.updateNogoodCounters(0);
  assert.equal(count(), 0, 'the two entries for cell 0 were taken out twice');
  // ...and taking both entries in one sweep counts it once, not twice.
  s.updateNogoodCounters(2);
  assert.equal(count(), 1, 'the two entries for cell 0 were counted twice');
});

void test('a partial literal counts before its cell is known', () => {
  const puzzle = scratchPuzzle();
  // "Not both: cell 0 isn't background, and cell 1 is."
  const notBackground = without(anything(3), fromColor(BACKGROUND));
  const s = scratchState(puzzle, [
    [0, notBackground],
    [1, fromColor(BACKGROUND)],
  ]);
  const count = () => s.nogoods[0]!.falseCount;

  // {background, 1, 2} minus the background is {1, 2}: unknown, but within the literal.
  learnOntoTrail(s, 0, false, BACKGROUND);
  assert.ok(!isKnown(s.state.grid[0]!));
  s.updateNogoodCounters(1);
  assert.equal(count(), 1);
  assert.deepEqual(
    deduction(s.nogoods[0]!, s.state.grid),
    [1, notBackground],
    "one literal holds, so cell 1 can't be background"
  );

  // Settling it doesn't count it again.
  learnOntoTrail(s, 0, false, C2);
  assert.ok(isKnownToBe(s.state.grid[0]!, C1));
  s.updateNogoodCounters(2);
  assert.equal(count(), 1);

  // And rewinding takes it out at the entry that put it in, not the one that settled it.
  s.updateNogoodCounters(1);
  assert.equal(count(), 1);
  s.updateNogoodCounters(0);
  assert.equal(count(), 0);
});

/**
 * Two guesses, each followed by one consequence, so the guesses are entries 0 and 2, and there's
 * an entry either side of every boundary worth probing.
 */
function twoGuessesDeep(s: ConpropState) {
  guessOntoTrail(s, 0, C1);
  learnOntoTrail(s, 1, true, C2);
  guessOntoTrail(s, 2, C1);
  learnOntoTrail(s, 3, true, BACKGROUND);
  s.updateNogoodCounters(s.trail.length);
}

void test('backjumping rewinds to just before the guess', () => {
  // One literal on each side of the cut, so a range that's an entry too long or too short shows
  // up in the count.
  const s = colorState(scratchPuzzle(), [
    [0, C1],
    [3, BACKGROUND],
  ]);
  twoGuessesDeep(s);
  assert.deepEqual(s.guesses, [
    { trailIdx: 0, color: C1 },
    { trailIdx: 2, color: C1 },
  ]);
  assert.equal(s.trail.length, 4);
  assert.equal(s.nogoods[0]!.falseCount, 2);

  // Just before guess 1: guess 0 stays, and so does its consequence.
  s.backjump(1);
  assert.equal(s.trail.length, 2, 'kept or dropped one trail entry too many');
  assert.deepEqual(s.guesses, [{ trailIdx: 0, color: C1 }]);
  assert.equal(s.nogoodsUpdatedTo, 2);
  assert.equal(
    s.nogoods[0]!.falseCount,
    1,
    "cell 3 was rewound past; cell 0 wasn't"
  );

  // Just before guess 0 is the root: nothing survives.
  s.backjump(0);
  assert.deepEqual(s.trail, []);
  assert.deepEqual(s.guesses, []);
  assert.equal(s.nogoodsUpdatedTo, 0);
  assert.equal(s.nogoods[0]!.falseCount, 0);
});

void test('a one-cell nogood comes back on after its deduction is unwound', () => {
  // A nogood naming one cell (what we get when a guess is wrong by itself) has no other literal
  // whose rewinding could make it speak up again. Its deduction leaves the cell unknown. Once
  // that's unwound, it has to notice by itself, or the picker is free to walk back into it.
  const puzzle = scratchPuzzle();
  const s = colorState(puzzle, [[0, C1]]); // "cell 0 isn't 1"
  const anythingBut1 = without(anything(3), fromColor(C1));

  // A guess about something else, so there's a level for the deduction to be on.
  guessOntoTrail(s, 2, C2);
  assert.deepEqual(deduction(s.nogoods[0]!, s.state.grid), [0, anythingBut1]);
  learnOntoTrail(s, 0, false, C1, { kind: 'nogood', nogood: 0 });
  assert.ok(!isKnown(s.state.grid[0]!), 'still {background, 2}');
  assert.equal(
    deduction(s.nogoods[0]!, s.state.grid),
    undefined,
    'it already said its piece'
  );

  // One more entry after it, so the deduction isn't last on the trail.
  learnOntoTrail(s, 3, true, BACKGROUND);
  s.updateNogoodCounters(s.trail.length);
  s.backjump(0);

  assert.ok(canBe(s.state.grid[0]!, C1), 'the deduction was rewound');
  assert.deepEqual(
    deduction(s.nogoods[0]!, s.state.grid),
    [0, anythingBut1],
    'the deduction is gone, so the nogood has to make it again'
  );
});

void test('backjumping puts the grid back', () => {
  const s = colorState(scratchPuzzle(), [
    [0, C1],
    [3, BACKGROUND],
  ]);
  guessOntoTrail(s, 0, C1);
  learnOntoTrail(s, 1, true, C2);
  const before = Uint32Array.from(s.state.grid);
  const cellsLeftBefore = s.state.cellsLeft;
  guessOntoTrail(s, 2, C1);
  learnOntoTrail(s, 3, true, BACKGROUND);
  s.updateNogoodCounters(s.trail.length);

  s.backjump(1);
  assert.deepEqual(
    s.state.grid,
    before,
    'the cells guess 1 settled are still settled'
  );
  assert.equal(s.state.cellsLeft, cellsLeftBefore);
});

/** One lane of `len` cells, with a single clue of two `C1`s. */
function oneCluePuzzle(colors: number, len: number): Puzzle {
  return singleLane(colors, len, [{ color: C1, count: 2 }]);
}

void test('a lane nogood names only what the contradiction needs', () => {
  // `1 . _ . 1` against a clue of 2: the ends can't both be in the one run. The background in
  // the middle is on the trail too, but the contradiction doesn't need it. And since the two
  // literals come from different guesses, it asserts.
  const s = colorState(oneCluePuzzle(2, 5), []);
  guessOntoTrail(s, 0, C1);
  learnOntoTrail(s, 2, true, BACKGROUND);
  guessOntoTrail(s, 4, C1);
  s.updateNogoodCounters(s.trail.length);

  const [nogood, assertingAt] = s.lineIsNogood(0);
  assert.deepEqual(
    nogood.notAllTrue,
    new Map([
      [0, fromColor(C1)],
      [4, fromColor(C1)],
    ])
  );
  assert.equal(nogood.falseCount, 2);
  assert.equal(
    assertingAt,
    1,
    'rewinding guess 1 leaves cell 0, so the nogood forces cell 4'
  );
});

void test('a lane nogood can lean on a merely narrowed cell', () => {
  // `{1,2} . 1` against a clue of 2: the only run of 1s that fits cell 0 is 0..2, which misses
  // cell 2. So the lane nogood has to say "cell 0 isn't background", which leaves it unknown.
  //
  // That narrowing came from an older nogood: "not both cell 2 is 1 and cell 0 is background".
  // Resolving through it leaves only the guess.
  const puzzle = oneCluePuzzle(3, 3);
  const s = colorState(puzzle, [
    [2, C1],
    [0, BACKGROUND],
  ]);
  guessOntoTrail(s, 2, C1);
  learnOntoTrail(s, 0, false, BACKGROUND, { kind: 'nogood', nogood: 0 });
  s.updateNogoodCounters(s.trail.length);

  const oneOrTwo = without(anything(3), fromColor(BACKGROUND));
  assert.deepEqual(s.laneReason(0, s.trail.length), [
    [0, oneOrTwo],
    [2, fromColor(C1)],
  ]);
  const [nogood, assertingAt] = s.lineIsNogood(0);
  assert.deepEqual(nogood.notAllTrue, new Map([[2, fromColor(C1)]]));
  assert.equal(assertingAt, 0, 'back to the root, where it rules out cell 2');
});

void test('resolution walks a lane clause back to the guess', () => {
  // Two rows by three columns, every lane but the last column clued 1:
  //
  //       1 1 -
  //    1  a b .
  //    1  c d g
  //
  // Guess `g`. Row 1 then rules out `c` and `d`, the first two columns fill `a` and `b`, and row
  // 0 can't hold both. Every literal of that comes from the one guess, so the bare lane clause
  // ("not both a and b") doesn't assert. Resolving it walks back through the columns (to `c`
  // and `d`), and then row 1, until only the guess is left.
  //
  // (The trail is built by hand, so the root never runs line logic. The empty column would
  // otherwise have ruled `g` out before anyone could guess it.)
  const one: Clue[] = [{ color: C1, count: 1 }];
  const puzzle = makePuzzle(2, [one, one], [one, one, []]);
  const [row0, row1, col0, col1] = [0, 1, 2, 3];
  const at = (lane: number, pos: number) => puzzle.laneCells[lane]![pos]!;
  const [a, b, c, d, g] = [
    at(row0, 0),
    at(row0, 1),
    at(row1, 0),
    at(row1, 1),
    at(row1, 2),
  ];
  const s = colorState(puzzle, []);

  guessOntoTrail(s, g, C1);
  const derive = (cell: number, color: number, lane: number) =>
    learnOntoTrail(s, cell, true, color, { kind: 'lane', lane });
  derive(c, BACKGROUND, row1);
  derive(d, BACKGROUND, row1);
  derive(a, C1, col0);
  derive(b, C1, col1);
  s.updateNogoodCounters(s.trail.length);

  assert.deepEqual(
    s.laneReason(row0, s.trail.length),
    [
      [a, fromColor(C1)],
      [b, fromColor(C1)],
    ],
    "the bare clause has two literals at level 1, so it can't assert"
  );
  const [nogood, assertingAt] = s.lineIsNogood(row0);
  assert.deepEqual(nogood.notAllTrue, new Map([[g, fromColor(C1)]]));
  assert.equal(nogood.falseCount, 1);
  assert.equal(assertingAt, 0, 'back to the root, where it rules out `g`');
});

// End-to-end: whole puzzles through `conpropSolve`.

/**
 * A picture, a row at a time: `.` is the background, and every other character is a color,
 * numbered in the order they first appear.
 */
function picture(rows: string[]): { colors: number; cells: number[][] } {
  const seen: string[] = [];
  const cells = rows.map((row) =>
    [...row].map((ch) => {
      if (ch === '.') return BACKGROUND;
      if (!seen.includes(ch)) seen.push(ch);
      return seen.indexOf(ch) + 1;
    })
  );
  return { colors: seen.length + 1, cells };
}

function puzzleOf(rows: string[]): Puzzle {
  const { colors, cells } = picture(rows);
  return puzzleFromPicture(colors, cells);
}

/** A solved grid, rendered the way `picture` reads one. */
function rendered(grid: Uint32Array, width: number): string[] {
  const out: string[] = [];
  for (let y = 0; y * width < grid.length; y++)
    out.push(
      [...grid.subarray(y * width, (y + 1) * width)]
        .map((cell) => '.#o'[31 - Math.clz32(cell)])
        .join('')
    );
  return out;
}

/** How many cells line logic alone leaves unknown, so a test can check it needs the search. */
function lineLogicCellsLeft(puzzle: Puzzle): number {
  return lineLogicSolve(puzzle).state.cellsLeft;
}

function solvedTo(puzzle: Puzzle, want: string[]) {
  const result = conpropSolve(puzzle);
  assert.ok(typeof result === 'object', String(result));
  assert.equal(result.cellsLeft, 0, 'this puzzle has exactly one solution');
  assert.deepEqual(rendered(result.grid, want[0]!.length), want);
}

/** Black runs of these lengths. */
function runs(...counts: number[]): Clue[] {
  return counts.map((count) => ({ color: C1, count }));
}

void test('a line-solvable puzzle needs no search', () => {
  const want = ['#####', '#...#', '#...#', '#...#', '#####'];
  solvedTo(puzzleOf(want), want);
});

void test('a puzzle that needs a guess', () => {
  // Line logic stalls with 18 of 25 cells unknown. One guess in the upper-left corner solves it.
  const want = ['..###', '..#.#', '##...', '....#', '.##..'];
  assert.equal(lineLogicCellsLeft(puzzleOf(want)), 18);
  solvedTo(puzzleOf(want), want);
});

void test('a puzzle that needs several guesses', () => {
  // Line logic gets 17 of 49 cells, so the search has to go several levels deep and back out.
  const want = [
    '...##..',
    '.#.#...',
    '##..##.',
    '..##.##',
    '##.....',
    '#..#..#',
    '.##.#.#',
  ];
  assert.equal(lineLogicCellsLeft(puzzleOf(want)), 32);
  solvedTo(puzzleOf(want), want);
});

void test('a multicolor puzzle that needs a guess', () => {
  // Three colors, so ruling a cell out doesn't settle it: a nogood's deduction has to leave two
  // possibilities where a black-and-white puzzle would leave one.
  const want = ['.##..', 'oo.#.', 'o..#o', 'o...o', '##..#'];
  assert.equal(puzzleOf(want).colors, 3);
  solvedTo(puzzleOf(want), want);
});

void test('a puzzle with no solution', () => {
  // Every lane is satisfiable by itself, and the row and column totals agree, so line logic
  // runs out of things to say with 16 cells unknown. Only the search can tell.
  const puzzle = makePuzzle(
    2,
    [runs(), runs(1), runs(2), runs(2), runs(2)],
    [runs(2), runs(1, 1), runs(1, 1), runs(1), runs()]
  );
  assert.equal(lineLogicCellsLeft(puzzle), 16);
  assert.equal(conpropSolve(puzzle), 'no-solution');
});

void test('a grid that only looks solved has no solution', () => {
  // Column 0 wants one filled cell and gets two: the rows fill all four cells, and only
  // verifying the columns catches it.
  const puzzle = makePuzzle(2, [runs(1), runs(1)], [runs(1), runs(2)]);
  assert.equal(conpropSolve(puzzle), 'no-solution');
});

void test('an ambiguous puzzle reports more than one solution', () => {
  // One filled cell per row and column of a 2×2 grid: both diagonals fit.
  const result = conpropSolve(puzzleOf(['#.', '.#']));
  assert.ok(typeof result === 'object');
  assert.ok(result.cellsLeft > 0, 'both diagonals fit these clues');
});

void test('impossible clues have no solution', () => {
  // Two columns, so the first row's run of three has nowhere to go.
  const puzzle = makePuzzle(2, [runs(3), runs(1)], [runs(1), runs(1)]);
  assert.equal(conpropSolve(puzzle), 'no-solution');
});

void test('a search out of time says so', () => {
  const want = [
    '...##..',
    '.#.#...',
    '##..##.',
    '..##.##',
    '##.....',
    '#..#..#',
    '.##.#.#',
  ];
  assert.equal(
    conpropSolve(puzzleOf(want), { timeLimitMs: -1 }),
    'out-of-time'
  );
});

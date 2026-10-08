import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BACKGROUND, canBe, fromColor, isKnown, isKnownToBe } from './cell.ts';
import {
  Mode,
  type TrailStep,
  SolveState,
  blankGrid,
  lineLogicSolve,
} from './grid.ts';
import {
  type Clue,
  makePuzzle,
  puzzleFromPicture,
  singleLane,
} from './puzzle.ts';

const BLACK = 1;

/** Black runs of these lengths. */
function runs(...counts: number[]): Clue[] {
  return counts.map((count) => ({ color: BLACK, count }));
}

/** Add a trail entry for something a test asserts by hand, rather than one line logic derived. */
function guess(trail: TrailStep[], state: SolveState, cell: number) {
  const level = trail[trail.length - 1]?.level ?? 0;
  trail.push({
    cell,
    old: state.grid[cell]!,
    level,
    reason: { kind: 'guess' },
  });
}

void test('a lane filled in by its crossings still has to agree with its clues', () => {
  // Line logic never looks at a lane again once its crossings have filled it in, so these
  // contradictions are only caught by verifying.

  // The rows fill every cell, so it looks solved, but the first column wants only one.
  const looksSolved = makePuzzle(2, [runs(2), runs(2)], [runs(1), runs(2)]);
  assert.equal(typeof lineLogicSolve(looksSolved).outcome, 'object');

  // The columns fill the bottom row in, but it wants only one. Meanwhile, line logic stalls on
  // the two diagonals of the top two rows, so it doesn't look solved.
  const stalls = makePuzzle(
    2,
    [runs(1), runs(1), runs(), runs(1)],
    [runs(1, 1), runs(1, 1)]
  );
  assert.equal(typeof lineLogicSolve(stalls).outcome, 'object');
});

void test('unwinding restores the state a guess started from', () => {
  // Two cells filled, on one diagonal or the other: line logic stalls, and a guess settles it.
  const puzzle = makePuzzle(2, [runs(1), runs(1)], [runs(1), runs(1)]);
  const state = SolveState.start(puzzle);
  assert.equal(state.run(), 'stalled');
  const stalledGrid = Uint32Array.from(state.grid);
  const stalledCellsLeft = state.cellsLeft;

  // The guess goes on the trail by hand (recording what the cell held before), and
  // `run(trail)` appends its consequences.
  const trail: TrailStep[] = [];
  guess(trail, state, 0);
  assert.equal(state.learn(0, BLACK), 'new');
  assert.equal(state.run(trail), 'solved');
  assert.notDeepEqual(state.grid, stalledGrid);
  assert.deepEqual(state.unknownCellsDrift(), []);

  const attempts =
    state.solveCounts[Mode.Skim]! + state.solveCounts[Mode.Scrub]!;
  state.unwind(trail);
  assert.deepEqual(state.grid, stalledGrid);
  assert.equal(state.cellsLeft, stalledCellsLeft);
  assert.deepEqual(state.unknownCellsDrift(), []);

  // Still stalled, and for free: line logic had already run itself out on this grid, so `run`
  // must say so without attempting a lane.
  assert.equal(state.run(), 'stalled');
  assert.equal(
    state.solveCounts[Mode.Skim]! + state.solveCounts[Mode.Scrub]!,
    attempts,
    'a rewound stall re-attempted lanes it had already exhausted'
  );

  // Quiet, but not frozen: a new fact still wakes the lanes that hold it.
  assert.equal(state.learn(0, BLACK, false), 'new');
  assert.equal(state.run(), 'solved');
});

void test('unwinding backs out a guess that turned out to be a contradiction', () => {
  // Five cells, one run of three: skimming pins the middle cell, and then has nothing left.
  const puzzle = singleLane(2, 5, runs(3));
  const state = SolveState.start(puzzle);
  assert.equal(state.run(), 'stalled');
  const stalledGrid = Uint32Array.from(state.grid);
  const stalledCellsLeft = state.cellsLeft;

  // Filling both ends needs a run of five, so this can't be completed.
  const trail: TrailStep[] = [];
  guess(trail, state, 0);
  state.learn(0, BLACK);
  guess(trail, state, 4);
  state.learn(4, BLACK);
  assert.equal(
    typeof state.run(trail),
    'object',
    'line logic should have caught this'
  );

  state.unwind(trail);
  assert.deepEqual(state.grid, stalledGrid);
  assert.equal(state.cellsLeft, stalledCellsLeft);
  assert.deepEqual(state.unknownCellsDrift(), []);
  assert.equal(state.run(), 'stalled');
});

void test('unwinding widens a cell narrowed in several steps', () => {
  // A trail can name one cell several times. Only the earliest entry says what it goes back to,
  // and `cellsLeft` and `unknownCells` have to move once, however many entries it took.
  const puzzle = singleLane(3, 4, []); // Nothing narrows the cells except what the test learns.
  const state = SolveState.start(puzzle);
  const wide = state.grid[2]!;
  assert.equal(state.cellsLeft, 4);

  const trail: TrailStep[] = [];
  guess(trail, state, 2);
  state.learn(2, 2, false);
  assert.ok(!isKnown(state.grid[2]!)); // still {background, 1}
  guess(trail, state, 2);
  state.learn(2, BLACK);
  assert.ok(isKnownToBe(state.grid[2]!, BLACK));
  assert.equal(state.cellsLeft, 3);

  state.unwind(trail);
  assert.equal(state.grid[2], wide);
  assert.equal(state.cellsLeft, 4);
  assert.deepEqual(state.unknownCellsDrift(), []);
});

void test('a clone is independent', () => {
  const puzzle = makePuzzle(2, [runs(1), runs(1)], [runs(1), runs(1)]);
  const stalled = SolveState.start(puzzle);
  assert.equal(stalled.run(), 'stalled');
  const supposing = stalled.clone();
  supposing.learn(0, BLACK);
  assert.equal(supposing.run(), 'solved');
  assert.equal(stalled.cellsLeft, 4);
  assert.ok(!isKnown(stalled.grid[0]!));
});

void test('max effort', () => {
  // Skimming red 2, black 2 in five cells can't rule black out of the first cell; scrubbing can.
  const puzzle = singleLane(3, 5, [
    { color: 2, count: 2 },
    { color: BLACK, count: 2 },
  ]);
  const skimmed = lineLogicSolve(puzzle, undefined, {
    maxEffort: Mode.Skim,
  }).state;
  assert.ok(canBe(skimmed.grid[0]!, BLACK));
  assert.equal(skimmed.solveCounts[Mode.Scrub], 0);
  const scrubbed = lineLogicSolve(puzzle).state;
  assert.equal(scrubbed.grid[0], fromColor(BACKGROUND) | fromColor(2));
});

void test('line logic is sound', () => {
  // Seeded random pictures. Not every one's clues determine it, so this only checks that line
  // logic never rules out a cell's real color.
  let seed = 0x2545f491;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let trial = 0; trial < 200; trial++) {
    const colors = 2 + random(3);
    const width = 1 + random(10);
    const height = 1 + random(10);
    const picture = Array.from({ length: height }, () =>
      Array.from({ length: width }, () =>
        random(2) ? random(colors) : BACKGROUND
      )
    );
    const puzzle = puzzleFromPicture(colors, picture);
    const { outcome, state } = lineLogicSolve(puzzle, blankGrid(puzzle));
    assert.notEqual(
      typeof outcome,
      'object',
      `contradiction in ${JSON.stringify(picture)}`
    );
    picture.flat().forEach((color, cell) => {
      assert.ok(
        canBe(state.grid[cell]!, color),
        `ruled out ${JSON.stringify(picture)}`
      );
    });
    assert.deepEqual(state.unknownCellsDrift(), []);
    assert.equal(
      state.cellsLeft,
      [...state.grid].filter((cell) => !isKnown(cell)).length
    );
  }
});

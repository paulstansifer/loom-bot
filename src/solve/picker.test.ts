import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKGROUND,
  anything,
  colorsOf,
  fromColor,
  isKnown,
  isKnownToBe,
} from './cell.ts';
import { SolveState, allFixedClues, blankGrid } from './grid.ts';
import {
  type Pick,
  Picker,
  newPickScores,
  scoreLane,
  seededRandom,
} from './picker.ts';
import { type Clue, type Puzzle, makePuzzle, singleLane } from './puzzle.ts';

const C1 = 1;
const C2 = 2;

function nono(color: number, count: number): Clue {
  return { color, count };
}

/** `?` could be anything, `.` is background, `1`/`2` are known, and `a` is "background or 1". */
function grid(cells: string): Uint32Array {
  return Uint32Array.from([...cells], (ch) => {
    switch (ch) {
      case '?':
        return anything(3);
      case '.':
        return fromColor(BACKGROUND);
      case '1':
        return fromColor(C1);
      case '2':
        return fromColor(C2);
      case 'a':
        return fromColor(BACKGROUND) | fromColor(C1);
      default:
        throw new Error(`unknown cell ${ch}`);
    }
  });
}

/** Scores accumulated over single-lane puzzles of up to 16 cells, in three colors. */
class Scores {
  scores = newPickScores(16, 3);

  /** Score the only lane of a single-lane puzzle, with `clues` and `fixed` as given. */
  score(clues: Clue[], fixed: number[], cells: string) {
    const puzzle = singleLane(3, cells.length, clues);
    scoreLane(puzzle, 0, clues, [fixed], grid(cells), this.scores);
  }
  len(cell: number, color: number): number {
    return this.scores.clueLen[cell * 3 + color]!;
  }
  prob(cell: number, color: number): [number, number] {
    return [
      this.scores.lo[cell * 3 + color]!,
      this.scores.hi[cell * 3 + color]!,
    ];
  }
}

void test('a blank lane with one clue', () => {
  const s = new Scores();
  s.score([nono(C1, 2)], [], '?????');
  for (let cell = 0; cell < 5; cell++) {
    assert.equal(s.len(cell, C1), 2);
    assert.equal(
      s.len(cell, BACKGROUND),
      2,
      'background takes the max over colors'
    );
    assert.deepEqual(s.prob(cell, C1), [2 / 5, 2 / 5]);
    assert.deepEqual(s.prob(cell, BACKGROUND), [3 / 5, 3 / 5]);
  }
  // C2 isn't in this lane's clues, so this lane says it can't be here.
  assert.equal(s.len(0, C2), 0);
  assert.deepEqual(s.prob(0, C2), [0, 0]);
});

void test('multiple colors take the longest clue and sum the counts', () => {
  const s = new Scores();
  s.score([nono(C1, 3), nono(C2, 1), nono(C1, 1)], [], '????????');
  assert.equal(s.len(0, C1), 3);
  assert.equal(s.len(0, C2), 1);
  assert.equal(s.len(0, BACKGROUND), 3);
  assert.deepEqual(s.prob(0, C1), [4 / 8, 4 / 8]);
  assert.deepEqual(s.prob(0, C2), [1 / 8, 1 / 8]);
  assert.deepEqual(s.prob(0, BACKGROUND), [3 / 8, 3 / 8]);
});

void test('an empty lane', () => {
  const s = new Scores();
  s.score([], [], '???');
  assert.equal(s.len(0, BACKGROUND), 0);
  assert.equal(s.len(0, C1), 0);
  assert.deepEqual(s.prob(0, BACKGROUND), [1, 1]);
});

void test('known cells leave the numerator and the denominator', () => {
  const s = new Scores();
  // One background cell and one C1 cell are already placed.
  s.score([nono(C1, 2)], [], '.1???');
  // C1: 2 cells, 1 already placed, 3 unknown places to put the other.
  assert.deepEqual(s.prob(2, C1), [1 / 3, 1 / 3]);
  // Background: 3 cells, 1 already placed, 3 unknown places to put the other 2.
  assert.deepEqual(s.prob(2, BACKGROUND), [2 / 3, 2 / 3]);
});

void test("cells that can't be a color leave its denominator", () => {
  const s = new Scores();
  // Cells 0 and 1 can't be C2; everything can be C1 or background.
  s.score([nono(C1, 1), nono(C2, 1)], [], 'aa???');
  assert.deepEqual(s.prob(2, C1), [1 / 5, 1 / 5]);
  assert.deepEqual(s.prob(2, C2), [1 / 3, 1 / 3]);
  assert.deepEqual(s.prob(2, BACKGROUND), [3 / 5, 3 / 5]);
});

void test("fixed clues don't count for length", () => {
  const s = new Scores();
  // The 3 is placed; the 1 isn't.
  s.score([nono(C1, 3), nono(C1, 1)], [0], '111.????');
  assert.equal(s.len(5, C1), 1);
  assert.equal(s.len(5, BACKGROUND), 1);
  // ...but they still count toward how many cells are left.
  assert.deepEqual(s.prob(5, C1), [1 / 4, 1 / 4]);
  assert.deepEqual(s.prob(5, BACKGROUND), [3 / 4, 3 / 4]);
});

void test('fixed clues from the real fixed clue finder', () => {
  const clues = [nono(C1, 3), nono(C1, 1)];
  const cells = '111.????';
  const puzzle = singleLane(3, cells.length, clues);
  const fixed = allFixedClues(puzzle, grid(cells));
  assert.deepEqual(fixed, [[0]]);
  const s = new Scores();
  scoreLane(puzzle, 0, clues, fixed, grid(cells), s.scores);
  assert.equal(s.len(5, C1), 1);
});

void test('a color with only fixed clues gets no length', () => {
  const s = new Scores();
  s.score([nono(C2, 2), nono(C1, 1)], [0], '22.???');
  assert.equal(s.len(4, C2), 0);
  assert.equal(s.len(4, C1), 1);
  assert.equal(s.len(4, BACKGROUND), 1);
});

void test('scores accumulate across lanes', () => {
  const s = new Scores();
  s.score([nono(C1, 2)], [], '????');
  s.score([nono(C1, 3)], [], '????');
  // Lengths add up...
  assert.equal(s.len(0, C1), 5);
  assert.equal(s.len(0, BACKGROUND), 5);
  // ...and probabilities stretch the range.
  assert.deepEqual(s.prob(0, C1), [2 / 4, 3 / 4]);
  assert.deepEqual(s.prob(0, BACKGROUND), [1 / 4, 2 / 4]);
  // A lane in the middle of the range doesn't shrink it.
  s.score([nono(C1, 1), nono(C1, 1)], [], '????');
  assert.deepEqual(s.prob(0, C1), [2 / 4, 3 / 4]);
  assert.equal(s.len(0, C1), 6);
});

void test('a solved lane', () => {
  const s = new Scores();
  s.score([nono(C1, 2)], [0], '.11.');
  assert.equal(s.len(0, BACKGROUND), 0);
});

void test('a color fully placed in a lane not solved', () => {
  const s = new Scores();
  // C1 is done, but the cells around it could still (in principle) be C1 or background.
  s.score([nono(C1, 2)], [0], 'a11a');
  assert.deepEqual(s.prob(0, C1), [0, 0]);
});

void test('the background fully placed in a lane not solved', () => {
  const s = new Scores();
  s.score([nono(C1, 2)], [], '..a1');
  assert.deepEqual(s.prob(2, C1), [1, 1]);
});

/** Every (unknown cell, color it could be), which the picks should be a permutation of. */
function openPicks(g: Uint32Array): Set<string> {
  const out = new Set<string>();
  g.forEach((cell, idx) => {
    if (!isKnown(cell))
      for (const color of colorsOf(cell)) out.add(`${idx},${color}`);
  });
  return out;
}

/**
 * Every pick a picker would make for `puzzle` holding `g` (blank by default), after line solving
 * if `lineSolve`, in order, and the grid it looked at.
 */
function picks(puzzle: Puzzle, g: Uint32Array | undefined, lineSolve: boolean) {
  const state = SolveState.start(puzzle, g ?? blankGrid(puzzle));
  if (lineSolve) state.run();
  const vsids = new Float64Array(state.grid.length * puzzle.colors);
  const picker = Picker.fromSituation(
    puzzle,
    state.grid,
    vsids,
    seededRandom(0)
  );
  const order: Pick[] = [];
  for (let pick; (pick = picker.pick(puzzle, state.grid, vsids));)
    order.push(pick);
  return { order, grid: state.grid };
}

function assertPermutationOfOpenPicks(order: Pick[], g: Uint32Array) {
  const seen = new Set(order.map(({ cell, color }) => `${cell},${color}`));
  assert.equal(seen.size, order.length, 'duplicate picks');
  assert.deepEqual(seen, openPicks(g));
}

void test('the order is every open pick once', () => {
  // Two solutions (the diagonals), so line solving can't get anywhere.
  const one = [nono(C1, 1)];
  const puzzle = makePuzzle(2, [one, one], [one, one]);
  for (const lineSolve of [false, true]) {
    const { order, grid: g } = picks(puzzle, undefined, lineSolve);
    assert.equal(order.length, 4 * 2, 'four cells, two colors each');
    assertPermutationOfOpenPicks(order, g);
  }
});

void test('the order alternates between clue length and disagreement', () => {
  // Four wide and three tall, from this solution:
  //   ###.
  //   #...
  //   ....
  const puzzle = makePuzzle(
    2,
    [[nono(C1, 3)], [nono(C1, 1)], []],
    [[nono(C1, 2)], [nono(C1, 1)], [nono(C1, 1)], []]
  );
  const at = (x: number, y: number) => y * 4 + x;
  // Blank the empty lanes (as line solving would), but leave the rest open, so that there's
  // something to disagree about:
  //   ???.
  //   ???.
  //   ....
  const g = blankGrid(puzzle);
  for (let x = 0; x < 4; x++) g[at(x, 2)] = fromColor(BACKGROUND);
  for (let y = 0; y < 3; y++) g[at(3, y)] = fromColor(BACKGROUND);

  // Most clue length: (0, 0), with 3 across and 2 down; 5 for both colors.
  // Widest disagreement: (0, 1). Its row says 1 is 1/3 likely; its column says certain.
  const { order, grid: after } = picks(puzzle, g, false);
  assertPermutationOfOpenPicks(order, after);
  assert.deepEqual(
    order.slice(0, 4).map((p) => p.cell),
    [at(0, 0), at(0, 1), at(0, 0), at(0, 1)]
  );
  // Each cell's two colors tie, so they come out back to back (in either order).
  const colors = (i: number, j: number) =>
    new Set([order[i]!.color, order[j]!.color]);
  assert.deepEqual(colors(0, 2), new Set([BACKGROUND, C1]));
  assert.deepEqual(colors(1, 3), new Set([BACKGROUND, C1]));
});

void test('colors line solving rules out are not picked', () => {
  // Two solutions:
  //   1.2      .12
  //   .1.  or  1..
  const puzzle = makePuzzle(
    3,
    [[nono(C1, 1), nono(C2, 1)], [nono(C1, 1)]],
    [[nono(C1, 1)], [nono(C1, 1)], [nono(C2, 1)]]
  );
  const at = (x: number, y: number) => y * 3 + x;
  const { order, grid: g } = picks(puzzle, undefined, true);
  // Line solving should have pinned down column 2 and nothing else.
  assert.ok(isKnownToBe(g[at(2, 0)]!, C2));
  assert.ok(isKnownToBe(g[at(2, 1)]!, BACKGROUND));
  assert.ok(!colorsOf(g[at(0, 0)]!).includes(C2));
  assertPermutationOfOpenPicks(order, g);
  assert.equal(order.length, 4 * 2);
});

void test('a solved puzzle has nothing to pick', () => {
  const puzzle = makePuzzle(
    3,
    [[nono(C1, 1), nono(C2, 1)]],
    [[nono(C1, 1)], [nono(C2, 1)]]
  );
  const { order, grid: g } = picks(puzzle, undefined, true);
  assert.ok(g.every(isKnown));
  assert.deepEqual(order, []);
});

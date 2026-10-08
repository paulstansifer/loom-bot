import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BACKGROUND, fromColor } from './cell.ts';
import { lineLogicSolve } from './grid.ts';
import { verifyLine } from './line.ts';
import { type Puzzle, blackAndWhite, puzzleFromPicture } from './puzzle.ts';
import { solve } from './solve.ts';
import { samples } from '../ocr/samples.ts';

/** Whether every cell is known, and every lane agrees with its clues. */
function satisfies(puzzle: Puzzle, cells: Int8Array): boolean {
  return puzzle.laneCells.every(
    (lane, i) =>
      lane.every((cell) => cells[cell]! >= 0) &&
      verifyLine(
        puzzle.lanes[i]!,
        Uint32Array.from(lane, (cell) => fromColor(cells[cell]!))
      )
  );
}

void test('a puzzle that needs a guess still gets its picture', () => {
  const picture = ['..###', '..#.#', '##...', '....#', '.##..'].map((row) =>
    [...row].map((ch) => (ch === '#' ? 1 : BACKGROUND))
  );
  const puzzle = puzzleFromPicture(2, picture);
  assert.ok(lineLogicSolve(puzzle).state.cellsLeft > 0);
  const answer = solve(puzzle);
  assert.ok(answer.kind === 'search', answer.kind);
  assert.deepEqual([...answer.cells], picture.flat());
});

void test('random pictures', () => {
  // Seeded random colored pictures. Whatever the solver knows has to agree with the picture the
  // clues came from, and a unique answer has to be it.
  let seed = 7;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const kinds = new Map<string, number>();
  for (let trial = 0; trial < 300; trial++) {
    const colors = 2 + random(3);
    const width = 1 + random(12);
    const height = 1 + random(12);
    const density = 1 + random(4);
    const picture = Array.from({ length: height }, () =>
      Array.from({ length: width }, () =>
        random(5) < density ? 1 + random(colors - 1) : BACKGROUND
      )
    );
    const puzzle = puzzleFromPicture(colors, picture);
    const answer = solve(puzzle, { timeLimitMs: 10_000 });
    kinds.set(answer.kind, (kinds.get(answer.kind) ?? 0) + 1);
    const where = JSON.stringify(picture);
    assert.notEqual(answer.kind, 'no-solution', where);
    if (answer.kind === 'no-solution') continue;
    picture.flat().forEach((color, cell) => {
      const known = answer.cells[cell]!;
      assert.ok(known === -1 || known === color, `cell ${cell} of ${where}`);
    });
    if (answer.kind === 'line-logic' || answer.kind === 'search')
      assert.ok(satisfies(puzzle, answer.cells), where);
  }
  // (So that this keeps testing the search. Random pictures are seldom unique without being
  // line-solvable, so the search's unique answers are tested in `search.test.ts`.)
  assert.ok((kinds.get('ambiguous') ?? 0) > 0, `${[...kinds]}`);
});

// The sample pictures' clues, if they're here (see `src/ocr/samples.ts`). Every checked one
// should have a solution, and solving it shouldn't take long.
for (const sample of samples()) {
  const clues = sample.clues!;
  if (!clues.checked) continue;
  void test(`sample ${sample.name}'s clues`, () => {
    const puzzle = blackAndWhite(clues.rowClues, clues.columnClues);
    const answer = solve(puzzle, { timeLimitMs: 10_000 });
    assert.ok(
      answer.kind === 'line-logic' ||
        answer.kind === 'search' ||
        answer.kind === 'ambiguous',
      answer.kind
    );
    if (answer.kind !== 'ambiguous') assert.ok(satisfies(puzzle, answer.cells));
  });
}

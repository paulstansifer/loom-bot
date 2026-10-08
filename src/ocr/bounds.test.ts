import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boundsByDigits, convincing } from './bounds.ts';

/** Cells from a picture: `#` has a digit in it. */
function cells(...rows: string[]): boolean[][] {
  return rows.map((row) => [...row].map((c) => c === '#'));
}

void test('clues above and to the left, in cells of their own', () => {
  // A grid 5 high and 6 wide, with two rows of column clues and three columns of row clues,
  // the clues pushed up against it (and an empty corner).
  const found = boundsByDigits(
    cells(
      '....#.#..',
      '...######',
      '..#......',
      '.##......',
      '###......',
      '..#......',
      '.##......'
    )
  );
  assert.deepEqual(found?.rect, { top: 2, bottom: 7, left: 3, right: 9 });
  assert.ok(found && convincing(found));
});

void test('clues on all four sides', () => {
  const found = boundsByDigits(
    cells(
      '.........',
      '..#####..',
      '.#.....#.',
      '##.....##',
      '.#.....#.',
      '.#.....#.',
      '##.....##',
      '..#####..',
      '..#.#.#..'
    )
  );
  assert.deepEqual(found?.rect, { top: 2, bottom: 7, left: 2, right: 7 });
});

void test('a side without clues goes as far as the lines', () => {
  // (Clues only on the left: the grid's top, right and bottom are the rectangle's.)
  const found = boundsByDigits(
    cells('.#....', '##....', '.#....', '.#....', '##....')
  );
  assert.deepEqual(found?.rect, { top: 0, bottom: 5, left: 2, right: 6 });
});

void test("a few lanes' clues crossed out, next to the grid", () => {
  // Columns 6 and 7 have their nearest clues crossed out (so not digits); it still goes by the
  // rest.
  const found = boundsByDigits(
    cells(
      '..###...',
      '..####..',
      '.#......',
      '##......',
      '.#......',
      '.#......'
    )
  );
  assert.deepEqual(found?.rect, { top: 2, bottom: 6, left: 2, right: 8 });
});

void test('a few stray digit-like things are not clues', () => {
  const found = boundsByDigits(
    cells(
      '..........',
      '...#......',
      '..........',
      '......#...',
      '..........',
      '..........'
    )
  );
  assert.ok(!found || !convincing(found));
});

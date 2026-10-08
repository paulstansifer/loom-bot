import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { State } from './cells.ts';
import { repair, repairLane } from './repair.ts';

const B = NaN;

/** `#` filled in, `x` crossed out, `.` undecided. */
function cells(text: string): State[] {
  return [...text].map((c) =>
    c === '#' ? 'filled' : c === 'x' ? 'crossed' : 'undecided'
  );
}

void test('a finished lane is its own clue', () => {
  // However many clues were read.
  assert.deepEqual(repairLane([B], cells('##x#xx###')), [2, 1, 3]);
  assert.deepEqual(repairLane([B, 4, 5, 6], cells('x#xxxxxx')), [1]);
  // Without any blots, the clues stand, even if they disagree.
  assert.deepEqual(repairLane([1, 1], cells('##x#xxxx')), [1, 1]);
});

void test('from the ends', () => {
  assert.deepEqual(repairLane([B, 3, B], cells('x##x.....x#')), [2, 3, 1]);
  // A clue that disagrees with its block is left as it is, but still uses it up.
  assert.deepEqual(repairLane([5, B, 3], cells('##x#x....')), [5, 1, 3]);
  // A block running into undecided cells counts, if its clue is blotted...
  assert.deepEqual(repairLane([B, 3], cells('x##......')), [2, 3]);
  // ...but if not, it might not be finished, so it's left for the middle.
  assert.deepEqual(repairLane([3, B], cells('x##......')), [3, B]);
});

void test('in the middle', () => {
  // A finished block of a length no clue has.
  assert.deepEqual(
    repairLane([1, 3, B, 1], cells('..x...###.x##x...')),
    [1, 3, 2, 1]
  );
  assert.deepEqual(repairLane([1, B, 1], cells('..x#x.x##x.')), [1, 2, 1]);
  // The finished blocks, if no lengths are unaccounted for.
  assert.deepEqual(repairLane([1, B, 1], cells('..x#x.')), [1, 1, 1]);
  // All the blocks, if that's the only count that matches.
  assert.deepEqual(
    repairLane([1, B, B, 1], cells('...##.x###x..')),
    [1, 2, 3, 1]
  );
  // Too many to choose from: give up.
  assert.deepEqual(repairLane([1, B, 1], cells('..x##x.x##x.')), [1, B, 1]);
});

void test('more blocks than clues', () => {
  assert.deepEqual(repairLane([B], cells('#x#x....')), [B]);
});

void test('by totals', () => {
  // Nothing decided, so nothing to go on from the grid. The rows fill 4.
  const states = cells('.........');
  const repaired = repair([[1], [B], [1]], [[2], [1], [1]], states, 3);
  assert.deepEqual(repaired.columns, [[1], [2], [1]]);
  assert.equal(repaired.filled, 1);
});

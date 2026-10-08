import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { State } from './cells.ts';
import type { Naming } from './names.ts';
import type { Reading } from './read.ts';
import { explainGroups } from './explain.ts';

/** `#` filled in, `x` crossed out, `.` undecided. */
function cells(rows: string[]): State[] {
  return [...rows.join('')].map((c) =>
    c === '#' ? 'filled' : c === 'x' ? 'crossed' : 'undecided'
  );
}

const named = (name: string, next?: string): Naming => ({
  name,
  d: 0,
  margin: 1,
  ...(next ? { next } : {}),
});

/** A reading of single-digit numbers: each lane's glyphs' groups. */
function reading(
  columns: number[][],
  rows: number[][],
  names: string[],
  next: string[] = []
): Reading {
  const groups: number[] = [];
  const glyphs = (lanes: number[][]) =>
    lanes.map((lane) => lane.map((g) => [groups.push(g) - 1]));
  return {
    groups,
    names: names.map((n, k) => named(n, next[k])),
    numberGlyphs: { columns: glyphs(columns), rows: glyphs(rows) },
  } as unknown as Reading;
}

void test('crossed-out 1s, read as 4s, are worked out from the grid', () => {
  // Group 0 is every "1", all crossed out, so named "4". Group 1 is a plain "3".
  const states = cells(['#x#', 'xxx', '###']);
  const r = reading([[0, 0], [0], [0, 0]], [[0, 0], [], [1]], ['4', '3']);
  const { reading: explained, struck } = explainGroups(r, states, 3);
  assert.deepEqual(struck, [0]);
  assert.deepEqual(explained.rows, [[NaN, NaN], [], [3]]);
});

void test('a misnamed group is renamed to its second-nearest template', () => {
  // Group 1 is a "3", named "0", but nearly a "3". Group 0 is every "1".
  const states = cells(['#x#', 'xxx', '###']);
  const r = reading(
    [[0, 0], [0], [0, 0]],
    [[0, 0], [], [1]],
    ['1', '0'],
    ['4', '3']
  );
  const { reading: explained, struck, renamed } = explainGroups(r, states, 3);
  assert.deepEqual(struck, []);
  assert.deepEqual(renamed, [1]);
  assert.deepEqual(explained.rows, [[1, 1], [], [3]]);
});

void test('clues that make sense are left alone', () => {
  // Even though the grid could say what they are.
  const states = cells(['#x#', 'xxx', '###']);
  const r = reading(
    [[0, 0], [0], [0, 0]],
    [[0, 0], [], [1]],
    ['1', '3'],
    ['4', '8']
  );
  const { struck, renamed } = explainGroups(r, states, 3);
  assert.deepEqual(struck, []);
  assert.deepEqual(renamed, []);
});

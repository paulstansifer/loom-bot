import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Glyph } from './glyphs.ts';
import { numbers, splitThreshold } from './numbers.ts';

/** A glyph from `x0` to `x1`, on the line from `y0` (20 px tall). Only its bounds matter here. */
function glyph(x0: number, x1: number, y0 = 0): Glyph {
  return {
    x0,
    x1,
    y0,
    y1: y0 + 20,
    ink: new Float32Array(0),
    contrast: 255,
    color: [0, 0, 0],
    struck: false,
  };
}

/** How many digits each number of each lane has. */
function shape(lanes: Glyph[][][]): number[][] {
  return lanes.map((lane) => lane.map((n) => n.length));
}

void test('a typeface where every digit takes the same width', () => {
  // Each digit is centered in 17 px; numbers are 4 px further apart. So a narrow "1" leaves a
  // wide gap, as wide as the gap between two numbers ("4 4"); only from middle to middle is
  // that clear. The columns have "10", "13" and "20", stacked, which say so.
  const columns = [
    [glyph(4, 12, 0), glyph(18, 32, 0), glyph(4, 12, 30), glyph(19, 32, 30)],
    [glyph(1, 15, 0), glyph(18, 32, 0)],
  ];
  const rows = [
    [glyph(4, 12), glyph(18, 32)], // 10
    [glyph(1, 16), glyph(22, 37)], // 4 4
    [glyph(1, 15), glyph(18, 32)], // 20
    [glyph(1, 16), glyph(22, 36), glyph(46, 54)], // 4 7 1
  ];
  const found = numbers({ columns, rows });
  assert.deepEqual(shape(found.columns), [[2, 2], [2]]);
  assert.deepEqual(shape(found.rows), [[2], [1, 1], [2], [1, 1, 1]]);
});

void test('a typeface where the gaps between digits are the same', () => {
  // No two-digit numbers in the columns, so it goes by how the rows' distances split.
  const columns = [[glyph(0, 10, 0), glyph(0, 10, 30)]];
  const rows = [
    [glyph(0, 5), glyph(6, 16), glyph(24, 29)], // 12 1
    [glyph(0, 10), glyph(18, 28)], // 3 4
    [glyph(0, 5), glyph(6, 11)], // 11
  ];
  const found = numbers({ columns, rows });
  assert.deepEqual(shape(found.columns), [[1, 1]]);
  assert.deepEqual(shape(found.rows), [[2, 1], [1, 1], [2]]);
});

void test('every digit its own number', () => {
  const rows = [
    [glyph(0, 10), glyph(18, 28)],
    [glyph(0, 5), glyph(13, 23), glyph(31, 41)],
  ];
  const found = numbers({ columns: [], rows });
  assert.deepEqual(shape(found.rows), [
    [1, 1],
    [1, 1, 1],
  ]);
});

void test('splitThreshold', () => {
  // All alike: no two-digit numbers.
  assert.equal(splitThreshold([24, 24.5, 23, 25], 20, 1.25), 0);
  // Two clear groups.
  const t = splitThreshold([14, 30, 31, 13.5, 29], 20, 1.25);
  assert.ok(14 < t && t < 29);
  // Two groups, but both too spread out to be digits of one number.
  assert.equal(splitThreshold([30, 60, 61], 20, 1.25), 0);
});

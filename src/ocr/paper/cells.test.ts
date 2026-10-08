import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { State } from '../cells.ts';
import type { Grid, Line } from '../grid.ts';
import type { Raster } from '../raster.ts';
import { readPaperCells } from './cells.ts';

const CELL = 32;

/** A straightened grid of `marks` (one string per row: `#` filled, `x` an X, `.` a dot, ` `
 * nothing), drawn in `rgb`, with its lines. */
function drawn(
  marks: string[],
  rgb = [90, 90, 90]
): { raster: Raster; grid: Grid } {
  const rows = marks.length;
  const cols = marks[0]!.length;
  const [width, height] = [cols * CELL + 1, rows * CELL + 1];
  const data = new Uint8Array(width * height * 3).fill(255);
  const dot = (x: number, y: number) => data.set(rgb, (y * width + x) * 3);
  marks.forEach((row, r) => {
    [...row].forEach((m, c) => {
      const [x0, y0] = [c * CELL, r * CELL];
      for (let d = 0; d < CELL; d++) {
        for (let e = 0; e < CELL; e++) {
          const [x, y] = [x0 + d, y0 + e];
          // The lines; shading, with gaps; an X; a dot.
          if (d === 0 || e === 0) dot(x, y);
          else if (m === '#' && (d + e) % 5 !== 0) dot(x, y);
          else if (
            m === 'x' &&
            d > 5 &&
            d < CELL - 5 &&
            (Math.abs(d - e) <= 1 || Math.abs(d + e - CELL) <= 1)
          )
            dot(x, y);
          else if (m === '.' && (d - 16) ** 2 + (e - 16) ** 2 <= 9) dot(x, y);
        }
      }
    });
  });
  const lines = (n: number): Line[] =>
    Array.from({ length: n + 1 }, (_, k) => ({
      lead: k * CELL - 1,
      trail: k * CELL + 1,
      center: k * CELL,
      width: 2,
      found: true,
    }));
  return {
    raster: { width, height, data },
    grid: {
      rows,
      cols,
      horizontal: lines(rows),
      vertical: lines(cols),
      pitch: { h: CELL, v: CELL },
      straightness: { h: 1, v: 1 },
      pixelPerfect: false,
    },
  };
}

const expected = (marks: string[]): State[] =>
  marks.flatMap((row) =>
    [...row].map((m) =>
      m === '#' ? 'filled' : m === ' ' ? 'undecided' : 'crossed'
    )
  );

void describe('readPaperCells', () => {
  void test('filled, crossed out and undecided', () => {
    const marks = ['##x  ', 'x.#  ', '  ###'];
    const { raster, grid } = drawn(marks);
    assert.deepEqual(readPaperCells(raster, grid).states, expected(marks));
  });

  void test('in colored marker', () => {
    const marks = ['##xx ', 'x  ##'];
    const { raster, grid } = drawn(marks, [230, 60, 90]);
    assert.deepEqual(readPaperCells(raster, grid).states, expected(marks));
  });

  void test('only filled cells', () => {
    const marks = ['## ', ' ##'];
    const { raster, grid } = drawn(marks);
    assert.deepEqual(readPaperCells(raster, grid).states, expected(marks));
  });

  void test('only crossed-out cells', () => {
    const marks = ['xx ', ' .x'];
    const { raster, grid } = drawn(marks);
    assert.deepEqual(readPaperCells(raster, grid).states, expected(marks));
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findPuzzle } from './bounds.ts';
import { cellsText, contradicted, readCells, stateCells } from './cells.ts';
import type { Grid, Line } from './grid.ts';
import type { Raster } from './raster.ts';
import { decode, samples } from './samples.ts';
import { blackAndWhite } from '../solve/puzzle.ts';

const CELL = 20;

type Rgb = [number, number, number];

/**
 * A picture of a grid of `CELL`-pixel cells, from `rows` of letters. `paint` says what each
 * letter is drawn as: a background color, and a mark's color drawn corner to corner, or in
 * the middle if it's a dot. A "counter" is drawn in the bottom-right corner.
 */
function draw(
  rows: string[],
  paint: Record<string, { fill: Rgb; mark?: Rgb; dot?: boolean; counter?: Rgb }>
): { raster: Raster; grid: Grid } {
  const [h, w] = [rows.length, rows[0]!.length];
  const [width, height] = [w * CELL + 1, h * CELL + 1];
  const data = new Uint8Array(width * height * 3).fill(128);
  const put = (x: number, y: number, c: Rgb) =>
    data.set(c, (y * width + x) * 3);
  rows.forEach((row, i) =>
    [...row].forEach((letter, j) => {
      const p = paint[letter]!;
      for (let y = 1; y < CELL; y++)
        for (let x = 1; x < CELL; x++) {
          let color = p.fill;
          const [dx, dy] = [x - CELL / 2, y - CELL / 2];
          if (p.mark && !p.dot && Math.abs(Math.abs(dx) - Math.abs(dy)) < 1.5)
            color = p.mark;
          if (p.mark && p.dot && dx * dx + dy * dy < 9) color = p.mark;
          if (p.counter && x > CELL - 6 && y > CELL - 6) color = p.counter;
          put(j * CELL + x, i * CELL + y, color);
        }
    })
  );
  const lines = (n: number): Line[] =>
    Array.from({ length: n + 1 }, (_, k) => ({
      lead: k * CELL,
      trail: k * CELL + 1,
      center: k * CELL + 0.5,
      width: 1,
      found: true,
    }));
  return {
    raster: { width, height, data },
    grid: {
      rows: h,
      cols: w,
      horizontal: lines(h),
      vertical: lines(w),
      pitch: { h: CELL, v: CELL },
      straightness: { h: 1, v: 1 },
      pixelPerfect: true,
    },
  };
}

const read = (rows: string[], paint: Parameters<typeof draw>[1]) => {
  const { raster, grid } = draw(rows, paint);
  return cellsText(readCells(raster, grid).states, grid.cols).split('\n');
};

const WHITE: Rgb = [250, 250, 250];
const BLACK: Rgb = [20, 20, 20];
const RED: Rgb = [200, 0, 0];

void test('light mode: dark fills, crossed-out cells, and nothing else', () => {
  const rows = ['..#.x', '#.xx.', '.x..#', 'x.#..'];
  assert.deepEqual(
    read(rows, {
      '.': { fill: WHITE },
      '#': { fill: BLACK },
      x: { fill: WHITE, mark: RED },
    }),
    rows
  );
});

void test('dark mode: light fills in several hues', () => {
  const rows = ['ab.x.', '.cax.', 'x..#.', '.x.x.'];
  assert.deepEqual(
    read(rows, {
      '.': { fill: [40, 40, 50] },
      a: { fill: [120, 190, 190] },
      b: { fill: [240, 160, 180] },
      c: { fill: [190, 225, 190] },
      '#': { fill: [120, 190, 190] },
      x: { fill: [40, 40, 50], mark: [235, 235, 235] },
    }).map((r) => r.replace(/[abc]/g, '#')),
    rows.map((r) => r.replace(/[abc]/g, '#'))
  );
});

void test('dots are crossed out, too', () => {
  const rows = ['.x.x', 'x#.x', '..#x', 'x.x.'];
  assert.deepEqual(
    read(rows, {
      '.': { fill: WHITE },
      '#': { fill: BLACK },
      x: { fill: WHITE, mark: BLACK, dot: true },
    }),
    rows
  );
});

void test('counters in a corner are not marks', () => {
  const rows = ['....', '....', '..#.', '....'];
  const counter = { fill: WHITE, counter: [90, 90, 90] as Rgb };
  assert.deepEqual(
    read(['....', '...c', '..#.', '.c..'], {
      '.': { fill: WHITE },
      '#': { fill: BLACK },
      c: counter,
    }),
    rows
  );
});

// The sample pictures, if they're here: where someone is solving, the progress read shouldn't
// contradict the clues in more than a few lanes (mistakes can contradict some).
for (const sample of samples()) {
  const clues = sample.clues!;
  if (
    !clues.checked ||
    !['1', '7', '14', '15', '21', '23'].includes(sample.name)
  )
    continue;
  void test(`progress read from sample ${sample.name}`, async () => {
    const raster = await decode(sample.path);
    const found = findPuzzle(raster);
    assert.ok(found.ok);
    const puzzle = blackAndWhite(clues.rowClues, clues.columnClues);
    const states = readCells(raster, found.grid).states;
    assert.ok(contradicted(puzzle, stateCells(states)).length <= 2);
  });
}

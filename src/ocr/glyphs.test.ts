import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findGlyphs, type Glyph } from './glyphs.ts';
import type { Grid, Line } from './grid.ts';
import type { Raster } from './raster.ts';

const CELL = 20;
/** How much room there is for clues, above the grid and left of it. */
const MARGIN = 70;
const CELLS = 3;
/** A clue's box, and the digit in it (a bar, like a "1"): how big, and where in its box. */
const BOX = 16;
const DIGIT = { x: 6, y: 3, w: 3, h: 10 };

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

type Rect = { x: number; y: number; w: number; h: number };

/** A white picture with a grid of `CELLS` by `CELLS` cells, clues still to be drawn. */
function picture() {
  const size = MARGIN + CELLS * CELL + 1;
  const data = new Uint8Array(size * size * 3).fill(255);
  const fill = ({ x, y, w, h }: Rect, color: Rgb) => {
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) data.set(color, (j * size + i) * 3);
  };
  const lines: Line[] = [];
  for (let k = 0; k <= CELLS; k++) {
    const at = MARGIN + k * CELL;
    fill({ x: at, y: MARGIN, w: 1, h: CELLS * CELL + 1 }, [128, 128, 128]);
    fill({ x: MARGIN, y: at, w: CELLS * CELL + 1, h: 1 }, [128, 128, 128]);
    lines.push({
      lead: at,
      trail: at + 1,
      center: at + 0.5,
      width: 1,
      found: true,
    });
  }
  const grid: Grid = {
    rows: CELLS,
    cols: CELLS,
    horizontal: lines,
    vertical: lines,
    pitch: { h: CELL, v: CELL },
    straightness: { h: 1, v: 1 },
    pixelPerfect: true,
  };
  const raster: Raster = { width: size, height: size, data };
  /** A digit in a box whose corner is at `(x, y)`; where the digit is. */
  const boxed = (x: number, y: number): Rect => {
    fill({ x, y, w: BOX, h: BOX }, BLACK);
    const digit = { ...DIGIT, x: x + DIGIT.x, y: y + DIGIT.y };
    fill(digit, WHITE);
    return digit;
  };
  return { raster, grid, fill, boxed };
}

function bounds(g: Glyph): Rect {
  return { x: g.x0, y: g.y0, w: g.x1 - g.x0, h: g.y1 - g.y0 };
}

void test('clues in boxes of their own, light on dark', () => {
  const { raster, grid, fill, boxed } = picture();
  // Column 1 has two clues, stacked, each in its box; column 2 has one; and column 3's isn't in
  // a box (as sample 34's highlighted clues aren't).
  const [x1, x2, x3] = [MARGIN + 2, MARGIN + CELL + 2, MARGIN + 2 * CELL + 2];
  const columns = [
    [boxed(x1, 28), boxed(x1, 50)],
    [boxed(x2, 50)],
    [{ ...DIGIT, x: x3 + DIGIT.x, y: 50 + DIGIT.y }],
  ];
  fill(columns[2]![0]!, BLACK);
  // Row 1 has two, side by side; the other rows have none.
  const rows = [[boxed(28, MARGIN + 2), boxed(50, MARGIN + 2)], [], []];

  const found = findGlyphs(raster, grid);
  assert.deepEqual(
    found.columns.map((lane) => lane.map(bounds)),
    columns
  );
  assert.deepEqual(
    found.rows.map((lane) => lane.map(bounds)),
    rows
  );
  // A digit is as much ink in a box as out of one.
  for (const glyph of [...found.columns, ...found.rows].flat()) {
    assert.ok(glyph.contrast > 200);
    assert.ok(glyph.ink.every((v) => v === 1));
  }
});

void test("a bold digit's middle isn't a clue in a box", () => {
  const { raster, grid, fill } = picture();
  // A "0" as a thick ring, in each column: it encloses its middle, but it's a digit.
  const zeros = [0, 1, 2].map((k) => ({
    x: MARGIN + k * CELL + 5,
    y: 50,
    w: 10,
    h: 14,
  }));
  for (const zero of zeros) {
    fill(zero, BLACK);
    fill({ x: zero.x + 3, y: zero.y + 3, w: 4, h: 8 }, WHITE);
  }
  const found = findGlyphs(raster, grid);
  assert.deepEqual(
    found.columns.map((lane) => lane.map(bounds)),
    zeros.map((zero) => [zero])
  );
});

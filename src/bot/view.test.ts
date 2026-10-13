import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodePicture } from '../ocr/decode.ts';
import type { Glyph } from '../ocr/glyphs.ts';
import type { Line } from '../ocr/grid.ts';
import type { Reading } from '../ocr/read.ts';
import { encodePng, glyphView } from './view.ts';

const glyph = (x0: number, y0: number, x1: number, y1: number): Glyph => ({
  x0,
  y0,
  x1,
  y1,
  ink: new Float32Array((x1 - x0) * (y1 - y0)),
  contrast: 1,
  color: [0, 0, 0],
  struck: false,
});

void test('glyph view: cut down to the grid and glyphs, and boxed by fit', () => {
  // A 2x2 grid of 10 px cells, from (30, 30), in a white picture, with a column's clue above
  // it and a row's to its left.
  const [width, height] = [100, 100];
  const picture = { width, height, data: new Uint8Array(width * height * 3) };
  picture.data.fill(255);
  const lines: Line[] = [0, 1, 2].map((k) => ({
    lead: 30 + k * 10,
    trail: 31 + k * 10,
    center: 30.5 + k * 10,
    width: 1,
    found: true,
  }));
  const reading: Reading = {
    grid: {
      rows: 2,
      cols: 2,
      horizontal: lines,
      vertical: lines,
      pitch: { h: 10, v: 10 },
      straightness: { h: 1, v: 1 },
      pixelPerfect: true,
    },
    glyphs: [glyph(32, 10, 38, 18), glyph(12, 32, 18, 39)],
    groups: [0, 1],
    members: [[0], [1]],
    names: [
      { name: '5', d: 0, margin: 1 },
      { name: '1', d: 0, margin: 1 },
    ],
    // The column's 5 doesn't fit in its 2 cells; the row's 1 does.
    columns: [[5], []],
    rows: [[1], []],
    numberGlyphs: { columns: [[[0]], []], rows: [[[1]], []] },
  };

  const view = decodePicture(encodePng(glyphView(picture, reading)));
  // From 8 px left of the row's glyph, and above the column's, to 8 px past the grid.
  assert.equal(view.width, 51 + 8 - (12 - 8));
  assert.equal(view.height, 51 + 8 - (10 - 8));
  const at = (x: number, y: number) => [
    ...view.data.subarray((y * view.width + x) * 3).slice(0, 3),
  ];
  // Each glyph's box's top-left corner, a pixel outside it.
  assert.deepEqual(at(31 - 4, 9 - 2), [255, 0, 0]);
  assert.deepEqual(at(11 - 4, 31 - 2), [0, 200, 0]);
  assert.deepEqual(at(0, 0), [255, 255, 255]);
});

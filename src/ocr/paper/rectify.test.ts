import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Raster } from '../raster.ts';
import { findPaperGrid } from './mesh.ts';
import { CELL, flatten, lineOffsets, straighten, unrule } from './rectify.ts';
import { photo } from './testing.ts';

/** A white picture `cells` cells square, and a way to draw on it. */
function blank(cells: number) {
  const size = cells * CELL;
  const data = new Uint8Array(size * size * 3).fill(255);
  const raster: Raster = { width: size, height: size, data };
  const paint = (x: number, y: number, v: number) =>
    data.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3);
  const at = (x: number, y: number) => data[(y * size + x) * 3]!;
  return { raster, paint, at };
}

void describe('straighten', () => {
  void test('puts the lines where they should be', () => {
    const { raster } = photo(10, 15);
    const found = findPaperGrid(raster);
    assert.ok(found.ok);
    const s = straighten(raster, found.grid);
    const { left, top } = s.margin;
    assert.equal(s.grid.vertical[0]!.center, left * CELL);
    assert.equal(s.grid.horizontal[0]!.center, top * CELL);
    // Within the grid, every line seen is within a pixel of where it should be.
    const offsets = lineOffsets(s.raster, {
      left,
      top,
      right: left + 15,
      bottom: top + 10,
    });
    for (const line of [...offsets.v, ...offsets.h]) {
      for (let b = 1; b < line.length - 1; b++)
        assert.ok(Math.abs(line[b]!) <= 1, `off by ${line[b]}`);
    }
  });
});

void describe('flatten', () => {
  void test('makes the paper white, under uneven light, with a big fill', () => {
    const { raster, paint, at } = blank(12);
    const size = raster.width;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const light = 170 + (80 * x) / size;
        // A dark fill over a third of it.
        paint(x, y, Math.round(x < size / 3 ? light * 0.4 : light));
      }
    }
    flatten(raster, new Uint8Array(size * size));
    assert.ok(at(size - 5, 5) >= 245 && at(size / 2, size / 2) >= 245);
    assert.ok(at(5, 5) <= 130, `the fill is ${at(5, 5)}`);
  });
});

void describe('unrule', () => {
  void test('erases dashed lines past the grid, but not a digit along one', () => {
    const { raster, paint, at } = blank(10);
    // The grid is cells 3 to 10, each way; the row clues are to its left.
    const grid = { left: 3, top: 3, right: 10, bottom: 10 };
    for (const x of [CELL, 2 * CELL]) {
      for (let y = 3 * CELL; y < 10 * CELL; y++)
        if (y % 10 < 5) for (let d = -1; d <= 0; d++) paint(x + d, y, 60);
    }
    // A "1" two-thirds of a cell long, along the second line.
    for (let y = 200; y < 221; y++)
      for (let d = -1; d <= 1; d++) paint(2 * CELL + d, y, 20);
    unrule(raster, grid);
    for (let y = 3 * CELL; y < 10 * CELL; y++) {
      assert.equal(at(CELL, y), 255, `a dash is left at ${y}`);
      if (y < 195 || y > 225) assert.equal(at(2 * CELL, y), 255);
    }
    assert.equal(at(2 * CELL, 210), 20);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { findGrid, type Line } from './grid.ts';
import type { Raster } from './raster.ts';
import { decode, samples } from './samples.ts';

type Rgb = [number, number, number];

/** A picture to draw on, starting out all `background`. */
function canvas(width: number, height: number, background: Rgb) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(background, i * 3);
  const raster: Raster = { width, height, data };
  const rect = (x0: number, y0: number, x1: number, y1: number, rgb: Rgb) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++)
        data.set(rgb, (y * width + x) * 3);
    }
  };
  return { raster, rect };
}

type Drawn = { lead: number; trail: number };

/**
 * A grid like the screenshots': lines centered on an evenly spaced (not whole-pixel) lattice,
 * heavier every five, and a border drawn inside the grid (its outer edge on the lattice). Returns
 * where each line was drawn.
 */
function drawGrid(
  rect: (x0: number, y0: number, x1: number, y1: number, rgb: Rgb) => void,
  o: {
    x: number;
    y: number;
    pitch: number;
    rows: number;
    cols: number;
    line: Rgb;
  }
): { horizontal: Drawn[]; vertical: Drawn[] } {
  const place = (origin: number, count: number): Drawn[] =>
    Array.from({ length: count + 1 }, (_, k) => {
      const at = origin + k * o.pitch;
      if (k === 0) return { lead: Math.round(at), trail: Math.round(at) + 5 };
      if (k === count)
        return { lead: Math.round(at) - 5, trail: Math.round(at) };
      const width = k % 5 === 0 ? 4 : 1;
      const lead = Math.round(at - width / 2);
      return { lead, trail: lead + width };
    });
  const horizontal = place(o.y, o.rows);
  const vertical = place(o.x, o.cols);
  const [x0, x1] = [vertical[0]!.lead, vertical[o.cols]!.trail];
  const [y0, y1] = [horizontal[0]!.lead, horizontal[o.rows]!.trail];
  for (const l of horizontal) rect(x0, l.lead, x1, l.trail, o.line);
  for (const l of vertical) rect(l.lead, y0, l.trail, y1, o.line);
  return { horizontal, vertical };
}

/** Each found line is where it was drawn (within a pixel). */
function assertLines(found: Line[], drawn: Drawn[]) {
  assert.equal(found.length, drawn.length);
  found.forEach((l, i) => {
    const d = drawn[i]!;
    assert.ok(
      Math.abs(l.center - (d.lead + d.trail) / 2) <= 1,
      `line ${i}: found ${l.lead}..${l.trail}, drawn ${d.lead}..${d.trail}`
    );
  });
}

/** Some digit-ish blobs, as clues, left of and above the grid. */
function drawClues(
  rect: (x0: number, y0: number, x1: number, y1: number, rgb: Rgb) => void,
  grid: { horizontal: Drawn[]; vertical: Drawn[] },
  ink: Rgb
) {
  const { horizontal: h, vertical: v } = grid;
  for (let k = 0; k + 1 < h.length; k++) {
    const y = (h[k]!.trail + h[k + 1]!.lead) / 2;
    rect(v[0]!.lead - 30, y - 8, v[0]!.lead - 22, y + 8, ink);
  }
  for (let j = 0; j + 1 < v.length; j++) {
    const x = (v[j]!.trail + v[j + 1]!.lead) / 2;
    rect(x - 4, h[0]!.lead - 30, x + 4, h[0]!.lead - 14, ink);
  }
}

void describe('findGrid on drawn grids', () => {
  void test('dark lines, with filled cells', () => {
    const { raster, rect } = canvas(700, 800, [245, 245, 245]);
    const dark: Rgb = [40, 40, 60];
    const grid = drawGrid(rect, {
      x: 120.3,
      y: 150.6,
      pitch: 31.7,
      rows: 15,
      cols: 15,
      line: dark,
    });
    drawClues(rect, grid, dark);
    // A block of filled cells, hiding the lines between them.
    const { horizontal: h, vertical: v } = grid;
    rect(v[3]!.lead, h[6]!.lead, v[9]!.trail, h[8]!.trail, dark);
    const result = findGrid(raster);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.equal(result.grid.rows, 15);
    assert.equal(result.grid.cols, 15);
    assert.ok(Math.abs(result.grid.pitch.h - 31.7) < 0.1);
    assertLines(result.grid.horizontal, h);
    assertLines(result.grid.vertical, v);
    assert.ok(result.grid.pixelPerfect);
  });

  void test('light lines on dark, not square', () => {
    const { raster, rect } = canvas(800, 700, [20, 20, 30]);
    const light: Rgb = [200, 200, 210];
    const grid = drawGrid(rect, {
      x: 150.2,
      y: 120.9,
      pitch: 40.4,
      rows: 10,
      cols: 15,
      line: light,
    });
    drawClues(rect, grid, light);
    const result = findGrid(raster);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.equal(result.grid.rows, 10);
    assert.equal(result.grid.cols, 15);
    assertLines(result.grid.horizontal, grid.horizontal);
    assertLines(result.grid.vertical, grid.vertical);
  });

  void test('clues in boxes that carry on the grid lines', () => {
    const { raster, rect } = canvas(800, 800, [250, 250, 250]);
    const dark: Rgb = [30, 30, 30];
    const pitch = 30.3;
    const grid = drawGrid(rect, {
      x: 250.5,
      y: 230.2,
      pitch,
      rows: 15,
      cols: 15,
      line: dark,
    });
    // Boxes for four clues per row, left of the grid, and three per column, above it: the grid's
    // lines carry on through them, but the corner between them is empty.
    const { horizontal: h, vertical: v } = grid;
    const left = v[0]!.lead - Math.round(4 * pitch);
    const top = h[0]!.lead - Math.round(3 * pitch);
    for (const l of h) rect(left, l.lead, v[0]!.lead, l.trail, dark);
    for (const l of v) rect(l.lead, top, l.trail, h[0]!.lead, dark);
    for (let i = 0; i < 4; i++) {
      const x = Math.round(left + i * pitch);
      rect(x, h[0]!.lead, x + 1, h[15]!.trail, dark);
      const y = Math.round(top + i * pitch);
      if (i < 3) rect(v[0]!.lead, y, v[15]!.trail, y + 1, dark);
    }
    const result = findGrid(raster);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.equal(result.grid.rows, 15);
    assert.equal(result.grid.cols, 15);
    assertLines(result.grid.horizontal, h);
    assertLines(result.grid.vertical, v);
  });

  void test('no grid', () => {
    const { raster, rect } = canvas(400, 400, [255, 255, 255]);
    rect(50, 50, 350, 60, [0, 0, 0]);
    assert.equal(findGrid(raster).ok, false);
  });
});

// The sample pictures, if they're here (see `samples.ts`). For each with checked clues, the grid
// must be the size the clues say.
const KNOWN_FAILURES: Record<string, string> = {
  '8': 'a photo of a paper puzzle',
  '10': 'a background with a grid of its own, which outweighs the puzzle',
};

void describe('findGrid on sample pictures', () => {
  for (const sample of samples().filter((s) => s.checked)) {
    void test(
      sample.name,
      { todo: KNOWN_FAILURES[sample.name] ?? false },
      async () => {
        const result = findGrid(await decode(sample.path));
        assert.ok(result.ok, result.ok ? '' : result.reason);
        assert.deepEqual(
          { rows: result.grid.rows, cols: result.grid.cols },
          { rows: sample.rows, cols: sample.cols }
        );
      }
    );
  }
});

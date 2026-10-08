import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Raster } from '../raster.ts';
import { decode, SAMPLES_DIR, sample } from '../samples.ts';
import { findPaperGrid } from './mesh.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A printed grid, photographed: `rows` by `cols` cells, a heavy line every five, turned, bent
 * and foreshortened, under uneven light, with a pencil fill over a few cells. `toGrid` is where
 * each point of the picture is in the grid (in cells from its top left corner).
 */
function photo(rows: number, cols: number) {
  const [width, height] = [900, 700];
  const pitch = 36;
  const turn = (4 * Math.PI) / 180;
  const toGrid = (x: number, y: number) => {
    const dx = x - 150;
    const dy = y - 120;
    const rx = dx * Math.cos(turn) + dy * Math.sin(turn);
    const ry = -dx * Math.sin(turn) + dy * Math.cos(turn);
    // Further down is further away (smaller), and the page curls a little.
    const scale = pitch * (1 - 0.0002 * ry);
    const u = rx / scale + 0.4 * Math.sin(ry / 300);
    const v = ry / scale + (0.0003 * (rx - 300) ** 2) / pitch;
    return { u, v };
  };
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { u, v } = toGrid(x, y);
      let ink = 0;
      const inside = (w: number, n: number) => w > -0.1 && w < n + 0.1;
      for (const [w, n, other, m] of [
        [u, cols, v, rows],
        [v, rows, u, cols],
      ] as const) {
        const k = Math.round(w);
        if (k < 0 || k > n || !inside(other, m)) continue;
        const away = Math.abs(w - k) * pitch;
        const half = k % 5 === 0 ? 1.6 : 0.6;
        const strength = k % 5 === 0 ? 0.9 : 0.5;
        ink = Math.max(
          ink,
          strength * Math.max(0, Math.min(1, half + 0.5 - away))
        );
      }
      // Pencil over a few cells.
      if (u > 2 && u < 6 && v > 6 && v < 8) ink = Math.max(ink, 0.55);
      const light = 235 * (0.8 + 0.2 * (x / width));
      const value = Math.round(light * (1 - ink));
      data.set([value, value, value], (y * width + x) * 3);
    }
  }
  const raster: Raster = { width, height, data };
  return { raster, toGrid };
}

void describe('findPaperGrid', () => {
  void test('a bent, turned, foreshortened grid', () => {
    const { raster, toGrid } = photo(10, 15);
    const result = findPaperGrid(raster);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.deepEqual(
      { rows: result.grid.rows, cols: result.grid.cols },
      { rows: 10, cols: 15 }
    );
    for (let v = 0; v <= 10; v += 0.5) {
      for (let u = 0; u <= 15; u += 0.5) {
        const p = result.grid.point(u, v);
        const back = toGrid(p.x, p.y);
        assert.ok(
          Math.abs(back.u - u) < 0.1 && Math.abs(back.v - v) < 0.1,
          `(${u}, ${v}) is at (${back.u.toFixed(2)}, ${back.v.toFixed(2)})`
        );
      }
    }
  });

  void test('no grid', () => {
    const data = new Uint8Array(400 * 300 * 3).fill(230);
    assert.equal(findPaperGrid({ width: 400, height: 300, data }).ok, false);
  });
});

// Photos of paper among the sample pictures, if they're here, with their grids' sizes (their
// `.clues` files aren't checked; 6 and 11 print their sizes, and 13's was counted).
const PHOTOS: Record<string, { rows: number; cols: number }> = {
  '6': { rows: 45, cols: 35 },
  '11': { rows: 30, cols: 30 },
  '13': { rows: 45, cols: 35 },
};

void describe('findPaperGrid on sample photos', () => {
  for (const [name, size] of Object.entries(PHOTOS)) {
    const path = join(SAMPLES_DIR, `${name}.webp`);
    if (!existsSync(path)) continue;
    void test(name, async () => {
      const result = findPaperGrid(await decode(sample(path).path));
      assert.ok(result.ok, result.ok ? '' : result.reason);
      assert.deepEqual(
        { rows: result.grid.rows, cols: result.grid.cols },
        size
      );
    });
  }
});

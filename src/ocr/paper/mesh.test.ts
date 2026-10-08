import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { decode, SAMPLES_DIR, sample } from '../samples.ts';
import { findPaperGrid } from './mesh.ts';
import { photo } from './testing.ts';

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

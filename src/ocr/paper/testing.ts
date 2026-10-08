/** Pictures for the tests. */

import type { Raster } from '../raster.ts';

/**
 * A printed grid, photographed: `rows` by `cols` cells, a heavy line every five, turned, bent
 * and foreshortened, under uneven light, with a pencil fill over a few cells. `toGrid` is where
 * each point of the picture is in the grid (in cells from its top left corner).
 */
export function photo(rows: number, cols: number) {
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

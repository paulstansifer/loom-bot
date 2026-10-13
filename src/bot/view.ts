/**
 * The glyph debugging view, for "!whynot" and "!debug" (`commands.ts`): the picture the clues were
 * read from (straightened, for a photo of paper), cut down to the grid and its clues, with each
 * glyph found boxed: green in a lane whose clues fit it, red in one whose don't (or that has a
 * clue that couldn't be read). It's `glyph-debug.ts`'s `NAME-glyphs.png`, without knowing what the
 * clues should be.
 */

import { PNG } from 'pngjs';

import type { Glyph, RGB } from '../ocr/glyphs.ts';
import type { Raster } from '../ocr/raster.ts';
import { fits, type Reading } from '../ocr/read.ts';

const FITS: RGB = [0, 200, 0];
const MISFITS: RGB = [255, 0, 0];

/** How much of the picture to keep around the grid and the glyphs. */
const MARGIN = 8;

export function glyphView(picture: Raster, reading: Reading): Raster {
  const { grid, glyphs, numberGlyphs, columns, rows } = reading;
  const colors = glyphs.map(() => FITS);
  const mark = (lanes: number[][][], clues: number[][], length: number) =>
    lanes.forEach((lane, i) => {
      if (fits(clues[i]!, length)) return;
      for (const g of lane.flat()) colors[g] = MISFITS;
    });
  mark(numberGlyphs.columns, columns, grid.rows);
  mark(numberGlyphs.rows, rows, grid.cols);
  const boxed = drawBoxes(
    picture,
    glyphs.map((glyph, i) => ({ glyph, rgb: colors[i]! }))
  );

  const xs = [grid.vertical[0]!.lead, grid.vertical.at(-1)!.trail];
  const ys = [grid.horizontal[0]!.lead, grid.horizontal.at(-1)!.trail];
  for (const g of glyphs) {
    xs.push(g.x0, g.x1);
    ys.push(g.y0, g.y1);
  }
  return crop(
    boxed,
    Math.min(...xs) - MARGIN,
    Math.min(...ys) - MARGIN,
    Math.max(...xs) + MARGIN,
    Math.max(...ys) + MARGIN
  );
}

/** A copy of `raster`, with a box drawn just outside each glyph. */
export function drawBoxes(
  raster: Raster,
  boxes: { glyph: Glyph; rgb: RGB }[]
): Raster {
  const { width, height } = raster;
  const data = Uint8Array.from(raster.data);
  const paint = (x: number, y: number, rgb: RGB) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.set(rgb, (y * width + x) * 3);
  };
  for (const { glyph: g, rgb } of boxes) {
    for (let x = g.x0 - 1; x <= g.x1; x++) {
      paint(x, g.y0 - 1, rgb);
      paint(x, g.y1, rgb);
    }
    for (let y = g.y0 - 1; y <= g.y1; y++) {
      paint(g.x0 - 1, y, rgb);
      paint(g.x1, y, rgb);
    }
  }
  return { width, height, data };
}

/** The part of `raster` from `x0`, `y0` to (not including) `x1`, `y1`, as far as it goes. */
function crop(
  raster: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Raster {
  [x0, y0] = [Math.max(0, x0), Math.max(0, y0)];
  [x1, y1] = [Math.min(raster.width, x1), Math.min(raster.height, y1)];
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * raster.width + x0) * 3;
    data.set(raster.data.subarray(from, from + width * 3), y * width * 3);
  }
  return { width, height, data };
}

/** `raster` as a PNG file. */
export function encodePng(raster: Raster): Uint8Array {
  const { width, height, data } = raster;
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = data[i * 3]!;
    png.data[i * 4 + 1] = data[i * 3 + 1]!;
    png.data[i * 4 + 2] = data[i * 3 + 2]!;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

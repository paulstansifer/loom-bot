/**
 * How much printed ink there is at each point of a photo of paper, evened out for the lighting.
 *
 * What's dark on paper is printed lines and digits, and the person's pencil, pen and marker. Print
 * is black, so it's dark in every channel; colored marker is bright in at least one. So "ink" is
 * how dark the *brightest* channel is: red, pink, green or yellow fills mostly fade away, and the
 * lines show through them. Pencil is gray, so it doesn't fade, but it's usually lighter than print.
 *
 * Lighting varies across a photo (shadows, vignetting, a curled page), so darkness is measured
 * against the paper nearby: the brightest point within about 50 px.
 */

import type { Raster } from '../raster.ts';

/** How dark each point is, from 0 (the paper) to 1 (black), row by row. */
export type Ink = {
  width: number;
  height: number;
  ink: Float32Array;
};

/** The biggest side a photo is worked on at. The settings here are in pixels at about that
 * size; bigger photos are shrunk to it. */
export const WORKING_SIZE = 1600;

/** The size of the blocks the paper's brightness is first measured in, and how many blocks away
 * the brightest one is looked for. */
const PAPER_BLOCK = 16;
const PAPER_REACH = 3;

/** `raster` shrunk by a whole factor, averaging, so that neither side is over `maxSide`; and
 * that factor. */
export function shrink(
  raster: Raster,
  maxSide = WORKING_SIZE
): { raster: Raster; factor: number } {
  const factor = Math.ceil(Math.max(raster.width, raster.height) / maxSide);
  if (factor <= 1) return { raster, factor: 1 };
  const width = Math.floor(raster.width / factor);
  const height = Math.floor(raster.height / factor);
  const data = new Uint8Array(width * height * 3);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = (y * factor + dy) * raster.width;
          for (let dx = 0; dx < factor; dx++)
            sum += raster.data[(row + x * factor + dx) * 3 + c]!;
        }
        data[(y * width + x) * 3 + c] = Math.round(sum / area);
      }
    }
  }
  return { raster: { width, height, data }, factor };
}

export function inkMap(raster: Raster): Ink {
  const { width, height, data } = raster;
  const v = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++)
    v[i] = Math.max(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!);

  // The brightest point in each block, then the brightest block nearby.
  const B = PAPER_BLOCK;
  const bw = Math.ceil(width / B);
  const bh = Math.ceil(height / B);
  const block = new Float32Array(bw * bh);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const j = Math.floor(y / B) * bw + Math.floor(x / B);
      block[j] = Math.max(block[j]!, v[y * width + x]!);
    }
  }
  const paper = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let m = 0;
      for (
        let yy = Math.max(0, by - PAPER_REACH);
        yy <= Math.min(bh - 1, by + PAPER_REACH);
        yy++
      ) {
        for (
          let xx = Math.max(0, bx - PAPER_REACH);
          xx <= Math.min(bw - 1, bx + PAPER_REACH);
          xx++
        )
          m = Math.max(m, block[yy * bw + xx]!);
      }
      paper[by * bw + bx] = m;
    }
  }

  // Each point against the paper's brightness there, interpolated between the blocks' middles.
  const ink = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) / B - 0.5, 0), bh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, bh - 1);
    const ay = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) / B - 0.5, 0), bw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, bw - 1);
      const ax = fx - x0;
      const bg =
        (paper[y0 * bw + x0]! * (1 - ax) + paper[y0 * bw + x1]! * ax) *
          (1 - ay) +
        (paper[y1 * bw + x0]! * (1 - ax) + paper[y1 * bw + x1]! * ax) * ay;
      ink[y * width + x] = Math.max(0, 1 - v[y * width + x]! / Math.max(bg, 1));
    }
  }
  return { width, height, ink };
}

/** The same ink, flipped over its diagonal: columns become rows. */
export function transposeInk(m: Ink): Ink {
  const { width, height, ink } = m;
  const out = new Float32Array(ink.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out[x * height + y] = ink[y * width + x]!;
  return { width: height, height: width, ink: out };
}

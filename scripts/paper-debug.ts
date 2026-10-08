/**
 * Finds the grid in photos of paper puzzles (`src/ocr/paper/`), and says what size it found, and
 * (with `--out DIR`) draws it:
 * - gray: every line found (chains of at least 6 crossings),
 * - orange: the lines heavy enough to be a grid's heavy lines,
 * - red: the heavy lines chosen as the grid's,
 * - green: the grid's cells (from the mesh), and dashed, carried on past it to where clues are.
 * and `NAME-straight.png`, the photo straightened through the mesh (`rectify.ts`), with the clues'
 * glyphs found there boxed (orange if struck out), and each labeled with its group's name.
 *
 *   node --experimental-strip-types scripts/paper-debug.ts [DIR | PICTURE...] [--out DIR]
 */

import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import type { Curve } from '../src/ocr/paper/lines.ts';
import { findPaperGrid, type PaperResult } from '../src/ocr/paper/mesh.ts';
import { straighten } from '../src/ocr/paper/rectify.ts';
import { PAPER } from '../src/ocr/paper/settings.ts';
import { readClues, type Reading, THRESHOLD } from '../src/ocr/read.ts';
import type { Raster } from '../src/ocr/raster.ts';
import {
  decode,
  sample,
  samples,
  SAMPLES_DIR,
  type Sample,
} from '../src/ocr/samples.ts';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
const inputs = args.filter(
  (_, i) => outIndex < 0 || (i !== outIndex && i !== outIndex + 1)
);

const list: Sample[] = (inputs.length > 0 ? inputs : [SAMPLES_DIR]).flatMap(
  (input) => (statSync(input).isDirectory() ? samples(input) : [sample(input)])
);
if (out) mkdirSync(out, { recursive: true });

for (const s of list) {
  const raster = await decode(s.path);
  const start = performance.now();
  const result = findPaperGrid(raster);
  const ms = performance.now() - start;
  const found = result.ok
    ? `${result.grid.rows}x${result.grid.cols}`
    : `- (${result.reason})`;
  const { clues } = s;
  console.log(
    [
      s.name.padEnd(8),
      (!clues ? 'no clues' : clues.checked ? 'checked' : 'unchecked').padEnd(
        10
      ),
      `expected ${clues ? `${clues.rows}x${clues.cols}` : '?'}`.padEnd(15),
      `found ${found}`.padEnd(22),
      `${ms.toFixed(0)}ms`.padStart(6),
      result.ok
        ? `heavy rows ${result.grid.heavy.h.join(',')} cols ${result.grid.heavy.v.join(',')}`
        : '',
    ].join(' ')
  );
  if (out) {
    const name =
      list.filter((t) => t.name === s.name).length > 1
        ? s.path.replace(/[/.]/g, '_')
        : s.name;
    await draw(raster, result, join(out, `${name}.png`));
    if (result.ok) {
      const straight = straighten(raster, result.grid);
      await drawRead(
        straight.raster,
        readClues(straight.raster, straight.grid, THRESHOLD, PAPER),
        join(out, `${name}-straight.png`)
      );
    }
  }
}

type Rgb = [number, number, number];

async function draw(raster: Raster, result: PaperResult, path: string) {
  const { width, height } = raster;
  const data = Uint8Array.from(raster.data);
  const { factor } = result.debug;
  const paint = (x: number, y: number, rgb: Rgb, thick = 1) => {
    for (let dy = 0; dy < thick; dy++) {
      for (let dx = 0; dx < thick; dx++) {
        const px = Math.round(x) + dx;
        const py = Math.round(y) + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        data.set(rgb, (py * width + px) * 3);
      }
    }
  };
  const thick = Math.max(1, Math.round(factor * 1.5));
  // A curve, in the shrunk picture's pixels (transposed, if `vertical`).
  const curve = (
    c: Curve,
    vertical: boolean,
    rgb: Rgb,
    from = c.from,
    to = c.to
  ) => {
    for (let a = from; a <= to; a += 0.5) {
      const b = c.at(a);
      if (vertical) paint(b * factor, a * factor, rgb, thick);
      else paint(a * factor, b * factor, rgb, thick);
    }
  };
  const gray: Rgb = [150, 150, 150];
  const orange: Rgb = [255, 150, 0];
  const red: Rgb = [230, 0, 0];
  const green: Rgb = [0, 190, 0];
  for (const [f, vertical] of [
    [result.debug.h, false],
    [result.debug.v, true],
  ] as const) {
    if (!f) continue;
    for (const chain of f.chains) {
      if (chain.crossings.length < 6) continue;
      for (const c of chain.crossings) {
        for (let d = -3; d <= 3; d++) {
          const [a, b] = [c.x + d, c.y + c.slope * d];
          if (vertical) paint(b * factor, a * factor, gray, thick);
          else paint(a * factor, b * factor, gray, thick);
        }
      }
    }
    for (const c of f.heavy) curve(c, vertical, orange);
  }
  if (result.debug.chosen) {
    for (const c of result.debug.chosen.h) curve(c, false, red);
    for (const c of result.debug.chosen.v) curve(c, true, red);
  }
  if (result.ok) {
    const { rows, cols, point } = result.grid;
    // Cells, and dashed, carried on half the grid's size past it.
    const [uFrom, uTo] = [-Math.ceil(cols / 2), cols + Math.ceil(cols / 2)];
    const [vFrom, vTo] = [-Math.ceil(rows / 2), rows + Math.ceil(rows / 2)];
    const steps = 20;
    const draw = (u: number, v: number, inside: boolean, k: number) => {
      if (!inside && k % 8 >= 4) return;
      const p = point(u, v);
      paint(p.x, p.y, green, Math.max(1, factor));
    };
    for (let u = 0; u <= cols; u++) {
      let k = 0;
      for (let v = vFrom; v <= vTo; v += 1 / steps, k++)
        draw(u, v, v >= 0 && v <= rows, k);
    }
    for (let v = 0; v <= rows; v++) {
      let k = 0;
      for (let u = uFrom; u <= uTo; u += 1 / steps, k++)
        draw(u, v, u >= 0 && u <= cols, k);
    }
  }
  await sharp(Buffer.from(data), { raw: { width, height, channels: 3 } })
    .png()
    .toFile(path);
}

/** The glyphs of `reading` boxed on `raster`, each labeled with its group's name. */
async function drawRead(raster: Raster, reading: Reading, path: string) {
  const { width, height } = raster;
  const data = Uint8Array.from(raster.data);
  const paint = (x: number, y: number, rgb: Rgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.set(rgb, (y * width + x) * 3);
  };
  let labels = '';
  reading.glyphs.forEach((g, i) => {
    const rgb: Rgb = g.struck ? [255, 140, 0] : [0, 170, 255];
    for (let x = g.x0 - 1; x <= g.x1; x++) {
      paint(x, g.y0 - 1, rgb);
      paint(x, g.y1, rgb);
    }
    for (let y = g.y0 - 1; y <= g.y1; y++) {
      paint(g.x0 - 1, y, rgb);
      paint(g.x1, y, rgb);
    }
    const label = reading.names[reading.groups[i]!]!.name;
    labels +=
      `<text x="${g.x1 + 1}" y="${g.y0 + 7}" font-family="monospace" font-size="9" ` +
      `fill="rgb(220,0,120)">${label}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`;
  await sharp(Buffer.from(data), { raw: { width, height, channels: 3 } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(path);
}

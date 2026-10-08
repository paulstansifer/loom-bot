/**
 * Finds the grid in each sample picture, compares its size to the clues, and (with `--out DIR`)
 * draws what it found:
 * - gray: every line of the lattice that was chosen,
 * - purple: the rectangle of cells found among them (which can include clue boxes),
 * - green: the grid's lines, from `lead` to `trail` (cyan where the line wasn't seen).
 *
 *   node --experimental-strip-types scripts/grid-debug.ts [DIR | PICTURE...] [--out DIR]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import { findGrid, type GridResult, type Line } from '../src/ocr/grid.ts';
import type { Raster } from '../src/ocr/raster.ts';
import {
  decode,
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

const dir =
  inputs.length === 1 && !/\.\w+$/.test(inputs[0]!) ? inputs[0]! : SAMPLES_DIR;
let list: Sample[] = samples(dir);
if (inputs.length > 0 && inputs.some((i) => /\.\w+$/.test(i))) {
  list = list.filter((s) => inputs.some((i) => s.path.endsWith(i)));
}
if (out) mkdirSync(out, { recursive: true });

let [right, wrong] = [0, 0];
for (const sample of list) {
  const raster = await decode(sample.path);
  const start = performance.now();
  const result = findGrid(raster);
  const ms = performance.now() - start;
  const found = result.ok
    ? `${result.grid.rows}x${result.grid.cols}`
    : `- (${result.reason})`;
  const expected = `${sample.rows}x${sample.cols}`;
  const matches =
    result.ok &&
    result.grid.rows === sample.rows &&
    result.grid.cols === sample.cols;
  if (sample.checked) {
    if (matches) right++;
    else wrong++;
  }
  const pitch = result.ok
    ? `pitch ${result.grid.pitch.h.toFixed(2)}/${result.grid.pitch.v.toFixed(2)}` +
      ` straight ${result.grid.straightness.h.toFixed(2)}/${result.grid.straightness.v.toFixed(2)}` +
      (result.grid.pixelPerfect ? '' : ' (not straight: a photo?)')
    : '';
  console.log(
    [
      sample.name.padEnd(6),
      (sample.checked ? 'checked' : 'unchecked').padEnd(10),
      `expected ${expected}`.padEnd(15),
      `found ${found}`.padEnd(22),
      matches ? 'ok  ' : 'BAD ',
      `${ms.toFixed(0)}ms`.padStart(6),
      pitch,
    ].join(' ')
  );
  if (out) await draw(raster, result, join(out, `${sample.name}.png`));
}
console.log(`checked: ${right} right, ${wrong} wrong`);

async function draw(raster: Raster, result: GridResult, path: string) {
  const { width, height } = raster;
  const data = Uint8Array.from(raster.data);
  const paint = (x: number, y: number, rgb: [number, number, number]) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.set(rgb, (y * width + x) * 3);
  };
  // A line across (horizontal, at `across`), from `from` to `to` along it.
  const stroke = (
    horizontal: boolean,
    across: number,
    from: number,
    to: number,
    rgb: [number, number, number],
    dashed = false
  ) => {
    for (let a = Math.max(0, Math.round(from)); a < Math.round(to); a++) {
      if (dashed && a % 8 >= 4) continue;
      if (horizontal) paint(a, across, rgb);
      else paint(across, a, rgb);
    }
  };
  const gray: [number, number, number] = [150, 150, 150];
  const purple: [number, number, number] = [170, 0, 255];
  const green: [number, number, number] = [0, 200, 0];
  const cyan: [number, number, number] = [0, 200, 255];
  const { allLines } = result.debug;
  const rectangle = result.debug.rectangle?.full;
  if (allLines) {
    for (const l of allLines.h) stroke(true, l.center, 0, width, gray, true);
    for (const l of allLines.v) stroke(false, l.center, 0, height, gray, true);
    if (rectangle) {
      const { top, bottom, left, right } = rectangle;
      const [t, b] = [allLines.h[top]!.center, allLines.h[bottom]!.center];
      const [l, r] = [allLines.v[left]!.center, allLines.v[right]!.center];
      for (const d of [-3, 3]) {
        stroke(true, t + d, l, r, purple);
        stroke(true, b - d, l, r, purple);
        stroke(false, l + d, t, b, purple);
        stroke(false, r - d, t, b, purple);
      }
    }
  }
  if (result.ok) {
    const { horizontal, vertical } = result.grid;
    const span = (lines: Line[]): [number, number] => [
      lines[0]!.lead,
      lines[lines.length - 1]!.trail,
    ];
    const [x0, x1] = span(vertical);
    const [y0, y1] = span(horizontal);
    const mark = (
      horizontal: boolean,
      line: Line,
      from: number,
      to: number
    ) => {
      const color = line.found ? green : cyan;
      if (line.width === 0) stroke(horizontal, line.lead, from, to, color);
      else
        for (let a = line.lead; a < line.trail; a++)
          stroke(horizontal, a, from, to, color);
    };
    for (const line of horizontal) mark(true, line, x0, x1);
    for (const line of vertical) mark(false, line, y0, y1);
  }
  await sharp(Buffer.from(data), { raw: { width, height, channels: 3 } })
    .png()
    .toFile(path);
}

/**
 * The digits 0 to 9 as drawn by various fonts (those installed here), as `Look`s, to name groups
 * of glyphs by, and marks that cross out a cell (named "x"), so as not to take them for digits.
 * (Dev-only: it renders them with `sharp`.) Run it to write them to `src/ocr/templates.ts`:
 *
 *   node --experimental-strip-types scripts/digit-templates.ts
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { look, type Look, SHAPE } from '../src/ocr/cluster.ts';
import type { Glyph } from '../src/ocr/glyphs.ts';
import { LEVELS } from '../src/ocr/names.ts';

export const FONTS = [
  'Roboto',
  'Roboto Condensed',
  'Noto Sans',
  'DejaVu Sans',
  'DejaVu Sans Condensed',
  'DejaVu Sans Mono',
  'Liberation Sans',
  'Liberation Sans Narrow',
  'Liberation Serif',
  'Liberation Mono',
  'Nimbus Sans',
  'FreeSans',
  'Cantarell',
  'Ubuntu',
  'Ubuntu Sans',
  'Quicksand',
  'URW Gothic',
  'Tuffy',
  'Hack',
  'C059',
];

/** What's drawn: the digits, and marks that cross a cell out (all named "x"). */
const TEXTS: [string, string][] = [
  ...Array.from({ length: 10 }, (_, d): [string, string] => [
    String(d),
    String(d),
  ]),
  ['X', 'x'],
  ['x', 'x'],
  ['\u00d7', 'x'],
  ['\u2715', 'x'],
];

export type Template = { name: string; font: string; look: Look };

export async function templates(size = 32): Promise<Template[]> {
  const out: Template[] = [];
  for (const font of FONTS) {
    for (const weight of ['normal', 'bold']) {
      for (const [text, name] of TEXTS) {
        const ink = await render(text, font, weight, size);
        if (ink) out.push({ name, font: `${font} ${weight}`, look: look(ink) });
      }
    }
  }
  return out;
}

/** A template's shape as text: a character of `LEVELS` per cell. */
function encode(shape: Float32Array): string {
  const top = LEVELS.length - 1;
  return Array.from(
    shape,
    (v) => LEVELS[Math.round(Math.min(1, Math.max(0, v)) * top)]
  ).join('');
}

async function write(path: string) {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const t of await templates()) {
    const shape = encode(t.look.shape);
    // (A font without a mark draws another font's, the same as before.)
    const key = `${t.name} ${t.look.w} ${t.look.h} ${shape}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(
      `  ['${t.name}', ${t.look.w}, ${t.look.h}, '${shape}'], // ${t.font}`
    );
  }
  writeFileSync(
    path,
    `// Written by \`scripts/digit-templates.ts\`: don't edit it by hand.\n\n` +
      `/** What each template is (a digit, or "x" for a mark crossing a cell out), its width and\n` +
      ` * height, and its shape: ${SHAPE}×${SHAPE}, row by row, each cell's ink as a character of\n` +
      ` * \`LEVELS\` (in \`names.ts\`). */\n` +
      `export const TEMPLATES: [string, number, number, string][] = [\n` +
      rows.join('\n') +
      `\n];\n`
  );
  console.log(`${rows.length} templates written to ${path}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await write(
    fileURLToPath(new URL('../src/ocr/templates.ts', import.meta.url))
  );
}

/** `text`, drawn dark on light, cropped to its ink, as a glyph. */
async function render(
  text: string,
  font: string,
  weight: string,
  size: number
): Promise<Glyph | undefined> {
  const [w, h] = [size * 2, size * 2];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="100%" height="100%" fill="white"/>` +
    `<text x="${size / 2}" y="${size * 1.5}" font-family="${font}" font-weight="${weight}"` +
    ` font-size="${size}">${text}</text></svg>`;
  const { data } = await sharp(Buffer.from(svg))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // As in `glyphs.ts`: the glyph's bounds are where it has at least 40% of its contrast.
  let [x0, y0, x1, y1] = [w, h, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (255 - data[y * w + x]! > 0.4 * 255) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    }
  }
  if (x1 <= x0) return undefined;
  const gw = x1 - x0;
  const ink = new Float32Array(gw * (y1 - y0));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      ink[(y - y0) * gw + (x - x0)] = (255 - data[y * w + x]!) / 255;
    }
  }
  return {
    x0,
    y0,
    x1,
    y1,
    ink,
    contrast: 255,
    color: [0, 0, 0],
    struck: false,
  };
}

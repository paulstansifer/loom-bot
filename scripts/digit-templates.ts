/**
 * The digits 0 to 9 as drawn by various fonts (those installed here), as `Look`s, to name groups
 * of glyphs by. (Dev-only: it renders them with `sharp`.)
 */

import sharp from 'sharp';

import { look, type Look } from '../src/ocr/cluster.ts';
import type { Glyph } from '../src/ocr/glyphs.ts';

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

export type Template = { digit: string; font: string; look: Look };

export async function templates(size = 32): Promise<Template[]> {
  const out: Template[] = [];
  for (const font of FONTS) {
    for (const weight of ['normal', 'bold']) {
      for (let d = 0; d <= 9; d++) {
        const ink = await render(String(d), font, weight, size);
        if (ink) {
          out.push({
            digit: String(d),
            font: `${font} ${weight}`,
            look: look(ink),
          });
        }
      }
    }
  }
  return out;
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

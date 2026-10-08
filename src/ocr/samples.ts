/**
 * The sample pictures, for tests and debugging (dev-only: it uses `sharp`, which is native).
 *
 * They live outside the repo (they're from r/nonograms): a directory of pictures, each with a
 * `NAME.clues` beside it. A `.clues` file that starts with `# UNCHECKED` hasn't been checked by
 * hand (and the picture is likely a photo).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import type { Raster } from './raster.ts';

export const SAMPLES_DIR =
  process.env.NONOGRAM_SAMPLES ??
  join(homedir(), 'others', 'reddit-nonograms-ocr');

export type Sample = {
  name: string;
  path: string;
  checked: boolean;
  /** The size of the grid, from the number of clue lines. */
  rows: number;
  cols: number;
};

/** The format: comment lines starting with `#`, then `columns`, a line per column, `rows`, and a
 * line per row. */
export function parseClues(text: string): {
  rows: number;
  cols: number;
  checked: boolean;
} {
  const lines = text.split('\n');
  const content = lines.filter((l) => !l.startsWith('#'));
  const columns = content.indexOf('columns');
  const rows = content.indexOf('rows');
  const count = (from: number, to: number) =>
    content.slice(from, to).filter((l) => l.trim() !== '').length;
  return {
    rows: count(rows + 1, content.length),
    cols: count(columns + 1, rows),
    checked: !lines.some((l) => l.startsWith('# UNCHECKED')),
  };
}

export function samples(dir = SAMPLES_DIR): Sample[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Sample[] = [];
  for (const file of names) {
    const match = /^(.*)\.(webp|png|jpe?g)$/.exec(file);
    if (!match) continue;
    const name = match[1]!;
    let clues: string;
    try {
      clues = readFileSync(join(dir, `${name}.clues`), 'utf8');
    } catch {
      continue;
    }
    out.push({ name, path: join(dir, file), ...parseClues(clues) });
  }
  const key = (s: Sample) => (/^\d+$/.test(s.name) ? Number(s.name) : Infinity);
  return out.sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
}

export async function decode(path: string): Promise<Raster> {
  const { data, info } = await sharp(path)
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
  };
}

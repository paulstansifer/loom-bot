/**
 * The sample pictures, for tests and debugging (dev-only: it uses `sharp`, which is native).
 *
 * They live outside the repo (they're from r/nonograms): a directory of pictures, each with a
 * `NAME.clues` beside it. A `.clues` file that starts with `# UNCHECKED` hasn't been checked by
 * hand (and the picture is likely a photo).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';

import type { Raster } from './raster.ts';

export const SAMPLES_DIR =
  process.env.NONOGRAM_SAMPLES ??
  join(homedir(), 'others', 'reddit-nonograms-ocr');

const PICTURE = /\.(webp|png|jpe?g)$/i;

export type Sample = {
  name: string;
  path: string;
  /** What its `.clues` file says, if it has one: the size of the grid (from the number of clue
   * lines), and whether that's been checked. */
  clues?: { rows: number; cols: number; checked: boolean };
};

/** The format: comment lines starting with `#`, then `columns`, a line per column, `rows`, and a
 * line per row. */
export function parseClues(text: string): {
  rows: number;
  cols: number;
  checked: boolean;
} {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const content = lines.filter((l) => !l.startsWith('#'));
  const columns = content.indexOf('columns');
  const rows = content.indexOf('rows');
  if (columns < 0 || rows < columns) {
    throw new Error('expected a `columns` line, and then a `rows` line');
  }
  const count = (from: number, to: number) =>
    content.slice(from, to).filter((l) => l.trim() !== '').length;
  return {
    rows: count(rows + 1, content.length),
    cols: count(columns + 1, rows),
    checked: !lines.some((l) => l.startsWith('# UNCHECKED')),
  };
}

/** The picture at `path`, and what the `.clues` file beside it says, if there is one. */
export function sample(path: string): Sample {
  const name = basename(path, extname(path));
  let text: string;
  try {
    text = readFileSync(join(path, '..', `${name}.clues`), 'utf8');
  } catch {
    return { name, path };
  }
  return { name, path, clues: parseClues(text) };
}

/** The pictures in `dir` that have clues, in order (numerically, where they're numbered). */
export function samples(dir = SAMPLES_DIR): Sample[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const key = (s: Sample) => (/^\d+$/.test(s.name) ? Number(s.name) : Infinity);
  return names
    .filter((file) => PICTURE.test(file))
    .map((file) => sample(join(dir, file)))
    .filter((s) => s.clues)
    .sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
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

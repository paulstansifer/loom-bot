/**
 * Woven, number-loom's share-string format. (This is `woven.rs`.)
 *
 * A share string is `WOVEN-`, then base64 (unpadded) of Brotli-compressed JSON, then `-`, broken
 * into lines of 100 characters. The JSON is a picture (its palette, shape and cells), any
 * metadata, and optionally someone's progress towards solving it. The web app opens one put
 * after a `#` in its URL.
 *
 * This writes byte-for-byte what number-loom writes, so it's tested against number-loom's own
 * frozen share strings (`woven-fixtures/`).
 */

import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

import type { Cell } from '../solve/cell.ts';
import {
  hasProgress,
  parseCells,
  RESERVED_CHS,
  spellCells,
  UNSOLVED,
} from './partialCells.ts';

export { UNSOLVED };

/** Where the web app lives. A `#WOVEN-...-` after it opens that puzzle. */
export const APP_URL = 'https://paulstansifer.github.io/number-loom/';

/** A triangle-shaped half of a square (in a trianogram): `true` is solid in that direction. */
export type Corner = { upper: boolean; left: boolean };

/** How a color is drawn and named. */
export type ColorInfo = {
  /** One character, for drawing it as text. */
  ch: string;
  name: string;
  rgb: [number, number, number];
  /** Its number in the picture's cells: 0 is the background. */
  color: number;
  corner?: Corner;
};

/** A square picture's size, or a triddler's outline (which is only passed through). */
export type Shape =
  { Square: { width: number; height: number } } | { Triangular: unknown };

/** A picture, perhaps with some cells `UNSOLVED`. */
export type Picture = {
  clueStyle: 'Nono' | 'Triano';
  /** One entry per color, including the background (and `UNSOLVED`, if it's used). */
  palette: ColorInfo[];
  shape: Shape;
  /** Each cell's color, row by row. */
  cells: number[];
};

export type WovenDocument = {
  title?: string;
  description?: string;
  author?: string;
  id?: string;
  license?: string;
  solution: Picture;
  /** Someone's progress towards solving it: one cell (a bitmask of colors) per cell. */
  inProgress?: ArrayLike<Cell>;
};

/** Black and white. (This is `bw_palette`.) */
export function bwPalette(): ColorInfo[] {
  return [
    { ch: ' ', name: 'white', rgb: [255, 255, 255], color: 0 },
    { ch: '#', name: 'black', rgb: [0, 0, 0], color: 1 },
  ];
}

/**
 * A square picture of `cells` (-1 where a cell isn't known, which becomes `UNSOLVED`, drawn as
 * `?`, as `grid_to_solution` does).
 */
export function squarePicture(
  width: number,
  height: number,
  cells: ArrayLike<number>,
  palette: ColorInfo[]
): Picture {
  const colors = Array.from(cells, (c) => (c < 0 ? UNSOLVED : c));
  const unsolved: ColorInfo = {
    ch: '?',
    name: 'unsolved',
    rgb: [128, 128, 128],
    color: UNSOLVED,
  };
  return {
    clueStyle: 'Nono',
    palette: colors.includes(UNSOLVED) ? [...palette, unsolved] : palette,
    shape: { Square: { width, height } },
    cells: colors,
  };
}

/** A link that opens `doc` in the web app. */
export function shareUrl(doc: WovenDocument): string {
  return `${APP_URL}#${toWoven(doc).replace(/\s/g, '')}`;
}

/** What a duplicate `ch` may be replaced with: printable ASCII, except space (the background). */
const REPLACEMENT_CHS = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
  String.fromCharCode(0x21 + i)
);

export function toWoven(doc: WovenDocument): string {
  const json = JSON.stringify(serialize(doc));
  const compressed = brotliCompressSync(Buffer.from(json, 'utf8'), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 22,
    },
  });
  const encoded = `WOVEN-${compressed.toString('base64').replace(/=+$/, '')}-`;
  let out = '';
  for (let i = 0; i < encoded.length; i++) {
    out += encoded[i];
    if ((i + 1) % 100 === 0) out += '\n';
  }
  return out;
}

/** The JSON that `toWoven` compresses. Keys are in the order serde writes them. */
export function serialize(doc: WovenDocument): unknown {
  const palette = doc.solution.palette;
  const inProgress =
    doc.inProgress &&
    hasProgress(
      doc.inProgress,
      palette.map((ci) => ci.color)
    )
      ? doc.inProgress
      : undefined;
  // Progress needs `?`, `[`, and `]` to itself, but only rename colors if we need to.
  const solution = serializeSolution(
    doc.solution,
    inProgress ? RESERVED_CHS : []
  );
  // If the palette couldn't be made unambiguous, dropping progress beats failing to save.
  const progress = inProgress
    ? spellInProgress(solution.palette, inProgress)
    : undefined;

  const v0: Record<string, unknown> = {};
  if (doc.title) v0.title = doc.title;
  if (doc.description) v0.description = doc.description;
  if (doc.author) v0.author = doc.author;
  if (doc.id) v0.id = doc.id;
  if (doc.license) v0.license = doc.license;
  v0.solution = {
    clue_style: doc.solution.clueStyle,
    palette: solution.palette.map(colorJson),
    shape: doc.solution.shape,
    ...(solution.c ? { c: solution.c } : {}),
    ...(solution.cells.length > 0 ? { cells: solution.cells } : {}),
  };
  if (progress) v0.in_progress = progress;
  return { V0: v0 };
}

function colorJson(ci: ColorInfo): unknown {
  return {
    ch: ci.ch,
    name: ci.name,
    rgb: ci.rgb,
    color: ci.color,
    ...(ci.corner
      ? { corner: { upper: ci.corner.upper, left: ci.corner.left } }
      : {}),
  };
}

/**
 * The palette, sorted, and the cells: spelled with each color's `ch` (`c`) if the palette can be
 * made to tell them apart, and as numbers (`cells`) otherwise. Only one of the two is written.
 */
function serializeSolution(
  picture: Picture,
  reserved: string[]
): { palette: ColorInfo[]; c: string; cells: number[] } {
  const asStored = [...picture.palette].sort(compareColorInfo);
  // Spelling the cells needs a palette whose `ch`s tell the colors apart, so try to make one.
  // The repaired palette is only worth writing if spelling the cells with it works.
  const repaired = asStored.map((ci) => ({ ...ci }));
  if (makeChsUnique(repaired, reserved)) {
    repaired.sort(compareColorInfo); // A new `ch` can change where an entry sorts.
    const c = spellPicture(picture.cells, repaired);
    if (c !== undefined) return { palette: repaired, c, cells: [] };
  }
  return { palette: asStored, c: '', cells: picture.cells };
}

/**
 * Gives every palette entry a `ch` that no other entry uses, and that isn't `reserved`, keeping
 * the ones that are already unambiguous. `false` if it runs out of characters.
 */
function makeChsUnique(palette: ColorInfo[], reserved: string[]): boolean {
  const spokenFor = new Set(palette.map((ci) => ci.ch));
  const taken = new Set(reserved);
  for (const ci of palette) {
    if (!taken.has(ci.ch)) {
      taken.add(ci.ch);
      continue;
    }
    const free = REPLACEMENT_CHS.find(
      (ch) => !taken.has(ch) && !spokenFor.has(ch)
    );
    if (free === undefined) return false;
    ci.ch = free;
    taken.add(free);
  }
  return true;
}

/** The cells spelled with the `ch`s of `palette`, or `undefined` if a color isn't in it. */
function spellPicture(
  cells: number[],
  palette: ColorInfo[]
): string | undefined {
  const chOf = new Map(palette.map((ci) => [ci.color, ci.ch]));
  let out = '';
  for (const color of cells) {
    const ch = chOf.get(color);
    if (ch === undefined) return undefined;
    out += ch;
  }
  return out;
}

/** Each `ch` and its color, or `undefined` if that's ambiguous or a `ch` is reserved. */
function chToColor(palette: ColorInfo[]): Map<string, number> | undefined {
  const out = new Map<string, number>();
  for (const ci of palette) {
    if (RESERVED_CHS.includes(ci.ch) || out.has(ci.ch)) return undefined;
    out.set(ci.ch, ci.color);
  }
  return out;
}

function spellInProgress(
  palette: ColorInfo[],
  cells: ArrayLike<Cell>
): string | undefined {
  const byCh = chToColor(palette);
  if (!byCh) return undefined;
  return spellCells(
    cells,
    new Map([...byCh].map(([ch, color]) => [color, ch]))
  );
}

/**
 * `ColorInfo`'s order in Rust: corners last (the plain ones first), then darkest first, then
 * by everything else.
 */
export function compareColorInfo(a: ColorInfo, b: ColorInfo): number {
  return (
    compareCorner(a.corner, b.corner) ||
    sum(a.rgb) - sum(b.rgb) ||
    a.rgb[0] - b.rgb[0] ||
    a.rgb[1] - b.rgb[1] ||
    a.rgb[2] - b.rgb[2] ||
    compareCodePoints(a.ch, b.ch) ||
    compareCodePoints(a.name, b.name) ||
    a.color - b.color
  );
}

function sum(rgb: [number, number, number]): number {
  return rgb[0] + rgb[1] + rgb[2];
}

/** `Option<Corner>`: `None` first, then by `upper`, then `left` (`false` first). */
function compareCorner(a: Corner | undefined, b: Corner | undefined): number {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  return Number(a.upper) - Number(b.upper) || Number(a.left) - Number(b.left);
}

/** As Rust compares strings: by code point (JS's `<` compares UTF-16 code units). */
function compareCodePoints(a: string, b: string): number {
  const [x, y] = [[...a], [...b]];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export function fromWoven(text: string): WovenDocument {
  const trimmed = text.trim();
  if (!trimmed.startsWith('WOVEN-')) throw new Error("missing 'WOVEN-' prefix");
  if (!trimmed.endsWith('-') || trimmed.length < 'WOVEN--'.length)
    throw new Error("must end in a '-'");
  const base64 = trimmed.slice('WOVEN-'.length, -1).replace(/\s/g, '');
  const json = brotliDecompressSync(Buffer.from(base64, 'base64')).toString(
    'utf8'
  );
  return deserialize(JSON.parse(json));
}

/** The inverse of `serialize`. */
export function deserialize(json: unknown): WovenDocument {
  const v0 = field(json, 'V0');
  if (v0 === undefined)
    throw new Error('not a version of Woven this understands');
  const s = field(v0, 'solution');

  // (A palette is a map from color to its entry, so a later entry for a color wins.)
  const byColor = new Map<number, ColorInfo>();
  for (const entry of array(field(s, 'palette'), 'palette')) {
    const ci = colorInfo(entry);
    byColor.set(ci.color, ci);
  }
  const palette = [...byColor.values()];
  const c = optionalString(field(s, 'c'), 'c');
  let cells: number[];
  if (c) {
    const byCh = new Map(palette.map((ci) => [ci.ch, ci.color]));
    cells = [...c].map((ch) => {
      const color = byCh.get(ch);
      if (color === undefined)
        throw new Error(
          `no color in the palette is drawn as ${JSON.stringify(ch)}`
        );
      return color;
    });
  } else {
    cells = array(field(s, 'cells') ?? [], 'cells').map((n) =>
      integer(n, 'cell')
    );
  }
  const clueStyle = field(s, 'clue_style');
  if (clueStyle !== 'Nono' && clueStyle !== 'Triano')
    throw new Error(`unknown clue style ${JSON.stringify(clueStyle)}`);
  const doc: WovenDocument = {
    solution: { clueStyle, palette, shape: shape(field(s, 'shape')), cells },
  };

  const progress = optionalString(field(v0, 'in_progress'), 'in_progress');
  if (progress) {
    const byCh = chToColor(palette);
    if (!byCh) throw new Error('unable to figure out the color');
    const inProgress = parseCells(progress, byCh);
    if (inProgress.length !== cells.length)
      throw new Error("in-progress cells don't match the solution's size");
    doc.inProgress = inProgress;
  }
  for (const key of [
    'title',
    'description',
    'author',
    'id',
    'license',
  ] as const) {
    const value = optionalString(field(v0, key), key);
    if (value) doc[key] = value;
  }
  return doc;
}

function field(json: unknown, key: string): unknown {
  return typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)[key]
    : undefined;
}

function array(json: unknown, what: string): unknown[] {
  if (!Array.isArray(json)) throw new Error(`${what} isn't a list`);
  return json;
}

function integer(json: unknown, what: string): number {
  if (!Number.isInteger(json)) throw new Error(`${what} isn't a whole number`);
  return json as number;
}

function optionalString(json: unknown, what: string): string {
  if (json === undefined || json === null) return '';
  if (typeof json !== 'string') throw new Error(`${what} isn't text`);
  return json;
}

function colorInfo(json: unknown): ColorInfo {
  const ch = optionalString(field(json, 'ch'), 'ch');
  if ([...ch].length !== 1)
    throw new Error(`a color's ch must be one character, not ${ch}`);
  const rgb = array(field(json, 'rgb'), 'rgb').map((n) => integer(n, 'rgb'));
  if (rgb.length !== 3) throw new Error('rgb must have three parts');
  const ci: ColorInfo = {
    ch,
    name: optionalString(field(json, 'name'), 'name'),
    rgb: rgb as [number, number, number],
    color: integer(field(json, 'color'), 'color'),
  };
  // (Older files write `"corner": null`.)
  const corner = field(json, 'corner');
  if (corner !== undefined && corner !== null)
    ci.corner = {
      upper: field(corner, 'upper') === true,
      left: field(corner, 'left') === true,
    };
  return ci;
}

function shape(json: unknown): Shape {
  const square = field(json, 'Square');
  if (square !== undefined)
    return {
      Square: {
        width: integer(field(square, 'width'), 'width'),
        height: integer(field(square, 'height'), 'height'),
      },
    };
  const triangular = field(json, 'Triangular');
  if (triangular !== undefined) return { Triangular: triangular };
  throw new Error('unknown shape');
}

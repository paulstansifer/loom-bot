/**
 * Partial solutions as text, as webpbn's format and Woven write them. (This is
 * `partial_cells.rs`.)
 *
 * Each cell is a palette color's `ch`, `?` for a cell that could be anything, or `[abc]` for one
 * that could be any of `a`, `b` or `c`. Cells are bitmasks of colors, as in `../solve/cell.ts`.
 */

import {
  type Cell,
  canBe,
  fromColor,
  knownColor,
  MAX_COLORS,
} from '../solve/cell.ts';

/** The color of a cell that isn't solved yet, in a picture. It can't be in a `Cell`'s mask. */
export const UNSOLVED = 255;

const UNKNOWN = '?';
const OPEN = '[';
const CLOSE = ']';

/** No color can be spelled with one of these, or the notation would be ambiguous. */
export const RESERVED_CHS = [UNKNOWN, OPEN, CLOSE];

/**
 * `text`'s cells. `?` is every color in `chToColor` (Rust uses a cell with every bit set, which a
 * JS bitmask can't hold).
 */
export function parseCells(
  text: string,
  chToColor: Map<string, number>
): Cell[] {
  const colorOf = (ch: string) => {
    const color = chToColor.get(ch);
    if (color === undefined)
      throw new Error(`undefined color char: ${JSON.stringify(ch)}`);
    if (color >= MAX_COLORS)
      throw new Error(`color ${color} doesn't fit in a cell`);
    return color;
  };
  let anything = 0;
  for (const color of cellColors(chToColor.values()))
    anything |= fromColor(color);

  const cells: Cell[] = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === UNKNOWN) {
      cells.push(anything);
    } else if (ch === OPEN) {
      let cell = 0;
      for (;;) {
        const next = chars[++i];
        if (next === undefined)
          throw new Error(`unclosed ${JSON.stringify(OPEN)}`);
        if (next === CLOSE) break;
        cell |= fromColor(colorOf(next));
      }
      cells.push(cell);
    } else {
      cells.push(fromColor(colorOf(ch)));
    }
  }
  return cells;
}

/**
 * The inverse of `parseCells`, or `undefined` if some cell's color has no `ch`. `?` is any cell
 * that could be every color in `chOf`.
 */
export function spellCells(
  cells: ArrayLike<Cell>,
  chOf: Map<number, string>
): string | undefined {
  const palette = cellColors(chOf.keys());
  let out = '';
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const color = knownColor(cell);
    if (color >= 0) {
      const ch = chOf.get(color);
      if (ch === undefined) return undefined;
      out += ch;
    } else if (couldBeAnything(cell, palette)) {
      out += UNKNOWN;
    } else {
      // Possibilities outside the palette can't happen, so there's no need to write them.
      out +=
        OPEN +
        palette
          .filter((c) => canBe(cell, c))
          .map((c) => chOf.get(c)!)
          .join('') +
        CLOSE;
    }
  }
  return out;
}

/**
 * Whether anything at all is known about `cells`, given the colors in the palette. If not,
 * `spellCells` would write nothing but `?`, and there's no point saving them.
 */
export function hasProgress(
  cells: ArrayLike<Cell>,
  palette: Iterable<number>
): boolean {
  const colors = cellColors(palette);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (knownColor(cell) >= 0 || !couldBeAnything(cell, colors)) return true;
  }
  return false;
}

/** The palette colors a `Cell` can talk about, in order. (Not `UNSOLVED`.) */
function cellColors(palette: Iterable<number>): number[] {
  return [...new Set(palette)]
    .filter((c) => c !== UNSOLVED)
    .sort((a, b) => a - b);
}

function couldBeAnything(cell: Cell, palette: number[]): boolean {
  return palette.every((color) => canBe(cell, color));
}

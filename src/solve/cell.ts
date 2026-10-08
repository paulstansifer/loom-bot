/**
 * What's known about a cell: the colors it could still be, as a bitmask (bit `c` for color `c`).
 * A grid of them is a `Uint32Array`. Color 0 is the background. (This is `line_solve.rs`'
 * `Cell`.)
 */
export type Cell = number;

export const BACKGROUND = 0;

/** Bit 31 would make the masks negative, so one fewer than that. */
export const MAX_COLORS = 31;

/** A cell that could be any of `colors` colors. */
export function anything(colors: number): Cell {
  return 2 ** colors - 1;
}

export function fromColor(color: number): Cell {
  return 1 << color;
}

export function isKnown(cell: Cell): boolean {
  return cell !== 0 && (cell & (cell - 1)) === 0;
}

export function isKnownToBe(cell: Cell, color: number): boolean {
  return cell === 1 << color;
}

export function canBe(cell: Cell, color: number): boolean {
  return (cell & (1 << color)) !== 0;
}

export function unknownButCanBe(cell: Cell, color: number): boolean {
  return canBe(cell, color) && !isKnownToBe(cell, color);
}

/** Everything `cell` could be, `other` could be, too. */
export function isWithin(cell: Cell, other: Cell): boolean {
  return (cell & ~other) === 0;
}

/** The possibilities in `cell` that aren't possibilities in `other`. */
export function without(cell: Cell, other: Cell): Cell {
  return cell & ~other;
}

/** The color, if it's known, and -1 if not. */
export function knownColor(cell: Cell): number {
  return isKnown(cell) ? 31 - Math.clz32(cell) : -1;
}

/** Each color `cell` could be, lowest first. */
export function colorsOf(cell: Cell): number[] {
  const out: number[] = [];
  for (let mask = cell; mask !== 0; mask &= mask - 1)
    out.push(31 - Math.clz32(mask & -mask));
  return out;
}

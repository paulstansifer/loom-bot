/**
 * Reading a photo of a paper puzzle: its grid (`mesh.ts`), straightened (`rectify.ts`), and read
 * as a screenshot is (`explain.ts`'s `readWithGrid`), but with its own settings (`settings.ts`).
 */

import type { State } from '../cells.ts';
import { readWithGrid } from '../explain.ts';
import type { Grid } from '../grid.ts';
import type { Raster } from '../raster.ts';
import type { Reading } from '../read.ts';
import { findPaperGrid } from './mesh.ts';
import { straighten } from './rectify.ts';
import { PAPER } from './settings.ts';

export type PaperReading =
  | {
      ok: true;
      /** The grid, in the straightened picture. */
      grid: Grid;
      reading: Reading;
      states: State[];
      /** How many clues were worked out from the grid. */
      filled: number;
    }
  | { ok: false; reason: string };

export function readPaper(
  photo: Raster,
  timed: <T>(what: string, f: () => T) => T = (_, f) => f()
): PaperReading {
  const found = timed('paper grid', () => findPaperGrid(photo));
  if (!found.ok) return { ok: false, reason: found.reason };
  const straight = timed('straighten', () => straighten(photo, found.grid));
  const { reading, states, filled } = readWithGrid(
    straight.raster,
    straight.grid,
    timed,
    PAPER
  );
  return { ok: true, grid: straight.grid, reading, states, filled };
}

/**
 * What differs between reading a screenshot and reading a photo of paper (straightened, see
 * `src/ocr/paper/`). The two are calibrated separately: the screenshots' settings are what the
 * readers were developed with, and the paper ones are in `paper/settings.ts`.
 */
import { readCells, type State } from './cells.ts';
import type { Grid } from './grid.ts';
import type { Raster } from './raster.ts';

export type Settings = {
  /** Glyphs shorter than this, as a fraction of a cell, don't count toward the typical glyph's
   * height (which says what's too small to be a digit). */
  typicalFrom: number;
  /** Whether a digit found crossed out (`Glyph.struck`) is unreadable, to be worked out from the
   * grid (`repair.ts`), not read through the line across it. */
  struckUnread: boolean;
  /** Whether a group of glyphs can be renamed to its second-nearest template, where that makes
   * the clues make more sense (`explain.ts`). (It can always be taken as crossed out.) */
  renameGroups: boolean;
  /** How the grid's state is read. */
  readCells: (raster: Raster, grid: Grid) => { states: State[] };
};

export const SCREENSHOT: Settings = {
  typicalFrom: 0,
  struckUnread: false,
  renameGroups: true,
  readCells,
};

/**
 * What differs between reading a screenshot and reading a photo of paper (straightened, see
 * `src/ocr/paper/`). The two are calibrated separately: the screenshots' settings are what the
 * readers were developed with, and the paper ones are in `paper/settings.ts`.
 */
export type Settings = {
  /** Glyphs shorter than this, as a fraction of a cell, don't count toward the typical glyph's
   * height (which says what's too small to be a digit). */
  typicalFrom: number;
};

export const SCREENSHOT: Settings = { typicalFrom: 0 };

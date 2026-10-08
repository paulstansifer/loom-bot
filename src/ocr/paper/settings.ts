/** The settings for reading a straightened photo of paper (see `../settings.ts`). */

import type { Settings } from '../settings.ts';

export const PAPER: Settings = {
  // Hand-drawn strokes across clues, and leftover dashes of ruled lines, break into many small
  // pieces, which can outnumber the digits. Printed digits are at least this tall.
  typicalFrom: 0.4,
};

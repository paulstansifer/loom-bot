/** The settings for reading a straightened photo of paper (see `../settings.ts`). */

import type { Settings } from '../settings.ts';
import { readPaperCells } from './cells.ts';

export const PAPER: Settings = {
  // Hand-drawn strokes across clues, and leftover dashes of ruled lines, break into many small
  // pieces, which can outnumber the digits. Printed digits are at least this tall.
  typicalFrom: 0.4,
  // A pencil or pen stroke across a printed digit hides it, where an app's line in another color
  // only crosses it. Someone who's crossed out a clue has usually finished its block.
  struckUnread: true,
  // Renaming can make a lot of clues make sense that aren't right: in sample 6, with its many
  // crossed-out clues unread, every "2" was renamed "3".
  renameGroups: false,
  // By how much of each cell is inked, not how it looks.
  readCells: readPaperCells,
};

/**
 * What to reply to a post's picture. For now (for testing), that's always something: the
 * guidance, if the clues read make sense, followed by what was read and how long it took; and
 * otherwise, what went wrong.
 *
 * The person's progress in the grid isn't read yet, so the guidance is for someone who hasn't
 * started.
 */

import { findPuzzle } from '../ocr/bounds.ts';
import type { Raster } from '../ocr/raster.ts';
import {
  cluesText,
  consistency,
  readClues,
  type Reading,
} from '../ocr/read.ts';
import { blankGrid } from '../solve/grid.ts';
import { blackAndWhite } from '../solve/puzzle.ts';
import { guidance, guidanceToMessage } from './guidance.ts';

/** Fewer lanes than this with clues in them, in either direction, isn't a puzzle. */
const MIN_LANES = 4;

/** Reddit's limit on a comment's length is 10,000 characters. */
const MAX_REPLY = 9500;

/** The Reddit username of whoever runs the bot, for the sign-off. (None yet.) */
const OPERATOR: string | undefined = undefined;

export type Reply = {
  /** One line, saying how it went. */
  status: string;
  /** Markdown, to comment with. */
  text: string;
  /** The clues read, if it got that far. */
  reading?: Reading;
};

export function replyTo(raster: Raster): Reply {
  const timings: string[] = [];
  const timed = <T>(what: string, f: () => T): T => {
    const start = performance.now();
    const result = f();
    timings.push(`${what} ${(performance.now() - start).toFixed(0)} ms`);
    return result;
  };
  const picture = `${raster.width}x${raster.height} picture`;

  const found = timed('grid', () => findPuzzle(raster));
  if (!found.ok)
    return debug(
      `no grid found: ${found.reason}`,
      [`Picture: ${picture}.`],
      timings
    );
  const { grid } = found;
  const reading = timed('clues', () => readClues(raster, grid));
  const check = consistency(reading);
  const facts = [
    `Picture: ${picture}. Grid: ${grid.cols}x${grid.rows}` +
      (grid.pixelPerfect ? '.' : ', not straight (a photo?).'),
    `Clue totals: columns ${check.columnTotal}, rows ${check.rowTotal}. ` +
      `Lanes that don't fit: ${check.misfits}. Empty lanes: ${check.empty}. ` +
      `Glyph groups: ${reading.members.length}; least naming margin ${check.margin.toFixed(3)}.`,
  ];
  const withClues = (lanes: number[][]) =>
    lanes.filter((l) => l.length > 0).length;
  if (
    withClues(reading.rows) < MIN_LANES ||
    withClues(reading.columns) < MIN_LANES
  )
    return debug(
      'too few lanes with clues for a puzzle',
      facts,
      timings,
      reading
    );
  if (!check.consistent)
    return debug("the clues read aren't consistent", facts, timings, reading);

  const puzzle = blackAndWhite(reading.rows, reading.columns);
  // (The person's progress isn't read yet.)
  const g = timed('guidance', () => guidance(puzzle, blankGrid(puzzle)));
  if (g === 'no-solution')
    return debug('the clues read have no solution', facts, timings, reading);
  const status = `read ${puzzle.width}x${puzzle.height}: ${g.solved}`;
  return {
    status,
    reading,
    text: fit(
      guidanceToMessage(puzzle, g, 0, OPERATOR) +
        debugSection(status, facts, timings, reading)
    ),
  };
}

/** A reply saying what went wrong. */
export function debug(
  status: string,
  facts: string[],
  timings: string[] = [],
  reading?: Reading
): Reply {
  return {
    status,
    ...(reading ? { reading } : {}),
    text: fit(
      "I couldn't read this puzzle." +
        debugSection(status, facts, timings, reading)
    ),
  };
}

function debugSection(
  status: string,
  facts: string[],
  timings: string[],
  reading?: Reading
): string {
  let text = `\n\n---\n\n**Debugging information** (this bot is being tested): ${status}.\n\n`;
  for (const fact of facts) text += `${fact}\n\n`;
  if (timings.length > 0) text += `Time taken: ${timings.join(', ')}.\n\n`;
  if (reading) {
    // (Indented four spaces, it's a code block.)
    const block = (lines: number[][]) =>
      lines
        .map((l, i) => `    ${String(i + 1).padStart(2)}: ${cluesText(l)}`)
        .join('\n');
    text += `Columns' clues, as read:\n\n${block(reading.columns)}\n\n`;
    text += `Rows' clues, as read:\n\n${block(reading.rows)}\n`;
  }
  return text;
}

/** Cut a reply that's too long for Reddit. */
function fit(text: string): string {
  return text.length <= MAX_REPLY
    ? text
    : `${text.slice(0, MAX_REPLY)}\n\n(…cut short.)`;
}

/**
 * What to reply to a post's picture: the guidance, if the clues read make sense, and otherwise,
 * nothing. Separately, there's what was read and how long it took, and what went wrong, for
 * whoever asks for it (`commands.ts`).
 *
 * The person's progress in the grid is read too (`cells.ts`), and clues that couldn't be read,
 * or seem to be crossed out (`explain.ts`), are worked out from it (`repair.ts`); clues that seem
 * misnamed are named again. If the progress contradicts the clues in many lanes, it was probably
 * misread, and the guidance is for someone who hasn't started.
 *
 * A picture is read as a screenshot first, and only if that doesn't work, as a photo of paper
 * (`src/ocr/paper/`), which has its own way of finding the grid.
 */

import { findPuzzle } from '../ocr/bounds.ts';
import {
  cellsText,
  contradicted,
  type State,
  stateCells,
} from '../ocr/cells.ts';
import { readWithGrid } from '../ocr/explain.ts';
import type { Grid } from '../ocr/grid.ts';
import { readPaper } from '../ocr/paper/read.ts';
import type { Raster } from '../ocr/raster.ts';
import { cluesText, consistency, type Reading } from '../ocr/read.ts';
import { blankGrid } from '../solve/grid.ts';
import { blackAndWhite } from '../solve/puzzle.ts';
import { guidance, guidanceToMessage } from './guidance.ts';

/** Fewer lanes than this with clues in them, in either direction, isn't a puzzle. */
const MIN_LANES = 4;

/** If the progress read contradicts more than this fraction of the lanes, it's not believed
 * (in a screenshot, or a photo of paper). */
const MOST_CONTRADICTED = 0.25;
const PAPER_MOST_CONTRADICTED = 0.25;

/** Reddit's limit on a comment's length is 10,000 characters. */
const MAX_REPLY = 9500;

/** The Reddit username of whoever runs the bot, for the sign-off.*/
const OPERATOR: string | undefined = 'paul_stansifer';

export type Reply = {
  /** One line, saying how it went. */
  status: string;
  /** Markdown, to comment with; none if the puzzle couldn't be read. */
  text?: string;
  /** Markdown: what was read, and how long it took, for whoever asks. */
  debugging: string;
  /** The clues read, if it got that far, and the picture they were read from (straightened, for
   * a photo of paper). */
  reading?: Reading;
  picture?: Raster;
};

/** A reading of the picture, as a screenshot or as a photo of paper. */
type Attempt = {
  kind: 'screenshot' | 'paper';
  /** The picture read (straightened, for a photo of paper), and the grid in it. */
  raster: Raster;
  grid: Grid;
  reading: Reading;
  states: State[];
  filled: number;
  /** The facts about it, for the debugging information. */
  facts: string[];
  /** What's wrong with it, if anything. */
  problem?: string;
};

export function replyTo(raster: Raster): Reply {
  const timings: string[] = [];
  const timed = <T>(what: string, f: () => T): T => {
    const start = performance.now();
    const result = f();
    timings.push(`${what} ${(performance.now() - start).toFixed(0)} ms`);
    return result;
  };
  const picture = `Picture: ${raster.width}x${raster.height} picture.`;

  // As a screenshot, and if that doesn't work, as a photo of paper.
  const shot = asScreenshot(raster, timed);
  const attempt =
    typeof shot !== 'string' && !shot.problem
      ? shot
      : (() => {
          const photo = asPaper(raster, timed);
          if (typeof photo !== 'string' && !photo.problem) return photo;
          // Neither: whichever got further says why.
          if (typeof shot !== 'string') {
            shot.facts.push(
              `As a photo of paper: ${typeof photo === 'string' ? photo : photo.problem}.`
            );
            return shot;
          }
          if (typeof photo !== 'string') {
            photo.facts.splice(
              1,
              0,
              `As a screenshot: no grid found (${shot}).`
            );
            return photo;
          }
          return `no grid found: ${shot}; as a photo of paper, ${photo}`;
        })();
  if (typeof attempt === 'string') return debug(attempt, [picture], timings);
  const {
    kind,
    raster: read,
    grid,
    reading,
    states,
    filled,
    facts,
    problem,
  } = attempt;
  // (The first fact is about the grid; the picture goes in front of it, as one line.)
  facts[0] = `${picture} ${facts[0]}`;
  if (problem) return debug(problem, facts, timings, reading, read);

  const puzzle = blackAndWhite(reading.rows, reading.columns);
  const cells = stateCells(states);
  const broken = contradicted(puzzle, cells).length;
  const believed =
    kind === 'paper'
      ? broken <= PAPER_MOST_CONTRADICTED * puzzle.lanes.length
      : grid.pixelPerfect && broken <= MOST_CONTRADICTED * puzzle.lanes.length;
  facts.push(
    `Progress read (${believed ? 'used' : 'not used'}; ${broken} lanes contradict it; ` +
      `${filled} unreadable clues worked out from it):\n\n${cellsText(
        states,
        grid.cols
      )
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')}`
  );
  const g = timed('guidance', () =>
    guidance(
      puzzle,
      believed ? cells : blankGrid(puzzle),
      undefined,
      kind === 'paper'
    )
  );
  if (g === 'no-solution')
    return debug(
      'the clues read have no solution',
      facts,
      timings,
      reading,
      read
    );
  const status = `read ${puzzle.width}x${puzzle.height}${kind === 'paper' ? ' (paper)' : ''}: ${g.solved}`;
  return {
    status,
    reading,
    picture: read,
    text: fit(guidanceToMessage(puzzle, g, 0, OPERATOR)),
    debugging: debugging(status, facts, timings, reading),
  };
}

type Timed = <T>(what: string, f: () => T) => T;

/** The picture read as a screenshot, or why there's no grid. */
function asScreenshot(raster: Raster, timed: Timed): Attempt | string {
  const found = timed('grid', () => findPuzzle(raster));
  if (!found.ok) return found.reason;
  const { grid } = found;
  const read = readWithGrid(raster, grid, timed);
  return judged({
    kind: 'screenshot',
    raster,
    grid,
    ...read,
    facts: [
      `Grid: ${grid.cols}x${grid.rows}` +
        (grid.pixelPerfect ? '.' : ', not straight (a photo?).'),
    ],
  });
}

/** The picture read as a photo of paper, or why there's no grid. */
function asPaper(raster: Raster, timed: Timed): Attempt | string {
  const read = readPaper(raster, timed);
  if (!read.ok) return read.reason;
  const { grid } = read;
  return judged({
    kind: 'paper',
    ...read,
    facts: [`Grid: ${grid.cols}x${grid.rows}, in a photo of paper.`],
  });
}

/** `a`, with what the clues read add up to, and what's wrong with them, if anything. */
function judged(a: Attempt): Attempt {
  const { reading } = a;
  const check = consistency(reading);
  a.facts.push(
    `Clue totals: columns ${check.columnTotal}, rows ${check.rowTotal}. ` +
      `Lanes that don't fit: ${check.misfits}. Empty lanes: ${check.empty}. ` +
      `Glyph groups: ${reading.members.length}; least naming margin ${check.margin.toFixed(3)}.`
  );
  const withClues = (lanes: number[][]) =>
    lanes.filter((l) => l.length > 0).length;
  if (
    withClues(reading.rows) < MIN_LANES ||
    withClues(reading.columns) < MIN_LANES
  )
    a.problem = 'too few lanes with clues for a puzzle';
  else if (!check.consistent) a.problem = "the clues read aren't consistent";
  return a;
}

/** A reply saying what went wrong. */
export function debug(
  status: string,
  facts: string[],
  timings: string[] = [],
  reading?: Reading,
  picture?: Raster
): Reply {
  return {
    status,
    ...(reading ? { reading } : {}),
    ...(picture ? { picture } : {}),
    debugging: debugging(status, facts, timings, reading),
  };
}

function debugging(
  status: string,
  facts: string[],
  timings: string[],
  reading?: Reading
): string {
  let text = `**Debugging information**: ${status}.\n\n`;
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
  return fit(text);
}

/** Cut a reply that's too long for Reddit. */
function fit(text: string): string {
  return text.length <= MAX_REPLY
    ? text
    : `${text.slice(0, MAX_REPLY)}\n\n(…cut short.)`;
}

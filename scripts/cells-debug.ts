/**
 * Reads the state of each sample picture's grid (filled, crossed out, undecided), and prints it
 * as text: `#` filled, `x` crossed out, `.` undecided. With a checked `.clues` file, it also says
 * how many lanes the state contradicts (a lane with no arrangement of its clues that fits its
 * decided cells). Someone's mistakes can contradict a few; a wrong reading, many.
 *
 *   node --experimental-strip-types scripts/cells-debug.ts [DIR | PICTURE...] [--quiet]
 */

import { statSync } from 'node:fs';

import { findPuzzle } from '../src/ocr/bounds.ts';
import {
  cellsText,
  contradicted,
  readCells,
  stateCells,
} from '../src/ocr/cells.ts';
import { blackAndWhite } from '../src/solve/puzzle.ts';
import {
  decode,
  sample,
  samples,
  SAMPLES_DIR,
  type Sample,
} from '../src/ocr/samples.ts';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const inputs = args.filter((a) => !a.startsWith('--'));
const list: Sample[] = (inputs.length > 0 ? inputs : [SAMPLES_DIR]).flatMap(
  (input) => (statSync(input).isDirectory() ? samples(input) : [sample(input)])
);

for (const s of list) {
  const raster = await decode(s.path);
  const found = findPuzzle(raster);
  if (!found.ok) {
    console.log(`${s.name}: no grid (${found.reason})`);
    continue;
  }
  const start = performance.now();
  const reading = readCells(raster, found.grid);
  const ms = performance.now() - start;
  const count = (state: string) =>
    reading.states.filter((x) => x === state).length;
  let bad = '';
  const { clues } = s;
  if (
    clues?.checked &&
    clues.rows === found.grid.rows &&
    clues.cols === found.grid.cols
  ) {
    const puzzle = blackAndWhite(clues.rowClues, clues.columnClues);
    const lanes = contradicted(puzzle, stateCells(reading.states));
    bad = `, ${lanes.length}/${puzzle.lanes.length} lanes contradicted`;
  }
  console.log(
    `${s.name}: ${found.grid.cols}x${found.grid.rows}, ` +
      `${count('filled')} filled, ${count('crossed')} crossed, ` +
      `${reading.meaning.length} groups, ${ms.toFixed(0)} ms${bad}`
  );
  if (!quiet) console.log(cellsText(reading.states, found.grid.cols) + '\n');
}

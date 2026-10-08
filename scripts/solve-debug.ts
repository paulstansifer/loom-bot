/**
 * Solves puzzles and reports how: by line logic, by searching (with how many guesses), or that
 * it's ambiguous, ran out of time, or has no solution, and how long that took.
 *
 * The inputs are directories of samples (their `.clues` files), `.clues` files, olsak-format
 * (`.g`) files (number-loom converts to those, from webpbn's format among others), or pictures of
 * puzzles one pixel per cell (as in number-loom's `examples/png`), where white (or else the
 * commonest color) is the background.
 *
 *   node --experimental-strip-types scripts/solve-debug.ts [DIR | FILE...] [--time MS]
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import sharp from 'sharp';

import { parseClues, samples, SAMPLES_DIR } from '../src/ocr/samples.ts';
import {
  blackAndWhite,
  makePuzzle,
  puzzleFromPicture,
  type Puzzle,
} from '../src/solve/puzzle.ts';
import { lineLogicSolve, Mode } from '../src/solve/grid.ts';
import { solve } from '../src/solve/solve.ts';

const args = process.argv.slice(2);
const timeIndex = args.indexOf('--time');
const timeLimitMs = timeIndex >= 0 ? Number(args[timeIndex + 1]) : 2000;
const inputs = args.filter(
  (_, i) => timeIndex < 0 || (i !== timeIndex && i !== timeIndex + 1)
);

/** Each input's puzzles, by name. */
async function load(input: string): Promise<[string, Puzzle][]> {
  if (statSync(input).isDirectory())
    return samples(input).flatMap((s) =>
      s.clues
        ? [[s.name, blackAndWhite(s.clues.rowClues, s.clues.columnClues)]]
        : []
    );
  if (input.endsWith('.clues')) {
    const clues = parseClues(readFileSync(input, 'utf8'));
    return [
      [basename(input), blackAndWhite(clues.rowClues, clues.columnClues)],
    ];
  }
  if (input.endsWith('.g'))
    return [[basename(input), fromOlsak(readFileSync(input, 'utf8'))]];
  return [[basename(input), await fromPicture(input)]];
}

/**
 * Olsak's format, as number-loom writes it: a `#d` section of colors (`0:` is the background,
 * and `a:a  #000000  black` says clues in `a` are that color), then `: rows` and `: columns`,
 * with a line of clues like `2a 1b` per lane.
 */
function fromOlsak(text: string): Puzzle {
  const lines = text.split(/\r?\n/);
  const rowsAt = lines.indexOf(': rows');
  const columnsAt = lines.indexOf(': columns');
  if (rowsAt < 0 || columnsAt < 0)
    throw new Error('not a puzzle with rows and columns');
  const colors = new Map([['0', 0]]);
  for (const line of lines.slice(0, rowsAt)) {
    const key = /^\s*(\S):/.exec(line)?.[1];
    if (key && !colors.has(key)) colors.set(key, colors.size);
  }
  const lanes = (from: number, to: number) =>
    lines.slice(from, to).map((line) =>
      [...line.matchAll(/(\d+)(\S)/g)].map(([, count, key]) => {
        const color = colors.get(key!);
        if (color === undefined) throw new Error(`unknown color ${key}`);
        return { color, count: Number(count) };
      })
    );
  let end = lines.length;
  while (end > columnsAt + 1 && lines[end - 1]!.trim() === '') end--;
  return makePuzzle(
    colors.size,
    lanes(rowsAt + 1, columnsAt),
    lanes(columnsAt + 1, end)
  );
}

/** A picture with a pixel per cell. */
async function fromPicture(path: string): Promise<Puzzle> {
  const { data, info } = await sharp(path)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = (i: number) =>
    (data[i * 3]! << 16) | (data[i * 3 + 1]! << 8) | data[i * 3 + 2]!;
  const counts = new Map<number, number>();
  for (let i = 0; i < info.width * info.height; i++)
    counts.set(rgb(i), (counts.get(rgb(i)) ?? 0) + 1);
  const background = counts.has(0xffffff)
    ? 0xffffff
    : [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const index = new Map([[background, 0]]);
  for (const color of counts.keys())
    if (!index.has(color)) index.set(color, index.size);
  const picture = Array.from({ length: info.height }, (_, y) =>
    Array.from({ length: info.width }, (_, x) =>
      index.get(rgb(y * info.width + x))!
    )
  );
  return puzzleFromPicture(index.size, picture);
}

for (const input of inputs.length > 0 ? inputs : [SAMPLES_DIR]) {
  let puzzles: [string, Puzzle][];
  try {
    puzzles = await load(input);
  } catch (e) {
    console.log(`${basename(input).padEnd(28)} ${String(e)}`);
    continue;
  }
  for (const [name, puzzle] of puzzles) {
    const start = performance.now();
    const answer = solve(puzzle, { timeLimitMs });
    const ms = performance.now() - start;
    const how =
      answer.kind === 'no-solution'
        ? answer.kind
        : `${answer.kind}${answer.guesses ? ` (${answer.guesses} guesses)` : ''}, ` +
          `${[...answer.cells].filter((c) => c < 0).length} unknown`;
    // (To compare with number-loom's report: line logic is deterministic, so these should match.)
    const counts = lineLogicSolve(puzzle).state.solveCounts;
    const lanes = `skims ${counts[Mode.Skim]} scrubs ${counts[Mode.Scrub]}`;
    const size = `${puzzle.width}x${puzzle.height}, ${puzzle.colors} colors`;
    console.log(
      `${name.padEnd(28)} ${size.padEnd(20)} ${how.padEnd(36)} ${lanes.padEnd(22)} ` +
        `${ms.toFixed(1)} ms`
    );
  }
}

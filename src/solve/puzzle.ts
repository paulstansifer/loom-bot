/**
 * A nonogram's clues, and which cells each lane crosses. (The parts of `puzzle.rs` and
 * `geometry.rs` that the solver needs, for square cells only.)
 */

import { BACKGROUND, MAX_COLORS } from './cell.ts';

/** A run of `count` cells of `color` (never the background). */
export type Clue = { color: number; count: number };

export type Puzzle = {
  width: number;
  height: number;
  /** How many colors there are, including the background (color 0). */
  colors: number;
  /** Each lane's clues: the rows, top to bottom, then the columns, left to right. */
  lanes: Clue[][];
  /** Each lane's cells, in order. Cell `y * width + x` is at `(x, y)`. */
  laneCells: Int32Array[];
  /** Each cell's lanes. */
  memberships: number[][];
};

/**
 * A puzzle from its rows' clues (top to bottom) and its columns' (left to right). Runs of 0,
 * which some formats write for an empty lane, are dropped.
 */
export function makePuzzle(
  colors: number,
  rows: Clue[][],
  columns: Clue[][]
): Puzzle {
  const width = columns.length;
  const height = rows.length;
  const laneCells: Int32Array[] = [];
  for (let y = 0; y < height; y++)
    laneCells.push(Int32Array.from({ length: width }, (_, x) => y * width + x));
  for (let x = 0; x < width; x++)
    laneCells.push(
      Int32Array.from({ length: height }, (_, y) => y * width + x)
    );
  return withLanes(colors, width, height, [...rows, ...columns], laneCells);
}

/** A puzzle with a single lane, for testing line logic without anything crossing it. */
export function singleLane(
  colors: number,
  length: number,
  clues: Clue[]
): Puzzle {
  return withLanes(
    colors,
    length,
    1,
    [clues],
    [Int32Array.from({ length }, (_, i) => i)]
  );
}

function withLanes(
  colors: number,
  width: number,
  height: number,
  lanes: Clue[][],
  laneCells: Int32Array[]
): Puzzle {
  if (colors > MAX_COLORS) throw new Error(`${colors} colors is too many`);
  const memberships: number[][] = Array.from(
    { length: width * height },
    () => []
  );
  laneCells.forEach((cells, lane) =>
    cells.forEach((cell) => memberships[cell]!.push(lane))
  );
  return {
    width,
    height,
    colors,
    lanes: lanes.map((clues) => clues.filter((clue) => clue.count > 0)),
    laneCells,
    memberships,
  };
}

/** A lane's clues, from its colors. */
export function cluesOf(line: ArrayLike<number>): Clue[] {
  const clues: Clue[] = [];
  for (let i = 0; i < line.length; i++) {
    const color = line[i]!;
    if (color === BACKGROUND) continue;
    if (i > 0 && line[i - 1] === color) clues[clues.length - 1]!.count++;
    else clues.push({ color, count: 1 });
  }
  return clues;
}

/** The puzzle whose answer is `picture` (rows of colors). (This is `solution_to_puzzle`.) */
export function puzzleFromPicture(colors: number, picture: number[][]): Puzzle {
  const width = picture[0]?.length ?? 0;
  return makePuzzle(
    colors,
    picture.map(cluesOf),
    Array.from({ length: width }, (_, x) =>
      cluesOf(picture.map((row) => row[x]!))
    )
  );
}

/** A black-and-white puzzle, from its rows' and columns' runs. */
export function blackAndWhite(rows: number[][], columns: number[][]): Puzzle {
  const clues = (counts: number[]) =>
    counts.map((count) => ({ color: 1, count }));
  return makePuzzle(2, rows.map(clues), columns.map(clues));
}

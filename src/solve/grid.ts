/**
 * Line logic over the whole grid: keep picking the most promising lane, solving it by itself,
 * and writing what it learned back, until the grid is solved or nothing more turns up. (This is
 * `grid_solve.rs`.)
 */

import { type Cell, anything, fromColor, isKnown } from './cell.ts';
import {
  countLane,
  exhaustLine,
  fixedClues,
  scoreCounts,
  skimLine,
  summarize,
  verifyLine,
} from './line.ts';
import type { Puzzle } from './puzzle.ts';

/**
 * How hard to look at a lane, from quickest to most thorough. `Verify` checks a lane that's
 * already full (it has to be done anyway, so it's done first).
 */
export const Mode = { Verify: 0, Skim: 1, Scrub: 2 } as const;
export type SolveMode = (typeof Mode)[keyof typeof Mode];
const MODES: readonly SolveMode[] = [Mode.Verify, Mode.Skim, Mode.Scrub];
const REGULAR_MODES: readonly SolveMode[] = [Mode.Skim, Mode.Scrub];

export type SolveOptions = { maxEffort?: SolveMode };

/** Why a trail entry narrowed its cell. */
export type TrailReason =
  | { kind: 'lane'; lane: number } // line logic on this lane
  | { kind: 'nogood'; nogood: number } // a search nogood (an index into its list) fired
  | { kind: 'guess' };

/** One entry on an undo trail: `cell` was `old` before this. */
export type TrailStep = {
  cell: number;
  old: Cell;
  /** How many guesses came before it. */
  level: number;
  reason: TrailReason;
};

/** Where `run` ended up. `contradiction` is a lane with no arrangement that fits the grid. */
export type Outcome = 'solved' | 'stalled' | { contradiction: number };

/** A blank grid: every cell could be anything. */
export function blankGrid(puzzle: Puzzle): Uint32Array {
  return new Uint32Array(puzzle.width * puzzle.height).fill(
    anything(puzzle.colors)
  );
}

/** Copy a lane's cells out of the grid into `buf` (or a new array). */
export function gather(
  puzzle: Puzzle,
  lane: number,
  grid: Uint32Array,
  buf?: Uint32Array
): Uint32Array {
  const cells = puzzle.laneCells[lane]!;
  const out = buf
    ? buf.subarray(0, cells.length)
    : new Uint32Array(cells.length);
  for (let i = 0; i < cells.length; i++) out[i] = grid[cells[i]!]!;
  return out;
}

/** A queue of lanes. */
class Queue {
  private items: number[];
  private head = 0;
  constructor(items: number[] = []) {
    this.items = items;
  }
  push(lane: number) {
    this.items.push(lane);
  }
  pop(): number | undefined {
    if (this.head === this.items.length) return undefined;
    const lane = this.items[this.head++];
    if (this.head > 64 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return lane;
  }
  isEmpty(): boolean {
    return this.head === this.items.length;
  }
  clear() {
    this.items = [];
    this.head = 0;
  }
  clone(): Queue {
    return new Queue(this.items.slice(this.head));
  }
}

/** How many fruitless attempts each mode below `maxEffort` gets before escalating. */
const INITIAL_ALLOWED_FAILURES = [0 /* ignored */, 10, 0 /* ignored */];

/**
 * Buffers reused across a whole solve (and shared by clones), so that no lane's solve
 * allocates. Nothing in here means anything from one step to the next.
 */
type Scratch = {
  lane: Uint32Array;
  orig: Uint32Array;
  affected: number[];
  /** Lane positions already in `changes`: a cell narrowed twice is reported twice. */
  recorded: Uint8Array;
  changedCells: number[];
  changedWas: Cell[];
};

/**
 * A solve in progress. Cloning one forks the search: give the copy a guess (`learn`) and `run`
 * it without disturbing the original.
 */
export class SolveState {
  readonly puzzle: Puzzle;
  readonly maxEffort: SolveMode;
  grid: Uint32Array;
  cellsLeft: number;
  /** How many lanes each mode has looked at. */
  solveCounts: number[];
  /** Per lane, how many of its cells aren't known. Kept up to date by `noteChange`. */
  private unknownCells: Int32Array;
  /** Per lane and mode (`lane * 3 + mode`), whether it's waiting in that mode's queue. */
  private queued: Uint8Array;
  /**
   * Per mode, which lanes are waiting for a turn, in order. Seeded once, best score first. After
   * that, a lane goes to the back when it's invalidated, rather than being re-ranked.
   */
  private queues: Queue[];
  /**
   * How many more fruitless attempts each mode below `maxEffort` gets before we stop trying it
   * and escalate. Reset whenever a harder mode turns something up.
   */
  private allowedFailures: number[];
  private scratch: Scratch;

  private constructor(from: {
    puzzle: Puzzle;
    maxEffort: SolveMode;
    grid: Uint32Array;
    cellsLeft: number;
    solveCounts: number[];
    unknownCells: Int32Array;
    queued: Uint8Array;
    queues: Queue[];
    allowedFailures: number[];
    scratch: Scratch;
  }) {
    this.puzzle = from.puzzle;
    this.maxEffort = from.maxEffort;
    this.grid = from.grid;
    this.cellsLeft = from.cellsLeft;
    this.solveCounts = from.solveCounts;
    this.unknownCells = from.unknownCells;
    this.queued = from.queued;
    this.queues = from.queues;
    this.allowedFailures = from.allowedFailures;
    this.scratch = from.scratch;
  }

  static start(
    puzzle: Puzzle,
    grid: Uint32Array = blankGrid(puzzle),
    options: SolveOptions = {}
  ): SolveState {
    const lanes = puzzle.lanes.length;
    const longest = Math.max(
      0,
      ...puzzle.laneCells.map((cells) => cells.length)
    );
    const scratch: Scratch = {
      lane: new Uint32Array(longest),
      orig: new Uint32Array(longest),
      affected: [],
      recorded: new Uint8Array(longest),
      changedCells: [],
      changedWas: [],
    };
    const unknownCells = new Int32Array(lanes);
    // Each lane's first (skim, scrub) scores, only for sorting the queues.
    const scores: { skim: number; scrub: number }[] = [];
    for (let lane = 0; lane < lanes; lane++) {
      const counts = countLane(gather(puzzle, lane, grid, scratch.lane));
      unknownCells[lane] = counts.unknownCells;
      scores.push(scoreCounts(summarize(puzzle.lanes[lane]!), counts));
    }
    let cellsLeft = 0;
    for (const cell of grid) if (!isKnown(cell)) cellsLeft++;

    const state = new SolveState({
      puzzle,
      maxEffort: options.maxEffort ?? Mode.Scrub,
      grid,
      cellsLeft,
      solveCounts: [0, 0, 0],
      unknownCells,
      queued: new Uint8Array(lanes * 3),
      queues: MODES.map(() => new Queue()),
      allowedFailures: [...INITIAL_ALLOWED_FAILURES],
      scratch,
    });
    // Seed each mode's queue, best score first. A lane that's already full only needs verifying.
    for (const mode of MODES) {
      const order: number[] = [];
      for (let lane = 0; lane < lanes; lane++)
        if (state.queuable(lane, mode)) {
          order.push(lane);
          state.queued[lane * 3 + mode] = 1;
        }
      if (mode === Mode.Skim)
        order.sort((a, b) => scores[b]!.skim - scores[a]!.skim);
      if (mode === Mode.Scrub)
        order.sort((a, b) => scores[b]!.scrub - scores[a]!.scrub);
      state.queues[mode] = new Queue(order);
    }
    return state;
  }

  clone(): SolveState {
    return new SolveState({
      puzzle: this.puzzle,
      maxEffort: this.maxEffort,
      grid: Uint32Array.from(this.grid),
      cellsLeft: this.cellsLeft,
      solveCounts: [...this.solveCounts],
      unknownCells: Int32Array.from(this.unknownCells),
      queued: Uint8Array.from(this.queued),
      queues: this.queues.map((q) => q.clone()),
      allowedFailures: [...this.allowedFailures],
      scratch: this.scratch,
    });
  }

  /** Verifying is for full lanes, and the rest is for the others. */
  private queuable(lane: number, mode: SolveMode): boolean {
    return (this.unknownCells[lane] === 0) === (mode === Mode.Verify);
  }

  /**
   * Step until the puzzle is solved or line logic stalls. With a `trail`, append each cell's
   * value before it was narrowed.
   *
   * The trail is complete even on a contradiction, which is the case that matters: nothing
   * reaches the grid until a line solver is done with its copy of a lane, so the step that found
   * the contradiction moved nothing, and unwinding the trail lands where the run started.
   */
  run(trail?: TrailStep[]): Outcome {
    for (;;) {
      const step = this.step(trail);
      if (step !== 'attempted') return step;
    }
  }

  /** Pop the next lane to try for `mode` off its queue. */
  private nextLane(mode: SolveMode): number | undefined {
    for (;;) {
      const lane = this.queues[mode]!.pop();
      if (lane === undefined) return undefined;
      this.queued[lane * 3 + mode] = 0;
      if (this.unknownCells[lane] === 0 && mode !== Mode.Verify) continue;
      return lane;
    }
  }

  /**
   * Pick the next lane, escalating to a more thorough mode once the cheaper ones stop paying off.
   * `undefined` when every mode up to `maxEffort` is exhausted.
   */
  private chooseLane(): [number, SolveMode] | undefined {
    // It has to be done some time, so do it now.
    const verify = this.nextLane(Mode.Verify);
    if (verify !== undefined) return [verify, Mode.Verify];

    for (;;) {
      let mode = this.maxEffort;
      for (const m of REGULAR_MODES)
        if (this.allowedFailures[m]! > 0) {
          mode = Math.min(mode, m) as SolveMode;
          break;
        }
      const lane = this.nextLane(mode);
      if (lane !== undefined) return [lane, mode];
      if (mode >= this.maxEffort) return undefined; // Nothing left to try.
      this.allowedFailures[mode] = 0; // Nothing left for this mode; try the next one up.
    }
  }

  /**
   * Do one unit of work: pick the most promising lane, run a line solver on it, write what it
   * learned back to the grid, and requeue every lane the changed cells cross.
   */
  step(trail?: TrailStep[]): 'attempted' | Outcome {
    const chosen = this.chooseLane();
    if (!chosen) return 'stalled';
    const [lane, mode] = chosen;
    const { puzzle, scratch } = this;
    const cells = puzzle.laneCells[lane]!;
    const clues = puzzle.lanes[lane]!;

    // Pull the lane out of the grid, so the line solvers see a plain array.
    const buf = gather(puzzle, lane, this.grid, scratch.lane);
    const orig = scratch.orig.subarray(0, buf.length);
    orig.set(buf);

    this.solveCounts[mode]!++;
    const affected = scratch.affected;
    affected.length = 0;
    const ok =
      mode === Mode.Verify
        ? verifyLine(clues, buf)
        : mode === Mode.Skim
          ? skimLine(clues, buf, affected)
          : exhaustLine(clues, buf, affected);
    if (!ok) return { contradiction: lane };
    for (let i = 0; i < cells.length; i++) this.grid[cells[i]!] = buf[i]!;

    // Only the cells the report names can have moved, so the counts move by a delta, rather
    // than by walking the lane again.
    const { recorded, changedCells, changedWas } = scratch;
    recorded.fill(0, 0, cells.length);
    changedCells.length = 0;
    changedWas.length = 0;
    let newlyKnown = 0;
    for (const position of affected) {
      if (recorded[position]) continue;
      recorded[position] = 1;
      const was = orig[position]!;
      if (!isKnown(was) && isKnown(buf[position]!)) newlyKnown++;
      changedCells.push(cells[position]!);
      changedWas.push(was);
    }
    this.cellsLeft -= newlyKnown;

    if (trail) {
      const level = trail[trail.length - 1]?.level ?? 0; // Only guesses change the level.
      const reason: TrailReason = { kind: 'lane', lane };
      changedCells.forEach((cell, i) =>
        trail.push({ cell, old: changedWas[i]!, level, reason })
      );
    }

    // Fold the changes into every lane that holds one, so that nothing after this (a caller that
    // stops because the puzzle's solved, or a clone) sees stale queues.
    this.invalidate(changedCells, changedWas, lane);

    if (this.cellsLeft === 0 && this.queues[Mode.Verify]!.isEmpty())
      return 'solved';

    // Made progress: reset, and try easy things first again.
    if (mode !== Mode.Skim && affected.length > 0)
      this.allowedFailures = [...INITIAL_ALLOWED_FAILURES];
    if (mode !== this.maxEffort) {
      if (affected.length === 0) this.allowedFailures[mode]!--;
      else
        this.allowedFailures[mode] = Math.min(
          10,
          this.allowedFailures[mode]! + 1
        );
    }
    return 'attempted';
  }

  /**
   * Suppose `cell` is `color` (or, with `is` false, isn't), and requeue everything that bears on,
   * so that `run` after a stall picks up from there.
   */
  learn(
    cell: number,
    color: number,
    is = true
  ): 'new' | 'same' | 'contradiction' {
    return this.learnWithin(cell, is ? fromColor(color) : ~fromColor(color));
  }

  /** `learn`, but narrowing `cell` to (some of) `within`, rather than to one color. */
  learnWithin(cell: number, within: Cell): 'new' | 'same' | 'contradiction' {
    const previous = this.grid[cell]!;
    const now = previous & within;
    if (now === 0) return 'contradiction';
    if (now === previous) return 'same';
    this.grid[cell] = now;
    if (isKnown(now)) this.cellsLeft--;
    this.invalidate([cell], [previous], -1);
    // A guess is new information, so it's worth another cheap pass before escalating.
    this.allowedFailures = [...INITIAL_ALLOWED_FAILURES];
    return 'new';
  }

  /**
   * Rewind the trail from entry `from` on. That always leaves the state stalled (no lanes
   * queued), but it only makes sense to guess from a stall anyway.
   */
  unwind(trail: TrailStep[], from = 0) {
    for (let i = trail.length - 1; i >= from; i--) {
      const { cell, old } = trail[i]!;
      const narrowed = this.grid[cell]!;
      if (narrowed === old) continue; // No-ops are okay.
      this.grid[cell] = old;
      if (isKnown(narrowed) && !isKnown(old)) this.cellsLeft++;
      for (const lane of this.puzzle.memberships[cell]!)
        this.noteChange(lane, narrowed, old);
    }
    for (const queue of this.queues) queue.clear();
    this.queued.fill(0);
  }

  /** Fold one cell's change into its lane's `unknownCells`, in either direction. */
  private noteChange(lane: number, was: Cell, now: Cell) {
    const wasKnown = isKnown(was);
    const nowKnown = isKnown(now);
    if (!wasKnown && nowKnown) this.unknownCells[lane]!--;
    else if (wasKnown && !nowKnown) this.unknownCells[lane]!++;
  }

  /**
   * React to a batch of changed cells (each with what it was before): fold each into
   * `unknownCells` for every lane holding it, and send each such lane to the back of every
   * mode's queue it isn't already in. `justSolved` (the lane the changes came from) isn't
   * requeued: it would just come straight back.
   */
  private invalidate(cells: number[], was: Cell[], justSolved: number) {
    // Fold all the changes in before touching any queue, so as not to act on a half-updated lane.
    const touched: number[] = [];
    cells.forEach((cell, i) => {
      const now = this.grid[cell]!;
      for (const lane of this.puzzle.memberships[cell]!) {
        this.noteChange(lane, was[i]!, now);
        if (!touched.includes(lane)) touched.push(lane);
      }
    });
    // Lowest lane first, rather than in whatever order the cells came in.
    touched.sort((a, b) => a - b);
    for (const lane of touched) {
      if (lane === justSolved) continue;
      for (const mode of MODES) {
        if (!this.queuable(lane, mode) || this.queued[lane * 3 + mode])
          continue;
        this.queued[lane * 3 + mode] = 1;
        this.queues[mode]!.push(lane);
      }
    }
  }

  /**
   * The lanes whose `unknownCells` disagrees with the grid. `unknownCells` moves by deltas, so a
   * missed change would quietly leave a lane looking unsolved (or solved) for good. (Rust checks
   * this with a debug assertion; here, it's for tests.)
   */
  unknownCellsDrift(): number[] {
    const drifted: number[] = [];
    this.puzzle.laneCells.forEach((cells, lane) => {
      let unknown = 0;
      for (const cell of cells) if (!isKnown(this.grid[cell]!)) unknown++;
      if (unknown !== this.unknownCells[lane]) drifted.push(lane);
    });
    return drifted;
  }
}

/** Line logic from `grid` (blank by default), as far as it goes. */
export function lineLogicSolve(
  puzzle: Puzzle,
  grid?: Uint32Array,
  options: SolveOptions = {}
): { outcome: Outcome; state: SolveState } {
  const state = SolveState.start(puzzle, grid, options);
  return { outcome: state.run(), state };
}

/** The clues each lane has pinned down and painted in (`fixedClues`), per lane. */
export function allFixedClues(puzzle: Puzzle, grid: Uint32Array): number[][] {
  return puzzle.lanes.map((clues, lane) =>
    fixedClues(clues, gather(puzzle, lane, grid))
  );
}

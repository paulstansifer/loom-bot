/**
 * Backtracking search for puzzles line logic can't finish, by constraint propagation with
 * conflict learning (as in a CDCL SAT solver). (This is `conprop.rs`.)
 *
 * Guess a cell's color, run line logic, and repeat. On a contradiction, work out which earlier
 * facts it really depended on, record that they can't all hold (a "nogood"), and jump back to
 * where the nogood says something new. Having found a solution, rule it out with a nogood and
 * look for a second one: running out of places to look proves it unique.
 */

import { type Cell, colorsOf, isKnown, isWithin, without } from './cell.ts';
import { exhaustLine } from './line.ts';
import { Picker, seededRandom } from './picker.ts';
import { SolveState, type TrailStep, gather } from './grid.ts';
import type { Puzzle } from './puzzle.ts';

/**
 * Literals that can't all hold at once. A literal holds when its cell is narrowed to a subset of
 * its mask.
 */
export type Nogood = {
  notAllTrue: Map<number, Cell>;
  /** How many of the literals hold. (Kept up to date by `updateNogoodCounters`.) */
  falseCount: number;
};

/**
 * `'contradiction'` if every literal holds, `[cell, within]` if all but one does (so that one's
 * cell has to be narrowed to `within`), and `undefined` otherwise.
 */
export function deduction(
  nogood: Nogood,
  grid: Uint32Array
): 'contradiction' | [number, Cell] | undefined {
  const remaining = nogood.notAllTrue.size - nogood.falseCount;
  if (remaining > 1) return undefined;
  if (remaining === 0) return 'contradiction';
  for (const [cell, within] of nogood.notAllTrue) {
    const now = grid[cell]!;
    if (!isWithin(now, within)) {
      const rest = without(now, within);
      return rest !== now ? [cell, rest] : undefined;
    }
  }
  throw new Error('nogood contradicted, but `falseCount` was too low');
}

/** Between the two ends of a stretch of the trail, `cell` went from `low` to `high`. */
function inform(
  nogood: Nogood,
  cell: number,
  low: Cell,
  high: Cell,
  forwards: boolean
) {
  const within = nogood.notAllTrue.get(cell)!;
  if (!isWithin(low, within) && isWithin(high, within))
    nogood.falseCount += forwards ? 1 : -1;
}

/** Why `propagate` found the current branch impossible. */
type Conflict = { lane: number } | { nogood: number };

/** What a finished search knows: all of the answer if `cellsLeft` is 0. */
export type SearchResult = { grid: Uint32Array; cellsLeft: number };

export class ConpropState {
  readonly puzzle: Puzzle;
  readonly state: SolveState;
  nogoods: Nogood[] = [];
  /** Per cell, the nogoods that mention it. */
  nogoodsByCell: number[][];
  /** Per (cell, color), at `cell * colors + color`, how often it's been in nogoods lately. */
  vsids: Float64Array;
  private vsidsDecay = 0;
  trail: TrailStep[] = [];
  /** How far along the trail the nogoods' counts are. */
  nogoodsUpdatedTo = 0;
  /** Each guess's place on the trail, and color. */
  guesses: { trailIdx: number; color: number }[] = [];
  private pickers: Picker[] = [];
  private random = seededRandom(0); // (Only for the pickers.)
  /** Never actually partial, of course. */
  solutionFound: Uint32Array | undefined;
  /**
   * Everything known at the root (without guesses) when the first solution was found. The search
   * for a second solution assumes the first one is wrong, so after that the root knows too much.
   */
  private rootKnowledge: SearchResult | undefined;
  /** How many guesses have been made, for reporting. */
  guessCount = 0;

  constructor(puzzle: Puzzle, state: SolveState) {
    this.puzzle = puzzle;
    this.state = state;
    this.nogoodsByCell = Array.from({ length: state.grid.length }, () => []);
    this.vsids = new Float64Array(state.grid.length * puzzle.colors);
  }

  /** Usually followed by `propagate`. Only changes anything if it returns `'new'`. */
  makeGuess(cell: number, color: number): 'new' | 'same' | 'contradiction' {
    const old = this.state.grid[cell]!;
    const result = this.state.learn(cell, color);
    if (result === 'new') {
      this.guesses.push({ trailIdx: this.trail.length, color });
      this.trail.push({
        cell,
        old,
        level: this.guesses.length,
        reason: { kind: 'guess' },
      });
    }
    return result;
  }

  /** Rewind to just before guess `guessIdx` (and its consequences). */
  backjump(guessIdx: number) {
    if (this.guesses.length === 0) {
      if (guessIdx !== 0) throw new Error('backjumping without guesses');
      return;
    }
    const { trailIdx } = this.guesses[guessIdx]!;
    this.updateNogoodCounters(trailIdx);
    this.state.unwind(this.trail, trailIdx);
    this.trail.length = trailIdx;
    this.guesses.length = guessIdx;
    this.pickers.length = Math.min(this.pickers.length, guessIdx + 1);
  }

  /** Start watching a nogood. */
  addNogood(nogood: Nogood) {
    const idx = this.nogoods.length;
    const { colors } = this.puzzle;
    for (const [cell, within] of nogood.notAllTrue) {
      this.nogoodsByCell[cell]!.push(idx);
      // Guessing any of these makes the literal hold.
      for (const color of colorsOf(within))
        if (color < colors) this.vsids[cell * colors + color]!++;
    }
    this.nogoods.push(nogood);
    if (this.vsidsDecay >= 16) {
      for (let i = 0; i < this.vsids.length; i++) this.vsids[i]! *= 0.95;
      this.vsidsDecay = 0;
    } else {
      this.vsidsDecay++;
    }
  }

  /**
   * A nogood that rules out the solution the guesses led to, in the hope of finding a different
   * one.
   */
  private solutionNogood(): Nogood {
    const notAllTrue = new Map<number, Cell>(
      this.guesses.map(({ trailIdx, color }) => [
        this.trail[trailIdx]!.cell,
        1 << color,
      ])
    );
    return { notAllTrue, falseCount: notAllTrue.size }; // Every one of them holds right now.
  }

  /** Bring the nogoods' counts up (or back) to describe the grid after `newIdx` trail entries. */
  updateNogoodCounters(newIdx: number) {
    if (newIdx === this.nogoodsUpdatedTo) return;
    const forwards = newIdx > this.nogoodsUpdatedTo;
    const [from, to] = forwards
      ? [this.nogoodsUpdatedTo, newIdx]
      : [newIdx, this.nogoodsUpdatedTo];
    // Only the two ends of the stretch matter. The first entry for a cell has its value at the
    // low end, and the grid has the high end, so don't count a cell twice.
    const seen = new Set<number>();
    for (let i = from; i < to; i++) {
      const { cell, old } = this.trail[i]!;
      if (seen.has(cell)) continue;
      seen.add(cell);
      if (isKnown(old))
        throw new Error(`made a redundant guess about cell ${cell}`);
      const high = this.state.grid[cell]!;
      for (const nogood of this.nogoodsByCell[cell]!)
        inform(this.nogoods[nogood]!, cell, old, high, forwards);
    }
    this.nogoodsUpdatedTo = newIdx;
  }

  /**
   * Apply line logic and the nogoods until nothing more turns up. `true` if that solves it. On a
   * `Conflict`, the grid is left as the conflict found it, so explain it before unwinding.
   */
  private propagate(): boolean | Conflict {
    let anyFired = true;
    while (anyFired) {
      anyFired = false;
      const outcome = this.state.run(this.trail);
      this.updateNogoodCounters(this.trail.length); // (before acting on the outcome)
      if (typeof outcome === 'object') return { lane: outcome.contradiction };

      for (let i = 0; i < this.nogoods.length; i++) {
        this.updateNogoodCounters(this.trail.length); // Get it right before `deduction`.
        const found = deduction(this.nogoods[i]!, this.state.grid);
        if (found === 'contradiction') return { nogood: i };
        if (!found) continue;
        anyFired = true;
        const [cell, within] = found;
        const before = this.state.grid[cell]!;
        // A contradiction here means the nogood's implication contradicts what we know.
        const learned = this.state.learnWithin(cell, within);
        if (learned === 'contradiction') return { nogood: i };
        // Only when it actually moved: `updateNogoodCounters` believes the trail.
        if (learned === 'new')
          this.trail.push({
            cell,
            old: before,
            level: this.guesses.length,
            reason: { kind: 'nogood', nogood: i },
          });
      }
    }
    return this.state.cellsLeft === 0;
  }

  /** A result if the search is over, and `undefined` if not. */
  private propagateAndLearn(): SearchResult | 'no-solution' | undefined {
    let result = this.propagate();
    while (typeof result === 'object') {
      if (this.guesses.length === 0) {
        // The root is contradictory! So the first solution is unique, or there's none at all.
        return this.solutionFound ? this.noGuessesLeft() : 'no-solution';
      }
      const [nogood, assertingAt] =
        'lane' in result
          ? this.lineIsNogood(result.lane)
          : this.resolveToUip([...this.nogoods[result.nogood]!.notAllTrue]);
      this.addNogood(nogood);
      this.backjump(assertingAt);
      result = this.propagate();
    }
    if (!result) return undefined; // No solution yet, and no contradiction.

    if (this.solutionFound) {
      if (sameGrid(this.solutionFound, this.state.grid))
        throw new Error('reached the same solution twice');
      // More than one solution: report what we proved.
      return this.rootKnowledge!;
    }
    this.solutionFound = Uint32Array.from(this.state.grid);
    // No guesses outstanding, so it's unique.
    if (this.guesses.length === 0)
      return { grid: this.solutionFound, cellsLeft: 0 };

    // Move the goalposts: now look for a second solution.
    this.addNogood(this.solutionNogood());
    this.backjump(0);
    // What's known without any guesses (and before using the made-up nogood).
    this.rootKnowledge = {
      grid: Uint32Array.from(this.state.grid),
      cellsLeft: this.state.cellsLeft,
    };
    return this.propagateAndLearn();
  }

  /**
   * Given that `probe` contradicts `clues`, set as many cells as possible back to `root` while
   * keeping it a contradiction. Returns the positions that had to be kept.
   */
  private static minimizeLineContradiction(
    probe: Uint32Array,
    root: Uint32Array,
    clues: Puzzle['lanes'][number]
  ): number[] {
    const buf = new Uint32Array(probe.length);
    const contradicts = () => {
      buf.set(probe);
      return !exhaustLine(clues, buf, []);
    };
    // Try putting each cell back...
    for (let pos = 0; pos < probe.length; pos++) {
      if (probe[pos] === root[pos]) continue;
      const orig = probe[pos]!;
      probe[pos] = root[pos]!;
      if (!contradicts()) probe[pos] = orig; // ...oops; that was needed for the contradiction!
    }
    const kept: number[] = [];
    for (let pos = 0; pos < probe.length; pos++)
      if (probe[pos] !== root[pos]) kept.push(pos);
    return kept;
  }

  /**
   * Why `lane` can't be satisfied, as it stood just before trail entry `before`
   * (`trail.length` for all of it): a minimal set of literals.
   *
   * With `pinned` (`[cell, within]`), it instead explains why entry `before` (which must be for
   * `cell`) narrowed it to `within`. Then the answer only names `cell` if what was already known
   * about it was part of the reason.
   */
  laneReason(
    lane: number,
    before: number,
    pinned?: [number, Cell]
  ): [number, Cell][] {
    const cells = this.puzzle.laneCells[lane]!;
    const clues = this.puzzle.lanes[lane]!;
    const posOf = new Map<number, number>();
    cells.forEach((cell, pos) => posOf.set(cell, pos));

    // Rewind time along the trail: `probe` stops at `before`, and `root` goes all the way back
    // to the first guess.
    const probe = gather(this.puzzle, lane, this.state.grid);
    const root = Uint32Array.from(probe);
    for (let i = this.trail.length - 1; i >= this.firstGuessAt(); i--) {
      const step = this.trail[i]!;
      const pos = posOf.get(step.cell);
      if (pos === undefined) continue;
      root[pos] = step.old;
      if (i >= before) probe[pos] = step.old;
    }

    // Suppose the pinned cell is anything *but* `within`. Minimizing finds out whether what was
    // already known about it matters.
    let pinnedPos = -1;
    let alreadyKnown = 0;
    if (pinned) {
      const [cell, within] = pinned;
      pinnedPos = posOf.get(cell)!;
      alreadyKnown = probe[pinnedPos]!;
      probe[pinnedPos] = without(alreadyKnown, within);
      root[pinnedPos] = without(root[pinnedPos]!, within);
    }

    const kept = ConpropState.minimizeLineContradiction(probe, root, clues);
    // (`probe` only holds what we supposed about the pinned cell.)
    return kept.map((pos) => [
      cells[pos]!,
      pos === pinnedPos ? alreadyKnown : probe[pos]!,
    ]);
  }

  /** Where on the trail the search starts making assumptions. */
  private firstGuessAt(): number {
    return this.guesses[0]?.trailIdx ?? this.trail.length;
  }

  /**
   * A contradiction makes a nogood, but we'd like it to be *asserting*: exactly one of its
   * literals should be from after the latest guess, so we can backjump past that guess, and the
   * nogood says something new there. So, until it's so, replace the newest literal with what
   * implied it.
   *
   * Returns the nogood, and the guess to backjump to.
   */
  resolveToUip(clause: [number, Cell][]): [Nogood, number] {
    // For each cell narrowed since the root, the trail entries that did it, oldest first.
    const entries = new Map<number, number[]>();
    for (let i = this.firstGuessAt(); i < this.trail.length; i++) {
      const cell = this.trail[i]!.cell;
      const steps = entries.get(cell);
      if (steps) steps.push(i);
      else entries.set(cell, [i]);
    }
    const rootValue = (cell: number) => {
      const steps = entries.get(cell);
      return steps ? this.trail[steps[0]!]!.old : this.state.grid[cell]!;
    };
    // The trail entry after which the literal held, or `undefined` if it held at the root.
    const settled = (cell: number, within: Cell): number | undefined => {
      if (isWithin(rootValue(cell), within)) return undefined;
      const steps = entries.get(cell)!;
      // Each entry leaves the cell as the next one found it (or as the grid has it, at the end).
      for (let k = 0; k < steps.length; k++) {
        const after =
          k + 1 < steps.length
            ? this.trail[steps[k + 1]!]!.old
            : this.state.grid[cell]!;
        if (isWithin(after, within)) return steps[k];
      }
      throw new Error("a literal being resolved doesn't hold");
    };

    // At most one per cell, with the trail entry that settled it.
    const literals = new Map<number, { trailIdx: number; within: Cell }>();
    const addLiteral = (cell: number, within: Cell) => {
      // Two literals about the same cell are the same as one about both.
      const existing = literals.get(cell);
      if (existing) {
        literals.delete(cell);
        within &= existing.within;
      }
      const trailIdx = settled(cell, within);
      if (trailIdx !== undefined) literals.set(cell, { trailIdx, within });
    };
    /** The newest literal, and the trail index of the second newest (or -1). */
    const newest = (): [number, number, Cell, number] | undefined => {
      let best: [number, number, Cell] | undefined;
      let second = -1;
      for (const [cell, { trailIdx, within }] of literals) {
        if (!best || trailIdx > best[1]) {
          if (best) second = best[1];
          best = [cell, trailIdx, within];
        } else if (trailIdx > second) {
          second = trailIdx;
        }
      }
      return best && [...best, second];
    };
    for (const [cell, within] of clause) addLiteral(cell, within);

    let backjumpTo: number;
    for (;;) {
      const found = newest();
      if (!found) {
        backjumpTo = 0; // The contradiction doesn't depend on any guesses at all!
        break;
      }
      const [cell, lastIdx, within, secondIdx] = found;
      const deepest = this.trail[lastIdx]!.level;
      // Is the newest literal alone on its level? Then we're done!
      if (secondIdx < 0) {
        backjumpTo = 0;
        break;
      }
      if (this.trail[secondIdx]!.level < deepest) {
        backjumpTo = this.trail[secondIdx]!.level;
        break;
      }

      // Replace the newest literal with what implied it.
      literals.delete(cell);
      const step = this.trail[lastIdx]!;
      let reason: [number, Cell][];
      if (step.reason.kind === 'guess') {
        throw new Error(
          'a guess is the oldest entry at its level, so it would be alone there'
        );
      } else if (step.reason.kind === 'nogood') {
        const notAllTrue = this.nogoods[step.reason.nogood]!.notAllTrue;
        reason = [...notAllTrue].filter(([other]) => other !== cell);
        // The nogood only ruled out its own literal. If that's not enough to get within
        // `within`, what was already known about the cell is a reason, too.
        if (!isWithin(without(rootValue(cell), notAllTrue.get(cell)!), within))
          reason.push([cell, step.old]);
      } else {
        reason = this.laneReason(step.reason.lane, lastIdx, [cell, within]);
      }
      for (const [c, w] of reason) addLiteral(c, w);
      for (const { trailIdx } of literals.values())
        if (trailIdx >= lastIdx)
          throw new Error("time-travel logic; we're in a loop!");
    }

    const notAllTrue = new Map<number, Cell>();
    for (const [cell, { within }] of literals) notAllTrue.set(cell, within);
    return [{ notAllTrue, falseCount: notAllTrue.size }, backjumpTo];
  }

  /**
   * Turn a contradiction in `lane` into a nogood, and the guess to backjump to. Call it with the
   * contradiction still in the grid.
   */
  lineIsNogood(lane: number): [Nogood, number] {
    return this.resolveToUip(this.laneReason(lane, this.trail.length));
  }

  /** Make one guess, and propagate it. A result if the search is over. */
  guessOnce(): SearchResult | 'no-solution' | undefined {
    // Make each level's picker lazily, so that it's made after propagating.
    if (this.pickers.length <= this.guesses.length) {
      if (this.pickers.length !== this.guesses.length)
        throw new Error('we should only ever be one picker short');
      this.pickers.push(
        Picker.fromSituation(
          this.puzzle,
          this.state.grid,
          this.vsids,
          this.random
        )
      );
    }
    const pick = this.pickers[this.pickers.length - 1]!.pick(
      this.puzzle,
      this.state.grid,
      this.vsids
    );
    if (!pick) {
      if (this.guesses.length !== 0)
        throw new Error('ran out of picks with guesses outstanding');
      return this.noGuessesLeft();
    }
    this.guessCount++;
    if (this.makeGuess(pick.cell, pick.color) !== 'new') return undefined; // Skip those.
    return this.propagateAndLearn();
  }

  /**
   * Everything's been tried. (The trail needn't be empty: root-level nogood deductions stay on
   * it when the last guess comes off.)
   */
  private noGuessesLeft(): SearchResult {
    // Nothing's left to try, so the grid we completed is the only one that fits. Or we never
    // completed one, and with no nogood ruling one out, the grid in hand is still honest.
    return this.solutionFound
      ? { grid: this.solutionFound, cellsLeft: 0 }
      : {
          grid: Uint32Array.from(this.state.grid),
          cellsLeft: this.state.cellsLeft,
        };
  }
}

function sameGrid(a: Uint32Array, b: Uint32Array): boolean {
  return a.every((cell, i) => cell === b[i]);
}

export type SearchOptions = {
  /** How long to search for (in ms) before giving up. */
  timeLimitMs?: number;
};

/**
 * Line logic, and then the search. `cellsLeft` is 0 if the answer is unique; otherwise, the grid
 * is what every solution agrees on. `'out-of-time'` if it ran out of time.
 */
export function conpropSolve(
  puzzle: Puzzle,
  options: SearchOptions = {}
): (SearchResult & { guesses: number }) | 'no-solution' | 'out-of-time' {
  const state = SolveState.start(puzzle);
  const outcome = state.run();
  if (typeof outcome === 'object') return 'no-solution';
  return search(puzzle, state, options);
}

/** The search, from a state line logic has stalled on. */
export function search(
  puzzle: Puzzle,
  stalled: SolveState,
  { timeLimitMs = Infinity }: SearchOptions = {}
): (SearchResult & { guesses: number }) | 'no-solution' | 'out-of-time' {
  if (stalled.cellsLeft === 0)
    return { grid: stalled.grid, cellsLeft: 0, guesses: 0 };
  const deadline = Date.now() + timeLimitMs;
  const conprop = new ConpropState(puzzle, stalled);
  for (;;) {
    if (Date.now() > deadline) return 'out-of-time';
    const result = conprop.guessOnce();
    if (result === 'no-solution') return result;
    if (result) return { ...result, guesses: conprop.guessCount };
  }
}

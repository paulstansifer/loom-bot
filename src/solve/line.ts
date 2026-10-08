/**
 * Line logic: what one lane's clues say about its cells, by themselves. (This is
 * `line_solve.rs`.)
 *
 * Each solver takes a lane's cells (gathered out of the grid) and narrows them in place. It
 * pushes the positions it changed onto `affected` (a position can appear more than once), and
 * returns `false` if the lane can't be completed at all. Then the lane may be partly narrowed,
 * and should be thrown away.
 */

import {
  BACKGROUND,
  type Cell,
  canBe,
  fromColor,
  isKnown,
  isKnownToBe,
  knownColor,
} from './cell.ts';
import type { Clue } from './puzzle.ts';

export type Lane = Uint32Array;

/** Clues of the same color need a background cell between them. */
function mustBeSeparated(a: Clue, b: Clue): boolean {
  return a.color === b.color;
}

function learn(
  lane: Lane,
  i: number,
  color: number,
  affected: number[]
): boolean {
  const cell = lane[i]!;
  if (!canBe(cell, color)) return false;
  if (!isKnown(cell)) affected.push(i);
  lane[i] = fromColor(color);
  return true;
}

function learnIntersect(
  lane: Lane,
  i: number,
  possible: Cell,
  affected: number[]
): boolean {
  const cell = lane[i]!;
  const now = cell & possible;
  if (now === 0) return false;
  if (now !== cell) {
    lane[i] = now;
    affected.push(i);
  }
  return true;
}

/** Every cell in the lane is background (only when there are no clues). */
function learnAllBackground(lane: Lane, affected: number[]): boolean {
  for (let i = 0; i < lane.length; i++)
    if (!learn(lane, i, BACKGROUND, affected)) return false;
  return true;
}

/** Is a completely solved lane consistent with its clues? */
export function verifyLine(clues: Clue[], lane: Lane): boolean {
  let clueIdx = 0;
  let idxInClue = -1; // between clues
  for (let i = 0; i < lane.length; i++) {
    const color = knownColor(lane[i]!);
    if (idxInClue < 0 && color === BACKGROUND) continue;
    const clue = clues[clueIdx];
    if (!clue) return false; // foreground after the last clue
    if (idxInClue < 0) {
      idxInClue = 0;
      if (
        clueIdx > 0 &&
        mustBeSeparated(clues[clueIdx - 1]!, clue) &&
        knownColor(lane[i - 1]!) !== BACKGROUND
      )
        return false; // unseparated clues
    }
    if (color !== clue.color) return false;
    if (idxInClue + 1 >= clue.count) {
      idxInClue = -1;
      clueIdx++;
    } else {
      idxInClue++;
    }
  }
  return clueIdx === clues.length;
}

/**
 * Where each clue ends, packed as far left as it'll go (or, `reversed`, where each starts, packed
 * as far right). For example, (1 2 1) with no other constraints gives
 *
 *     .] .  .] .  .]
 *
 * `null` if they don't fit.
 */
function packedExtents(
  clues: Clue[],
  lane: Lane,
  reversed: boolean
): number[] | null {
  const n = clues.length;
  const len = lane.length;
  if (n === 0) return [];
  const laneAt = (i: number) => (reversed ? lane[len - 1 - i]! : lane[i]!);
  const clueAt = (i: number) => (reversed ? clues[n - 1 - i]! : clues[i]!);

  // Pack to the left (having abstracted over `reversed`).
  const extents: number[] = [];
  let pos = 0;
  let last: Clue | undefined;
  for (let clueIdx = 0; clueIdx < n; clueIdx++) {
    const clue = clueAt(clueIdx);
    if (last && mustBeSeparated(last, clue)) pos++;
    // (This could be made a little more efficient with the Boyer-Moore algorithm.)
    let placeable = false;
    while (!placeable) {
      placeable = true;
      for (let k = 0; k < clue.count; k++) {
        if (pos + k >= len) return null;
        if (!canBe(laneAt(pos + k), clue.color)) {
          pos++;
          placeable = false;
          break;
        }
      }
    }
    extents.push(pos + clue.count - 1);
    pos += clue.count;
    last = clue;
  }

  // We might be able to do better: are there any orphaned foreground cells off to the right?
  // (A conservative approximation: it doesn't check that the clue pulled in is the cell's color,
  // or take account of known background cells, or gaps between clues of the same color.)
  let cur = n - 1;
  let i = len - 1;
  for (;;) {
    if (!canBe(laneAt(i), BACKGROUND)) {
      if (extents[cur]! < i) extents[cur] = i; // Pull it in!
      // Either way, skip past the rest of the cells the clue covers, and keep looking. (One past
      // them, since `i` goes down by one below.)
      i = extents[cur]! + 1 - clueAt(cur).count;
      if (cur === 0) break;
      cur--;
    }
    if (i === 0) break;
    i--;
  }

  if (reversed) return extents.reverse().map((e) => len - e - 1);
  return extents;
}

/**
 * Whether skimming has pinned a clue down: the two packings leave it only one placement, and every
 * cell it covers is already known. `leftExtent` is the clue's rightmost possible start and
 * `rightExtent` its leftmost possible end.
 */
function clueIsFixed(
  clue: Clue,
  leftExtent: number,
  rightExtent: number,
  lane: Lane
): boolean {
  if (rightExtent + 1 !== leftExtent + clue.count) return false;
  for (let i = leftExtent; i <= rightExtent; i++)
    if (!isKnown(lane[i]!)) return false;
  return true;
}

/** The indices of the clues that skimming finds pinned down (none, if the lane's contradictory). */
export function fixedClues(clues: Clue[], lane: Lane): number[] {
  const leftPackedRightExtents = packedExtents(clues, lane, false);
  const rightPackedLeftExtents = packedExtents(clues, lane, true);
  if (!leftPackedRightExtents || !rightPackedLeftExtents) return [];
  const fixed: number[] = [];
  clues.forEach((clue, i) => {
    if (
      clueIsFixed(
        clue,
        rightPackedLeftExtents[i]!,
        leftPackedRightExtents[i]!,
        lane
      )
    )
      fixed.push(i);
  });
  return fixed;
}

/**
 * "Skimming": pack all the clues to their leftmost and rightmost possible places. Any cell a
 * clue covers in both is that clue's color.
 */
export function skimLine(
  clues: Clue[],
  lane: Lane,
  affected: number[]
): boolean {
  const n = clues.length;
  if (n === 0) return learnAllBackground(lane, affected);

  // Rule out colors that don't appear in this lane at all. (That saves some scrubbing.)
  let possibleColors = fromColor(BACKGROUND);
  for (const clue of clues) possibleColors |= fromColor(clue.color);
  // (Only if it would do anything.)
  let laneCanBe = 0;
  let anyImpossible = false;
  for (const cell of lane) {
    laneCanBe |= cell;
    if ((cell & possibleColors) === 0) anyImpossible = true;
  }
  if (anyImpossible || (laneCanBe & ~possibleColors) !== 0)
    for (let i = 0; i < lane.length; i++)
      if (!learnIntersect(lane, i, possibleColors, affected)) return false;

  // Now slam the clues back and forth!
  const leftPackedRightExtents = packedExtents(clues, lane, false);
  if (!leftPackedRightExtents) return false;
  const rightPackedLeftExtents = packedExtents(clues, lane, true);
  if (!rightPackedLeftExtents) return false;

  for (let clueIdx = 0; clueIdx < n; clueIdx++) {
    const clue = clues[clueIdx]!;
    const leftExtent = rightPackedLeftExtents[clueIdx]!;
    const rightExtent = leftPackedRightExtents[clueIdx]!;
    if (leftExtent > rightExtent) continue; // No overlap
    const overlap = rightExtent - leftExtent + 1;
    if (overlap > clue.count) return false; // The clue is too short.

    for (let i = leftExtent; i <= rightExtent; i++)
      if (!learnIntersect(lane, i, fromColor(clue.color), affected))
        return false;

    // (The background inference below doesn't seem to make this unnecessary; it's not known why.)
    if (overlap === clue.count) {
      const gapBefore =
        clueIdx > 0 && mustBeSeparated(clues[clueIdx - 1]!, clue);
      const gapAfter =
        clueIdx + 1 < n && mustBeSeparated(clue, clues[clueIdx + 1]!);
      if (gapBefore && !learn(lane, leftExtent - 1, BACKGROUND, affected))
        return false;
      if (gapAfter && !learn(lane, rightExtent + 1, BACKGROUND, affected))
        return false;
    }
  }

  // Similarly, are there cells between adjacent clues that neither can reach? (`pbnsolve` does
  // this.)
  for (let clueIdx = 0; clueIdx + 1 < n; clueIdx++) {
    const prevRightmostEnd =
      rightPackedLeftExtents[clueIdx]! + clues[clueIdx]!.count - 1;
    const leftmostStart =
      leftPackedRightExtents[clueIdx + 1]! + 1 - clues[clueIdx + 1]!.count;
    for (let i = prevRightmostEnd + 1; i < leftmostStart; i++)
      if (!learn(lane, i, BACKGROUND, affected)) return false;
  }

  // Nothing can reach past the outermost clues' outermost possible places.
  const leftmost = leftPackedRightExtents[0]! + 1 - clues[0]!.count;
  const rightmost = rightPackedLeftExtents[n - 1]! + clues[n - 1]!.count;
  for (let i = 0; i < leftmost; i++)
    if (!learn(lane, i, BACKGROUND, affected)) return false;
  for (let i = rightmost; i < lane.length; i++)
    if (!learn(lane, i, BACKGROUND, affected)) return false;
  return true;
}

// Scratch space for `exhaustLine`, which is on the hot path. Grown as needed.
let reachable = new Uint8Array(256);
let clueFits = new Uint8Array(256);
let bothReachable = new Uint8Array(64);
let superposition = new Uint32Array(64);

/**
 * "Scrubbing": find every arrangement of the clues that fits the lane, and keep only the colors
 * some arrangement gives each cell. It's linear in (clues × slack), where the slack is how many
 * cells the clues leave over for background.
 */
export function exhaustLine(
  clues: Clue[],
  lane: Lane,
  affected: number[]
): boolean {
  const n = clues.length;
  const len = lane.length;
  if (n === 0) return learnAllBackground(lane, affected);

  let totalSlack = len;
  for (const clue of clues) totalSlack -= clue.count;
  if (totalSlack < 0) return false; // The clues are longer than the lane.

  // Every possible place for every clue. As an optimization, to keep the table smaller, instead
  // of an index into the lane, it's indexed by the total gap so far (as if all clues were
  // zero-width). Adding `lenSoFar` (the clues' lengths so far) gives the actual index.
  //
  // The edges are handled by an "if", rather than stored in the table:
  //
  //            Edge | A | B | C | Edge
  //     Gap 0   *   | * | * | - | -
  //     Gap 1   -   | * | * | * | -
  //     Gap 2   -   | - | * | * | *
  //
  // `reachable[clueIdx * stride + gap]`.
  const stride = totalSlack + 1;
  const size = stride * n;
  if (reachable.length < size) {
    reachable = new Uint8Array(size * 2);
    clueFits = new Uint8Array(size * 2);
  }
  if (bothReachable.length < stride) bothReachable = new Uint8Array(stride * 2);
  if (superposition.length < len) superposition = new Uint32Array(len * 2);
  reachable.fill(0, 0, size);
  superposition.fill(0, 0, len);

  // Both flood fills keep asking "does this clue fit here?", so work that out for every place.
  // `clueFits[clueIdx * stride + gap]` is whether clue `clueIdx` can be on the cells `gap` puts
  // it on.
  let lenSoFar = 0;
  for (let clueIdx = 0; clueIdx < n; clueIdx++) {
    const clue = clues[clueIdx]!;
    const bit = fromColor(clue.color);
    for (let gap = 0; gap <= totalSlack; gap++) {
      let fits = 1;
      for (let k = 0; k < clue.count; k++)
        if ((lane[lenSoFar + gap + k]! & bit) === 0) {
          fits = 0;
          break;
        }
      clueFits[clueIdx * stride + gap] = fits;
    }
    lenSoFar += clue.count;
  }

  // Flood-fill reachability from the left.
  //
  // Rather than testing every (previous gap, new gap) pair: the previous gaps that can lead to a
  // given `newGap` are exactly those with no cell that can't be background in between. That's a
  // contiguous range whose ends both only move right as `newGap` grows. So sweep `newGap` upward,
  // keeping count of how many gaps in that window the previous clue can reach. Each gap is only
  // visited once, not once per pair.
  lenSoFar = 0;
  for (let clueIdx = 0; clueIdx < n; clueIdx++) {
    const clue = clues[clueIdx]!;
    const needsGap = clueIdx > 0 && mustBeSeparated(clues[clueIdx - 1]!, clue);
    const row = clueIdx * stride;
    const prevRow = row - stride;
    // The first clue has no predecessor: the left edge stands in for it.
    const prevReachable = (gap: number) =>
      clueIdx > 0 ? reachable[prevRow + gap] === 1 : gap === 0;

    // `inWindow` counts the reachable gaps in `lo..added`, and `added` never runs past the
    // largest previous gap that the current `newGap` would accept.
    let lo = 0;
    let added = 0;
    let inWindow = 0;
    for (let newGap = 0; newGap <= totalSlack; newGap++) {
      // The cell just short of `newGap` has become part of the gap...
      if (newGap > 0 && !canBe(lane[lenSoFar + newGap - 1]!, BACKGROUND)) {
        // ...and it can't be background, so every previous gap at or below it is ruled out.
        for (; lo < newGap; lo++)
          if (lo < added && prevReachable(lo)) inWindow--;
        added = Math.max(added, lo);
      }
      // A clue that must be separated from its predecessor can't start where the predecessor's
      // gap left off, so it gives up one gap of reach.
      const highestPrevGap = needsGap ? newGap - 1 : newGap;
      for (; added <= highestPrevGap; added++)
        if (prevReachable(added)) inWindow++;

      if (inWindow > 0 && clueFits[row + newGap]) reachable[row + newGap] = 1;
    }
    lenSoFar += clue.count;
  }

  // Flood-fill reachability from the right, intersected with reachability from the left.
  // `lenSoFar` is at its high-water mark, and goes back down to 0.
  for (let clueIdx = n - 1; clueIdx >= 0; clueIdx--) {
    const clue = clues[clueIdx]!;
    const needsGap =
      clueIdx + 1 < n && mustBeSeparated(clue, clues[clueIdx + 1]!);
    const row = clueIdx * stride;
    const usable = (gap: number) =>
      reachable[row + gap] === 1 && clueFits[row + gap] === 1;
    bothReachable.fill(0, 0, stride);

    // The mirror of the left pass's sweep, plus recording background cells. `lo` is the leftmost
    // gap this clue could be at while leaving every cell between it and `gapAfter` background,
    // and it only moves right as `gapAfter` grows, as do `firstOk` and `gapAfter` itself. Since
    // all three only move right, both ranges written below can pick up where the last one
    // stopped, which keeps this linear in the slack rather than quadratic.
    let lo = 0;
    // The leftmost gap at or after `lo` where this clue both fits and is reachable from the
    // left: the leftmost start of any surviving arrangement, in other words.
    let firstOk = 0;
    let markedUpTo = 0;
    let paintedUpTo = 0;
    for (let gapAfter = 0; gapAfter <= totalSlack; gapAfter++) {
      if (gapAfter > 0 && !canBe(lane[lenSoFar + gapAfter - 1]!, BACKGROUND))
        lo = gapAfter;

      if (clueIdx === n - 1) {
        // The right edge is always after all the background.
        if (gapAfter !== totalSlack) continue;
      } else if (!reachable[(clueIdx + 1) * stride + gapAfter]) {
        continue; // The clue to the right couldn't be there.
      }

      // As on the left, a clue that must be separated from its neighbor gives up a gap.
      const highestGap = needsGap ? gapAfter - 1 : gapAfter;
      if (highestGap < 0 || highestGap < lo) continue;

      // Every gap in `lo..=highestGap` that the left pass also reached is actually reachable!
      for (let gap = Math.max(markedUpTo, lo); gap <= highestGap; gap++)
        if (usable(gap)) bothReachable[gap] = 1;
      markedUpTo = Math.max(markedUpTo, highestGap + 1);

      // Skipping gaps this clue can't use is always safe: they can't come back.
      firstOk = Math.max(firstOk, lo);
      while (firstOk <= highestGap && !usable(firstOk)) firstOk++;

      // Cells between the clue's leftmost real place and `gapAfter` are ones some arrangement
      // leaves as background.
      if (firstOk <= highestGap) {
        for (let gap = Math.max(paintedUpTo, firstOk); gap < gapAfter; gap++)
          superposition[lenSoFar + gap]! |= fromColor(BACKGROUND);
        paintedUpTo = Math.max(paintedUpTo, gapAfter);
      }
    }

    const bit = fromColor(clue.color);
    for (let gap = 0; gap <= totalSlack; gap++) {
      if (bothReachable[gap]) {
        // Reachable in both directions! Record it.
        for (let k = 0; k < clue.count; k++)
          superposition[lenSoFar - clue.count + gap + k]! |= bit;
      } else {
        reachable[row + gap] = 0;
      }
    }
    lenSoFar -= clue.count;
  }

  // The first gap needs handling too, since the right-to-left pass doesn't look at it. Only the
  // longest possible one matters.
  for (let firstGap = totalSlack; firstGap >= 0; firstGap--) {
    if (reachable[firstGap]) {
      for (let i = 0; i < firstGap; i++)
        superposition[i]! |= fromColor(BACKGROUND);
      break;
    }
  }

  for (let i = 0; i < len; i++)
    if (!learnIntersect(lane, i, superposition[i]!, affected)) return false;
  return true;
}

/** Everything the lane-picking heuristics need from a lane's clues, worked out once. */
export type ClueSummary = {
  /** Total foreground cells the clues account for. */
  foregroundCells: number;
  /**
   * As `foregroundCells`, plus the separators that adjacent same-color clues need. If this is the
   * lane's length, the lane is solvable with no other knowledge.
   */
  spaceTaken: number;
  longestClue: number;
  count: number;
};

export function summarize(clues: Clue[]): ClueSummary {
  let foregroundCells = 0;
  let longestClue = 0;
  let separators = 0;
  clues.forEach((clue, i) => {
    foregroundCells += clue.count;
    longestClue = Math.max(longestClue, clue.count);
    if (i > 0 && mustBeSeparated(clues[i - 1]!, clue)) separators++;
  });
  return {
    foregroundCells,
    spaceTaken: foregroundCells + separators,
    longestClue,
    count: clues.length,
  };
}

/** The tallies of a lane's cells that `scoreCounts` needs. */
export type LaneCounts = {
  len: number;
  /** The longest run of cells that aren't known to be background. */
  longestForegroundableSpan: number;
  knownBackgroundCells: number;
  /** Cells whose color isn't pinned down yet. */
  unknownCells: number;
  /** Maximal runs of cells that are definitely not background. */
  knownForegroundChunks: number;
  firstIsKnownBackground: boolean;
  lastIsKnownBackground: boolean;
};

export function countLane(lane: ArrayLike<Cell>): LaneCounts {
  const counts: LaneCounts = {
    len: lane.length,
    longestForegroundableSpan: 0,
    knownBackgroundCells: 0,
    unknownCells: 0,
    knownForegroundChunks: 0,
    firstIsKnownBackground: false,
    lastIsKnownBackground: false,
  };
  let span = 0;
  let inForegroundChunk = false;
  for (let i = 0; i < lane.length; i++) {
    const cell = lane[i]!;
    const knownBackground = isKnownToBe(cell, BACKGROUND);
    if (i === 0) counts.firstIsKnownBackground = knownBackground;
    counts.lastIsKnownBackground = knownBackground;
    if (!knownBackground) {
      span++;
      counts.longestForegroundableSpan = Math.max(
        span,
        counts.longestForegroundableSpan
      );
    } else {
      span = 0;
      counts.knownBackgroundCells++;
    }
    if (!isKnown(cell)) counts.unknownCells++;
    if (!canBe(cell, BACKGROUND)) {
      if (!inForegroundChunk) counts.knownForegroundChunks++;
      inForegroundChunk = true;
    } else {
      inForegroundChunk = false;
    }
  }
  return counts;
}

/** How promising a lane looks for skimming and for scrubbing (higher is better). */
export function scoreCounts(
  summary: ClueSummary,
  counts: LaneCounts
): { skim: number; scrub: number } {
  const skim =
    summary.count === 0
      ? 1000 // Can solve it right away!
      : summary.foregroundCells +
        summary.longestClue -
        counts.longestForegroundableSpan +
        (counts.firstIsKnownBackground ? 0 : 2) +
        (counts.lastIsKnownBackground ? 0 : 2);

  const knownForegroundCells =
    counts.len - counts.unknownCells - counts.knownBackgroundCells;
  // Scrubbing is likely to show foreground cells if this is high:
  const density =
    summary.spaceTaken -
    knownForegroundCells +
    summary.longestClue -
    summary.count;
  const unknownBackgroundCells =
    counts.len - summary.foregroundCells - counts.knownBackgroundCells;
  // Matching runs of foreground cells to clues is likely to show background cells if this is
  // high: > 0 is very good, 0 is still good, -1 is alright, -2 is probably not worth a look.
  const excessChunks =
    knownForegroundCells > 0
      ? counts.knownForegroundChunks - summary.count
      : -2;
  const scrub =
    density +
    Math.max(0, Math.trunc((unknownBackgroundCells * (excessChunks + 2)) / 2));
  return { skim, scrub };
}

export function scoreLane(
  clues: Clue[],
  lane: ArrayLike<Cell>
): { skim: number; scrub: number } {
  return scoreCounts(summarize(clues), countLane(lane));
}

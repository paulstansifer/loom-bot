import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Cell, anything, fromColor, isKnownToBe } from './cell.ts';
import {
  type Lane,
  exhaustLine,
  fixedClues,
  scoreLane,
  skimLine,
  verifyLine,
} from './line.ts';
import type { Clue } from './puzzle.ts';

const COLORS: Record<string, number> = { '⬜': 0, '⬛': 1, '🟥': 2, '🟩': 3 };

function color(ch: string): number {
  const c = COLORS[ch];
  if (c === undefined) throw new Error(`unknown color ${ch}`);
  return c;
}

/** Clues: `⬛2 🟥1` is a run of two black, then one red. */
function n(spec: string): Clue[] {
  return spec
    .split(/\s+/)
    .filter((s) => s)
    .map((chunk) => {
      const [first, ...rest] = [...chunk];
      return { color: color(first!), count: Number(rest.join('')) };
    });
}

/** A lane: each cell is the colors it could be, and `🔳` is black or white. */
function l(spec: string): Lane {
  return Uint32Array.from(
    spec
      .split(/\s+/)
      .filter((s) => s)
      .map((cell) => {
        if (cell === '🔳') return fromColor(0) | fromColor(1);
        let mask = 0;
        for (const ch of cell) mask |= fromColor(color(ch));
        return mask;
      })
  );
}

function exhaust(clues: Clue[], init: string): Lane {
  const lane = l(init);
  assert.ok(exhaustLine(clues, lane, []), 'contradiction');
  return lane;
}

function skim(clues: Clue[], init: string): Lane {
  const lane = l(init);
  assert.ok(skimLine(clues, lane, []), 'contradiction');
  return lane;
}

void test('clues too long for the lane are a contradiction', () => {
  for (const init of ['🔳 🔳 🔳', '⬜ ⬛ 🔳', '⬛ ⬛ ⬛']) {
    assert.equal(exhaustLine(n('⬛4'), l(init), []), false, init);
    assert.equal(exhaustLine(n('⬛2 ⬛3'), l(init), []), false, init);
    assert.equal(skimLine(n('⬛4'), l(init), []), false, init);
  }
  // Exactly filling the lane is fine, and leaves no slack at all.
  assert.deepEqual(exhaust(n('⬛3'), '🔳 🔳 🔳'), l('⬛ ⬛ ⬛'));
});

void test('exhaust', () => {
  assert.deepEqual(exhaust(n('⬛1'), '🔳 🔳 🔳 🔳'), l('🔳 🔳 🔳 🔳'));
  assert.deepEqual(exhaust(n('⬛1'), '⬜ 🔳 🔳 🔳'), l('⬜ 🔳 🔳 🔳'));
  assert.deepEqual(exhaust(n('⬛1 ⬛2'), '🔳 🔳 🔳 🔳'), l('⬛ ⬜ ⬛ ⬛'));
  assert.deepEqual(exhaust(n('⬛1'), '🔳 🔳 ⬛ 🔳'), l('⬜ ⬜ ⬛ ⬜'));
  assert.deepEqual(exhaust(n('⬛3'), '🔳 🔳 🔳 🔳'), l('🔳 ⬛ ⬛ 🔳'));
  assert.deepEqual(exhaust(n('⬛3'), '🔳 ⬛ 🔳 🔳 🔳'), l('🔳 ⬛ ⬛ 🔳 ⬜'));
  assert.deepEqual(
    exhaust(n('⬛2 ⬛2'), '🔳 🔳 🔳 🔳 🔳'),
    l('⬛ ⬛ ⬜ ⬛ ⬛')
  );
  assert.deepEqual(
    exhaust(n('⬛2 ⬛2'), '🔳 🔳 🔳 🔳 🔳 🔳'),
    l('🔳 ⬛ 🔳 🔳 ⬛ 🔳')
  );
  // Different colors don't need separating, so we don't know as much:
  assert.deepEqual(
    exhaust(n('🟥2 ⬛2'), '🟥⬛⬜ 🟥⬛⬜ 🟥⬛⬜ 🟥⬛⬜ 🟥⬛⬜'),
    l('🟥⬜ 🟥 🟥⬛⬜ ⬛ ⬛⬜')
  );
});

void test('skim', () => {
  assert.deepEqual(skim(n('⬛1'), '🔳 🔳 🔳 🔳'), l('🔳 🔳 🔳 🔳'));
  assert.deepEqual(skim(n('⬛1'), '⬜ 🔳 🔳 🔳'), l('⬜ 🔳 🔳 🔳'));
  assert.deepEqual(skim(n('⬛3'), '🔳 🔳 🔳 🔳'), l('🔳 ⬛ ⬛ 🔳'));
  assert.deepEqual(skim(n('⬛2 ⬛1'), '🔳 🔳 🔳 🔳'), l('⬛ ⬛ ⬜ ⬛'));
  assert.deepEqual(skim(n('⬛1 ⬛2'), '🔳 🔳 🔳 🔳'), l('⬛ ⬜ ⬛ ⬛'));
  assert.deepEqual(
    skim(n('⬛2'), '🔳 🔳 🔳 🔳 🔳 ⬛ ⬛ 🔳'),
    l('⬜ ⬜ ⬜ ⬜ ⬜ ⬛ ⬛ ⬜')
  );
  assert.deepEqual(skim(n('⬛1'), '🔳 🔳 ⬛ 🔳'), l('⬜ ⬜ ⬛ ⬜'));
  assert.deepEqual(skim(n('⬛3'), '🔳 ⬛ 🔳 🔳 🔳'), l('🔳 ⬛ ⬛ 🔳 ⬜'));
  assert.deepEqual(skim(n('⬛2 ⬛2'), '🔳 🔳 🔳 🔳 🔳'), l('⬛ ⬛ ⬜ ⬛ ⬛'));
  // Different colors don't need separating, so we don't know as much:
  assert.deepEqual(
    skim(n('🟥2 ⬛2'), '🟥⬛⬜ 🟥⬛⬜ 🟥⬛⬜ 🟥⬛⬜ 🟥⬛⬜'),
    l('🟥⬛⬜ 🟥 🟥⬛⬜ ⬛ 🟥⬛⬜')
  );
  // Longer clues:
  assert.deepEqual(
    skim(n('⬛7'), '🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳'),
    l('🔳 🔳 🔳 ⬛ ⬛ ⬛ ⬛ 🔳 🔳 🔳')
  );
  // More clues in a lane:
  assert.deepEqual(
    skim(n('⬛1 ⬛1 ⬛1 ⬛1'), '🔳 🔳 🔳 🔳 🔳 🔳 🔳'),
    l('⬛ ⬜ ⬛ ⬜ ⬛ ⬜ ⬛')
  );
  assert.deepEqual(skim(n('⬛6'), '⬛ ⬛ 🔳 🔳 ⬛ ⬛'), l('⬛ ⬛ ⬛ ⬛ ⬛ ⬛'));
});

void test('fixed clues', () => {
  // Pinned and painted:
  assert.deepEqual(fixedClues(n('⬛3'), l('⬛ ⬛ ⬛')), [0]);
  assert.deepEqual(fixedClues(n('⬛1 ⬛1'), l('⬛ ⬜ ⬛')), [0, 1]);
  // Pinned, but the cells aren't painted yet, so the player hasn't resolved it:
  assert.deepEqual(fixedClues(n('⬛3'), l('🔳 🔳 🔳')), []);
  // Not pinned at all:
  assert.deepEqual(fixedClues(n('⬛1 ⬛1'), l('🔳 🔳 🔳 🔳')), []);
  // Only the second clue has been placed:
  assert.deepEqual(fixedClues(n('⬛1 ⬛2'), l('🔳 🔳 ⬜ ⬛ ⬛')), [1]);
  // Nothing to fix:
  assert.deepEqual(fixedClues(n(''), l('🔳 🔳 🔳')), []);
  // A contradictory lane reports nothing, rather than failing:
  assert.deepEqual(fixedClues(n('⬛4'), l('🔳 🔳 🔳')), []);
});

void test('verify', () => {
  assert.ok(verifyLine(n('⬛1 ⬛2'), l('⬛ ⬜ ⬛ ⬛')));
  assert.ok(verifyLine(n('🟥1 ⬛2'), l('🟥 ⬛ ⬛ ⬜')));
  assert.ok(verifyLine(n(''), l('⬜ ⬜')));
  assert.ok(!verifyLine(n('⬛1 ⬛2'), l('⬛ ⬛ ⬛ ⬜')), 'unseparated');
  assert.ok(
    !verifyLine(n('⬛1'), l('⬛ ⬜ ⬛')),
    'foreground after the last clue'
  );
  assert.ok(!verifyLine(n('⬛1 ⬛1'), l('⬛ ⬜ ⬜')), 'clues unused');
  assert.ok(!verifyLine(n('🟥1'), l('⬛ ⬜ ⬜')), 'wrong color');
});

void test('heuristic examples', () => {
  const x = anything(2);
  const w = fromColor(0);
  const b = fromColor(1);
  const scrub = (counts: number[], ...lane: Cell[]) =>
    scoreLane(
      counts.map((count) => ({ color: 1, count })),
      lane
    ).scrub;

  assert.equal(scrub([1], x, x, x, x), 1);
  assert.equal(scrub([1], w, x, x, x), 1);
  assert.equal(scrub([2], w, w, x, x), 3);
  assert.equal(scrub([1, 2], x, x, x, x), 4);
  assert.equal(scrub([1], x, x, b, x), 3);
  assert.equal(scrub([3], x, x, x, x), 5);
  assert.equal(scrub([3], x, b, x, x, x), 6);
  assert.equal(scrub([10], ...Array<Cell>(15).fill(x)), 19);
  assert.equal(scrub([3], ...Array<Cell>(15).fill(x)), 5);
  assert.equal(scrub([3], x, x, x, x, b, ...Array<Cell>(10).fill(x)), 16);
});

void test('observed errors', () => {
  const black = (lane: Lane, i: number) => isKnownToBe(lane[i]!, 1);

  assert.ok(
    black(exhaust(n('⬛4 ⬛4'), '🔳 🔳 🔳 🔳 ⬜ ⬛ 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳'), 6)
  );
  assert.ok(
    black(
      exhaust(
        n('⬛2 ⬛2 ⬛4 ⬛4 ⬛1'),
        '🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 ⬜ ⬛ 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳'
      ),
      11
    )
  );
  assert.ok(
    black(
      exhaust(
        n('⬛1 ⬛4 ⬛4 ⬛2 ⬛2'),
        '🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 ⬛ ⬜ 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳 🔳'
      ),
      13
    )
  );
});

/** Every way to color `len` cells with `colors` colors. */
function* everyLane(len: number, colors: number): Generator<number[]> {
  if (len === 0) {
    yield [];
    return;
  }
  for (const rest of everyLane(len - 1, colors))
    for (let c = 0; c < colors; c++) yield [c, ...rest];
}

void test('exhaust agrees with brute force', () => {
  // Every lane of up to 6 cells in 3 colors, against every (cell masks) restriction from a seeded
  // random stream: `exhaustLine` must keep exactly the colors some consistent arrangement has.
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let len = 1; len <= 6; len++) {
    const lanes = [...everyLane(len, 3)];
    for (const truth of lanes) {
      const clues: Clue[] = [];
      truth.forEach((c, i) => {
        if (c === 0) return;
        if (i > 0 && truth[i - 1] === c) clues[clues.length - 1]!.count++;
        else clues.push({ color: c, count: 1 });
      });
      const lane = Uint32Array.from(truth, (c) => {
        let mask = fromColor(c);
        for (let o = 0; o < 3; o++) if (random() < 0.6) mask |= fromColor(o);
        return mask;
      });
      const expected = new Uint32Array(len);
      for (const candidate of lanes) {
        if (candidate.some((c, i) => (lane[i]! & fromColor(c)) === 0)) continue;
        if (!verifyLine(clues, Uint32Array.from(candidate, fromColor)))
          continue;
        candidate.forEach((c, i) => (expected[i]! |= fromColor(c)));
      }
      const got = Uint32Array.from(lane);
      assert.ok(exhaustLine(clues, got, []));
      assert.deepEqual(
        got,
        expected,
        `${JSON.stringify(clues)} on ${[...lane]}`
      );
    }
  }
});

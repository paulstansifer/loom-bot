import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decode, samples } from '../ocr/samples.ts';
import { anything, BACKGROUND, fromColor } from '../solve/cell.ts';
import { puzzleFromPicture } from '../solve/puzzle.ts';
import { debug, guidanceFor, replyTo } from './reply.ts';

void test('a debugging reply says what went wrong', () => {
  const reply = debug('no grid found: just a cat', ['Picture: 10x10 picture.']);
  assert.equal(reply.text, undefined);
  assert.ok(reply.debugging.includes('no grid found: just a cat'));
  assert.ok(reply.debugging.includes('Picture: 10x10 picture.'));
});

void test('a blank picture has no puzzle', () => {
  const reply = replyTo({
    width: 50,
    height: 40,
    data: new Uint8Array(50 * 40 * 3).fill(255),
  });
  assert.match(reply.status, /^no grid found/);
  assert.equal(reply.text, undefined);
});

/** `#` filled in, `x` crossed out, `.` undecided. */
function progress(rows: string[]): Uint32Array {
  return Uint32Array.from(rows.join(''), (ch) =>
    ch === '#' ? fromColor(1) : ch === 'x' ? fromColor(BACKGROUND) : anything(2)
  );
}

/** A spiral, which line logic solves. */
const SPIRAL = puzzleFromPicture(
  2,
  ['#####', '#....', '#.###', '#...#', '#####'].map((row) =>
    [...row].map((ch) => (ch === '#' ? 1 : BACKGROUND))
  )
);

void test('a few mistakes that put many lanes wrong are still progress', () => {
  // Two cells wrong, of 25, but they contradict 3 lanes of 10.
  const cells = progress(['#####', '#xxxx', 'x####', '#xxx#', '#####']);
  const { report, believed, broken } = guidanceFor(SPIRAL, cells, true, false);
  assert.equal(broken, 3);
  assert.ok(believed);
  assert.ok(report !== 'no-solution');
  assert.deepEqual(report.errors, [10, 11]);
});

void test('progress that mostly disagrees with the answer was misread', () => {
  // (Filled and crossed out, the wrong way around.)
  const cells = progress(['xxxxx', 'x####', 'x#xxx', 'x###x', 'xxxxx']);
  const { report, believed } = guidanceFor(SPIRAL, cells, true, false);
  assert.ok(!believed);
  assert.ok(report !== 'no-solution');
  assert.deepEqual(report.errors, []);
  assert.equal(report.filledCells, 0);
});

void test("a crooked picture's progress isn't believed, right or not", () => {
  const cells = progress(['#####', '#xxxx', '#x###', '#xxx#', '#####']);
  assert.ok(!guidanceFor(SPIRAL, cells, false, false).believed);
  assert.ok(guidanceFor(SPIRAL, cells, true, false).believed);
});

// The sample pictures, if they're here (see `src/ocr/samples.ts`). Every checked one but the
// known failures (see `DEVELOPING.md`) gets guidance, from the clues in its file.
const KNOWN_FAILURES = ['3', '8', '10'];
for (const sample of samples()) {
  const clues = sample.clues!;
  if (!clues.checked || KNOWN_FAILURES.includes(sample.name)) continue;
  void test(`a reply to sample ${sample.name}`, async () => {
    const reply = replyTo(await decode(sample.path));
    assert.match(
      reply.status,
      new RegExp(`^read ${clues.cols}x${clues.rows}: `)
    );
    assert.deepEqual(reply.reading?.columns, clues.columnClues);
    assert.deepEqual(reply.reading?.rows, clues.rowClues);
    assert.ok(
      reply.text!.startsWith(
        `This looks like a ${clues.cols}x${clues.rows} puzzle`
      )
    );
    if (!reply.status.endsWith('ambiguous'))
      assert.ok(reply.text!.includes('[Start from scratch]('));
    assert.ok(!reply.text!.includes('Debugging information'));
    assert.ok(reply.debugging.includes("Columns' clues, as read:"));
    assert.ok(reply.text!.length < 10_000 && reply.debugging.length < 10_000);
  });
}

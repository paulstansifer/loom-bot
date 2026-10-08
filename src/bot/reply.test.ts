import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decode, samples } from '../ocr/samples.ts';
import { debug, replyTo } from './reply.ts';

void test('a debugging reply says what went wrong', () => {
  const reply = debug('no grid found: just a cat', ['Picture: 10x10 picture.']);
  assert.ok(reply.text.startsWith("I couldn't read this puzzle."));
  assert.ok(reply.text.includes('no grid found: just a cat'));
  assert.ok(reply.text.includes('Picture: 10x10 picture.'));
});

void test('a blank picture has no puzzle', () => {
  const reply = replyTo({
    width: 50,
    height: 40,
    data: new Uint8Array(50 * 40 * 3).fill(255),
  });
  assert.match(reply.status, /^no grid found/);
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
      reply.text.startsWith(
        `This looks like a ${clues.cols}x${clues.rows} puzzle`
      )
    );
    if (!reply.status.endsWith('ambiguous'))
      assert.ok(reply.text.includes('[Start from scratch]('));
    assert.ok(reply.text.length < 10_000);
  });
}

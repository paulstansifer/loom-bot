import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { blackAndWhite } from '../../solve/puzzle.ts';
import { solve } from '../../solve/solve.ts';
import { consistency } from '../read.ts';
import { decode, SAMPLES_DIR } from '../samples.ts';
import { readPaper } from './read.ts';

// Sample 13 (a photo of a finished puzzle in red marker), if the samples are here: its clues,
// read with the grid's help, make sense, and solve by line logic.
const path = join(SAMPLES_DIR, '13.webp');
if (existsSync(path)) {
  void test('readPaper on sample 13', async () => {
    const read = readPaper(await decode(path));
    assert.ok(read.ok, read.ok ? '' : read.reason);
    assert.ok(consistency(read.reading).consistent);
    const { rows, columns } = read.reading;
    assert.equal(solve(blackAndWhite(rows, columns)).kind, 'line-logic');
  });
}

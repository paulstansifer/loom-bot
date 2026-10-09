import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isDeleteCommand } from './commands.ts';

void test('"!delete", however it is typed', () => {
  assert.ok(isDeleteCommand('!delete'));
  assert.ok(isDeleteCommand('  !Delete\n'));
});

void test('not "!delete"', () => {
  assert.ok(!isDeleteCommand('delete'));
  assert.ok(!isDeleteCommand('!delete this, please'));
  assert.ok(!isDeleteCommand('Thanks! Should I !delete it?'));
});

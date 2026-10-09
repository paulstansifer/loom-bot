import assert from 'node:assert/strict';
import { test } from 'node:test';

import { command } from './commands.ts';

void test('commands, however they are typed', () => {
  assert.equal(command('!delete'), 'delete');
  assert.equal(command('  !Delete\n'), 'delete');
  assert.equal(command('!DEBUG'), 'debug');
  assert.equal(command('!optout'), 'optout');
  assert.equal(command('!optin '), 'optin');
});

void test('not commands', () => {
  assert.equal(command('delete'), undefined);
  assert.equal(command('!delete this, please'), undefined);
  assert.equal(command('Thanks! Should I !delete it?'), undefined);
  assert.equal(command('!opt out'), undefined);
});

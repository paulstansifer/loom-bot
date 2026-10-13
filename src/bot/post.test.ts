import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unfit } from './post.ts';

const fine = {
  removed: false,
  spam: false,
  removedByCategory: undefined,
  locked: false,
  nsfw: false,
};

void test('an ordinary post is fit to reply to', () => {
  assert.equal(unfit(fine), undefined);
});

void test('removed, locked and NSFW posts are not', () => {
  assert.equal(unfit({ ...fine, removed: true }), 'it was removed');
  assert.equal(unfit({ ...fine, spam: true }), 'it was removed');
  assert.equal(
    unfit({ ...fine, removedByCategory: 'automod_filtered' }),
    'it was removed'
  );
  assert.equal(unfit({ ...fine, locked: true }), "it's locked");
  assert.equal(unfit({ ...fine, nsfw: true }), "it's NSFW");
});

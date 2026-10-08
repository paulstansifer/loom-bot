import assert from 'node:assert/strict';
import { test } from 'node:test';

import { firstPicture } from './picture.ts';

void test('a single picture', () => {
  const post = { url: 'https://i.redd.it/abc123.png', body: '', gallery: [] };
  assert.equal(firstPicture(post), 'https://i.redd.it/abc123.png');
});

void test('a gallery, in its order', () => {
  const post = {
    url: 'https://www.reddit.com/gallery/xyz',
    gallery: [
      { url: 'https://i.redd.it/broken.png', status: 2 },
      {
        url: 'https://preview.redd.it/first.jpg?width=640&amp;s=abc',
        status: 1,
      },
      { url: 'https://i.redd.it/second.png', status: 1 },
    ],
  };
  assert.equal(
    firstPicture(post),
    'https://preview.redd.it/first.jpg?width=640&s=abc'
  );
});

void test('pictures in the text', () => {
  const post = {
    url: 'https://www.reddit.com/r/nonograms/comments/xyz/help/',
    body: 'Stuck here:\n\nhttps://preview.redd.it/early.png?width=640\n\nand here:\n\n[pic](https://preview.redd.it/late.png?width=640)',
    gallery: [],
  };
  assert.equal(
    firstPicture(post),
    'https://preview.redd.it/early.png?width=640'
  );
});

void test('no picture', () => {
  for (const post of [
    {
      url: 'https://www.reddit.com/r/nonograms/comments/xyz/question/',
      body: 'How?',
      gallery: [],
    },
    { url: 'https://v.redd.it/video', gallery: [] },
    { url: 'https://www.youtube.com/watch?v=abc.png', gallery: [] },
    // (Pictures elsewhere would need their hosts allowed.)
    { url: 'https://imgur.com/abc.png', gallery: [] },
  ])
    assert.equal(firstPicture(post), undefined, post.url);
});

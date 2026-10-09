/** Replying to a new post: reading its first picture, and commenting with what came of it. */

import { reddit } from '@devvit/web/server';
import type { T3 } from '@devvit/shared-types/tid.js';

import { optedOut, saveDebugging } from './commands.ts';
import { downloadPicture, firstPicture } from './picture.ts';
import { debug, type Reply, replyTo } from './reply.ts';

/** How many crossposts deep to look for the original. */
const MAX_CROSSPOSTS = 3;

export async function handlePost(id: T3): Promise<void> {
  let post = await reddit.getPostById(id);
  if (post.authorId && (await optedOut(post.authorId))) {
    console.log(`${id}: its author opted out`);
    return;
  }
  // A crosspost's pictures are in the post it's a copy of.
  for (let i = 0; i < MAX_CROSSPOSTS && post.crosspostParentId; i++)
    post = await reddit.getPostById(post.crosspostParentId);
  const url = firstPicture({
    url: post.url,
    body: post.body,
    gallery: post.gallery,
  });
  if (!url) {
    console.log(`${id}: no picture`);
    return;
  }

  let reply: Reply;
  try {
    reply = replyTo(await downloadPicture(url));
  } catch (e) {
    reply = debug(`couldn't get the picture: ${String(e)}`, [
      `Picture: ${url}`,
    ]);
  }
  console.log(`${id}: ${reply.status} (${url})`);
  const comment = await reddit.submitComment({
    id,
    text: reply.text,
    runAs: 'APP',
  });
  await saveDebugging(comment.id, reply.debugging);
}

/** Replying to a new post: reading its first picture, and commenting with what came of it. */

import { type Post, reddit } from '@devvit/web/server';
import type { T3 } from '@devvit/shared-types/tid.js';

import { optedOut, saveDebugging } from './commands.ts';
import { downloadPicture, firstPicture } from './picture.ts';
import { debug, type Reply, replyTo } from './reply.ts';

/** How many crossposts deep to look for the original. */
const MAX_CROSSPOSTS = 3;

/**
 * Why a post is left alone whatever its picture is, if it is: it's been removed (by anyone: a
 * moderator, a filter, Reddit, or its author), or it's locked, or NSFW.
 */
export function unfit(
  post: Pick<Post, 'removed' | 'spam' | 'removedByCategory' | 'locked' | 'nsfw'>
): string | undefined {
  if (post.removed || post.spam || post.removedByCategory)
    return 'it was removed';
  if (post.locked) return "it's locked";
  if (post.nsfw) return "it's NSFW";
  return undefined;
}

export async function handlePost(id: T3): Promise<void> {
  let post = await reddit.getPostById(id);
  const why = unfit(post);
  if (why) {
    console.log(`${id}: ${why}`);
    await saveDebugging(id, `I skipped this post because ${why}.`);
    return;
  }
  if (post.authorId && (await optedOut(post.authorId))) {
    console.log(`${id}: its author opted out`);
    await saveDebugging(id, 'I skipped this post because its author opted out.');
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
    await saveDebugging(
      id,
      'I skipped this post because it has no picture I can read.'
    );
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
  await saveDebugging(id, reply.debugging);
  if (reply.text)
    await reddit.submitComment({ id, text: reply.text, runAs: 'APP' });
}

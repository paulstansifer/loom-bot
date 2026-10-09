/**
 * Commands people can give the bot in comments:
 *
 * - "!delete", replying to one of the bot's comments on their own post, deletes it.
 * - "!whynot", as a top-level comment on a post, gets what the bot made of it: what was read, how
 *   long it took, and what went wrong (saved when the bot looked at the post, for
 *   `DEBUGGING_DAYS`). The bot doesn't reply to a post it can't read, so this is how to find out.
 * - "!debug", replying to the bot's reply to a post, gets the same.
 * - "!optout", anywhere, stops the bot replying to their posts, and "!optin" undoes that.
 */

import { reddit, redis } from '@devvit/web/server';
import type { OnCommentCreateRequest } from '@devvit/web/shared';
import type { T1, T2, T3 } from '@devvit/shared-types/tid.js';

type Command = 'delete' | 'debug' | 'whynot' | 'optout' | 'optin';

const COMMANDS: readonly Command[] = [
  'delete',
  'debug',
  'whynot',
  'optout',
  'optin',
];

/** How long a reply's debugging information is kept for. */
const DEBUGGING_DAYS = 365;

/** The command a comment's text is, if it's one (in any case, and with any space around it). */
export function command(body: string): Command | undefined {
  const text = body.trim().toLowerCase();
  return COMMANDS.find((c) => text === `!${c}`);
}

const optOutKey = (user: T2) => `optout:${user}`;
const debuggingKey = (post: T3) => `debugging:${post}`;

export async function optedOut(user: T2): Promise<boolean> {
  return (await redis.exists(optOutKey(user))) > 0;
}

/** Keeps `debugging` for whoever asks about `post`. */
export async function saveDebugging(
  post: T3,
  debugging: string
): Promise<void> {
  await redis.set(debuggingKey(post), debugging, {
    expiration: new Date(Date.now() + DEBUGGING_DAYS * 24 * 60 * 60 * 1000),
  });
}

/** Does what a new comment says to, if it's a command. */
export async function handleComment(
  input: OnCommentCreateRequest
): Promise<void> {
  const { comment, author, post } = input;
  if (!comment || !author?.id) return;
  const which = command(comment.body);
  if (!which) return;
  const id = comment.id as T1;
  const user = author.id as T2;
  const answer = (text: string) =>
    reddit.submitComment({ id, text, runAs: 'APP' });

  switch (which) {
    case 'optout':
      await redis.set(optOutKey(user), '1');
      console.log(`${id}: ${user} opted out`);
      await answer(
        `OK, I won't reply to your posts any more. To undo this, comment "!optin".`
      );
      return;
    case 'optin':
      await redis.del(optOutKey(user));
      console.log(`${id}: ${user} opted in`);
      await answer(`OK, I'll reply to your posts again.`);
      return;
  }

  if (which === 'whynot') {
    if (comment.parentId.startsWith('t3_'))
      await explain(input, comment.postId as T3);
    return;
  }

  // The rest are replies to the bot's comments.
  if (!comment.parentId.startsWith('t1_')) return;
  const parent = await reddit.getCommentById(comment.parentId as T1);
  const app = await reddit.getAppUser();
  if (!app || parent.authorId !== app.id) return;

  switch (which) {
    case 'delete':
      if (user !== post?.authorId) {
        console.log(`${id}: !delete from someone other than the post's author`);
        return;
      }
      await parent.delete();
      console.log(`${id}: deleted ${parent.id}, as the post's author asked`);
      return;
    case 'debug': {
      // (Only a reply to the post itself, the bot's one comment, has any.)
      if (parent.parentId.startsWith('t3_'))
        await explain(input, parent.postId);
      return;
    }
  }
}

/** Replies to the comment with what the bot made of `post`, if it's looked at it. */
async function explain(input: OnCommentCreateRequest, post: T3): Promise<void> {
  const id = input.comment!.id as T1;
  const debugging = await redis.get(debuggingKey(post));
  if (!debugging) {
    console.log(`${id}: no debugging information for ${post}`);
    return;
  }
  await reddit.submitComment({ id, text: debugging, runAs: 'APP' });
}

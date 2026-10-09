/**
 * Commands people can give the bot in comments:
 *
 * - "!delete", replying to one of the bot's comments on their own post, deletes it.
 * - "!debug", replying to the bot's reply to a post, gets what was read, and how long it took
 *   (saved when the bot replied, for `DEBUGGING_DAYS`).
 * - "!optout", anywhere, stops the bot replying to their posts, and "!optin" undoes that.
 */

import { reddit, redis } from '@devvit/web/server';
import type { OnCommentCreateRequest } from '@devvit/web/shared';
import type { T1, T2 } from '@devvit/shared-types/tid.js';

type Command = 'delete' | 'debug' | 'optout' | 'optin';

const COMMANDS: readonly Command[] = ['delete', 'debug', 'optout', 'optin'];

/** How long a reply's debugging information is kept for. */
const DEBUGGING_DAYS = 365;

/** The command a comment's text is, if it's one (in any case, and with any space around it). */
export function command(body: string): Command | undefined {
  const text = body.trim().toLowerCase();
  return COMMANDS.find((c) => text === `!${c}`);
}

const optOutKey = (user: T2) => `optout:${user}`;
const debuggingKey = (comment: T1) => `debugging:${comment}`;

export async function optedOut(user: T2): Promise<boolean> {
  return (await redis.exists(optOutKey(user))) > 0;
}

/** Keeps `debugging` for whoever asks about the bot's comment `comment`. */
export async function saveDebugging(
  comment: T1,
  debugging: string
): Promise<void> {
  await redis.set(debuggingKey(comment), debugging, {
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
      // (Only the bot's replies to posts have any saved.)
      const debugging = await redis.get(debuggingKey(parent.id));
      if (!debugging) {
        console.log(`${id}: no debugging information for ${parent.id}`);
        return;
      }
      await answer(debugging);
      return;
    }
  }
}

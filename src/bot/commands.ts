/** Commands people can give the bot by replying to its comments. */

import { reddit } from '@devvit/web/server';
import type { OnCommentCreateRequest } from '@devvit/web/shared';
import type { T1 } from '@devvit/shared-types/tid.js';

/** Whether a comment's text is "!delete" (in any case, and with any space around it). */
export function isDeleteCommand(body: string): boolean {
  return body.trim().toLowerCase() === '!delete';
}

/**
 * If a new comment is the post's author replying "!delete" to one of the bot's comments, deletes
 * that comment.
 */
export async function handleComment(
  input: OnCommentCreateRequest
): Promise<void> {
  const { comment, author, post } = input;
  if (!comment || !isDeleteCommand(comment.body)) return;
  const id = comment.id;
  if (!comment.parentId.startsWith('t1_')) return; // (A reply to the post itself.)
  if (!author?.id || author.id !== post?.authorId) {
    console.log(`${id}: !delete from someone other than the post's author`);
    return;
  }
  const parent = await reddit.getCommentById(comment.parentId as T1);
  const app = await reddit.getAppUser();
  if (!app || parent.authorId !== app.id) return;
  await parent.delete();
  console.log(`${id}: deleted ${parent.id}, as the post's author asked`);
}

/**
 * Commands people can give the bot in comments:
 *
 * - "!delete", replying to one of the bot's comments, or on its own on a post, forgets the post:
 *   it deletes every comment the bot made about it, and what it kept.
 * - "!whynot", as a top-level comment on a post, gets what the bot made of it: what was read, how
 *   long it took, and what went wrong (saved when the bot looked at the post, for
 *   `DEBUGGING_DAYS`). The bot doesn't reply to a post it can't read, so this is how to find out.
 *   If the bot got as far as finding the clues' glyphs, there's a link to a picture of them
 *   (`view.ts`), drawn and uploaded then.
 * - "!debug", replying to the bot's reply to a post, gets the same. A post only ever gets one
 *   such answer.
 * - "!optout", anywhere, stops the bot replying to their posts, and "!optin" undoes that.
 *
 * The first four are only for the post's author and the subreddit's moderators.
 */

import { media, reddit, redis } from '@devvit/web/server';
import type { OnCommentCreateRequest } from '@devvit/web/shared';
import type { T1, T2, T3 } from '@devvit/shared-types/tid.js';

import { downloadPicture } from './picture.ts';
import { replyTo } from './reply.ts';
import { encodePng, glyphView } from './view.ts';

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
const explainedKey = (post: T3) => `explained:${post}`;
const pictureKey = (post: T3) => `picture:${post}`;
/** The comments the bot has made about a post, as the fields of a hash. */
const responsesKey = (post: T3) => `responses:${post}`;

const viewLink = (url: string) => `[Glyph detection debugging image](${url})`;

export async function optedOut(user: T2): Promise<boolean> {
  return (await redis.exists(optOutKey(user))) > 0;
}

/** Keeps `debugging` for whoever asks about `post`, and where its picture is, if the bot read
 * one, to draw the glyph view from. */
export async function saveDebugging(
  post: T3,
  debugging: string,
  picture?: string
): Promise<void> {
  const expiration = new Date(
    Date.now() + DEBUGGING_DAYS * 24 * 60 * 60 * 1000
  );
  await redis.set(debuggingKey(post), debugging, { expiration });
  if (picture) await redis.set(pictureKey(post), picture, { expiration });
}

/** Notes that `comment` is the bot's, about `post`, so that "!delete" can find it. */
export async function recordResponse(post: T3, comment: T1): Promise<void> {
  const key = responsesKey(post);
  await redis.hSet(key, { [comment]: '1' });
  await redis.expire(key, DEBUGGING_DAYS * 24 * 60 * 60);
}

/** Comments as the bot, and records it (see `recordResponse`). */
export async function respond(post: T3, parent: T1 | T3, text: string) {
  const comment = await reddit.submitComment({
    id: parent,
    text,
    runAs: 'APP',
  });
  await recordResponse(post, comment.id);
  return comment;
}

/**
 * Forgets `post`: deletes every comment the bot made about it (and `also`, if given), and what it
 * kept. All that stays is a note that this was done, in place of the debugging information. (The
 * glyph view's picture stays on Reddit, since an app can't delete what it uploads, but nothing
 * links to it.)
 */
async function forget(post: T3, also?: T1): Promise<void> {
  const comments = new Set(await redis.hKeys(responsesKey(post)));
  if (also) comments.add(also);
  for (const comment of comments) {
    try {
      await (await reddit.getCommentById(comment as T1)).delete();
    } catch (e) {
      // (Most likely already gone.)
      console.error(`${post}: couldn't delete ${comment}: ${String(e)}`);
    }
  }
  await redis.del(pictureKey(post), responsesKey(post));
  await redis.set(
    debuggingKey(post),
    'The information about this post was deleted, as its author or a moderator asked.',
    { expiration: new Date(Date.now() + DEBUGGING_DAYS * 24 * 60 * 60 * 1000) }
  );
}

/** Does what a new comment says to, if it's a command. */
export async function handleComment(
  input: OnCommentCreateRequest
): Promise<void> {
  const { comment, author } = input;
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
        `This bot won't reply to your posts in the future. To undo this, comment "!optin".`
      );
      return;
    case 'optin':
      await redis.del(optOutKey(user));
      console.log(`${id}: ${user} opted in`);
      await answer(`This bot will resume replying to your posts.`);
      return;
  }

  if (which === 'whynot') {
    if (comment.parentId.startsWith('t3_'))
      await explain(input, comment.postId as T3);
    return;
  }

  // On a post, "!delete" is for when the bot made no comment to reply to.
  if (which === 'delete' && comment.parentId.startsWith('t3_')) {
    if (!(await fromAuthorOrMod(input))) {
      console.log(
        `${id}: !delete from neither the post's author nor a moderator`
      );
      return;
    }
    await forget(comment.postId as T3);
    console.log(`${id}: forgot ${comment.postId}, as ${user} asked`);
    return;
  }

  // The rest are replies to the bot's comments.
  if (!comment.parentId.startsWith('t1_')) return;
  const parent = await reddit.getCommentById(comment.parentId as T1);
  const app = await reddit.getAppUser();
  if (!app || parent.authorId !== app.id) return;

  switch (which) {
    case 'delete':
      if (!(await fromAuthorOrMod(input))) {
        console.log(
          `${id}: !delete from neither the post's author nor a moderator`
        );
        return;
      }
      await forget(comment.postId as T3, parent.id);
      console.log(`${id}: forgot ${comment.postId}, as ${user} asked`);
      return;
    case 'debug': {
      // (Only a reply to the post itself, the bot's one comment, has any.)
      if (parent.parentId.startsWith('t3_'))
        await explain(input, parent.postId);
      return;
    }
  }
}

/** Whether the comment is from its post's author, or one of the subreddit's moderators. */
async function fromAuthorOrMod(
  input: OnCommentCreateRequest
): Promise<boolean> {
  const { author, post, subreddit } = input;
  if (!author) return false;
  if (author.id === post?.authorId) return true;
  if (!subreddit) return false;
  const mods = await reddit
    .getModerators({ subredditName: subreddit.name, username: author.name })
    .all();
  return mods.length > 0;
}

/**
 * Replies to the comment with what the bot made of `post`, if it's looked at it, the comment is
 * from the post's author or a moderator, and nobody has been told already.
 */
async function explain(input: OnCommentCreateRequest, post: T3): Promise<void> {
  const id = input.comment!.id as T1;
  if (!(await fromAuthorOrMod(input))) {
    console.log(`${id}: asked by neither the post's author nor a moderator`);
    return;
  }
  const debugging = await redis.get(debuggingKey(post));
  if (!debugging) {
    console.log(`${id}: no debugging information for ${post}`);
    return;
  }
  // Counting, not checking and then setting: of two comments at once, only one gets 1.
  if ((await redis.incrBy(explainedKey(post), 1)) > 1) {
    console.log(`${id}: ${post} has been explained already`);
    return;
  }
  await redis.expire(explainedKey(post), DEBUGGING_DAYS * 24 * 60 * 60);
  try {
    const view = await uploadGlyphView(post);
    const text = view ? `${debugging}\n\n${viewLink(view)}` : debugging;
    await respond(post, id, text);
  } catch (e) {
    // Nobody was told, so the next one to ask still can be.
    await redis.del(explainedKey(post));
    throw e;
  }
}

/**
 * The glyph view (`view.ts`) of `post`'s picture, uploaded, if the bot read one, and got as far as
 * the glyphs. The picture is read again for it, rather than every post's being uploaded in case
 * someone asks.
 */
async function uploadGlyphView(post: T3): Promise<string | undefined> {
  const url = await redis.get(pictureKey(post));
  if (!url) return undefined;
  try {
    const { reading, picture } = replyTo(await downloadPicture(url));
    if (!reading || !picture) return undefined;
    const png = Buffer.from(encodePng(glyphView(picture, reading)));
    const { mediaUrl } = await media.upload({
      url: `data:image/png;base64,${png.toString('base64')}`,
      type: 'image',
    });
    return mediaUrl;
  } catch (e) {
    // The debugging information is still worth having without it.
    console.error(`${post}: no glyph view: ${String(e)}`);
    return undefined;
  }
}

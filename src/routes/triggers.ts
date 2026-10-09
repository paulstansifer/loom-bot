import { Hono } from 'hono';
import type {
  OnCommentCreateRequest,
  OnPostCreateRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import type { T3 } from '@devvit/shared-types/tid.js';

import { handleComment } from '../bot/commands.ts';
import { handlePost } from '../bot/post.ts';

export const triggers = new Hono();

triggers.post('/on-post-create', async (c) => {
  const input = await c.req.json<OnPostCreateRequest>();
  const id = input.post?.id;
  if (id) {
    // A post that goes wrong is reported and skipped, not retried: it would likely only go
    // wrong again.
    try {
      await handlePost(id as T3);
    } catch (e) {
      console.error(`${id}: ${String(e)}`);
    }
  }
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-comment-create', async (c) => {
  const input = await c.req.json<OnCommentCreateRequest>();
  try {
    await handleComment(input);
  } catch (e) {
    console.error(`${input.comment?.id}: ${String(e)}`);
  }
  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

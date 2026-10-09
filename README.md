# number-loom-bot

A Reddit bot, built on [Devvit](https://developers.reddit.com/), that reads the nonogram in a
post's picture and replies with help solving it: whether it's solvable with line logic, which
lanes to look at next, and a link to solve it in
[Number Loom](https://paulstansifer.github.io/number-loom/).

It's a port of parts of [Number Loom](https://github.com/paulstansifer/number-loom)'s solver,
its share-link format, and its Reddit bot, to TypeScript, with a clue reader of its own. See
`DEVELOPING.md`.

## What it does

TODO: describe, for someone who sees the bot's reply on a post:

- What it replies to: the first picture in a post (screenshots, and photos of paper puzzles).
- What a reply contains, and that the hints are in spoilers.
- That it stays silent when it can't read the puzzle, and why that's deliberate.
- That it's a bot, and who runs it (u/paul_stansifer).

## Commands

Comment these exactly, and nothing else in the comment:

| Command   | Where                       | Who           | What it does                                                   |
| --------- | --------------------------- | ------------- | -------------------------------------------------------------- |
| `!delete` | Reply to the bot's comment  | The post's OP | Deletes the bot's comment.                                     |
| `!whynot` | Top-level comment on a post | Anyone        | Shows what the bot made of the post, for when it didn't reply. |
| `!debug`  | Reply to the bot's comment  | Anyone        | Shows what the bot read, and how long it took.                 |
| `!optout` | Anywhere                    | Anyone        | The bot stops replying to your posts.                          |
| `!optin`  | Anywhere                    | Anyone        | Undoes `!optout`.                                              |

TODO: check the wording against how the bot actually behaves, once it's been playtested.

## Limits

TODO: what to expect, for people deciding whether to trust it:

- Which pictures work: PNG and JPEG on `i.redd.it` / `preview.redd.it`; no WebP.
- What goes wrong: unusual apps' screenshots, glare and creases on paper photos, handwriting.
- That it can misread progress, and what it does then (guides as if you hadn't started).
- Only black-and-white puzzles for now (TODO: confirm).

## Privacy

TODO: what it stores (Redis: opted-out user IDs, and a year of debugging notes per post), and
that it downloads and reads pictures but doesn't keep them.

## Development

```
npm install
npm run test:unit
npm run dev        # playtest in the subreddit in devvit.json
```

TODO: how to deploy and install it in a subreddit, and who to contact (issues, mod mail).

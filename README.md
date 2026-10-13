# number-loom-bot

This is a Reddit bot that reads screenshots (or, under good conditions, photographs) of nonograms and replies with a link to a solvable puzzle in [Number Loom](https://paulstansifer.github.io/number-loom/) and a spoiler-hidden set of suggested next moves.

## Commands

| Command   | Where                       | Who                    | What it does                                           |
| --------- | --------------------------- | ---------------------- | ------------------------------------------------------ |
| `!delete` | Reply to the bot's comment  | The post's OP, or mods | Deletes the bot's comment.                             |
| `!whynot` | Top-level comment on a post | The post's OP, or mods | Shows debugging information if the bot didn't respond. |
| `!debug`  | Reply to the bot's comment  | The post's OP, or mods | Shows what the bot read, and how long it took.         |
| `!optout` | Anywhere                    | Anyone                 | Makes the bot stop replying to your posts.             |
| `!optin`  | Anywhere                    | Anyone                 | Undoes `!optout`.                                      |

The bot answers `!whynot` or `!debug` only once per post.

## Development

I'm afraid that this is pretty much entirely LLM-generated, with two exceptions:

- I insisted on writing the user-visible text myself.
- The solver is translated from Number Loom's solver, which is mostly human-written.

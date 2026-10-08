# number-loom-bot

A Reddit bot, built on [Devvit](https://developers.reddit.com/), that reads the nonogram in a
post's picture and replies with help solving it: whether it's solvable with line logic, which
lanes to look at next, and a link to solve it in
[Number Loom](https://paulstansifer.github.io/number-loom/).

It's a port of parts of [Number Loom](https://github.com/paulstansifer/number-loom)'s solver,
its share-link format, and its Reddit bot, to TypeScript, with a clue reader of its own. See
`DEVELOPING.md`.

```
npm install
npm run test:unit
npm run dev        # playtest in the subreddit in devvit.json
```

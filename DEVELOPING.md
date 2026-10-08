# Developing `number-loom-bot`

A Reddit (Devvit) bot that reads a nonogram from a screenshot and replies about it. It started
from Devvit's mod-tool template (the "Mop" commands in `src/core`, `src/routes` are the
template's). It has to run in Node.js and answer in under 30 seconds, which rules out the
`ocr-clues` pipeline in `~/src/number-loom/src/ocr-clue-bot/` (see its `DEVELOPING.md`). So
the plan is to find the grid first, from its pixel-perfect lines, and let that guide reading the
clues.

Use the Node version in `.nvmrc` (`nvm use`); the tests need Node's TypeScript stripping.

```
npm run test:unit    # node --test over src/**/*.test.ts
npm run test:types   # tsc
npm run lint         # src/ and scripts/
```

Source files import each other with `.ts` extensions, so that Node can run them directly
(`rewriteRelativeImportExtensions` in `tsconfig.json` makes `tsc` accept that).

## Finding the grid (`src/ocr/grid.ts`)

`findGrid(raster)` takes decoded RGB pixels (`src/ocr/raster.ts`; decoding isn't its business,
and which decoder will work on Devvit is still an open question) and returns the grid's size and
every grid line's position: `lead` (its first row of pixels) and `trail` (one past its last), so
each cell's inside is from one line's `trail` to the next one's `lead`. It takes about 20–160 ms
on a phone screenshot. (A picture covered in graph paper, which it can't do anything with, takes
over a second.)

What the screenshots show, measured in eight different apps:

- Every line, thin or heavy (the heavy ones are usually every fifth), is *centered* on one evenly
  spaced lattice: the spacing between centers stays the same, to within about 0.3 px, across
  the heavy lines. So the cells beside a heavy line are smaller; the stride doesn't change. The
  spacing isn't a whole number of pixels (58.45 px, 43.5 px, …).
- The border is the exception: it's drawn *inside* the grid, with its outer edge on the lattice.
- Lines can be dark on light, light on dark, or colored. In "tile" apps there are no lines, just
  gaps between rounded tiles.
- Next to a filled cell, a line merges into the fill, so instead of light-dark-light there's a
  single step. Between two filled cells, there's often no line at all.

So the grid is found from *edges* (where one row of pixels differs from the next), not from
light-dark-light lines: a line always leaves an edge on at least one side, unless it's between
two filled cells. The steps:

1. `edges`: an edge wherever a pixel differs from the next by more than a threshold, in any of
   R, G, B. Compression blurs edges over a few pixels, so only the strongest counts, but only
   compared with neighbors that change the same way: a thin line's two edges are a pixel apart.
   The edges in each row of pixels are joined into runs, bridging gaps of up to 20 px: where cells
   are drawn as tiles, the gaps between them cross each tile's edge, often with rounded corners
   either side.
2. `profile`: how much edge each row has, counting only runs at least 50 px long and at least
   half edge. That leaves out digits and marks, and is where "pixel-perfect" comes in: a grid line
   in a screenshot is one long run in a single row of pixels. In a photo, the line wanders from
   row to row.
3. `lattices`: the likeliest evenly spaced sets of peaks in that profile. Each one is grown from
   a pair of peaks, refitting the spacing as it goes. Half the true spacing misses every other
   line, and five times the spacing (just the heavy lines) is short, so the true spacing scores
   best. A few are kept, since other things can repeat too.
4. `measure`: each line of a lattice, from the outermost strong edges near where the lattice
   says it is. These measured lines, not the lattice, give the cells' bounds. The lattice only
   says which line is which. (That would also cope with an app whose stride *does* jump at its
   heavy lines, if there is one.)
5. `rectangle`: the biggest rectangle of cells whose border has an edge all the way around. The
   outside of the border always has an edge, even next to a filled cell. The lines inside it
   have to mostly have edges too. Coverage is only checked over the middle of each cell's side,
   since tiles' rounded corners break up their edges.
6. Clue boxes: some apps put clues in boxes that carry the grid's lines on, so the biggest
   rectangle includes them. As in `ocr-clues`' `grid.rs`, that's told by which lines reach
   furthest: the grid's vertical lines carry on up through the column clues' boxes, but the row
   clues' boxes' lines don't, so leading columns whose lines clearly stop are row clues. Rows at
   the top are handled the same way.
7. `straightness`: whether each line is in the same place at both ends of the grid. This is
   reported as `pixelPerfect`. It's only a hint: a photo of a screen can be nearly straight,
   and still give the right grid.

Things that didn't work, so as not to try them again:

- Choosing between lattices by the size of the rectangle they give. A third of the true spacing
  can make a bigger grid out of patterns inside the cells.
- Telling the heavy lines (or the border) from the rest, by width or by "ink" (each line's median
  color across it). Edge widths vary by a couple of pixels with compression ringing. The median
  is taken over the fills in a well-filled grid. Both were too noisy to decide anything with.

### Testing against pictures

The pictures this was developed against are from r/nonograms, so they're kept out of the repo,
in `~/others/reddit-nonograms-ocr` (or wherever `NONOGRAM_SAMPLES` says). Each `NAME.webp` has a
`NAME.clues` beside it, in `ocr-clues`' format. One that starts with `# UNCHECKED` was never
corrected by hand, and its picture is likely a photo. `npm run test:unit` checks that the grid
found in each checked picture is the size its clues say, and skips this if the pictures aren't
there.

```
node --experimental-strip-types scripts/grid-debug.ts [DIR | PICTURE...] [--out DIR]
```

prints, for each picture (by default, each one in the samples directory with a `.clues` file),
the size found against the size expected, with the time taken. With `--out`, it draws what it
found. Gray dashes are the lattice. Purple is the rectangle, including
any clue boxes. Green is each grid line, from `lead` to `trail`, and cyan is a line that wasn't
seen and was placed where the lattice says. It decodes with `sharp`, a dev-only dependency
(it's native).

### Known failures

- A background with a grid of its own, at a spacing that the puzzle's is a multiple of (sample
  10). The background's lattice outweighs the puzzle's, so no grid is found. Not worth solving for
  now.
- Clue areas drawn as part of one big grid, including the corner between them (sample 19). No
  line clearly stops, so there's nothing to tell where the grid starts, except that the clue
  cells are gray.
- Clue boxes on only one side. The grid's own lines don't carry on into the other side either,
  so the boxes look like part of the grid.
- Photos of paper (4, 6, 8, 11, 12, 13), which are out of scope. They give wrong grids, and
  only some are flagged as not `pixelPerfect`. Reading the clues will need a way to reject them,
  such as clues that don't add up.

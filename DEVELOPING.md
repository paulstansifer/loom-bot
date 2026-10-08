# Developing `number-loom-bot`

A Reddit (Devvit) bot that reads a nonogram from a screenshot and replies about it. It started
from Devvit's mod-tool template (the "Mop" commands in `src/core`, `src/routes` are the
template's). It has to run in Node.js and answer in under 30 seconds, which rules out the
`ocr-clues` pipeline in `~/src/number-loom/src/ocr-clue-bot/` (see its `DEVELOPING.md`). Devvit
doesn't allow WebAssembly either, so tesseract.js, `ocrs` and onnxruntime are out. So
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

## Reading the clues (`src/ocr/glyphs.ts`, `cluster.ts`, `numbers.ts`)

This is an experiment so far: it finds glyphs, groups them by look, and groups digits into
numbers, but doesn't yet name the groups in the bot itself, or check the result against the
grid.

`findGlyphs(raster, grid)` finds each lane's glyphs, in reading order. A column's clues are above
it, between its two lines carried on upward, and a row's are to its left.

1. The background, at each point along the lane, is the commonest color in the lane's middle
   half, over about a cell's length. (Only the middle, since the lane's sides can be the gaps
   between clue boxes.)
2. Blobs are the 8-connected pixels that differ from the background even faintly. Each blob is
   then cut again, at 40% of its own contrast. That way a dimmed clue is cut the same way as the
   rest, and faint fringes don't join neighboring digits. With one fixed threshold, dimmed
   digits broke into pieces, and their outlines came out a pixel tighter, so they didn't group
   with the undimmed ones.
3. A blob that can't be a glyph (it touches the lane's sides, or is too long) may be digits
   crossed out with lines of another color, which join them to each other and to the sides.
   Its colors are split three ways by k-means (two ways split by brightness, putting the dark
   red lines in with the black digits). Whichever color makes the most glyph-shaped blobs wins.
   Pixels of another color with that color on both sides, within 4 px, count as that color too:
   they're where a line crosses a stroke. Those glyphs are flagged `struck`.
4. Outward from the grid, glyphs are kept until there's a gap of more than a cell.

`cluster` groups a picture's glyphs by how they look. Each glyph's ink, as a fraction of its
contrast, is stretched to 16×16. Two glyphs are compared by the average difference, unless
their sizes clearly differ. A glyph joins the nearest group within 0.12 of its average look.
Dimmed and crossed-out digits mostly join the plain ones.

`numbers` groups each lane's glyphs into numbers. A column's clues are stacked, a number to a
line of text. A row's are in one line, split where the digits are far apart, as in `ocr-clues`'
`reread.rs`. What's far apart is decided from all the rows together. What to measure depends on
the typeface. In most, the space between digits stays the same, since a "1" is narrow. In some,
every digit takes the same width, and it's the distance from one digit's middle to the next
that stays the same. (In sample 23, "10" has as wide a gap as "4 7", since its "1" sits in a
lot of space.)

Two digits side by side in a column's clues are certainly one number, so where the columns have
any multi-digit numbers, they decide it:
- The measure is the one those pairs agree on more closely: as their digits' widths vary, the
  typeface keeps one of them the same.
- The threshold is at the biggest jump (as a ratio) between one row distance and the next,
  above the farthest of those pairs. Not at the split that best separates the two groups'
  averages: a row's digits can be a pixel further apart than a column's (sample 3), and that
  split can fall between them.

Otherwise, it's `reread.rs`'s rule: whichever of the two measures splits more cleanly into near
and far. There, numbers must be at least 1.35 times as far apart as digits, middle to middle.
Sample 23's are only about 1.25 times as far apart, and that's what the columns' pairs are for.

Naming the groups is only in `scripts/glyph-debug.ts` so far. Each group's average look is
compared with the digits drawn in about 20 installed fonts (`scripts/digit-templates.ts`, using
`sharp`), by shape and a little by proportions. For the bot, those templates would need to be
rendered once into a data file.

```
node --experimental-strip-types scripts/glyph-debug.ts [DIR | PICTURE...] [--out DIR]
  [--threshold T] [--verbose]
```

checks this against the `.clues` files. It reads each lane whole, and compares it with the clues.
Separately, a lane with as many glyphs as its clues have digits
gives each glyph its digit. Then a group should hold only one digit, and its template should
name that digit. `--out` draws the glyphs (`NAME-glyphs.png`: green in a lane with the right
count, red otherwise) and the groups (`NAME-groups.png`). On the checked samples whose grid is
found:

- 414 of 440 lanes are read exactly right: all of those that have the right number of glyphs.
- No group mixes two digits, at a threshold of 0.12. From 0.14, a few do, and at 0.2, 54
  glyphs are in the wrong group. Below 0.12, digits split into more groups.
- Every one of the 1256 glyphs in those lanes is in a group named right. The nearest
  template of another digit is at least 0.026 further away.
- It takes 10–210 ms a picture.

### Known failures

- Sample 3's middle panel: gray digits with dark drop shadows on a gradient, nearly the
  background's brightness. The shadow and the digit come apart, and some digits are missed
  (18 of the 26 bad lanes).
- Sample 21's four bad lanes have glyphs to spare (not looked into yet). Its condensed two-digit
  numbers are a font of their own, but where they're found right, they read right.

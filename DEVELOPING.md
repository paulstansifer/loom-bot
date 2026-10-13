# Developing `number-loom-bot`

*While this project is mostly LLM-written, please only write user-visible text if you're a human. 
If you're an LLM, just put in a TODO.*

A Reddit (Devvit) bot that reads a nonogram from a screenshot and replies about it. It started
from Devvit's mod-tool template, whose moderation commands have since been removed. It has to run
in Node.js and answer in under 30 seconds, which rules out the
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

- Every line, thin or heavy (the heavy ones are usually every fifth), is _centered_ on one evenly
  spaced lattice: the spacing between centers stays the same, to within about 0.3 px, across
  the heavy lines. So the cells beside a heavy line are smaller; the stride doesn't change. The
  spacing isn't a whole number of pixels (58.45 px, 43.5 px, …).
- The border is the exception: it's drawn _inside_ the grid, with its outer edge on the lattice.
- Lines can be dark on light, light on dark, or colored. In "tile" apps there are no lines, just
  gaps between rounded tiles.
- Next to a filled cell, a line merges into the fill, so instead of light-dark-light there's a
  single step. Between two filled cells, there's often no line at all.

So the grid is found from _edges_ (where one row of pixels differs from the next), not from
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
   says which line is which. (That would also cope with an app whose stride _does_ jump at its
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

Where the clues are in cells of their own that carry on the grid's lines, including the corner
between them (sample 19), or on graph paper ruled at the grid's spacing (sample 12, with clues
on all four sides), no line stops, so the lines alone can't tell where the grid is. So
`findPuzzle` (in `bounds.ts`) goes on to look at where the clues are, within the biggest
rectangle (`outer`):

- Every lane has at least one clue, if only a 0, pushed up against the grid. So the cell just
  outside the grid's edge has a digit in nearly every lane, and no cell inside ever does.
- `digitCells` looks for glyphs in each cell by itself, inside its lines, so that nothing joins
  up across cells. (Done along whole rows of cells instead, lines crossing out sample 15's clues
  joined them to the grid's border.) The glyphs are grouped and named as for the clues (see
  below), and marks crossing out cells are named "x", not digits.
- `boundsByDigits` tries every rectangle, counting the lanes with a digit just outside each
  edge, less twice the digits inside. Ties go to the bigger rectangle, so a side with no clues
  goes as far as the lines. (Sample 19's last two columns have their nearest clue cells crossed
  out.)
- It's only used if at least 60% of the lanes on one side have a digit just outside. Otherwise,
  a few stray digit-like things in a picture (or a photo) make a small rectangle that fits
  them. Sample 15's row clues are in long boxes whose lines carry on the grid's horizontal
  lines, but with no lines between the clues, so they're cut up cell by cell, and too few read
  as digits to count. The lines already tell where its grid is.

This adds 20–250 ms.

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
- Clue boxes on only one side. The grid's own lines don't carry on into the other side either,
  so the boxes look like part of the grid.
- Photos of paper (4, 6, 11, 13). They give wrong grids, and only some are flagged as not
  `pixelPerfect`. They have a pipeline of their own (see "Photos of paper", below).
- Sample 8, a puzzle drawn by hand in a drawing app, whose lines wobble.

## Reading the clues (`src/ocr/glyphs.ts`, `cluster.ts`, `names.ts`, `numbers.ts`)

This is an experiment so far: it finds glyphs, groups them by look, names the groups, and groups
digits into numbers, but nothing yet puts those together into clues outside
`scripts/glyph-debug.ts`, or checks the result against the grid.

`findGlyphs(raster, grid)` finds each lane's glyphs, in reading order. A column's clues are above
it, between its two lines carried on upward, and a row's are to its left.

1. The background, at each point along the lane, is the commonest color in the lane's middle
   half, over about a cell's length around it. (Only the middle, since the lane's sides can be
   the gaps between clue boxes.) Where one background meets another, say at the top of a clue
   box, the other one can be commoner over that length. So the commonest colors over a cell's
   length ending at the point, and starting there, count as background too, if they're clearly
   different (by more than 24). At the top of sample 23's clue box, without this, the white
   above made the box's tan count as ink, and it swallowed a faint "9". Not shorter lengths:
   over a third of a cell, the commonest color can be a bold digit's. And not when they're
   only a little different: then, in sample 3's gradients, faint digits disappeared. Even over a
   cell, it can be a digit's on a textured background, whose color is spread over many shades:
   sample 12's crossed-out "10"s fill their cells, at the end of the lane, and were lost. So a
   color to either side also has to be the commonest over two cells (as another background
   would be), and there have to be two cells' length to that side.
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
   they're where a line crosses a stroke. Those glyphs are flagged `struck`. (Only the
   blob's pixels that weren't already glyphs: otherwise, a digit on a box of its own, or with
   a drop shadow, is found twice.)

   Before that, it may be X's in place of clues, from corner to corner of their cells (sample
   19's app crosses out a clue that way, and the clue is gone). An X touches the lane's sides,
   and joins the X's in the cells beside it. So a blob across the lane, and a whole number of
   cells long, is cut into cells. A cell whose ink comes within 0.08 of a cell of 90% of the
   points along both its diagonals is an X, and a glyph of its own, named "x" by its template:
   `repair` works the clue out from the grid. Unless its strong ink (80% of the blob's contrast,
   leaving out an X's gray anti-aliased edges) is in two colors: then it's an X drawn over a
   digit, as in sample 15, whose X's are red, and the digit is found under it as above.

4. Outward from the grid, glyphs are kept until there's a gap of more than a cell.
5. Slivers and specks are dropped: anything narrower than 0.2 of the picture's median glyph
   height, or shorter than 0.6 of it. They're bits of lines and boxes, or of a digit's shadow.
   No typeface in the samples has a "1" narrower than 0.3 of its height, or a digit shorter
   than 0.87 of the median.
6. Strays are dropped, along with everything further out: a glyph past a gap more than twice
   the picture's usual one between glyphs (in lanes going the same way), and off-center by more
   than 0.15 of the lane's width (compared with the usual glyph, since some apps don't center
   the clues). Sample 24 has "FILLS 103/144" above a column's clues, and sample 29 has a bit of
   background left of a row's. Neither test alone is enough: in sample 12 (a clue to a cell),
   real clues are as far apart, and in samples 3, 21 and 23, two-digit numbers in narrow columns
   are as far off-center.
7. Missing glyphs are looked for where the layout says they should be. The clues are aligned
   against the grid, so the clue nearest the grid is about as far from it in every lane; and a
   column's clues are evenly stacked. Where one of those places is empty, a blob there that was
   left out (too faint, or past a gap) is taken, if it's in the middle of the lane and about a
   digit's height. Columns are checked going outward, as far as one place past their outermost
   clue; rows only at the place nearest the grid, since their numbers needn't be evenly
   spaced. This only gains one lane on the samples, but it's cheap. (The one missing digit in
   sample 3 that was looked into, row 5's last "1", leaves no blob at all.)

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

`names.ts` names each group's average look by the nearest template, by shape and a little by
proportions. The templates are the digits drawn in about 20 installed fonts, and marks that
cross out a cell (X, x, ×, ✕, named "x"), rendered with `sharp` by
`scripts/digit-templates.ts` into `src/ocr/templates.ts`. Run it again to change them:

```
node --experimental-strip-types scripts/digit-templates.ts
```

Each template's 16×16 shape is a string of 64 levels, about 145 KB in all. (Prettier is told
to leave the file alone.)

```
node --experimental-strip-types scripts/glyph-debug.ts [DIR | PICTURE...] [--out DIR]
  [--threshold T] [--verbose]
```

checks this against the `.clues` files. It reads each lane whole, and compares it with the clues.
Separately, a lane with as many glyphs as its clues have digits
gives each glyph its digit. Then a group should hold only one digit, and its template should
name that digit. `--out` draws the glyphs (`NAME-glyphs.png`: green in a lane with the right
count, red otherwise) and the groups (`NAME-groups.png`).

All that is the glyphs by themselves, without the grid's state, so samples 12 and 19, whose
crossed-out clues can only be worked out from the grid (see "Second thoughts", below), score
badly. "with grid" is the reading the bot gets (`readWithGrid` in `explain.ts`): how many lanes
it gets right, and how its clues solve (`line-logic`, `search`, `ambiguous`, …, or
`inconsistent`, not tried). With the grid's help, 738 of the 745 lanes of the checked samples
whose grid is found are read right, all but sample 3's, and every one of those samples but 3
and 7 is uniquely solvable (7's clues have two solutions). Without it, on the checked samples
but 12 and 19:

- 627 of 635 lanes are read exactly right, and 630 have the right number of glyphs. Every
  sample but 3 and 24 is read entirely right.
- No group mixes two digits, at a threshold of 0.12. At 0.14, 11 glyphs are in the wrong group,
  and at 0.2, 94 are. Below 0.12, digits split into more groups.
- 1802 of the 1805 glyphs in those lanes are in a group named right. The ones that aren't are
  sample 3's two shadowed digits, and sample 24's one "8", named "0" by 0.001. Elsewhere, the
  nearest template of another digit is at least 0.018 further away.
- It takes 20–270 ms a picture.

The row and column totals of a checked `.clues` file should agree. Two didn't (3 and 15), and
in both, the picture showed the reading was right and the file was wrong.

A picture whose `.clues` file is unchecked is read without a score. Instead, it says whether
what it read is consistent: the rows' and columns' totals agree, every lane's clues fit in it,
and no more than a fifth of the lanes are empty. That says which files are worth checking by
hand. It also says how the clues read with the grid's help solve. With `--out`, it writes what
it read to `NAME.clues` there, to start from. Of the unchecked samples, only 18 reads
consistently, and with the grid's help, its clues solve by line logic. Where its reading differed from its file (written by
`ocr-clues`, whose totals don't agree), the picture agreed with the reading.

### Known failures

- Sample 3's middle panel, and the spotlit corner of its row clues: gray digits with dark drop
  shadows on gradients, nearly the background's brightness. Five lanes are missing digits, and
  two have a digit named wrong.

These are read by themselves badly, but the bot reads them right, with the grid's help (see
"Second thoughts", below):

- Sample 12's pixel font's digits (a "2" as an "8"), and worse, its crossed-out ones (with a
  flag on the upper left, in the digits' own color).
- Sample 19's tiny "6"s, named "0" (the "6" template is second), and its crossed-out clues.
- Sample 24's one "8", named "0".

## Reading the grid's state (`src/ocr/cells.ts`, `repair.ts`, `explain.ts`)

`readCells(raster, grid)` says which cells are filled, crossed out or undecided, without the
clues (which is good, since a well-solved puzzle's are crossed out). It's a port of number-loom's
`cells.rs`, changed for what the samples showed.

1. Each cell's _middle_ (60% of its width) is shrunk to 8x8 RGB. Staying in the middle leaves out
   the grid's lines, and the counters some apps print in a cell's corner (sample 26).
2. The looks are grouped: a look joins the first group within 0.08 (RMS) of its average, then
   everything moves to its nearest group. A picture's cells fall into a handful of groups (10–12
   in the worst samples, with gradients). Never more than 16.
3. A group is _marked_ if the middle of its average look differs from the color at the middles of
   its edges (where neither an X nor a dot reaches). That's by color, not brightness, so
   sample 7's one red X on the dark background counts.
4. Colors within 0.12 of each other make a family (a photo's vignette is a gradient of
   undecided cells; a highlighted row is a shade off). A marked group's color is what's behind
   its mark. The undecided cells are the biggest family, with a bonus of 1.5 for one with marks
   on it. Every other plain group is filled, whatever its hue: filled isn't "darker" (in dark
   mode, sample 7, it's lighter, and its fills are three colors), and in sample 15 so many cells
   are crossed out that the filled ones are about as many as the undecided ones.

What this reads, on every checked sample whose grid is found: the lanes the state contradicts
(no arrangement of the clues fits its decided cells) are 0 of them, except for 2 in sample 15
and 1 in sample 21. Those are the person's mistakes, as far as I can tell from the pictures.
`scripts/cells-debug.ts [DIR | PICTURE...] [--quiet]` prints the state as text (`#`, `x`, `.`)
and that count. Without a `.cells` ground truth, a count of contradicted lanes is the check.

Not handled:

- Sample 22's gems (small diamonds in the middle of a few cells, nothing to do with the
  puzzle). They happen not to be taken for marks there, but nothing stops it. The plan was to
  name a mark by templates (X, dot) and ignore ones that match none; not done.
- Colored puzzles, where fills of different colors mean different things. (Fills of different
  colors in a black-and-white puzzle are all just "filled".)
- A cell's "crossed" and "undecided" backgrounds differing (sample 14's crossed cell is white on
  gray): it's the groups' colors that decide, so it works there, but only because the one white
  cell is too few to be a family.
- Checking the cell groups' meanings against the clues, trying other meanings for them when
  many lanes contradict. For now the bot only stops using the progress if over a quarter of the
  lanes contradict it, or the picture isn't straight (`reply.ts`).

`repair` (`repairLane`, `repair`; a port of `repair.rs`) works out clues that couldn't be read
(`NaN`, from marks named "x" where a digit should be) from the state: a fully decided lane's
clues are its blocks; otherwise finished blocks are matched with clues from each end, then the
middle ones in order; and a last blotted clue is whatever makes the totals agree (see its
header comment for the details, and its tests). Not ported: dimmed clues, and backup readings.
Struck-out digits in another color are read through the strike (`glyphs.ts`), so they don't
need this.

### Second thoughts (`explain.ts`)

Sample 12's app crosses out a clue with a flag on its upper left, in the digits' own color, so
`glyphs.ts` can't tell. A crossed-out digit looks different from the plain one, so it's a
group of its own, but its name is likely wrong (a struck "1" is named "4", a struck "2" or "3"
"8"). Two-digit ones, joined by their flag, are named "x", and so are `NaN` already. And some
groups are named wrong, but their second-nearest template is right: sample 19's tiny "6"s, and
sample 24's "8", are named "0".

`explainGroups` takes a group as crossed out (`NaN`, for `repair` to work out from the grid),
or renames it to its second-nearest template, where that makes the clues make more sense.
Greedily, one group at a time, it makes whichever change lowers the most: the lanes that don't
fit (or are still `NaN` after `repair`), plus the lanes the grid contradicts, plus 2 if the
totals don't agree, plus 0.5 per group taken as crossed out and 0.4 per group renamed. (That
last part is so a group isn't changed for no reason: against a finished grid, taking every group
as crossed out would agree perfectly. Renaming costs less, since a clue read is better than one
worked out. Without that, sample 24's "4"s were taken as crossed out instead of its "0"
renamed, which got the same clues, since its row with the "0" was fully decided.) On sample 12
that gives clues that are consistent, that the grid doesn't contradict, and that line logic
solves; the lanes I checked against the picture were right. It renames one group in each of
samples 12, 19 and 24. Of the other checked samples, it only changes sample 3 (a known
failure), where it takes its "9"s as crossed out. Since 258 of sample 12's clues are copied from the grid, any mistakes the person made in
those lanes are copied into them, unseen.

## Photos of paper (`src/ocr/paper/`)

Photos of printed puzzles look nothing like screenshots, so they get their own way of finding
the grid. Then the photo is straightened, so that it looks like a screenshot, and read by the
same readers, but with settings of their own (`Settings`, in `src/ocr/settings.ts`; the paper
ones are in `paper/settings.ts`), so that the screenshots' are left alone.

Which kind a picture is is decided by which works (`reply.ts`): the screenshot pipeline first,
unchanged, and this one only if that finds no grid, or reads clues that don't make sense. (Telling
them apart beforehand didn't work. Screenshots' flat areas (pixels the same as their neighbors)
overlap with photos', since WebP smooths photos and some apps have textured backgrounds. And
sample 14, a photo of a tablet's screen, is as crooked as some paper photos by `straightness`,
but the screenshot pipeline reads it fine.)

`findPaperGrid(raster)` (`mesh.ts`) works from the heavy lines every fifth line (and around the
border), which are darker than anything the person draws but a heavily scribbled fill:

1. `inkMap` (`ink.ts`): how dark each point is, against the paper nearby (the brightest point
   within about 50 px), which evens out shadows and vignetting. Darkness is the _brightest_
   channel's: print is black, so it's dark in every channel, while colored marker is bright in
   one, so red, pink or yellow fills fade, and the lines show through them. Pictures are first
   shrunk to at most 1600 px a side, so the settings in pixels mean the same everywhere.
2. `crossings` (`lines.ts`): the picture is cut into 24 strips across the lines. In each, the ink
   is summed along the slant that makes its lines sharpest, which can change from one end of the
   strip to the other (perspective makes lines converge). Each line is a narrow ridge in that
   profile: higher than the ink 4 px to _both_ sides, which leaves out fills. A crossing's
   heaviness is its height against the median of the 4 crossings each side.
3. `chains`: crossings linked from strip to strip, each to the nearest one where the slants say
   it should be (within 4 px a strip), skipping up to 2 strips where a fill hides the line.
4. Heavy lines: chains at least 1.5 times as heavy as their neighbors (the median, along the
   chain), merged where they lie along each other, and fitted with a cubic `y = f(x)`. They have
   to be unbroken: darker than 5 px either side over 80% of their length. Thin lines have to be
   over 70%. Rows of digits (sample 6's row clues line up into columns) and dashed lines (sample
   11's clue boxes) are about half.
5. `cellsBetween`: how many cells there are between two heavy lines, from the thin lines between
   them: the most cells, up to 10, for which 60% of the evenly spaced places where the lines
   between would be have one within 0.2 of a cell. Twice the right number puts half its lines
   where there are none. Rows of digits don't count as lines, so a clue box isn't a block.
6. `gridLines`: from each heavy line, out each way to the next heavy line 5 cells on (or 10, one
   missed), and at either end, to one less than 5 cells on, if it's well supported (a grid that
   isn't a multiple of 5). The start that gathers the most support (crossings on its lines) wins:
   a scribbled fill can make a thin line look heavy (1wvi8zy, below), and starting there goes
   nowhere. At least a block each way.
7. The mesh: where each chosen heavy line meets each other one. `point(u, v)` is a Coons patch in
   each block, so it follows the heavy lines along all four sides, and cuts each block evenly.
   Past the grid, it carries on along the outermost block's curves, to where the clues are. A
   heavy line, past where it was seen, is placed from the two nearest lines that were seen there
   (as many cells on from them as it is), not by its own cubic, which goes its own way: sample
   13's right border was only seen below its fills, and at the top of its clues was a cell off.

On the photos it finds 6's grid (45x35, as printed on it), 11's (30x30, likewise) and 13's
(45x35, counted), and 10x15 in one of the Rust bot's downloads
(`~/src/number-loom/bot/1wvi8zy`), and the mesh follows their lines to within a pixel or two.
On a synthetic grid turned 4°, foreshortened and bent (`mesh.test.ts`), every point of the mesh
is within 0.05 cells of the truth, where a straight grid between its corners is off by 0.75. It
takes about 0.6 s, mostly finding each strip's slant.

```
node --experimental-strip-types scripts/paper-debug.ts [DIR | PICTURE...] [--out DIR]
```

says what size grid it finds in each picture, and with `--out`, draws its lines (gray), its
heavy lines (orange), the ones chosen (red), and the cells (green, and dashed past the grid);
and the straightened picture, with the glyphs found in it boxed and named.

`straighten` (`rectify.ts`) resamples the photo through the mesh into a picture with 32 px cells,
reaching out past the grid to the left and top (up to 0.6 of the grid's size, or the photo's
edge) for the clues. Then:

- `flatten`: each channel is divided by the paper's color, a quadratic surface fitted to each
  cell's brightest, starting from the brighter half of them, and then leaving out cells well
  below the fit (fills, even where most of the grid is red marker). (Starting from all of them,
  a fill over a third of the picture pulled the fit down to it, and it came out white.) So the paper is white, as in a screenshot. Without this, the row clues weren't
  split into numbers, and the filled cells weren't told from the empty ones.
- `lineOffsets`: where each line is, beside each cell, within 0.2 of a cell of where it should
  be. Offsets far from those along the line around them are dropped (a digit's stroke), and a
  line seen along less than 30% of the picture isn't one (past the grid, there may be no lines,
  but there are digits). The gaps are filled in along each line. The mesh is moved by them, and
  the photo resampled, up to 3 times, until the lines are within a pixel. That puts right the
  clues' cells (sample 13's last columns were narrowed), and the clue area's own lines where
  the page curls toward the spine (sample 11).
- `unrule`: past the grid, lines along where the grid's lines would be, solid or dashed, are
  erased where they're narrow (paper 4 px either side), if they're there for 40% of the clue
  area: sample 11's clue boxes are graph paper with dashed lines, and the dashes were read as
  "1"s. Only runs as short as a dash (0.4 of a cell), or longer than a cell (a solid line): a
  digit's stroke that happens to be along a line is in between.

`readPaper` (`paper/read.ts`) then reads it with `readWithGrid`, with the paper settings. They
differ from the screenshots' in:

- `typicalFrom`: the typical glyph's height, which says what's too small to be a digit, is
  taken only from glyphs at least 0.4 of a cell tall. Pen strokes across sample 11's clues, and
  what's left of its dashes, break into pieces that outnumbered the digits, so the typical
  height was a piece's, none were dropped, and pieces side by side in the columns' clues were
  taken for two-digit numbers, which made every row one number.
- `struckUnread`: a digit found crossed out (by `glyphs.ts`, as for screenshots) isn't read,
  but worked out from the grid (`repair.ts`). A pencil stroke across a printed digit hides it,
  where an app's line in another color only crosses it, and the struck digits in sample 6 were
  named wrong as often as not (a "3" as a "7", a "6" as a "4").
- `renameGroups`: off. Taking a group as crossed out still is (`explain.ts`), but renaming one
  to its second-nearest template made too much make sense: in sample 6, every "2" became a "3",
  and every "5" a "6".
- `readCells`: `readPaperCells` (`paper/cells.ts`), not `readCells`. On paper, a cell is filled
  however the person likes (pencil shading, marker, a zigzag scribble), and crossed out with an
  X of any size, or a dot, so the cells aren't grouped by how they look, but by how much of
  each (leaving out 0.15 of it at each side, for the lines) is inked, in the darkest channel (so
  that colored marker counts): under 3% is undecided, and the rest is split by Otsu's method,
  less crossed out, more filled. Where they divide differs: 13's fat red X's cover up to 65%,
  and 1wvi8zy's pink scribbled fills as little as 45%; 1wvi8zy's tiny X's are 5 to 10%. If the
  two sides' averages are under 0.3 apart, they're all one or the other.

How the photos read (the `.clues` files of all of them are unchecked, so this is by eye):

- 13 (finished, in red marker): consistent, and solves by line logic with the grid's help (the
  groups taken as crossed out are worked out from its finished grid). The clues alone are close
  (the totals differ by 2).
- 1wvi8zy: every clue read right; its clues have two solutions. Its cells are read right but
  for two in its curled corner.
- 6: its rows 1 to 40 are read right, and its cells agree with all its rows' clues. But rows 41
  to 43's crossed-out clues can't be worked out (their rows aren't finished), and a few of its
  columns' crossed-out digits weren't found crossed out, and are misread.
- 11: inconsistent: nearly every clue is crossed out in pen, and most are misread.

It takes 2 to 5 s a photo, mostly straightening (each pass resamples the photo).

Not handled:

- Sample 4: its lines are pale gray, and the heavy ones are barely darker. (It's a color
  puzzle, too.)
- 1wv65fw (in the Rust bot's downloads): a puzzle printed with no lines, just alternately
  shaded cells.
- Screenshots. It does badly on them, which is fine: they're read the other way.

Things that didn't work, so as not to try them again:

- Telling heavy lines by a fixed strength: lighting and focus vary too much across a photo.
  Compared with the lines beside them, they're about twice as strong.
- One slope per strip. Where the lines converge, the ones far from the strip's slope smear out:
  13's right border, which leans the other way from its left one, was missed.
- Narrower strips (48), for the same reason: chains broke up more than they gained.
- Quadratic curves: sample 6's right side waves, and half its crossings were left out of the fit.
- Counting cells by the median gap between lines: scribbled fills add ridges between lines.
- Darker than either side by 0.08, for unbroken lines: thin lines under marker are only a little
  darker than it.
- Looking for lines within 0.3 of a cell of where they should be, when straightening: digits
  beside the lines were taken for them, and pulled 13's last column of clues out of shape.
- Putting the straightened picture right only from the grid's lines: past the grid, the clue
  area's own lines can be off, where the page curls.

## Solving (`src/solve/`)

There was no JavaScript nonogram solver that does both color puzzles and backtracking, so this is
a port of number-loom's (`~/src/number-loom/src/solve/`), cut down to square cells and plain
(color, count) clues. `TRANSLATION.md` there says which commit it's from, and what changed in
each file. Keep it up to date when porting more from number-loom.

`solve(puzzle, { timeLimitMs })` (`solve.ts`) is the Rust bot's `find_answer`. It runs line logic
and, if that doesn't finish the puzzle, the search, for up to 2 s by default. It says how the
answer was found (`line-logic`, `search`, `ambiguous` or `out-of-time`, or `no-solution`), and
gives each cell's color (-1 where it isn't known). It's synchronous, and checks the time between
guesses. A `Puzzle` (`puzzle.ts`) is colors `0..colors-1` (0 is the background), with a list of
clues per lane: the rows, then the columns. `blackAndWhite(rows, columns)` makes one from
numbers.

- `line.ts`: what one lane says by itself. "Skimming" packs the clues to each end and keeps
  what's covered both ways. "Scrubbing" (`exhaustLine`) finds every arrangement, in time linear
  in clues × slack.
- `grid.ts`: `SolveState` keeps picking the most promising lane, cheap skims first, then scrubs,
  until the grid is solved or stalls. It can record an undo trail, and be cloned or rewound,
  for the search.
- `search.ts`: guess, propagate, and on a contradiction, learn a nogood from the lanes that
  caused it and backjump (as in a CDCL SAT solver). After a first solution, rule it out and look
  for a second, to tell unique from ambiguous.
- `picker.ts`: which guess to make, alternating between the longest clues through a cell and
  the cells whose lanes most disagree about a color.

The ported Rust tests pin down hand-checked cases. Beyond them, `exhaustLine` is checked by
brute force on every short lane, and random colored pictures have to solve to answers that agree
with them.

```
node --experimental-strip-types scripts/solve-debug.ts [DIR | FILE...] [--time MS]
```

solves each sample's `.clues` (by default), or `.clues` files, olsak `.g` files (number-loom
converts webpbn's format to those: `number-loom IN.xml OUT.g -o olsak`), or number-loom's
one-pixel-per-cell pictures. It says how each was solved, how many lanes line logic skimmed and
scrubbed, and how long it took. Line logic is deterministic, so those lane counts should match
the `number-loom IN` report exactly. They do for all 31 of number-loom's square `puzzles/*.xml`
and all 34 `examples/png`. (Guess counts won't match: the picker's random tie-breaking isn't
Rust's.) Every one of those, and every checked sample, solves in under 10 ms. Sample 7's clues
have two solutions (a rectangle of four cells can be swapped), so it's `ambiguous`.

Not ported yet: number-loom's line cache, which is only worth it if scrubbing turns out to be
slow on real puzzles.

## Share links (`src/formats/`)

`shareUrl` makes a link that opens a picture (and, optionally, someone's progress) in
number-loom's web app, from a Woven share string: Brotli-compressed JSON, in base64.
`woven.ts` is a port of number-loom's `woven.rs`, and `TRANSLATION.md` there says from which
commit and what changed. It writes byte-for-byte what number-loom does, and the tests hold it to
that: `woven-fixtures/` is a copy of number-loom's frozen share strings. Share strings written
for all the checked samples (with progress) read back right in the Rust app.

It uses `node:zlib` for Brotli, which works on Devvit (confirmed in a playtest).

## The bot (`src/bot/`, `src/routes/triggers.ts`)

When a post is made (Devvit's `onPostCreate` trigger), `handlePost` (`post.ts`) finds its first
picture: in a gallery, the picture it links to, or the first one in its text (`picture.ts`, as
the Rust bot's `first_picture` does). A crosspost's is the original's. Only pictures on
`i.redd.it` and `preview.redd.it` are downloaded, since Devvit only lets an app fetch from the
domains in `devvit.json`. A post without one gets no reply. Neither does one that's been removed
(by a moderator, a filter, Reddit or its author: `unfit` goes by `removed`, `spam` and
`removedByCategory`), is locked, or is NSFW, as it is when the trigger arrives. For a crosspost,
that's the crosspost, not the original.

`replyTo` (`reply.ts`) finds the grid, reads the clues, and checks them (`src/ocr/read.ts`,
which `glyph-debug.ts` uses too). If that finds no grid, or clues that don't make sense, it tries again as a
photo of paper (see "Photos of paper"). If they make sense, it replies with guidance (`guidance.ts`, a
port of the Rust bot's `guidance.rs`, whose message wording is human-written: don't change it).
That includes a link that opens the puzzle in the web app. When the clues don't make sense, or
no grid is found, it doesn't reply at all. Either way, there's debugging information too: what was read, how long
it took, and what went wrong. It's kept for the post's author, or a moderator, to ask for with
"!whynot" or "!debug" (see below). The person's
progress in the grid is read (see above) and the guidance is for it, unless it contradicts the
clues in over a quarter of the lanes (then it's a misreading, and the guidance is for someone
who hasn't started). The debugging information shows it as text.

```
node --experimental-strip-types scripts/reply-debug.ts PICTURE_OR_URL... [--status]
```

prints the reply a picture (a file, or a post's picture's URL) would get, and its debugging
information.

Pictures are decoded in pure JavaScript (`src/ocr/decode.ts`), since `sharp` is native: PNG with
`pngjs`, and JPEG with a copy of `jpeg-js`' decoder (`src/ocr/vendor/`). r/nonograms' pictures
are PNG and JPEG. (Preview pictures are WebP only for a browser that asks for it.) `jpeg-js` as it
comes repeats a subsampled color component, where libjpeg (and so `sharp`) interpolates it. On
colored edges, that made pixels differ by up to 116, which was enough to make a real post
unreadable. So the copy interpolates, and converts colors, as libjpeg does. Now every pixel is
within 3 of `sharp`'s. On the 12 pictures of real posts the Rust bot downloaded
(`~/src/number-loom/bot/*/picture.*`), the replies are the same as from `sharp`'s decoding,
except for which of two failures a few unreadable photos get. The same 5 read as for the Rust
bot. A reply takes 0.1 to 0.6 s for a screenshot, and up to 2.5 s for a big photo.

People can give the bot commands in comments (Devvit's `onCommentCreate` trigger;
`handleComment` in `commands.ts`):

- "!delete", replying to one of the bot's comments, deletes it, if it's from the post's author
  (a crosspost's is whoever crossposted it, since that's where the bot replied) or one of the
  subreddit's moderators. Anyone else is ignored. Their
  "!delete" comment stays, since the bot can't delete other people's comments.
- "!whynot", as a top-level comment on a post, gets the debugging information from when the bot
  looked at the post. It's kept in Redis, under the post's ID, for a year. (Posts
  the bot skipped, for having no picture or an opted-out author, or for being removed, locked
  or NSFW, get a note saying so.)
  "!debug", replying to the bot's reply, gets the same. Both are only for the post's author
  and the subreddit's moderators, as for "!delete". And a post gets
  only one such answer, whichever command asks and whoever it's from: a counter in Redis, under
  the post's ID, says it's been given.
- "!optout", anywhere, stops the bot replying to the commenter's posts (kept in Redis, under
  their user ID), and "!optin" undoes that. The bot answers both, to say it's done it.

Not yet known, since it needs a playtest on Devvit:

- Whether the post `onPostCreate` hands over is far enough along for its pictures to be ready,
  and whether `Post.gallery`'s URLs are the ones expected.
- Whether the domains for `fetch` in `devvit.json` (`i.redd.it` and `preview.redd.it`) need
  Reddit's approval before the app is published. (They work in a playtest.)

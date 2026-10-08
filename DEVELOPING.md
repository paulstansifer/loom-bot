# Developing `number-loom-bot`

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
- Photos of paper (4, 6, 8, 11, 13), which are out of scope. They give wrong grids, and
  only some are flagged as not `pixelPerfect`. Reading the clues will need a way to reject them,
  such as clues that don't add up.

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
   only a little different: then, in sample 3's gradients, faint digits disappeared.
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
4. Outward from the grid, glyphs are kept until there's a gap of more than a cell.
5. Slivers and specks are dropped: anything narrower than 0.2 of the picture's median glyph
   height, or shorter than 0.6 of it. They're bits of lines and boxes, or of a digit's shadow.
   No typeface in the samples has a "1" narrower than 0.3 of its height, or a digit shorter
   than 0.87 of the median.
6. Missing glyphs are looked for where the layout says they should be. The clues are aligned
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
count, red otherwise) and the groups (`NAME-groups.png`). On the checked samples whose grid is
found:

- 433 of 440 lanes are read exactly right, and 435 have the right number of glyphs. Every
  sample but 3 is read entirely right.
- No group mixes two digits, at a threshold of 0.12. At 0.14, one glyph is in the wrong group,
  and at 0.2, 54 are. Below 0.12, digits split into more groups.
- 1354 of the 1356 glyphs in those lanes are in a group named right. The two that aren't are
  sample 3's shadowed digits. Elsewhere, the nearest template of another digit is at least
  0.026 further away.
- It takes 10–240 ms a picture.

The row and column totals of a checked `.clues` file should agree. Two didn't (3 and 15), and
in both, the picture showed the reading was right and the file was wrong.

A picture whose `.clues` file is unchecked is read without a score. Instead, it says whether
what it read is consistent: the rows' and columns' totals agree, every lane's clues fit in it,
and no more than a fifth of the lanes are empty. That says which files are worth checking by
hand. With `--out`, it writes what it read to `NAME.clues` there, to start from. Of the unchecked
samples, only 18 reads consistently. Where its reading differed from its file (written by
`ocr-clues`, whose totals don't agree), the picture agreed with the reading.

### Known failures

- Samples 12 and 19's clues (their grids are found right, but their `.clues` files are
  unchecked). Sample 12's pixel font isn't like any of the templates' (its "1" has a flag, like
  a "7"), and sample 19's digits are tiny, and its "6"s read as "0"s. Their row and column
  totals don't agree, which says so.
- Sample 3's middle panel, and the spotlit corner of its row clues: gray digits with dark drop
  shadows on gradients, nearly the background's brightness. Five lanes are missing digits, and
  two have a digit named wrong.

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

It uses `node:zlib` for Brotli. That works in Node, but whether Devvit allows it hasn't been
checked yet. If it doesn't, Brotli can store data uncompressed, which is easy to write, but makes
for longer links.

## The bot (`src/bot/`, `src/routes/triggers.ts`)

When a post is made (Devvit's `onPostCreate` trigger), `handlePost` (`post.ts`) finds its first
picture: in a gallery, the picture it links to, or the first one in its text (`picture.ts`, as
the Rust bot's `first_picture` does). A crosspost's is the original's. Only pictures on
`i.redd.it` and `preview.redd.it` are downloaded, since Devvit only lets an app fetch from the
domains in `devvit.json`. A post without one gets no reply.

`replyTo` (`reply.ts`) finds the grid, reads the clues, and checks them (`src/ocr/read.ts`,
which `glyph-debug.ts` uses too). If they make sense, it replies with guidance (`guidance.ts`, a
port of the Rust bot's `guidance.rs`, whose message wording is human-written: don't change it).
That includes a link that opens the puzzle in the web app. For now, while the bot is being
tested, every reply also has debugging information: what was read, and how long it took. And
when the clues don't make sense, or no grid is found, it replies with that instead. The person's
progress in the grid isn't read yet, so the guidance is for someone who hasn't started.

```
node --experimental-strip-types scripts/reply-debug.ts PICTURE_OR_URL... [--status]
```

prints the reply a picture (a file, or a post's picture's URL) would get.

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

Not yet known, since it needs a playtest on Devvit:

- Whether the post `onPostCreate` hands over is far enough along for its pictures to be ready,
  and whether `Post.gallery`'s URLs are the ones expected.
- Whether `fetch` from `i.redd.it` and `preview.redd.it` is allowed (the domains are in
  `devvit.json`, but may need Reddit's approval), and whether `node:zlib` is (see "Share links").

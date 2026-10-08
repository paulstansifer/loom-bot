# Translation notes

This directory is a TypeScript port of number-loom's solver (`~/src/number-loom/src/solve/`), as
of commit `47d7cb5cf249e849fc7782d0ce3c1742c159f3bb` (2026-10-06, "Default to rendering unknown
squares like normal people do it."). It was ported from that commit, not from the working copy.
The working copy had uncommitted, unfinished "Blot" (unknown-length clue) changes to
`line_solve.rs`.

To see what's changed upstream since:

```
git -C ~/src/number-loom diff 47d7cb5 -- src/solve src/puzzle.rs
```

## Throughout

- **Only (color, count) clues**: no `Clue` trait, `Triano` or `Blot` (or the `Behaved`
  wrapper). Two clues must be separated exactly when they're the same color.
- **Only square cells**: no `GridKind`, `Geometry` or triddlers. A `Puzzle` has its lanes' cell
  indices (`laneCells`) and each cell's lanes (`memberships`), precomputed. That's all the solver
  used `LaneMap` for. Lanes are the rows, then the columns, as in Rust. Cell `y * width + x` is
  at `(x, y)`.
- **Colors are `0..colors-1`**, with 0 the background, and at most 31 of them. There's no
  palette (`ColorInfo`: names, RGB, …). The caller keeps track of what each color looks like.
- **A `Cell` is a number**, the bitmask Rust wraps, and a grid of them is a `Uint32Array`. Its
  methods are free functions in `cell.ts`. `known_or` is `knownColor`, which gives -1 for
  unknown. `new(palette)`/`new_anything` are `anything(colors)`. `new_impossible` is `0`, and
  `actually_could_be` is `|= fromColor(c)`.
- **No `anyhow` errors.** A line solver returns `false` on a contradiction, rather than
  `Err` (the Rust comment wished for `Option`). Exceptions would be slow, and scrubbing and
  conflict analysis hit contradictions constantly. The error messages were never read anyway.
  A `ScrubReport` is the `affected: number[]` argument, which the solver pushes onto.

## `line_solve.rs` → `cell.ts`, `line.ts`

- Dropped: `SolveMode`'s names and colors (it moves to `grid.ts`), `ModeMap`,
  `learn_that_not`/`learn_cell_not` (only the old scrub used them), `settle_line` (GUI),
  `scrub_line` (the old scrub, unused), `skim_heuristic`/`scrub_heuristic` (`scoreLane` does
  both), `filter_report_by_color` (`only_solve_color`) and `count_cells`.
- `skim_to_find_fixed_clues` is `fixedClues`. `bg_squares` is folded into `exhaustLine`.
  `ClueSummary::new` is `summarize`. `score_counts` doesn't return `all_known` (no caller used
  it).
- `exhaustLine` keeps its tables (`reachable`, `clue_fits`, `both_reachable`, `superposition`)
  in module-level typed arrays, grown as needed, rather than allocating them per call.
- `packedExtents`' `clue_color_at` is gone, since a clue is one color all the way along. So is
  the per-cell wiggle-room union in `skimLine`, which is just the clue's color.
- Tests: the emoji notation is kept. The Triano, Blot, settle, old-scrub and `filter_report`
  tests are dropped. New: `verify`, and a brute-force check of `exhaustLine` on every lane of up
  to 6 cells in 3 colors.

## `grid_solve.rs` → `grid.ts`

- `SolveContext` is gone. `SolveState` holds the puzzle, `maxEffort` and its scratch buffers
  itself (clones share the buffers, as forks shared the context), so no method takes a `ctx`.
  `SolveState::new` is `SolveState.start`. `LaneState` is spread over per-lane typed arrays
  (`unknownCells`, and `queued`, indexed `lane * 3 + mode`). `ModeMap` is a 3-element array
  indexed by `Mode`.
- `run`/`run_recording` are one `run(trail?)`, and `step`/`step_recording` are one
  `step(trail?)`. They return `'solved' | 'stalled' | { contradiction: lane }` rather than a
  `Result`, which replaces the `Unsolvable` trait and `Contradiction`. `learn`/`learn_within`
  return `'new' | 'same' | 'contradiction'`. `learn`'s `is` parameter comes last and defaults
  to `true`. `learn_new` is gone. `unwind(trail, from)` takes a start index, rather than a
  slice.
- `VecDeque` is a small array-with-a-head `Queue`.
- `debug_assert_unknown_cells_agree` is `unknownCellsDrift()`, which the tests call, since there
  are no debug builds.
- `TrailStep { cell_idx, old_value, … }` is `{ cell, old, … }`, and `TrailReason` is a tagged
  union.
- `gather_into` is `gather` (with an optional buffer), and `fixed_clues` is `allFixedClues`.
  `line_logic_solve` is `lineLogicSolve`, which returns the outcome and the state, rather than a
  `Report`.
- Dropped: `SolveOptions`' tracing, progress, `only_solve_color` and `stop_at_first_solution`,
  as well as `display_step`, `family_letter`/`text_coord`, `LineCache`/`op_or_cache` (see
  below), `settle_solution`, `analyze_lines`, `disambig_candidates`, `Report`/`dyn_solution`,
  and the separate `solve`.
- Tests: the unwind tests, the crossing-contradiction test and `max_effort` are ported. New: a
  clone test, and a soundness test over random colored pictures (in place of the triangular
  ones).

## Not (yet) ported

- **The line cache** (`LineCache`, keyed on clues plus lane contents). In JS, the key would be a
  string built on every call. It's only worth adding if scrubbing turns out to be the
  bottleneck.

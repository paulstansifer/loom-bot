# Translation notes

This directory is a TypeScript port of number-loom's Woven format (`src/formats/woven.rs` and
`src/formats/partial_cells.rs` in `~/src/number-loom`), as of commit
`47d7cb5cf249e849fc7782d0ce3c1742c159f3bb` (2026-10-06), the same commit as `../solve/`. To see
what's changed upstream since:

```
git -C ~/src/number-loom diff 47d7cb5 -- src/formats/woven.rs src/formats/partial_cells.rs examples/woven
```

`woven-fixtures/` is a copy of number-loom's `examples/woven` (its frozen share strings) at that
commit. Copy any new `.woven` files in when number-loom adds them. Never edit them, which is
why Prettier ignores them.

## Throughout

- **No `Document`.** `WovenDocument` is what Woven stores: optional metadata, a `Picture`, and
  optional progress. `to_woven`/`from_woven` are `toWoven`/`fromWoven`, and
  `WovenVersion0` ↔ JSON is `serialize`/`deserialize`. A picture is decoded as data, not turned
  into a `Solution` (or puzzle), so nothing is solved on the way. `from_woven`'s filename
  argument is gone.
- **The JSON is built by hand, in serde's key order**, rather than by serde. serde's compact
  JSON is exactly `JSON.stringify` of an object with keys in field order, and serde's pretty
  JSON is `JSON.stringify(_, null, 2)`, which is how the fixture `.json`s are compared.
  `deserialize` checks types by hand, and like serde it ignores unknown fields.
- **Brotli is `node:zlib`'s**, at the same settings (quality 11, window 22). It writes the same
  bytes as the Rust `brotli` crate for every fixture. That's an observation, not a promise,
  but the fixture test would catch a change.
- **Shapes and clue styles pass through.** Only square pictures matter to the bot, but
  `{"Triangular": …}` shapes, `Triano` clues and `corner`s are kept as they are, so that all of
  number-loom's fixtures can be tested. Nothing here needs a triddler's geometry.
- **A palette is an array** of `ColorInfo` (one entry per color), not a `HashMap`. It's written
  sorted, as Rust does. `ColorInfo`'s `Ord` is `compareColorInfo`, comparing `ch` and `name` by
  code point, as Rust compares `char`s and `String`s. Decoding keeps the last entry for a color,
  as collecting into a `HashMap` does.
- **Errors are thrown `Error`s.** The `panic!` for a cell `ch` that's not in the palette is a
  thrown error too.

## `woven.rs` → `woven.ts`

- `SerializableSolution::from_solution`/`new` is `serializeSolution`, and
  `make_chs_unique`, `spell_cells` and `ch_to_color` are `makeChsUnique`, `spellPicture` and
  `chToColor`. `spell_in_progress` and `cell_colors` (reading `c` or `cells`) are folded in.
- `fromWoven` trims whitespace before looking for the `WOVEN-` and the final `-`, so a share
  string with a trailing newline (as when its length is a multiple of 100) still reads.
- Added: `bwPalette` (`import.rs`' `bw_palette`), `squarePicture` (`grid_to_solution`'s
  handling of unknown cells, which become `UNSOLVED`), `APP_URL` and `shareUrl` (the Rust bot's
  `share_url`, in `guidance.rs`).
- Tests: `golden_tests`' two claims (`share_strings_stay_compatible`), against the copied
  fixtures. The update and generation modes aren't ported: new fixtures come from number-loom.
  `encoding_does_not_depend_on_hash_order` is unnecessary, since there's no hash map. The
  `cell_spelling_tests` and the round-trip and progress tests are ported, minus the triddler
  ones (and those that need clues, which this doesn't derive).

## `partial_cells.rs` → `partialCells.ts`

- Cells are bitmasks (numbers), as in `../solve/cell.ts`. A Rust `Cell::new_anything()` has
  every bit set, which a positive JS int can't, so `parseCells` reads `?` as every color in the
  palette instead. That's the same thing to everything that reads it.
- `UNSOLVED` (255) lives here, since it's the one color a cell can't hold.
- Tests: all ported.

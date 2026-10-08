import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { anything, fromColor } from '../solve/cell.ts';
import { parseCells, RESERVED_CHS, spellCells } from './partialCells.ts';
import {
  APP_URL,
  bwPalette,
  type ColorInfo,
  compareColorInfo,
  deserialize,
  fromWoven,
  type Picture,
  serialize,
  shareUrl,
  squarePicture,
  toWoven,
  UNSOLVED,
  type WovenDocument,
} from './woven.ts';

// Frozen share strings (copied from number-loom's `examples/woven`): one `NAME.N.woven` per
// encoding some build of number-loom has written for a document, oldest first, and `NAME.json`,
// the same document as readable JSON. Two claims tie them together, as in number-loom:
//
// 1. every `.woven` in a group, and the `.json`, mean the same document;
// 2. what this writes is byte-for-byte one of the `.woven` files.
const FIXTURES = join(import.meta.dirname, 'woven-fixtures');

function fixtures(): { name: string; json: string; wovens: string[] }[] {
  const groups = new Map<string, [number, string][]>();
  for (const file of readdirSync(FIXTURES)) {
    const match = /^(.+)\.(\d+)\.woven$/.exec(file);
    if (!match) continue;
    const list = groups.get(match[1]!) ?? [];
    list.push([Number(match[2]), join(FIXTURES, file)]);
    groups.set(match[1]!, list);
  }
  return [...groups].map(([name, wovens]) => ({
    name,
    json: join(FIXTURES, `${name}.json`),
    wovens: wovens.sort((a, b) => a[0] - b[0]).map(([, path]) => path),
  }));
}

/** What this makes of a stored document: loaded, and written back out as readable JSON. */
function canonical(path: string): string {
  return (
    JSON.stringify(serialize(fromWoven(readFileSync(path, 'utf8'))), null, 2) +
    '\n'
  );
}

void test('share strings stay compatible', () => {
  const groups = fixtures();
  assert.ok(groups.length >= 5);
  for (const { name, json, wovens } of groups) {
    const expected = canonical(wovens[0]!);
    // Claim 1. (serde's pretty JSON is laid out as `JSON.stringify(_, null, 2)`'s is.)
    for (const path of wovens.slice(1))
      assert.equal(canonical(path), expected, path);
    assert.equal(readFileSync(json, 'utf8'), expected, json);
    // Claim 2.
    const current = toWoven(fromWoven(readFileSync(wovens[0]!, 'utf8')));
    assert.ok(
      wovens.some(
        (path) => readFileSync(path, 'utf8').trimEnd() === current.trimEnd()
      ),
      `${name} now encodes to something number-loom never wrote:\n${current}`
    );
  }
});

function color(ch: string, name: string, c: number): ColorInfo {
  return { ch, name, rgb: [c, c, c], color: c };
}

function picture(palette: ColorInfo[], cells: number[]): Picture {
  return {
    clueStyle: 'Nono',
    palette,
    shape: { Square: { width: cells.length, height: 1 } },
    cells,
  };
}

/** The solution part of what's written. */
function written(doc: WovenDocument): {
  palette: ColorInfo[];
  c?: string;
  cells?: number[];
} {
  return (serialize(doc) as { V0: { solution: never } }).V0.solution;
}

void test('a well-formed palette spells its cells', () => {
  const doc = {
    solution: picture(
      [color(' ', 'white', 0), color('#', 'black', 1)],
      [0, 1, 1]
    ),
  };
  assert.equal(written(doc).c, ' ##');
  assert.equal(written(doc).cells, undefined, 'the numeric form is redundant');
  assert.deepEqual(deserialize(serialize(doc)).solution.cells, [0, 1, 1]);
});

void test('a repeated ch is reassigned before writing', () => {
  // Left alone, `#` would read back as whichever came first.
  const doc = {
    solution: picture(
      [
        color(' ', 'white', 0),
        color('#', 'black', 1),
        color('#', 'charcoal', 2),
      ],
      [0, 1, 2]
    ),
  };
  const chs = written(doc).palette.map((ci) => ci.ch);
  assert.equal(new Set(chs).size, chs.length, `${chs}`);
  assert.equal(written(doc).cells, undefined);
  assert.deepEqual(deserialize(serialize(doc)).solution.cells, [0, 1, 2]);
});

void test('reassigning a ch disturbs nothing else', () => {
  const doc = {
    solution: picture(
      [
        color(' ', 'white', 0),
        color('!', 'black', 1),
        color('!', 'charcoal', 2),
        color('"', 'slate', 3),
      ],
      [0, 1, 2, 3]
    ),
  };
  const chOf = (name: string) =>
    written(doc).palette.find((ci) => ci.name === name)!.ch;
  assert.equal(chOf('white'), ' ');
  assert.equal(chOf('black'), '!', 'the first claim on a ch keeps it');
  assert.equal(chOf('slate'), '"', 'an entry further along keeps its ch too');
  assert.equal(
    chOf('charcoal'),
    '#',
    'the duplicate takes the first free character'
  );
  assert.deepEqual(deserialize(serialize(doc)).solution.cells, [0, 1, 2, 3]);
});

void test('repairing a palette is idempotent', () => {
  const doc = {
    solution: picture(
      [color('#', 'black', 1), color('#', 'shadow', 2)],
      [1, 2]
    ),
  };
  const once = serialize(doc);
  assert.deepEqual(serialize(deserialize(once)), once);
});

void test('a cell missing from the palette falls back to numbers', () => {
  const doc = { solution: picture([color(' ', 'white', 0)], [0, 7]) };
  assert.equal(written(doc).c, undefined);
  assert.deepEqual(written(doc).cells, [0, 7]);
  assert.deepEqual(deserialize(serialize(doc)).solution.cells, [0, 7]);
});

void test('the numeric form still reads', () => {
  const palette = [
    { ch: ' ', name: 'white', rgb: [255, 255, 255], color: 0, corner: null },
    { ch: '#', name: 'black', rgb: [0, 0, 0], color: 1, corner: null },
  ];
  const shape = { Square: { width: 3, height: 1 } };
  const before = {
    V0: { solution: { clue_style: 'Nono', palette, shape, cells: [0, 1, 1] } },
  };
  const withC = {
    V0: { solution: { clue_style: 'Nono', palette, shape, c: ' ##' } },
  };
  assert.deepEqual(deserialize(before).solution.cells, [0, 1, 1]);
  assert.deepEqual(deserialize(withC).solution.cells, [0, 1, 1]);
});

void test('a share string round trip', () => {
  const doc: WovenDocument = {
    title: 'Test Title',
    description: 'Test Description',
    author: 'Test Author',
    id: 'Test ID',
    license: 'Test License',
    solution: squarePicture(1, 1, [1], bwPalette()),
  };
  // (A palette's order doesn't mean anything: it's written sorted.)
  const back = fromWoven(toWoven(doc));
  back.solution.palette.sort(compareColorInfo);
  doc.solution.palette.sort(compareColorInfo);
  assert.deepEqual(back, doc);
});

void test('progress round trip', () => {
  // Black is drawn as `?` here, which progress needs for itself, so it has to be renamed.
  const palette = bwPalette();
  palette[1]!.ch = '?';
  palette.push({ ch: 'r', name: 'red', rgb: [255, 0, 0], color: 2 });
  const [b, x, r] = [0, 1, 2];
  const inProgress = [
    fromColor(x),
    anything(3),
    fromColor(b) | fromColor(x),
    fromColor(r),
  ];
  const doc: WovenDocument = {
    solution: squarePicture(2, 2, [x, r, b, x], palette),
    inProgress,
  };
  // Black, `?`, either white or black, and red.
  assert.equal(
    (serialize(doc) as { V0: { in_progress: string } }).V0.in_progress,
    '!?[ !]r'
  );
  const back = fromWoven(toWoven(doc));
  assert.deepEqual(back.inProgress, inProgress);
  assert.deepEqual(back.solution.cells, [x, r, b, x]);
  const blackCh = back.solution.palette.find((ci) => ci.color === x)!.ch;
  assert.ok(!RESERVED_CHS.includes(blackCh));
});

void test('progress that knows nothing is not written, and costs no color its ch', () => {
  const palette = bwPalette();
  palette[1]!.ch = '?';
  const doc: WovenDocument = {
    solution: squarePicture(2, 1, [1, 0], palette),
    inProgress: [anything(2), anything(2)],
  };
  const v0 = (serialize(doc) as { V0: Record<string, unknown> }).V0;
  assert.equal(v0.in_progress, undefined);
  assert.ok(written(doc).palette.some((ci) => ci.ch === '?'));
  assert.equal(fromWoven(toWoven(doc)).inProgress, undefined);
});

void test('unknown cells become UNSOLVED', () => {
  const p = squarePicture(2, 1, [1, -1], bwPalette());
  assert.deepEqual(p.cells, [1, UNSOLVED]);
  assert.deepEqual(fromWoven(toWoven({ solution: p })).solution.cells, [
    1,
    UNSOLVED,
  ]);
});

void test('a share URL', () => {
  const url = shareUrl({
    solution: squarePicture(30, 30, Array(900).fill(1), bwPalette()),
  });
  assert.ok(url.startsWith(`${APP_URL}#WOVEN-`));
  assert.ok(!/\s/.test(url));
});

void test('partial cells round trip', () => {
  const chOf = new Map([
    [0, '.'],
    [1, 'X'],
    [2, 'r'],
  ]);
  const chToColor = new Map([...chOf].map(([c, ch]) => [ch, c]));
  const cells = [fromColor(1), anything(3), fromColor(0) | fromColor(2), 0];
  const text = spellCells(cells, chOf)!;
  assert.equal(text, 'X?[.r][]');
  assert.deepEqual(parseCells(text, chToColor), cells);
  // Every palette color, but not spelled `?`, still means the same thing.
  assert.equal(spellCells(parseCells('[.Xr]', chToColor), chOf), '?');
});

void test('malformed partial cells are rejected', () => {
  const chToColor = new Map([['.', 0]]);
  for (const text of ['[.', 'Q', '[Q]'])
    assert.throws(() => parseCells(text, chToColor), text);
});

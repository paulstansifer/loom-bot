/**
 * Finds the clues' glyphs in each sample picture (whose grid is found right), groups them by how
 * they look, and checks that against the clues: a lane with as many glyphs as its clues have
 * digits gives each glyph its digit, and then a group should have only one digit in it.
 *
 * That's the glyphs by themselves. The bot reads the clues with the grid's help too (`explain.ts`:
 * crossed-out clues worked out from the grid, misnamed groups renamed), at the usual threshold:
 * "with grid" is how many lanes that gets right, followed by how its clues solve (or that they're
 * inconsistent, so there's no point trying).
 *
 * A picture whose clues haven't been checked (or that has none) is read without a score: it says
 * whether the clues read are consistent (the rows' and columns' totals agree, and each lane's
 * clues fit in it), which says whether the reading is worth checking by hand, and how the clues
 * read with the grid's help solve.
 *
 * With `--out DIR`, draws, for each picture, the glyphs found (`NAME-glyphs.png`: green in a lane
 * with the right number of them, red otherwise), and each group in a row (`NAME-groups.png`,
 * labeled with the digits its glyphs should be). For a picture without checked clues, it also
 * writes what it read, as `NAME.clues`, to start checking from.
 *
 *   node --experimental-strip-types scripts/glyph-debug.ts [DIR | PICTURE...] [--out DIR]
 *     [--threshold T] [--verbose]
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';

import { drawBoxes } from '../src/bot/view.ts';
import {
  cluster,
  distance,
  look,
  type Look,
  meanLook,
} from '../src/ocr/cluster.ts';
import { findGlyphs, type Glyph } from '../src/ocr/glyphs.ts';
import { findPuzzle } from '../src/ocr/bounds.ts';
import { readWithGrid } from '../src/ocr/explain.ts';
import type { Grid } from '../src/ocr/grid.ts';
import { name } from '../src/ocr/names.ts';
import { numbers } from '../src/ocr/numbers.ts';
import {
  cluesText,
  consistency,
  readClues,
  type Reading,
} from '../src/ocr/read.ts';
import type { Raster } from '../src/ocr/raster.ts';
import { blackAndWhite } from '../src/solve/puzzle.ts';
import { solve } from '../src/solve/solve.ts';
import {
  decode,
  sample,
  samples,
  SAMPLES_DIR,
  type Sample,
} from '../src/ocr/samples.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const out = option('--out');
const threshold = Number(option('--threshold') ?? 0.12);
const verbose = args.includes('--verbose');
const inputs = args.filter((a) => !a.startsWith('--'));

const list: Sample[] = (inputs.length > 0 ? inputs : [SAMPLES_DIR]).flatMap(
  (input) => (statSync(input).isDirectory() ? samples(input) : [sample(input)])
);
if (out) mkdirSync(out, { recursive: true });

const totals = {
  lanes: 0,
  lanesOk: 0,
  glyphs: 0,
  wrong: 0,
  named: 0,
  read: 0,
  gridRead: 0,
  solved: 0,
  pictures: 0,
};
for (const s of list) {
  const clues = s.clues;
  const raster = await decode(s.path);
  const result = findPuzzle(raster);
  if (!clues?.checked) {
    if (!result.ok) console.log(`${s.name.padEnd(4)} unchecked  no grid`);
    else await unscored(s, raster, result.grid);
    continue;
  }
  if (
    !result.ok ||
    result.grid.rows !== clues.rows ||
    result.grid.cols !== clues.cols
  ) {
    console.log(`${s.name.padEnd(4)} grid not found right; skipped`);
    continue;
  }
  const start = performance.now();
  const lanes = findGlyphs(raster, result.grid);
  const ms = performance.now() - start;

  // Each glyph, with the digit it should be (if its lane has the right number of glyphs).
  const glyphs: { glyph: Glyph; digit: string | undefined; lane: string }[] =
    [];
  let lanesOk = 0;
  const addLanes = (kind: string, found: Glyph[][], expected: number[][]) => {
    found.forEach((lane, i) => {
      const digits = expected[i]!.join('');
      const ok = lane.length === digits.length;
      if (ok) lanesOk++;
      lane.forEach((glyph, k) =>
        glyphs.push({
          glyph,
          digit: ok ? digits[k] : undefined,
          lane: `${kind} ${i}`,
        })
      );
    });
  };
  addLanes('column', lanes.columns, clues.columnClues);
  addLanes('row', lanes.rows, clues.rowClues);
  const laneCount = clues.rows + clues.cols;

  const looks = glyphs.map((g) => look(g.glyph));
  // How far each labeled glyph is from its nearest of the same digit, and of another.
  let worstSame = 0;
  let worstOther = Infinity;
  glyphs.forEach((g, i) => {
    if (g.digit === undefined) return;
    let same = Infinity;
    let other = Infinity;
    glyphs.forEach((o, j) => {
      if (i === j || o.digit === undefined) return;
      const d = distance(looks[i]!, looks[j]!);
      if (o.digit === g.digit) same = Math.min(same, d);
      else other = Math.min(other, d);
    });
    if (same < Infinity) worstSame = Math.max(worstSame, same);
    worstOther = Math.min(worstOther, other);
  });

  const { groups, members, names } = nameGroups(looks);
  const groupCount = members.length;
  // A glyph is wrong if its group's commonest digit isn't its own.
  let wrong = 0;
  let labeled = 0;
  const groupDigits = members.map((m) => {
    const counts = new Map<string, number>();
    for (const i of m) {
      const d = glyphs[i]!.digit;
      if (d !== undefined) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const sorted = [...counts].sort((p, q) => q[1] - p[1]);
    for (const [, n] of sorted.slice(1)) wrong += n;
    labeled += sorted.reduce((sum, [, n]) => sum + n, 0);
    return sorted;
  });
  const singletons = members.filter((m) => m.length === 1).length;
  // How many glyphs the groups' names name right.
  let named = 0;
  let worstMargin = Infinity;
  names.forEach((n, k) => {
    if (groupDigits[k]!.length > 0)
      worstMargin = Math.min(worstMargin, n.margin);
  });
  members.forEach((m) => {
    for (const i of m) {
      if (glyphs[i]!.digit === names[groups[i]!]!.name) named++;
    }
  });

  // Each lane read whole: its glyphs grouped into numbers, each digit as its group is named. (No
  // clues reads the same as a single 0.)
  const index = new Map(glyphs.map((g, i) => [g.glyph, i]));
  const digitOf = (g: Glyph) => names[groups[index.get(g)!]!]!.name;
  const laneNumbers = numbers(lanes);
  let read = 0;
  const misread: string[] = [];
  const readLanes = (
    kind: string,
    found: Glyph[][][],
    expected: number[][]
  ) => {
    found.forEach((lane, i) => {
      const text = cluesText(lane.map((n) => Number(n.map(digitOf).join(''))));
      if (text === cluesText(expected[i]!)) read++;
      else
        misread.push(
          `${kind} ${i}: expected ${cluesText(expected[i]!)}, read ${text}`
        );
    });
  };
  readLanes('column', laneNumbers.columns, clues.columnClues);
  readLanes('row', laneNumbers.rows, clues.rowClues);

  // The same, with the grid's help, as the bot reads it.
  const helped = withGrid(raster, result.grid);
  let gridRead = 0;
  const gridMisread: string[] = [];
  const compare = (kind: string, found: number[][], expected: number[][]) => {
    found.forEach((lane, i) => {
      const [text, want] = [cluesText(lane), cluesText(expected[i]!)];
      if (text === want) gridRead++;
      else gridMisread.push(`${kind} ${i}: expected ${want}, read ${text}`);
    });
  };
  compare('column', helped.reading.columns, clues.columnClues);
  compare('row', helped.reading.rows, clues.rowClues);

  totals.read += read;
  totals.gridRead += gridRead;
  totals.pictures++;
  if (helped.solved === 'line-logic' || helped.solved === 'search')
    totals.solved++;
  totals.lanes += laneCount;
  totals.lanesOk += lanesOk;
  totals.glyphs += labeled;
  totals.wrong += wrong;
  totals.named += named;
  console.log(
    [
      s.name.padEnd(4),
      `read ${read}/${laneCount}`.padEnd(12),
      `with grid ${gridRead}/${laneCount} ${helped.solved}`.padEnd(29),
      `lanes ${lanesOk}/${laneCount}`.padEnd(13),
      `glyphs ${glyphs.length}`.padEnd(11),
      `groups ${groupCount}`.padEnd(10),
      `singletons ${singletons}`.padEnd(14),
      `mixed-up ${wrong}/${labeled}`.padEnd(16),
      `named right ${named}/${labeled}`.padEnd(20),
      `margin>=${worstMargin.toFixed(3)}`.padEnd(15),
      `same<=${worstSame.toFixed(3)} other>=${worstOther.toFixed(3)}`.padEnd(
        28
      ),
      `${ms.toFixed(0)}ms`,
    ].join(' ')
  );
  if (verbose) {
    for (const m of misread) console.log(`     ${m}`);
    for (const m of gridMisread) console.log(`     with grid: ${m}`);
    groupDigits.forEach((digits, k) => {
      const label = digits.map(([d, n]) => `${d}x${n}`).join(' ') || '?';
      const { name: guess, d } = names[k]!;
      const misnamed = digits.length > 0 && digits[0]![0] !== guess;
      if (digits.length > 1 || misnamed)
        console.log(
          `     group ${k} (${members[k]!.length}): ${label}; looks like ` +
            `${guess} (${d.toFixed(3)})`
        );
    });
  }
  if (out) {
    await drawGlyphs(raster, glyphs, join(out, `${s.name}-glyphs.png`));
    await drawGroups(
      raster,
      members.map((m) => m.map((i) => glyphs[i]!.glyph)),
      groupDigits.map(
        (d, k) =>
          `${d.map(([digit, n]) => `${digit}x${n}`).join(' ')} ~${names[k]!.name}`
      ),
      join(out, `${s.name}-groups.png`)
    );
  }
}
console.log(
  `lanes read right: ${totals.read}/${totals.lanes} ` +
    `(with grid: ${totals.gridRead}/${totals.lanes}); ` +
    `with the right number of glyphs: ${totals.lanesOk}/${totals.lanes}; ` +
    `glyphs in a group of another digit: ${totals.wrong}/${totals.glyphs}; ` +
    `named right: ${totals.named}/${totals.glyphs}; ` +
    `uniquely solvable with grid: ${totals.solved}/${totals.pictures} pictures`
);

/** The clues read with the grid's help, as the bot reads them, and how they solve (or
 * "inconsistent", if their totals don't agree, or some don't fit). */
function withGrid(
  raster: Raster,
  grid: Grid
): { reading: Reading; solved: string } {
  const { reading } = readWithGrid(raster, grid);
  const solved = consistency(reading).consistent
    ? solve(blackAndWhite(reading.rows, reading.columns)).kind
    : 'inconsistent';
  return { reading, solved };
}

/** `looks` grouped, each group's members, and each group named by the nearest template to its
 * average look. */
function nameGroups(looks: Look[]) {
  const groups = cluster(looks, threshold);
  const members: number[][] = Array.from(
    { length: Math.max(-1, ...groups) + 1 },
    () => []
  );
  groups.forEach((k, i) => members[k]!.push(i));
  const names = members.map((m) => name(meanLook(m.map((i) => looks[i]!))));
  return { groups, members, names };
}

/**
 * Reads the clues of a picture whose clues haven't been checked, and says whether they're
 * consistent: whether the rows' and columns' totals agree, and how many lanes' clues don't fit
 * in them, or are empty (which is allowed, but not for most of them), and how sure the naming
 * was.
 */
async function unscored(s: Sample, raster: Raster, grid: Grid) {
  const reading = readClues(raster, grid, threshold);
  const { glyphs, groups, members, names, columns, rows } = reading;
  const digitOf = (i: number) => names[groups[i]!]!.name;
  const {
    columnTotal: colTotal,
    rowTotal,
    misfits: bad,
    empty,
    margin,
    consistent,
  } = consistency(reading);
  const file = s.clues
    ? s.clues.rows === grid.rows && s.clues.cols === grid.cols
      ? ''
      : ` (its file says ${s.clues.rows}x${s.clues.cols})`
    : ' (no file)';
  const helped = withGrid(raster, grid);
  console.log(
    [
      s.name.padEnd(4),
      'unchecked ',
      `grid ${grid.rows}x${grid.cols}`.padEnd(11),
      `totals ${colTotal}/${rowTotal}`.padEnd(17),
      `misfits ${bad}`.padEnd(11),
      `empty ${empty}`.padEnd(9),
      `groups ${members.length}`.padEnd(10),
      `margin>=${margin.toFixed(3)}`.padEnd(15),
      (consistent ? 'consistent: worth checking' : 'inconsistent') +
        `; with grid ${helped.solved}` +
        (grid.pixelPerfect ? '' : ', not straight (a photo?)') +
        file,
    ].join(' ')
  );
  if (verbose) {
    console.log('     columns');
    for (const l of columns) console.log(`     ${cluesText(l)}`);
    console.log('     rows');
    for (const l of rows) console.log(`     ${cluesText(l)}`);
  }
  if (out) {
    writeFileSync(
      join(out, `${s.name}.clues`),
      `# UNCHECKED: read by glyph-debug.ts from ${basename(s.path)}; ` +
        `columns total ${colTotal}, rows ${rowTotal}.\n` +
        `columns\n${columns.map(cluesText).join('\n')}\n` +
        `rows\n${rows.map(cluesText).join('\n')}\n`
    );
    await drawGlyphs(
      raster,
      glyphs.map((glyph, i) => ({ glyph, digit: digitOf(i) })),
      join(out, `${s.name}-glyphs.png`)
    );
    await drawGroups(
      raster,
      members.map((m) => m.map((i) => glyphs[i]!)),
      names.map((n) => `~${n.name}`),
      join(out, `${s.name}-groups.png`)
    );
  }
}

async function drawGlyphs(
  raster: Raster,
  glyphs: { glyph: Glyph; digit: string | undefined }[],
  path: string
) {
  const { width, height, data } = drawBoxes(
    raster,
    glyphs.map(({ glyph, digit }) => ({
      glyph,
      rgb: digit === undefined ? [255, 0, 0] : [0, 200, 0],
    }))
  );
  await sharp(Buffer.from(data), { raw: { width, height, channels: 3 } })
    .png()
    .toFile(path);
}

/** Each group in a row: its label, then its glyphs as they are in the picture (up to 40). */
async function drawGroups(
  raster: Raster,
  groups: Glyph[][],
  labels: string[],
  path: string
) {
  const cell = 32;
  const labelWidth = 160;
  const perRow = 40;
  const width = labelWidth + perRow * cell;
  const height = Math.max(1, groups.length) * cell;
  const data = new Uint8Array(width * height * 3).fill(255);
  groups.forEach((group, row) => {
    group.slice(0, perRow).forEach((g, k) => {
      const w = g.x1 - g.x0;
      const h = g.y1 - g.y0;
      const scale = Math.min(1, (cell - 4) / Math.max(w, h));
      for (let ty = 0; ty < cell - 2; ty++) {
        for (let tx = 0; tx < cell - 2; tx++) {
          const sx = g.x0 + Math.floor(tx / scale) - 1;
          const sy = g.y0 + Math.floor(ty / scale) - 1;
          if (sx > g.x1 || sy > g.y1) continue;
          if (sx < 0 || sy < 0 || sx >= raster.width || sy >= raster.height)
            continue;
          const from = (sy * raster.width + sx) * 3;
          const to =
            ((row * cell + ty + 1) * width + labelWidth + k * cell + tx + 1) *
            3;
          data.set(raster.data.subarray(from, from + 3), to);
        }
      }
    });
  });
  const text = labels
    .map(
      (l, row) =>
        `<text x="4" y="${row * cell + 21}" font-family="monospace" font-size="14">` +
        `${row}: ${l || '?'}</text>`
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${text}</svg>`;
  await sharp(Buffer.from(data), { raw: { width, height, channels: 3 } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(path);
}

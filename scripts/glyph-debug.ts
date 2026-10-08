/**
 * Finds the clues' glyphs in each sample picture (whose grid is found right), groups them by how
 * they look, and checks that against the clues: a lane with as many glyphs as its clues have
 * digits gives each glyph its digit, and then a group should have only one digit in it.
 *
 * With `--out DIR`, draws, for each picture, the glyphs found (`NAME-glyphs.png`: green in a lane
 * with the right number of them, red otherwise), and each group in a row (`NAME-groups.png`,
 * labeled with the digits its glyphs should be).
 *
 *   node --experimental-strip-types scripts/glyph-debug.ts [DIR | PICTURE...] [--out DIR]
 *     [--threshold T] [--verbose]
 */

import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import {
  cluster,
  distance,
  look,
  meanLook,
  shapeDistance,
  type Look,
} from '../src/ocr/cluster.ts';
import { findGlyphs, type Glyph } from '../src/ocr/glyphs.ts';
import { findGrid } from '../src/ocr/grid.ts';
import { templates, type Template } from './digit-templates.ts';
import type { Raster } from '../src/ocr/raster.ts';
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
const aspectWeight = Number(option('--aspect') ?? 0.2);
const verbose = args.includes('--verbose');
const digitTemplates = await templates();

/** The template nearest `l` in shape (and, a little, in proportions), and how much further the
 * nearest template of any other digit is. */
function nearestTemplate(l: Look): {
  template: Template;
  d: number;
  margin: number;
} {
  const byDigit = new Map<string, { template: Template; d: number }>();
  for (const t of digitTemplates) {
    const aspect = Math.abs(Math.log(l.w / l.h / (t.look.w / t.look.h)));
    const d = shapeDistance(l, t.look) + aspectWeight * aspect;
    if (d < (byDigit.get(t.digit)?.d ?? Infinity))
      byDigit.set(t.digit, { template: t, d });
  }
  const [best, next] = [...byDigit.values()].sort((p, q) => p.d - q.d);
  return { ...best!, margin: next!.d - best!.d };
}
const inputs = args.filter((a) => !a.startsWith('--'));

const list: Sample[] = (inputs.length > 0 ? inputs : [SAMPLES_DIR]).flatMap(
  (input) => (statSync(input).isDirectory() ? samples(input) : [sample(input)])
);
if (out) mkdirSync(out, { recursive: true });

const totals = { lanes: 0, lanesOk: 0, glyphs: 0, wrong: 0, named: 0 };
for (const s of list) {
  const clues = s.clues;
  if (!clues?.checked) continue;
  const raster = await decode(s.path);
  const result = findGrid(raster);
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
  const mismatches: string[] = [];
  const addLanes = (kind: string, found: Glyph[][], expected: number[][]) => {
    found.forEach((lane, i) => {
      const digits = expected[i]!.join('');
      const ok = lane.length === digits.length;
      if (ok) lanesOk++;
      else
        mismatches.push(
          `${kind} ${i}: expected ${expected[i]!.join(' ')}, found ${lane.length} glyphs`
        );
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

  const groups = cluster(looks, threshold);
  const groupCount = Math.max(-1, ...groups) + 1;
  const members: number[][] = Array.from({ length: groupCount }, () => []);
  groups.forEach((k, i) => members[k]!.push(i));
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
  // Each group named by the nearest template to its average look; how many glyphs that names
  // right.
  const names = members.map((m) =>
    nearestTemplate(meanLook(m.map((i) => looks[i]!)))
  );
  let named = 0;
  let worstMargin = Infinity;
  names.forEach((n, k) => {
    if (groupDigits[k]!.length > 0)
      worstMargin = Math.min(worstMargin, n.margin);
  });
  members.forEach((m) => {
    for (const i of m) {
      if (glyphs[i]!.digit === names[groups[i]!]!.template.digit) named++;
    }
  });

  totals.lanes += laneCount;
  totals.lanesOk += lanesOk;
  totals.glyphs += labeled;
  totals.wrong += wrong;
  totals.named += named;
  console.log(
    [
      s.name.padEnd(4),
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
    for (const m of mismatches) console.log(`     ${m}`);
    groupDigits.forEach((digits, k) => {
      const label = digits.map(([d, n]) => `${d}x${n}`).join(' ') || '?';
      const { template, d } = names[k]!;
      const misnamed = digits.length > 0 && digits[0]![0] !== template.digit;
      if (digits.length > 1 || misnamed)
        console.log(
          `     group ${k} (${members[k]!.length}): ${label}; looks like ` +
            `${template.digit} in ${template.font} (${d.toFixed(3)})`
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
          `${d.map(([digit, n]) => `${digit}x${n}`).join(' ')} ~${names[k]!.template.digit}`
      ),
      join(out, `${s.name}-groups.png`)
    );
  }
}
console.log(
  `lanes with the right number of glyphs: ${totals.lanesOk}/${totals.lanes}; ` +
    `glyphs in a group of another digit: ${totals.wrong}/${totals.glyphs}; ` +
    `named right: ${totals.named}/${totals.glyphs}`
);

async function drawGlyphs(
  raster: Raster,
  glyphs: { glyph: Glyph; digit: string | undefined }[],
  path: string
) {
  const { width, height } = raster;
  const data = Uint8Array.from(raster.data);
  const paint = (x: number, y: number, rgb: number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.set(rgb, (y * width + x) * 3);
  };
  for (const { glyph: g, digit } of glyphs) {
    const rgb = digit === undefined ? [255, 0, 0] : [0, 200, 0];
    for (let x = g.x0 - 1; x <= g.x1; x++) {
      paint(x, g.y0 - 1, rgb);
      paint(x, g.y1, rgb);
    }
    for (let y = g.y0 - 1; y <= g.y1; y++) {
      paint(g.x0 - 1, y, rgb);
      paint(g.x1, y, rgb);
    }
  }
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

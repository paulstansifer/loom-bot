/**
 * Grouping each lane's glyphs into numbers.
 *
 * A column's clues are stacked, a number to a line, so each line of text is a number. A row's are
 * all in one line, split into numbers where the digits are far apart. All the rows share a
 * typeface, so what's far apart is decided from all of them together. But what to measure
 * depends on the typeface. In most, it's the space between digits that's the same everywhere (a
 * "1" is narrow). In some, every digit takes the same width (a "1" sits in a lot of space), and
 * it's the distance from one digit's middle to the next's. Whichever splits more cleanly into
 * near and far is the one to go by. (This is `ocr-clues`' `reread.rs`.)
 */

import { type Glyph, type LaneGlyphs, textLines } from './glyphs.ts';

/** Each lane's clues, as numbers, each the glyphs of its digits. */
export type LaneNumbers = { columns: Glyph[][][]; rows: Glyph[][][] };

export function numbers(lanes: LaneGlyphs): LaneNumbers {
  const all = [...lanes.columns, ...lanes.rows].flat();
  const h = median(all.map((g) => g.y1 - g.y0));
  const columns = lanes.columns.map(textLines);
  // Digits side by side in a column's clues are certainly one number.
  const within = columns.flatMap((lane) =>
    lane.flatMap((line) => line.slice(1).map((g, i) => [line[i]!, g] as const))
  );
  const { measure, threshold } = rowSpacing(lanes.rows, h, within);
  const rows = lanes.rows.map((lane) => {
    const out: Glyph[][] = [];
    lane.forEach((g, i) => {
      if (i > 0 && measure(lane[i - 1]!, g) < threshold)
        out[out.length - 1]!.push(g);
      else out.push([g]);
    });
    return out;
  });
  return { columns, rows };
}

type Measure = (a: Glyph, b: Glyph) => number;

/** The space between two glyphs. */
const gap: Measure = (a, b) => b.x0 - a.x1;
/** The distance from the middle of one glyph to the next's. */
const advance: Measure = (a, b) => (b.x0 + b.x1 - a.x0 - a.x1) / 2;

/**
 * How to measure how far apart two digits in a row are, and how far apart is another number.
 * `within` are pairs of digits known to be in one number (from the columns' clues), if there are
 * any: then the threshold must put them all on the near side, which says much more than how
 * far apart typefaces' numbers tend to be.
 */
export function rowSpacing(
  rows: Glyph[][],
  h: number,
  within: (readonly [Glyph, Glyph])[] = []
): { measure: Measure; threshold: number } {
  const measured = (m: Measure) =>
    rows.flatMap((lane) => lane.slice(1).map((g, i) => m(lane[i]!, g)));
  // (Not pieces of one glyph, side by side: they overlap, or are of different heights.)
  const known = within.filter(([a, b]) => {
    const [ha, hb] = [a.y1 - a.y0, b.y1 - b.y0];
    return gap(a, b) >= 0 && Math.abs(ha - hb) <= 0.25 * Math.max(ha, hb);
  });
  if (known.length > 0) {
    const byGap = anchored(
      measured(gap),
      known.map(([a, b]) => gap(a, b))
    );
    const byAdvance = anchored(
      measured(advance),
      known.map(([a, b]) => advance(a, b))
    );
    // Whichever measure the known pairs agree on more closely is the one the typeface keeps
    // the same. (If they agree on both equally, say, if they're all the same number, go by
    // which splits the rows more cleanly.)
    const spread = (m: Measure) => deviation(known.map(([a, b]) => m(a, b)));
    const [sg, sa] = [spread(gap), spread(advance)];
    const preferGap =
      sg < sa - 0.25 ||
      (Math.abs(sg - sa) <= 0.25 &&
        (byAdvance?.clarity ?? 0) <= (byGap?.clarity ?? 0));
    const chosen = preferGap ? byGap : byAdvance;
    if (chosen) {
      return { measure: preferGap ? gap : advance, threshold: chosen.t };
    }
  }
  const gaps = measured(gap);
  const t = splitThreshold(gaps, 0.45 * h, 1.5);
  const byGap = t === 0 ? undefined : { t, clarity: clarity(gaps, t) };
  // (From middle to middle, digits of different widths in a proportional typeface are a little
  // nearer or farther apart: as much as 1.25 times, where every clue is one digit. A space
  // between numbers makes it at least 1.4.)
  const byAdvance = splitOtsu(measured(advance), 1.0 * h, 1.35);
  // From middle to middle, every digit is about as far from the next as any other: they're all
  // numbers of their own.
  if (!byAdvance) return { measure: gap, threshold: 0 };
  if (byGap && byGap.clarity >= byAdvance.clarity) {
    return { measure: gap, threshold: byGap.t };
  }
  return { measure: advance, threshold: byAdvance.t };
}

/**
 * The threshold between near and far in `distances`, where `within` are all near: at the
 * biggest jump (as a ratio) from one distance to the next, from the farthest of `within` up.
 * (Not at the split that best separates the two groups' averages: a row's digits can be a pixel
 * or so further apart than a column's, and that split can fall between them.) And how cleanly
 * it splits. `undefined` if there's no jump of at least 1.05 times.
 */
function anchored(
  distances: number[],
  within: number[]
): { t: number; clarity: number } | undefined {
  const all = [...distances, ...within].sort((p, q) => p - q);
  const most = Math.max(...within);
  let best = { ratio: 1.05, t: NaN };
  for (let i = 1; i < all.length; i++) {
    const [lo, hi] = [all[i - 1]!, all[i]!];
    if (lo < most) continue;
    const ratio = hi / Math.max(lo, 1);
    if (ratio > best.ratio) best = { ratio, t: (lo + hi) / 2 };
  }
  return Number.isNaN(best.t)
    ? undefined
    : { t: best.t, clarity: clarity(all, best.t) };
}

/**
 * The threshold at the biggest jump (as a ratio, at least `minJump`) between one distance and
 * the next bigger one, where the smaller one is under `limit`. Or 0, if there's no such jump.
 */
export function splitThreshold(
  distances: number[],
  limit: number,
  minJump: number
): number {
  const sorted = [...distances].sort((p, q) => p - q);
  let best = { ratio: minJump, threshold: 0 };
  for (let i = 1; i < sorted.length; i++) {
    const [lo, hi] = [sorted[i - 1]!, sorted[i]!];
    const ratio = hi / Math.max(lo, 0.1);
    if (lo < limit && ratio > best.ratio) {
      best = {
        ratio,
        threshold: Math.min(Math.sqrt(Math.max(lo, 0) * hi), limit),
      };
    }
  }
  return best.threshold;
}

/**
 * The threshold that best separates `distances` into two groups (Otsu's method), the digits of
 * one number and neighboring numbers, and how cleanly. `undefined` if there aren't two groups
 * with averages at least `ratio` apart, or the closer group isn't close enough (`limit`) to be
 * digits of one number.
 */
export function splitOtsu(
  distances: number[],
  limit: number,
  ratio: number
): { t: number; clarity: number } | undefined {
  const sorted = [...distances].sort((p, q) => p - q);
  let best: { separation: number; t: number } | undefined;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! <= 0) continue;
    const [lo, hi] = [sorted.slice(0, i), sorted.slice(i)];
    const [m0, m1] = [mean(lo), mean(hi)];
    if (m1 < ratio * Math.max(m0, 1) || m0 > limit) continue;
    const separation = lo.length * hi.length * (m1 - m0) ** 2;
    if (!best || separation > best.separation) {
      best = {
        separation,
        t: Math.min((sorted[i - 1]! + sorted[i]!) / 2, limit),
      };
    }
  }
  return best && { t: best.t, clarity: clarity(sorted, best.t) };
}

/** How cleanly `threshold` splits `distances`: the difference between the two groups' averages,
 * against how much they vary within themselves. */
export function clarity(distances: number[], threshold: number): number {
  const lo = distances.filter((d) => d < threshold);
  const hi = distances.filter((d) => d >= threshold);
  if (lo.length === 0 || hi.length === 0) return 0;
  const [m0, m1] = [mean(lo), mean(hi)];
  const variance = (v: number[], m: number) =>
    v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length;
  return (m1 - m0) ** 2 / Math.max(1, variance(lo, m0) + variance(hi, m1));
}

function deviation(v: number[]): number {
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
}

function mean(v: number[]): number {
  return v.reduce((s, x) => s + x, 0) / v.length;
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const sorted = [...v].sort((p, q) => p - q);
  return sorted[Math.floor(sorted.length / 2)]!;
}

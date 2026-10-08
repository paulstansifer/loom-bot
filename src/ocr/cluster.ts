/**
 * Grouping a picture's glyphs by how they look. In a screenshot, every glyph of the same digit is
 * drawn the same way (give or take where it falls between pixels), so a picture's glyphs fall
 * into a handful of groups, and each group only needs to be read once.
 */

import type { Glyph } from './glyphs.ts';

/** The size of the square that each glyph's ink is scaled to, to compare them. */
export const SHAPE = 16;

/** `glyph`'s ink, stretched to `SHAPE` by `SHAPE` (averaging over the pixels each cell covers). */
export function shape(glyph: Glyph): Float32Array {
  const w = glyph.x1 - glyph.x0;
  const h = glyph.y1 - glyph.y0;
  const wx = weights(w, SHAPE);
  const wy = weights(h, SHAPE);
  // Across, then down.
  const across = new Float32Array(h * SHAPE);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = glyph.ink[y * w + x]!;
      if (v === 0) continue;
      for (const [i, wt] of wx[x]!) across[y * SHAPE + i]! += v * wt;
    }
  }
  const out = new Float32Array(SHAPE * SHAPE);
  for (let y = 0; y < h; y++) {
    for (const [j, wt] of wy[y]!) {
      for (let i = 0; i < SHAPE; i++)
        out[j * SHAPE + i]! += across[y * SHAPE + i]! * wt;
    }
  }
  return out;
}

/** For each of `n` source pixels, the target cells (of `m`) it overlaps, and by how much of the
 * cell. */
function weights(n: number, m: number): [number, number][][] {
  const scale = n / m;
  return Array.from({ length: n }, (_, s) => {
    const out: [number, number][] = [];
    for (let i = Math.floor(s / scale); i < m && i * scale < s + 1; i++) {
      const overlap = Math.min(s + 1, (i + 1) * scale) - Math.max(s, i * scale);
      if (overlap > 0) out.push([i, overlap / scale]);
    }
    return out;
  });
}

/** What's compared: a glyph's size and its shape. */
export type Look = { w: number; h: number; shape: Float32Array };

export function look(glyph: Glyph): Look {
  return {
    w: glyph.x1 - glyph.x0,
    h: glyph.y1 - glyph.y0,
    shape: shape(glyph),
  };
}

/** How different two looks are: the average difference in ink between their shapes, or
 * `Infinity` if they're clearly different sizes. */
export function distance(p: Look, q: Look): number {
  const close = (u: number, v: number) =>
    Math.abs(u - v) <= Math.max(2, 0.2 * Math.max(u, v));
  if (!close(p.w, q.w) || !close(p.h, q.h)) return Infinity;
  return shapeDistance(p, q);
}

/** The average difference in ink between two looks' shapes (whatever their sizes). */
export function shapeDistance(p: Look, q: Look): number {
  let sum = 0;
  for (let i = 0; i < p.shape.length; i++) {
    sum += Math.abs(p.shape[i]! - q.shape[i]!);
  }
  return sum / p.shape.length;
}

/** The average of `looks`. */
export function meanLook(looks: Look[]): Look {
  const n = looks.length;
  const shape = new Float32Array(SHAPE * SHAPE);
  for (const l of looks) l.shape.forEach((v, i) => (shape[i]! += v / n));
  return {
    w: looks.reduce((s, l) => s + l.w, 0) / n,
    h: looks.reduce((s, l) => s + l.h, 0) / n,
    shape,
  };
}

/**
 * Groups `looks`: each joins the nearest group (by its average look so far) within `threshold`,
 * or starts a new one; then each is moved to the nearest group's final average. Returns the group
 * of each.
 */
export function cluster(looks: Look[], threshold: number): number[] {
  type Group = { n: number; w: number; h: number; sum: Float32Array };
  const groups: Group[] = [];
  const mean = (g: Group): Look => ({
    w: g.w / g.n,
    h: g.h / g.n,
    shape: g.sum.map((v) => v / g.n),
  });
  const nearest = (l: Look, means: Look[]) => {
    let best = -1;
    let bestD = threshold;
    means.forEach((m, k) => {
      const d = distance(l, m);
      if (d <= bestD) [best, bestD] = [k, d];
    });
    return best;
  };
  for (const l of looks) {
    let k = nearest(l, groups.map(mean));
    if (k < 0) {
      k = groups.length;
      groups.push({ n: 0, w: 0, h: 0, sum: new Float32Array(l.shape.length) });
    }
    const g = groups[k]!;
    g.n++;
    g.w += l.w;
    g.h += l.h;
    l.shape.forEach((v, i) => (g.sum[i]! += v));
  }
  const means = groups.map(mean);
  const assigned = looks.map((l) => nearest(l, means));
  // Anything that's now near no group (rare) gets one of its own; then renumber densely.
  let next = means.length;
  const raw = assigned.map((k) => (k < 0 ? next++ : k));
  const renumber = new Map<number, number>();
  return raw.map((k) => {
    if (!renumber.has(k)) renumber.set(k, renumber.size);
    return renumber.get(k)!;
  });
}

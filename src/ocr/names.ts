/**
 * Naming glyphs' looks: by the nearest of the templates (digits as drawn by various fonts, and
 * marks that cross out a cell), in shape and a little in proportions.
 */

import { type Look, shapeDistance } from './cluster.ts';
import { TEMPLATES } from './templates.ts';

/** The characters that stand for a template's ink, from none to all. */
export const LEVELS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** How much a difference in proportions (as a log ratio of width to height) counts against a
 * template, compared with a difference in shape. */
const ASPECT_WEIGHT = 0.2;

/** A look's name: a digit, or "x" for a mark crossing a cell out. */
export type Naming = {
  name: string;
  /** How far it is from the nearest template. */
  d: number;
  /** How much further the nearest template with another name is, and that name. */
  margin: number;
  next?: string;
};

let decoded: { name: string; look: Look }[] | undefined;

function templates(): { name: string; look: Look }[] {
  decoded ??= TEMPLATES.map(([name, w, h, text]) => ({
    name,
    look: {
      w,
      h,
      shape: Float32Array.from(
        text,
        (ch) => LEVELS.indexOf(ch) / (LEVELS.length - 1)
      ),
    },
  }));
  return decoded;
}

export function name(l: Look): Naming {
  const byName = new Map<string, number>();
  for (const t of templates()) {
    const aspect = Math.abs(Math.log(l.w / l.h / (t.look.w / t.look.h)));
    const d = shapeDistance(l, t.look) + ASPECT_WEIGHT * aspect;
    if (d < (byName.get(t.name) ?? Infinity)) byName.set(t.name, d);
  }
  const [best, next] = [...byName].sort((p, q) => p[1] - q[1]);
  return {
    name: best![0],
    d: best![1],
    margin: next![1] - best![1],
    next: next![0],
  };
}

export function isDigit(n: Naming): boolean {
  return n.name !== 'x';
}

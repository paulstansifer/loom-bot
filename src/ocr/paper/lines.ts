/**
 * Finding the printed lines in a photo of paper, as curves.
 *
 * Unlike a screenshot's, a photo's lines aren't in one row of pixels: they're tilted by the
 * camera, converge with perspective, and bend where the page curls. But over a short stretch,
 * a line is nearly straight. So the picture is cut into strips across the lines, and in each,
 * the ink is summed along the angle that makes the lines sharpest. Each line crosses the strip
 * as a narrow ridge in that profile. The ridges are then linked from strip to strip into chains,
 * and each chain is fitted with a smooth curve.
 *
 * Everything here works on horizontal-ish lines; vertical ones are found the same way, in the
 * transposed ink.
 */

import type { Ink } from './ink.ts';

/** How many strips the picture is cut into. */
const STRIPS = 24;
/** The steepest slope (dy/dx) tried for a strip's lines, and the most it can change from the
 * top of the picture to the bottom. */
const MAX_SLOPE = 0.3;
const MAX_SPREAD = 0.3;
/** How far either side of a ridge, in pixels, the ink must drop. Wider than a heavy line
 * (with its blur), narrower than a cell. */
const RIDGE_REACH = 4;
/** The faintest ridge counted as a line crossing. */
const MIN_RIDGE = 0.03;
/** How far, in pixels, a chain's next crossing can be from where it's expected, per strip
 * since its last one. */
const LINK_TOLERANCE = 4;
/** How many strips in a row a chain can skip (where a line is hidden under a fill). */
const MAX_SKIP = 2;
/** How many neighboring crossings on each side a crossing's heaviness is compared with. */
const NEIGHBORS = 4;

/** Where a line crosses a strip. */
export type Crossing = {
  /** The middle of the strip, and where along it the line crosses. */
  x: number;
  y: number;
  /** The slope of the lines in the strip. */
  slope: number;
  /** How far the ridge stands above the ink either side. */
  strength: number;
  /** Its strength compared with the crossings around it (the median of `NEIGHBORS` each side):
   * a heavy line's is about twice a thin line's. */
  heaviness: number;
};

export type Strip = { from: number; to: number; crossings: Crossing[] };

/** The slope of a strip's lines at `y`: they needn't be parallel, since perspective makes
 * them converge (a keystone), so it changes by `spread` from top to bottom. */
export type Slant = { slope: number; spread: number };

export function slopeAt(m: Ink, slant: Slant, y: number): number {
  return slant.slope + (slant.spread * (y - m.height / 2)) / m.height;
}

/** The ink summed across the strip `[x0, x1)`, along lines slanted by `slant`, at each `y`
 * (where those lines cross the strip's middle). */
export function stripProfile(
  m: Ink,
  x0: number,
  x1: number,
  slant: Slant
): Float32Array {
  const { width, height, ink } = m;
  const p = new Float32Array(height);
  const middle = (x0 + x1) / 2;
  const slopes = new Float32Array(height);
  for (let y = 0; y < height; y++) slopes[y] = slopeAt(m, slant, y);
  for (let x = x0; x < x1; x++) {
    const dx = x - middle;
    for (let y = 0; y < height; y++) {
      const from = y + slopes[y]! * dx;
      const whole = Math.floor(from);
      if (whole < 0 || whole + 1 >= height) continue;
      const a = from - whole;
      const i = whole * width + x;
      p[y]! += ink[i]! * (1 - a) + ink[i + width]! * a;
    }
  }
  for (let y = 0; y < height; y++) p[y]! /= x1 - x0;
  return p;
}

/** How far each point of `p` stands above the lowest point within `reach` on *both* sides: high
 * for a narrow line, zero for the inside or edge of something wide (like a filled cell). */
export function ridges(p: Float32Array, reach = RIDGE_REACH): Float32Array {
  const r = new Float32Array(p.length);
  for (let y = reach; y < p.length - reach; y++) {
    let before = Infinity;
    let after = Infinity;
    for (let d = 1; d <= reach; d++) {
      before = Math.min(before, p[y - d]!);
      after = Math.min(after, p[y + d]!);
    }
    r[y] = Math.max(0, p[y]! - Math.max(before, after));
  }
  return r;
}

/** The peaks of `r` at least `min` high, placed between pixels by a parabola through each. */
export function ridgePeaks(
  r: Float32Array,
  min = MIN_RIDGE
): { y: number; strength: number }[] {
  const out = [];
  for (let y = 1; y < r.length - 1; y++) {
    const [a, b, c] = [r[y - 1]!, r[y]!, r[y + 1]!];
    if (b < min || b <= a || b < c) continue;
    const curve = a - 2 * b + c;
    out.push({ y: y + (curve < 0 ? (a - c) / (2 * curve) : 0), strength: b });
  }
  return out;
}

/** How sharp a profile's lines are: its ridges' total, squared. */
function sharpness(m: Ink, x0: number, x1: number, slant: Slant): number {
  let total = 0;
  for (const v of ridges(stripProfile(m, x0, x1, slant))) total += v * v;
  return total;
}

/** Each strip's line crossings, at the slope that makes them sharpest. */
export function crossings(m: Ink, strips = STRIPS): Strip[] {
  const w = Math.max(8, Math.round(m.width / strips));
  const out: Strip[] = [];
  for (let x0 = 0; x0 + w <= m.width; x0 += w) {
    const x1 = x0 + w;
    // The slope, coarsely; then the spread; then both finely.
    let best: Slant = { slope: 0, spread: 0 };
    let bestScore = -1;
    const tryAll = (slants: Slant[]) => {
      for (const slant of slants) {
        const score = sharpness(m, x0, x1, slant);
        if (score > bestScore) [best, bestScore] = [slant, score];
      }
    };
    const range = (from: number, to: number, step: number) =>
      Array.from(
        { length: Math.round((to - from) / step) + 1 },
        (_, k) => from + k * step
      );
    tryAll(
      range(-MAX_SLOPE, MAX_SLOPE, 0.03).map((slope) => ({ slope, spread: 0 }))
    );
    let { slope, spread } = best;
    tryAll(
      range(-MAX_SPREAD, MAX_SPREAD, 0.05).map((sp) => ({ slope, spread: sp }))
    );
    ({ slope, spread } = best);
    tryAll(
      range(slope - 0.025, slope + 0.025, 0.005).map((sl) => ({
        slope: sl,
        spread,
      }))
    );
    ({ slope, spread } = best);
    tryAll(
      range(spread - 0.04, spread + 0.04, 0.01).map((sp) => ({
        slope,
        spread: sp,
      }))
    );
    const slant = best;
    const peaks = ridgePeaks(ridges(stripProfile(m, x0, x1, slant)));
    const strip: Crossing[] = peaks.map((p, i) => {
      const around = [
        ...peaks.slice(Math.max(0, i - NEIGHBORS), i),
        ...peaks.slice(i + 1, i + 1 + NEIGHBORS),
      ]
        .map((q) => q.strength)
        .sort((a, b) => a - b);
      const typical =
        around.length > 0 ? around[around.length >> 1]! : p.strength;
      return {
        x: (x0 + x1) / 2,
        y: p.y,
        slope: slopeAt(m, slant, p.y),
        strength: p.strength,
        heaviness: p.strength / typical,
      };
    });
    out.push({ from: x0, to: x1, crossings: strip });
  }
  return out;
}

/** A line's crossings, linked from strip to strip, in order. */
export type Chain = {
  crossings: Crossing[];
  /** The median of its crossings' heaviness. */
  heaviness: number;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
};

/**
 * The crossings linked into chains, strip by strip: each chain goes on to the crossing nearest
 * where it's expected (from the strips' slopes), if that's close enough, the closest matches
 * first. A chain can skip `MAX_SKIP` strips.
 */
export function chains(strips: Strip[]): Chain[] {
  type Open = { crossings: Crossing[]; last: number };
  const open: Open[] = [];
  const done: Crossing[][] = [];
  strips.forEach((strip, i) => {
    const matches: [number, Open, number][] = [];
    for (const chain of open) {
      const end = chain.crossings[chain.crossings.length - 1]!;
      const tolerance = LINK_TOLERANCE * (i - chain.last);
      strip.crossings.forEach((c, k) => {
        const expected = end.y + ((end.slope + c.slope) / 2) * (c.x - end.x);
        const off = Math.abs(c.y - expected);
        if (off <= tolerance) matches.push([off, chain, k]);
      });
    }
    matches.sort((a, b) => a[0] - b[0]);
    const extended = new Set<Open>();
    const taken = new Set<number>();
    for (const [, chain, k] of matches) {
      if (extended.has(chain) || taken.has(k)) continue;
      extended.add(chain);
      taken.add(k);
      chain.crossings.push(strip.crossings[k]!);
      chain.last = i;
    }
    for (let j = open.length - 1; j >= 0; j--) {
      if (i - open[j]!.last > MAX_SKIP) {
        done.push(open[j]!.crossings);
        open.splice(j, 1);
      }
    }
    strip.crossings.forEach((c, k) => {
      if (!taken.has(k)) open.push({ crossings: [c], last: i });
    });
  });
  for (const chain of open) done.push(chain.crossings);
  return done.map((crossings) => ({
    crossings,
    heaviness: median(crossings.map((c) => c.heaviness)),
  }));
}

/** A smooth curve, `y = at(x)`, fitted to a line's crossings from `from` to `to` (beyond which
 * it's extrapolated). */
export type Curve = {
  at: (x: number) => number;
  from: number;
  to: number;
  /** How many crossings it was fitted to, and their median heaviness. */
  support: number;
  heaviness: number;
  points: { x: number; y: number }[];
};

/** The highest power of x in a curve. A page's curl is gentle over a grid; more than this
 * overfits, and extrapolates wildly. */
const DEGREE = 3;
/** How far, in pixels, a crossing can be from its curve, after the first fit, and still count. */
const FIT_TOLERANCE = 2.5;

/** The least-squares polynomial through `points` (in `x` scaled to about [-1, 1] around
 * `center`), as its coefficients, lowest power first. */
function polyfit(
  points: { x: number; y: number }[],
  degree: number,
  center: number,
  scale: number
): number[] {
  const n = degree + 1;
  const a = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (const { x, y } of points) {
    const u = (x - center) / scale;
    const powers = [1];
    for (let k = 1; k < 2 * n; k++) powers.push(powers[k - 1]! * u);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) a[r]![c]! += powers[r + c]!;
      a[r]![n]! += powers[r]! * y;
    }
  }
  // Gaussian elimination, with partial pivoting.
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const p = a[col]![col]!;
    if (Math.abs(p) < 1e-12) return [median(points.map((q) => q.y))];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / p;
      for (let c = col; c <= n; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map((row, r) => row[n]! / row[r]!);
}

/** A curve through `points`, of a degree they can support, refitted without the ones far off
 * it. */
export function fitCurve(
  points: { x: number; y: number; heaviness?: number }[]
): Curve {
  let from = Math.min(...points.map((p) => p.x));
  let to = Math.max(...points.map((p) => p.x));
  const center = (from + to) / 2;
  const scale = Math.max(1, (to - from) / 2);
  const degreeFor = (count: number) => Math.max(0, Math.min(DEGREE, count - 2));
  let kept = points;
  let coef = polyfit(kept, degreeFor(kept.length), center, scale);
  const evaluate = (c: number[], x: number) => {
    const u = (x - center) / scale;
    let y = 0;
    for (let k = c.length - 1; k >= 0; k--) y = y * u + c[k]!;
    return y;
  };
  for (let round = 0; round < 2; round++) {
    const close = kept.filter(
      (p) => Math.abs(p.y - evaluate(coef, p.x)) <= FIT_TOLERANCE
    );
    if (close.length < 2 || close.length === kept.length) break;
    kept = close;
    coef = polyfit(kept, degreeFor(kept.length), center, scale);
  }
  from = Math.min(...kept.map((p) => p.x));
  to = Math.max(...kept.map((p) => p.x));
  const final = coef;
  return {
    at: (x) => evaluate(final, x),
    from,
    to,
    support: kept.length,
    heaviness: median(kept.map((p) => p.heaviness ?? 1)),
    points: kept.map(({ x, y }) => ({ x, y })),
  };
}

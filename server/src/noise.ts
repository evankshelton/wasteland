// Seeded, stateless 2D noise. Every value is a pure function of (seed, x, y),
// so any chunk can be generated independently and in any order.

/** 32-bit integer hash of two coordinates and a seed. */
export function hash2(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic float in [0, 1) for an integer lattice point. */
export function rand2(seed: number, x: number, y: number): number {
  return hash2(seed, x, y) / 4294967296;
}

const GRADS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

function grad(seed: number, ix: number, iy: number, dx: number, dy: number): number {
  const g = GRADS[hash2(seed, ix, iy) & 7]!;
  return g[0] * dx + g[1] * dy;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Gradient (Perlin-style) noise, roughly in [-1, 1]. */
export function perlin(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fade(fx);
  const v = fade(fy);
  const n00 = grad(seed, x0, y0, fx, fy);
  const n10 = grad(seed, x0 + 1, y0, fx - 1, fy);
  const n01 = grad(seed, x0, y0 + 1, fx, fy - 1);
  const n11 = grad(seed, x0 + 1, y0 + 1, fx - 1, fy - 1);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.414;
}

/** Fractal Brownian motion: several octaves of perlin noise, normalised to about [-1, 1]. */
export function fbm(seed: number, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin(seed + i * 1013, x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

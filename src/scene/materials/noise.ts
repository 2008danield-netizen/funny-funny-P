/**
 * Deterministic noise primitives for procedural texture generation.
 *
 * Everything is seeded so a given preset generates byte-identical textures on
 * every load and on every machine — important once designs are shared between a
 * homeowner and their designer, and essential for reproducible screenshots.
 */

/** Small, fast, seedable PRNG. Good enough for texture work. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothstep-style interpolation curve; removes the grid artefacts of lerp. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A tileable value-noise field.
 *
 * `period` is the grid size in cells; sampling wraps at `period`, which is what
 * makes the resulting texture repeat seamlessly when applied to a large floor.
 */
export class ValueNoise2D {
  private readonly grid: Float32Array;
  private readonly period: number;

  constructor(period: number, seed: number) {
    this.period = period;
    this.grid = new Float32Array(period * period);
    const random = mulberry32(seed);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = random();
  }

  /** Reads a lattice point, wrapping so the field tiles seamlessly. */
  private at(x: number, y: number): number {
    const p = this.period;
    const ix = ((x % p) + p) % p;
    const iy = ((y % p) + p) % p;
    return this.grid[iy * p + ix] ?? 0;
  }

  /** Samples the field at continuous coordinates. Returns 0..1. */
  sample(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = fade(x - x0);
    const ty = fade(y - y0);

    const top = lerp(this.at(x0, y0), this.at(x0 + 1, y0), tx);
    const bottom = lerp(this.at(x0, y0 + 1), this.at(x0 + 1, y0 + 1), tx);
    return lerp(top, bottom, ty);
  }
}

/**
 * Fractal Brownian motion — stacked octaves of value noise.
 *
 * Each octave doubles the frequency and halves the amplitude, producing the
 * self-similar detail that makes wood grain and concrete read as real material
 * rather than as smooth blobs.
 */
export function fbm(
  noise: ValueNoise2D,
  x: number,
  y: number,
  octaves: number,
  basePeriod: number,
): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;

  for (let i = 0; i < octaves; i++) {
    // Multiplying by basePeriod keeps every octave aligned to the tiling grid.
    value += amplitude * noise.sample((x * frequency) % basePeriod, (y * frequency) % basePeriod);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / total;
}

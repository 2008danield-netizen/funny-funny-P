/**
 * Canvas helpers shared by the procedural texture generators.
 */

/** Creates an offscreen canvas plus its 2D context, throwing if unavailable. */
export function createCanvas(size: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable — cannot generate textures.');
  return { canvas, ctx };
}

/** Parses "#rrggbb" into 0-255 components. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** Blends two colours, `t` = 0 gives `a`, `t` = 1 gives `b`. */
export function mixRgb(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/** Clamps to the 0-255 byte range. */
export function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Converts a greyscale height field into a tangent-space normal map.
 *
 * Uses a Sobel operator to estimate the surface slope at each texel. Sampling
 * wraps at the edges so the normal map tiles as seamlessly as its source.
 * `strength` scales how pronounced the resulting bumps appear under lighting.
 */
export function heightToNormalMap(height: ImageData, strength: number): ImageData {
  const { width, height: h, data } = height;
  const out = new ImageData(width, h);

  // Reads the red channel (the height field is greyscale) with wrapping.
  const sample = (x: number, y: number): number => {
    const wx = ((x % width) + width) % width;
    const wy = ((y % h) + h) % h;
    return (data[(wy * width + wx) * 4] ?? 0) / 255;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      // Sobel kernels give a smoother gradient than a plain finite difference.
      const tl = sample(x - 1, y - 1);
      const t = sample(x, y - 1);
      const tr = sample(x + 1, y - 1);
      const l = sample(x - 1, y);
      const r = sample(x + 1, y);
      const bl = sample(x - 1, y + 1);
      const b = sample(x, y + 1);
      const br = sample(x + 1, y + 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      // Build and normalise the surface normal from the two slopes.
      const nx = dx * strength;
      const ny = dy * strength;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz);

      const index = (y * width + x) * 4;
      // Normals are stored biased into 0..1, the standard tangent-space encoding.
      out.data[index] = clamp255(((nx / length) * 0.5 + 0.5) * 255);
      out.data[index + 1] = clamp255(((ny / length) * 0.5 + 0.5) * 255);
      out.data[index + 2] = clamp255(((nz / length) * 0.5 + 0.5) * 255);
      out.data[index + 3] = 255;
    }
  }
  return out;
}

/** Builds a greyscale ImageData from a per-texel height function returning 0..1. */
export function renderHeightField(
  size: number,
  fn: (u: number, v: number) => number,
): ImageData {
  const image = new ImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = clamp255(fn(x / size, y / size) * 255);
      const index = (y * size + x) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  return image;
}

/**
 * Straightening a photograph of a paper plan.
 *
 * A great many people have their floor plan as a printed sheet, and the way
 * they will get it into this app is by photographing it on a table. That photo
 * is never square on: the sheet comes out as a trapezium, near edges longer
 * than far ones, and every measurement taken off it is wrong by a different
 * amount in a different place. Scaling cannot fix that — no single number can,
 * because the error varies across the picture.
 *
 * What fixes it is a PROJECTIVE transform. Mark the four corners of the sheet,
 * and there is exactly one such transform taking them to the corners of a
 * rectangle; applying it to the whole image undoes the camera's angle and gives
 * back something as good as a scan. Eight unknowns, eight equations, one linear
 * solve — and then the tracing on top of it means something.
 *
 * The maths here is pure and tested. The resampling at the bottom needs a
 * canvas, and is the only part that touches the browser.
 */

import type { Point2 } from '@/state/types';

/**
 * A 3x3 projective transform, row-major, with the last entry fixed at 1.
 *
 * Nine numbers, eight degrees of freedom: scaling all nine by the same amount
 * describes the same transform, so one of them is pinned and the rest are
 * solved for.
 */
export type Homography = readonly number[];

/**
 * Finds the transform taking four points to four other points.
 *
 * Each correspondence gives two equations. Written out, the projective mapping
 *
 *     u = (a x + b y + c) / (g x + h y + 1)
 *     v = (d x + e y + f) / (g x + h y + 1)
 *
 * rearranges to two linear rows in the eight unknowns, and four points give the
 * eight rows needed. Returns null when the four points are degenerate — three
 * in a line, or two the same — because then there is no transform rather than a
 * badly conditioned one, and a solver that returns something anyway would hand
 * back an image folded through itself.
 */
export function solveHomography(from: readonly Point2[], to: readonly Point2[]): Homography | null {
  if (from.length !== 4 || to.length !== 4) return null;

  const matrix: number[][] = [];
  const rhs: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x, z: y } = from[i]!;
    const { x: u, z: v } = to[i]!;

    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    rhs.push(u);
    matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    rhs.push(v);
  }

  const solved = solveLinearSystem(matrix, rhs);
  if (!solved) return null;

  const h = [...solved, 1];

  /*
   * The eight equations can have a perfectly good solution that describes a
   * useless transform.
   *
   * Send three of the four corners to points in a straight line and the algebra
   * still solves — it just solves to a matrix that flattens the whole plane
   * onto that line. Every pixel then maps to the same place, and resampling
   * through it produces a smear. The system being solvable is not the test;
   * the transform being invertible is, so the determinant is checked against
   * the size of the matrix rather than against zero, which would depend on
   * whether the image was measured in pixels or in metres.
   */
  const determinant =
    h[0]! * (h[4]! * h[8]! - h[5]! * h[7]!) -
    h[1]! * (h[3]! * h[8]! - h[5]! * h[6]!) +
    h[2]! * (h[3]! * h[7]! - h[4]! * h[6]!);

  const scale = Math.max(...h.map(Math.abs));
  if (Math.abs(determinant) < 1e-9 * scale ** 3) return null;

  return h;
}

/** Maps one point through a transform. */
export function applyHomography(h: Homography, point: Point2): Point2 {
  const denominator = h[6]! * point.x + h[7]! * point.z + h[8]!;
  // A point on the transform's horizon maps to infinity. Nothing sensible can
  // be returned, so the point is left where it is rather than becoming a NaN
  // that spreads through every later calculation.
  if (Math.abs(denominator) < 1e-12) return point;

  return {
    x: (h[0]! * point.x + h[1]! * point.z + h[2]!) / denominator,
    z: (h[3]! * point.x + h[4]! * point.z + h[5]!) / denominator,
  };
}

/**
 * Gaussian elimination with partial pivoting.
 *
 * Eight equations is small enough that anything cleverer would be showing off,
 * but the pivoting is not optional: without it a sheet photographed dead square
 * — which is the case somebody is most likely to try first — puts a zero on the
 * diagonal and the whole thing divides by nothing.
 */
function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
  const size = rhs.length;
  const rows = matrix.map((row, index) => [...row, rhs[index]!]);

  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column]!) < 1e-12) return null;

    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];

    const pivotRow = rows[column]!;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = rows[row]![column]! / pivotRow[column]!;
      if (factor === 0) continue;
      for (let k = column; k <= size; k++) {
        rows[row]![k]! -= factor * pivotRow[k]!;
      }
    }
  }

  return rows.map((row, index) => row[size]! / row[index]!);
}

/* ------------------------------ The four corners -------------------------- */

/**
 * Puts four clicked points into the order the transform expects.
 *
 * People click corners in whatever order they see them, and a transform fed
 * them in the wrong order produces an image rotated, mirrored or folded. Sorted
 * by angle about their own centre, then rotated so the first is the one nearest
 * the top-left — which for a photograph of a sheet is unambiguous.
 */
export function orderCorners(points: readonly Point2[]): Point2[] | null {
  if (points.length !== 4) return null;

  const centre = {
    x: points.reduce((sum, p) => sum + p.x, 0) / 4,
    z: points.reduce((sum, p) => sum + p.z, 0) / 4,
  };

  const byAngle = [...points].sort(
    (a, b) => Math.atan2(a.z - centre.z, a.x - centre.x) - Math.atan2(b.z - centre.z, b.x - centre.x),
  );

  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const point = byAngle[i]!;
    const distance = (point.x - centre.x) ** 2 + (point.z - centre.z) ** 2;
    const corner = point.x - centre.x < 0 && point.z - centre.z < 0 ? -distance : distance;
    if (corner < best) {
      best = corner;
      start = i;
    }
  }

  return [0, 1, 2, 3].map((offset) => byAngle[(start + offset) % 4]!);
}

/**
 * How big the straightened sheet should be, in pixels.
 *
 * Opposite sides of the trapezium disagree — that is the whole point of the
 * distortion — so each dimension is taken as the longer of its two, which keeps
 * the detail from the nearer edge rather than throwing it away. The aspect that
 * comes out is only approximately the sheet's true one; getting that exactly
 * right needs the camera's focal length, which a photograph does not carry.
 * It does not matter: the scale is set afterwards by calibration, from a
 * distance the user knows.
 */
export function straightenedSize(ordered: readonly Point2[]): { width: number; height: number } {
  const span = (a: Point2, b: Point2) => Math.hypot(b.x - a.x, b.z - a.z);
  const [topLeft, topRight, bottomRight, bottomLeft] = ordered as [Point2, Point2, Point2, Point2];

  return {
    width: Math.max(1, Math.round(Math.max(span(topLeft, topRight), span(bottomLeft, bottomRight)))),
    height: Math.max(1, Math.round(Math.max(span(topLeft, bottomLeft), span(topRight, bottomRight)))),
  };
}

/* -------------------------------- Resampling ------------------------------ */

/**
 * Redraws an image as if the camera had been square on to it.
 *
 * Worked backwards: for every pixel of the OUTPUT, find where it came from in
 * the input and sample there. Forwards would leave holes wherever the transform
 * stretches, which on a steeply angled photo is most of the far half.
 *
 * Sampled bilinearly, because a plan is thin dark lines on white and
 * nearest-neighbour turns those into a dotted mess at exactly the scale the
 * line detector then has to work at.
 */
export function straightenImage(
  source: CanvasImageSource & { width: number; height: number },
  corners: readonly Point2[],
): HTMLCanvasElement | null {
  const ordered = orderCorners(corners);
  if (!ordered) return null;

  const { width, height } = straightenedSize(ordered);
  const rectangle: Point2[] = [
    { x: 0, z: 0 },
    { x: width, z: 0 },
    { x: width, z: height },
    { x: 0, z: height },
  ];

  // Output back to input, which is the direction the resampling walks.
  const inverse = solveHomography(rectangle, ordered);
  if (!inverse) return null;

  const input = document.createElement('canvas');
  input.width = source.width;
  input.height = source.height;
  const inputContext = input.getContext('2d');
  if (!inputContext) return null;
  inputContext.drawImage(source, 0, 0);
  const from = inputContext.getImageData(0, 0, source.width, source.height);

  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const outputContext = output.getContext('2d');
  if (!outputContext) return null;
  const to = outputContext.createImageData(width, height);

  resampleThrough(from, to, inverse);
  outputContext.putImageData(to, 0, 0);
  return output;
}

/** The pixel loop, kept separate so it can be tested without a canvas. */
export function resampleThrough(
  from: { width: number; height: number; data: Uint8ClampedArray },
  to: { width: number; height: number; data: Uint8ClampedArray },
  inverse: Homography,
): void {
  for (let y = 0; y < to.height; y++) {
    for (let x = 0; x < to.width; x++) {
      const source = applyHomography(inverse, { x: x + 0.5, z: y + 0.5 });
      const index = (y * to.width + x) * 4;

      if (
        source.x < 0 ||
        source.z < 0 ||
        source.x >= from.width ||
        source.z >= from.height
      ) {
        // Off the original photograph: white, so a sheet marked slightly
        // generously comes out on paper-coloured margins rather than black.
        to.data[index] = 255;
        to.data[index + 1] = 255;
        to.data[index + 2] = 255;
        to.data[index + 3] = 255;
        continue;
      }

      sampleBilinear(from, source.x - 0.5, source.z - 0.5, to.data, index);
    }
  }
}

function sampleBilinear(
  image: { width: number; height: number; data: Uint8ClampedArray },
  x: number,
  y: number,
  out: Uint8ClampedArray,
  at: number,
): void {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);

  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));

  for (let channel = 0; channel < 4; channel++) {
    const topLeft = image.data[(y0 * image.width + x0) * 4 + channel]!;
    const topRight = image.data[(y0 * image.width + x1) * 4 + channel]!;
    const bottomLeft = image.data[(y1 * image.width + x0) * 4 + channel]!;
    const bottomRight = image.data[(y1 * image.width + x1) * 4 + channel]!;

    const top = topLeft + (topRight - topLeft) * fx;
    const bottom = bottomLeft + (bottomRight - bottomLeft) * fx;
    out[at + channel] = Math.round(top + (bottom - top) * fy);
  }
}

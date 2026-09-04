/**
 * Finding the walls in a scanned floor plan.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT PROMISE.
 *
 * It proposes. It does not decide. Every wall it finds is offered for the user
 * to accept or reject, and that is not timidity — it is the only honest design.
 * Scans are photocopied, skewed, annotated, hatched and dimensioned; a detector
 * confident enough to build a house unattended would be wrong often enough to
 * produce a plausible house that is not yours, which is the worst outcome
 * available. Proposing is useful and checkable; deciding is neither.
 *
 * THE PIPELINE.
 *
 *  1. WORK SMALL. A scan is six megapixels and none of that resolution helps
 *     find a wall. Everything below runs on a reduced copy and the answers are
 *     scaled back, which turns a second and a half into a tenth of one.
 *  2. INK. Grey, then a threshold chosen by Otsu's method — which picks the
 *     split that best separates the page into two groups rather than using a
 *     fixed number that a grey photocopy or a bright photograph would fail.
 *  3. LINES. A Hough transform: every ink pixel votes for every line it could
 *     lie on, and the lines of a drawing win by an enormous margin because
 *     hundreds of pixels agree on each. This is what makes it robust to gaps,
 *     speckle and dashed lines, none of which a contour tracer survives.
 *  4. SEGMENTS. A line is infinite; a wall is not. Each winning line is walked
 *     end to end and broken wherever the ink stops for longer than a doorway.
 *  5. WALLS. A wall in a plan is drawn as TWO lines — its two faces — so
 *     parallel pairs the right distance apart are recombined into one
 *     centreline with a thickness. That is what makes the output walls rather
 *     than twice as many walls.
 * -----------------------------------------------------------------------------
 *
 * Everything here is pure and works on a plain `{width, height, data}`, so it
 * is tested against drawings generated in the test file rather than against a
 * scan nobody can check.
 */

import type { Point2 } from '@/state/types';

/** The subset of ImageData this module needs, so tests need no canvas. */
export interface Pixels {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel. */
  data: Uint8ClampedArray;
}

/** A straight run of ink, in image pixels. */
export interface Segment {
  from: Point2;
  to: Point2;
  /** How much of the line's length actually had ink under it, 0-1. */
  coverage: number;
}

/** A proposed wall, in image pixels. */
export interface DetectedWall {
  /** The centreline. */
  from: Point2;
  to: Point2;
  /**
   * Thickness in pixels, or null where only one face of the wall was found.
   *
   * Null is a real answer and worth keeping: a single line might be a wall
   * drawn thin, or it might be a dimension line or the edge of the paper, and
   * the caller can treat the two cases differently.
   */
  thicknessPixels: number | null;
  /** 0-1: how strongly the ink supports it. */
  confidence: number;
}

export interface DetectionOptions {
  /** Longest side to work at, in pixels. */
  workingSize: number;
  /** Shortest run of ink worth calling a wall, in original pixels. */
  minLength: number;
  /** Gap that is a doorway rather than the end of a wall, in original pixels. */
  maxGap: number;
  /** Wall thickness range for pairing up faces, in original pixels. */
  minThickness: number;
  maxThickness: number;
  /** Cap on how many walls to propose. */
  maxWalls: number;
}

export const DETECTION_DEFAULTS: DetectionOptions = {
  workingSize: 1100,
  minLength: 40,
  maxGap: 14,
  minThickness: 3,
  maxThickness: 40,
  maxWalls: 200,
};

/* --------------------------------- Step 1 --------------------------------- */

/** Nearest-neighbour reduction. Good enough: the next step is a threshold. */
export function reduce(image: Pixels, longestSide: number): { pixels: Pixels; factor: number } {
  const longest = Math.max(image.width, image.height);
  if (longest <= longestSide) return { pixels: image, factor: 1 };

  const factor = longestSide / longest;
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / factor));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / factor));
      const from = (sourceY * image.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      data[to] = image.data[from]!;
      data[to + 1] = image.data[from + 1]!;
      data[to + 2] = image.data[from + 2]!;
      data[to + 3] = 255;
    }
  }

  return { pixels: { width, height, data }, factor };
}

/* --------------------------------- Step 2 --------------------------------- */

/** Luminance, one byte per pixel. */
export function toGrey(image: Pixels): Uint8ClampedArray {
  const grey = new Uint8ClampedArray(image.width * image.height);
  for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
    // Rec. 601 weights: green carries most of the perceived brightness, and a
    // plain average turns a blue-inked plan into a much fainter one.
    grey[i] = (image.data[p]! * 299 + image.data[p + 1]! * 587 + image.data[p + 2]! * 114) / 1000;
  }
  return grey;
}

/**
 * Otsu's threshold: the split that best separates the page into two groups.
 *
 * A fixed threshold works on a clean scan and fails on everything else — a grey
 * photocopy has no pixels below 100, a photograph taken by a window has half
 * the sheet at 250. Otsu asks the histogram where the two humps are, which is
 * what a person means by "the ink and the paper".
 */
export function otsuThreshold(grey: Uint8ClampedArray): number {
  const histogram = new Array<number>(256).fill(0);
  for (const value of grey) histogram[value]! += 1;

  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i]!;

  let sumBelow = 0;
  let countBelow = 0;
  let best = 0;
  let bestVariance = -1;

  for (let threshold = 0; threshold < 256; threshold++) {
    countBelow += histogram[threshold]!;
    if (countBelow === 0) continue;
    const countAbove = total - countBelow;
    if (countAbove === 0) break;

    sumBelow += threshold * histogram[threshold]!;
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (sum - sumBelow) / countAbove;

    // Between-class variance: maximising it is the same as minimising the
    // spread within each group, and is far cheaper to compute.
    const variance = countBelow * countAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = threshold;
    }
  }

  return best;
}

/** 1 where there is ink, 0 where there is paper. */
export function inkMask(image: Pixels, threshold?: number): Uint8Array {
  const grey = toGrey(image);
  const cut = threshold ?? otsuThreshold(grey);

  const mask = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i++) mask[i] = grey[i]! <= cut ? 1 : 0;
  return mask;
}

/** The box the drawing actually occupies, ignoring the margins of the sheet. */
export function contentBounds(
  image: Pixels,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  const mask = inkMask(image);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!mask[y * image.width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minZ: minY, maxZ: maxY };
}

/* --------------------------------- Step 3 --------------------------------- */

interface Line {
  theta: number;
  rho: number;
  votes: number;
}

/**
 * Every line the ink agrees on, strongest first.
 *
 * One accumulator cell per (angle, distance-from-origin) pair; each ink pixel
 * adds a vote to every cell it could belong to. A wall five hundred pixels long
 * puts five hundred votes in one cell, which no amount of speckle comes close
 * to — and unlike tracing contours, it does not care that the line is dashed,
 * crossed by dimension arrows, or broken by a doorway.
 */
export function houghLines(
  mask: Uint8Array,
  width: number,
  height: number,
  minVotes: number,
  maxLines: number,
  thetaSteps = 180,
): Line[] {
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoOffset = diagonal;
  const rhoCount = diagonal * 2 + 1;

  const accumulator = new Int32Array(thetaSteps * rhoCount);
  const cosines = new Float64Array(thetaSteps);
  const sines = new Float64Array(thetaSteps);
  for (let t = 0; t < thetaSteps; t++) {
    const theta = (Math.PI * t) / thetaSteps;
    cosines[t] = Math.cos(theta);
    sines[t] = Math.sin(theta);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let t = 0; t < thetaSteps; t++) {
        const rho = Math.round(x * cosines[t]! + y * sines[t]!) + rhoOffset;
        accumulator[t * rhoCount + rho]! += 1;
      }
    }
  }

  /*
   * Peaks, taken one at a time and then suppressed.
   *
   * A strong line lights up its neighbours as well — a wall a few pixels thick
   * genuinely lies on several nearby lines — so taking the top N cells would
   * return the same wall five times. After each peak its neighbourhood is
   * cleared, which is what makes the result one entry per wall face.
   */
  const found: Line[] = [];
  const thetaWindow = Math.max(1, Math.round(thetaSteps / 60));
  const rhoWindow = 6;

  for (let n = 0; n < maxLines; n++) {
    let bestIndex = -1;
    let bestVotes = minVotes - 1;
    for (let i = 0; i < accumulator.length; i++) {
      if (accumulator[i]! > bestVotes) {
        bestVotes = accumulator[i]!;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;

    const t = Math.floor(bestIndex / rhoCount);
    const rho = (bestIndex % rhoCount) - rhoOffset;
    found.push({ theta: (Math.PI * t) / thetaSteps, rho, votes: bestVotes });

    for (let dt = -thetaWindow; dt <= thetaWindow; dt++) {
      const tt = t + dt;
      if (tt < 0 || tt >= thetaSteps) continue;
      for (let dr = -rhoWindow; dr <= rhoWindow; dr++) {
        const rr = rho + dr + rhoOffset;
        if (rr < 0 || rr >= rhoCount) continue;
        accumulator[tt * rhoCount + rr] = 0;
      }
    }
  }

  return found;
}

/* --------------------------------- Step 4 --------------------------------- */

/**
 * Walks a line from one side of the image to the other, collecting the runs of
 * ink along it.
 *
 * A gap shorter than `maxGap` is a doorway, an arrow crossing the wall, or a
 * photocopier's bad day, and the wall continues through it. Anything longer is
 * the end of the wall.
 */
export function segmentsAlong(
  line: Line,
  mask: Uint8Array,
  width: number,
  height: number,
  minLength: number,
  maxGap: number,
  tolerance = 2,
): Segment[] {
  const cos = Math.cos(line.theta);
  const sin = Math.sin(line.theta);
  // A point on the line, and the direction along it.
  const originX = cos * line.rho;
  const originY = sin * line.rho;
  const dirX = -sin;
  const dirY = cos;

  // How far to walk each way before leaving the image for good.
  const reach = Math.ceil(Math.hypot(width, height));

  const hasInkNear = (x: number, y: number): boolean => {
    for (let dx = -tolerance; dx <= tolerance; dx++) {
      for (let dy = -tolerance; dy <= tolerance; dy++) {
        const px = Math.round(x + dx);
        const py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        if (mask[py * width + px]) return true;
      }
    }
    return false;
  };

  const segments: Segment[] = [];
  let runStart: number | null = null;
  let lastInk: number | null = null;
  let inkSteps = 0;

  const close = (endAt: number) => {
    if (runStart === null) return;
    const length = endAt - runStart;
    if (length >= minLength) {
      segments.push({
        from: { x: originX + dirX * runStart, z: originY + dirY * runStart },
        to: { x: originX + dirX * endAt, z: originY + dirY * endAt },
        coverage: Math.min(1, inkSteps / Math.max(1, length)),
      });
    }
    runStart = null;
    inkSteps = 0;
  };

  for (let step = -reach; step <= reach; step++) {
    const x = originX + dirX * step;
    const y = originY + dirY * step;

    if (x < -tolerance || y < -tolerance || x > width + tolerance || y > height + tolerance) {
      // Outside the image: whatever run was open ends here.
      if (lastInk !== null) close(lastInk);
      lastInk = null;
      continue;
    }

    if (hasInkNear(x, y)) {
      if (runStart === null) runStart = step;
      lastInk = step;
      inkSteps += 1;
    } else if (lastInk !== null && step - lastInk > maxGap) {
      close(lastInk);
      lastInk = null;
    }
  }
  if (lastInk !== null) close(lastInk);

  return segments;
}

/* --------------------------------- Step 5 --------------------------------- */

const angleOf = (segment: Segment): number =>
  Math.atan2(segment.to.z - segment.from.z, segment.to.x - segment.from.x);

const lengthOf = (segment: Segment): number =>
  Math.hypot(segment.to.x - segment.from.x, segment.to.z - segment.from.z);

/** Smallest angle between two undirected lines, in radians. */
function angleBetween(a: number, b: number): number {
  let difference = Math.abs(a - b) % Math.PI;
  if (difference > Math.PI / 2) difference = Math.PI - difference;
  return difference;
}

/**
 * Pairs the two faces of each wall into one centreline.
 *
 * A wall on a plan is a pair of parallel lines a wall's thickness apart. Left
 * as they are, tracing produces two walls per wall — which looks nearly right
 * on screen and is completely wrong the moment anybody measures a room. So
 * parallel lines the right distance apart, overlapping along their length, are
 * recombined into a single wall down the middle with a real thickness.
 *
 * Greedy, best pair first: a wall that meets another at a corner could pair
 * with either, and taking the strongest agreement first is what stops one wall
 * stealing its neighbour's face.
 */
export function pairFaces(
  segments: readonly Segment[],
  minThickness: number,
  maxThickness: number,
): DetectedWall[] {
  interface Candidate {
    a: number;
    b: number;
    thickness: number;
    overlap: number;
  }

  const candidates: Candidate[] = [];

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i]!;
      const b = segments[j]!;

      // Parallel, within about three degrees.
      if (angleBetween(angleOf(a), angleOf(b)) > 0.055) continue;

      // How far apart, measured across the line rather than end to end.
      const direction = { x: Math.cos(angleOf(a)), z: Math.sin(angleOf(a)) };
      const normal = { x: -direction.z, z: direction.x };
      const offset = (b.from.x - a.from.x) * normal.x + (b.from.z - a.from.z) * normal.z;
      const thickness = Math.abs(offset);
      if (thickness < minThickness || thickness > maxThickness) continue;

      // And how much of their length they share.
      const project = (point: Point2) =>
        (point.x - a.from.x) * direction.x + (point.z - a.from.z) * direction.z;
      const aStart = 0;
      const aEnd = lengthOf(a);
      const bStart = Math.min(project(b.from), project(b.to));
      const bEnd = Math.max(project(b.from), project(b.to));

      const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
      if (overlap < Math.min(aEnd - aStart, bEnd - bStart) * 0.5) continue;

      candidates.push({ a: i, b: j, thickness, overlap });
    }
  }

  // The longest agreement wins first.
  candidates.sort((one, other) => other.overlap - one.overlap);

  const used = new Set<number>();
  const walls: DetectedWall[] = [];

  for (const candidate of candidates) {
    if (used.has(candidate.a) || used.has(candidate.b)) continue;
    used.add(candidate.a);
    used.add(candidate.b);

    const a = segments[candidate.a]!;
    const b = segments[candidate.b]!;
    const direction = { x: Math.cos(angleOf(a)), z: Math.sin(angleOf(a)) };
    const project = (point: Point2) =>
      (point.x - a.from.x) * direction.x + (point.z - a.from.z) * direction.z;

    // The centreline spans only the part both faces agree on.
    const start = Math.max(0, Math.min(project(b.from), project(b.to)));
    const end = Math.min(lengthOf(a), Math.max(project(b.from), project(b.to)));

    // The centreline sits half a thickness across from the first face, and runs
    // from a's own origin so that `start` and `end` above still mean what they
    // measured.
    const normal = { x: -direction.z, z: direction.x };
    const offset = ((b.from.x - a.from.x) * normal.x + (b.from.z - a.from.z) * normal.z) / 2;
    const base = { x: a.from.x + normal.x * offset, z: a.from.z + normal.z * offset };

    walls.push({
      from: { x: base.x + direction.x * start, z: base.z + direction.z * start },
      to: { x: base.x + direction.x * end, z: base.z + direction.z * end },
      thicknessPixels: candidate.thickness,
      confidence: Math.min(1, (a.coverage + b.coverage) / 2),
    });
  }

  // Whatever was left over is a line with only one face found.
  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    const segment = segments[i]!;
    walls.push({
      from: segment.from,
      to: segment.to,
      thicknessPixels: null,
      // Marked down, because an unpaired line is as likely to be a dimension
      // line or the edge of the sheet as it is to be a wall.
      confidence: segment.coverage * 0.6,
    });
  }

  return walls;
}

/* ------------------------------- Altogether ------------------------------- */

/**
 * Finds the walls in a plan image.
 *
 * Coordinates come back in the ORIGINAL image's pixels, whatever size the
 * detector chose to work at.
 */
export function detectWalls(
  image: Pixels,
  options: Partial<DetectionOptions> = {},
): DetectedWall[] {
  const settings = { ...DETECTION_DEFAULTS, ...options };
  const { pixels, factor } = reduce(image, settings.workingSize);

  const mask = inkMask(pixels);
  const minLength = Math.max(6, settings.minLength * factor);
  const maxGap = Math.max(2, settings.maxGap * factor);

  const lines = houghLines(
    mask,
    pixels.width,
    pixels.height,
    // A line has to be at least as well supported as the shortest wall worth
    // proposing, less a little for the pixels a doorway takes out of it.
    Math.max(12, Math.round(minLength * 0.55)),
    settings.maxWalls * 2,
  );

  const segments: Segment[] = [];
  for (const line of lines) {
    segments.push(
      ...segmentsAlong(line, mask, pixels.width, pixels.height, minLength, maxGap),
    );
  }

  const walls = pairFaces(
    segments,
    Math.max(2, settings.minThickness * factor),
    Math.max(4, settings.maxThickness * factor),
  );

  // Back into the original image's pixels.
  const scale = 1 / factor;
  return walls
    .map((wall) => ({
      ...wall,
      from: { x: wall.from.x * scale, z: wall.from.z * scale },
      to: { x: wall.to.x * scale, z: wall.to.z * scale },
      thicknessPixels: wall.thicknessPixels === null ? null : wall.thicknessPixels * scale,
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, settings.maxWalls);
}

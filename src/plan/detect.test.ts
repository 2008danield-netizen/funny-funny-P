/**
 * Tests for the wall detector.
 *
 * Drawn rather than photographed: every fixture here is a floor plan this file
 * generates, so the right answer is known exactly and a failure says which part
 * of the pipeline moved. A test against a real scan would be untestable in the
 * useful sense — nobody could say whether a change made it better or worse.
 *
 * What is checked is the shape of the answer, not the pixel: that the walls
 * come back where they were drawn, that a wall drawn as two faces comes back as
 * ONE wall with a thickness, that a doorway does not cut a wall in half, and
 * that a page of speckle produces nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  contentBounds,
  detectWalls,
  inkMask,
  otsuThreshold,
  pairFaces,
  toGrey,
  type DetectedWall,
  type Pixels,
} from './detect';

/* -------------------------------- Drawing --------------------------------- */

function sheet(width: number, height: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  return { width, height, data };
}

/** Draws a filled black rectangle, the way a plan draws a wall. */
function band(image: Pixels, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const index = (y * image.width + x) * 4;
      image.data[index] = 0;
      image.data[index + 1] = 0;
      image.data[index + 2] = 0;
    }
  }
}

/** A wall drawn as its two faces, thickness apart, as most plans draw them. */
function twoFacedWall(
  image: Pixels,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
): void {
  const horizontal = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
  const half = thickness / 2;
  if (horizontal) {
    band(image, x0, Math.round(y0 - half), x1, Math.round(y0 - half) + 1);
    band(image, x0, Math.round(y0 + half), x1, Math.round(y0 + half) + 1);
  } else {
    band(image, Math.round(x0 - half), y0, Math.round(x0 - half) + 1, y1);
    band(image, Math.round(x0 + half), y0, Math.round(x0 + half) + 1, y1);
  }
}

const near = (value: number, expected: number, tolerance: number) =>
  Math.abs(value - expected) <= tolerance;

/** Does a wall run roughly between these two points, either way round? */
function found(walls: readonly DetectedWall[], a: [number, number], b: [number, number], tolerance = 12) {
  return walls.some((wall) => {
    const forward =
      near(wall.from.x, a[0], tolerance) &&
      near(wall.from.z, a[1], tolerance) &&
      near(wall.to.x, b[0], tolerance) &&
      near(wall.to.z, b[1], tolerance);
    const backward =
      near(wall.from.x, b[0], tolerance) &&
      near(wall.from.z, b[1], tolerance) &&
      near(wall.to.x, a[0], tolerance) &&
      near(wall.to.z, a[1], tolerance);
    return forward || backward;
  });
}

/* -------------------------------- The steps ------------------------------- */

describe('ink and paper', () => {
  it('turns colour into brightness the way an eye does', () => {
    const image = sheet(2, 1);
    // Pure green is much brighter to us than pure blue, and an average would
    // call them the same — which turns a blue-inked plan into a faint one.
    image.data.set([0, 255, 0, 255, 0, 0, 255, 255]);
    const grey = toGrey(image);
    expect(grey[0]!).toBeGreaterThan(grey[1]!);
  });

  it('finds the split between ink and paper wherever it happens to be', () => {
    // A grey photocopy: paper at 190, ink at 90. A fixed threshold at 128 would
    // work here, but Otsu has to find it without being told.
    const image = sheet(20, 20);
    for (let i = 0; i < 400; i++) {
      const value = i < 100 ? 90 : 190;
      image.data.set([value, value, value, 255], i * 4);
    }
    // The split is reported as the top of the darker group, and `inkMask`
    // treats "at or below" as ink — so 90 here is exactly right.
    const threshold = otsuThreshold(toGrey(image));
    expect(threshold).toBeGreaterThanOrEqual(90);
    expect(threshold).toBeLessThan(190);

    const mask = inkMask(image);
    expect(mask[0]).toBe(1);
    expect(mask[399]).toBe(0);
  });

  it('finds the box the drawing sits in, ignoring the margins', () => {
    const image = sheet(200, 150);
    band(image, 50, 40, 150, 44);
    const bounds = contentBounds(image)!;

    expect(bounds.minX).toBe(50);
    expect(bounds.maxX).toBe(150);
    expect(bounds.minZ).toBe(40);
    expect(bounds.maxZ).toBe(44);
    expect(contentBounds(sheet(10, 10))).toBeNull();
  });
});

/* -------------------------------- The walls ------------------------------- */

describe('finding walls', () => {
  it('finds the four walls of a room drawn as filled bands', () => {
    const image = sheet(400, 300);
    band(image, 50, 50, 350, 56);   // top
    band(image, 50, 244, 350, 250); // bottom
    band(image, 50, 50, 56, 250);   // left
    band(image, 344, 50, 350, 250); // right

    const walls = detectWalls(image, { workingSize: 400, minLength: 60, minThickness: 3, maxThickness: 20 });

    expect(walls.length).toBeGreaterThanOrEqual(4);
    expect(found(walls, [50, 53], [350, 53], 14)).toBe(true);
    expect(found(walls, [50, 247], [350, 247], 14)).toBe(true);
  });

  it('reads a wall drawn as two faces as ONE wall with a thickness', () => {
    // This is the whole point of the pairing step. Two lines 10 px apart are a
    // 10 px wall, not two walls — and a plan traced the other way measures
    // every room wrong.
    const image = sheet(400, 200);
    twoFacedWall(image, 40, 100, 360, 100, 12);

    const walls = detectWalls(image, {
      workingSize: 400,
      minLength: 60,
      minThickness: 6,
      maxThickness: 24,
    });

    const paired = walls.filter((wall) => wall.thicknessPixels !== null);
    expect(paired.length).toBeGreaterThanOrEqual(1);
    expect(paired[0]!.thicknessPixels!).toBeGreaterThan(8);
    expect(paired[0]!.thicknessPixels!).toBeLessThan(18);
    // And down the middle of the two faces, not on either one.
    expect(Math.abs(paired[0]!.from.z - 100)).toBeLessThan(5);
  });

  it('carries a wall through a doorway rather than cutting it in two', () => {
    // A 300 px wall with a 24 px doorway in the middle is one wall.
    const image = sheet(400, 200);
    band(image, 50, 98, 188, 104);
    band(image, 212, 98, 350, 104);

    const walls = detectWalls(image, {
      workingSize: 400,
      minLength: 60,
      maxGap: 40,
      minThickness: 3,
      maxThickness: 20,
    });

    expect(found(walls, [50, 101], [350, 101], 16)).toBe(true);
  });

  it('stops at a real gap instead of joining two separate walls', () => {
    // The same drawing with a much larger break: two walls, not one.
    const image = sheet(400, 200);
    band(image, 20, 98, 140, 104);
    band(image, 260, 98, 380, 104);

    const walls = detectWalls(image, {
      workingSize: 400,
      minLength: 60,
      maxGap: 20,
      minThickness: 3,
      maxThickness: 20,
    });

    expect(found(walls, [20, 101], [380, 101], 16)).toBe(false);
    const spanning = walls.filter(
      (wall) => Math.hypot(wall.to.x - wall.from.x, wall.to.z - wall.from.z) > 300,
    );
    expect(spanning).toHaveLength(0);
  });

  it('finds a wall drawn at an angle', () => {
    const image = sheet(400, 400);
    for (let t = 0; t <= 300; t++) {
      const x = 50 + t;
      const y = 50 + t;
      band(image, x, y, x + 3, y + 3);
    }

    const walls = detectWalls(image, { workingSize: 400, minLength: 80, minThickness: 3, maxThickness: 20 });
    const diagonal = walls.find(
      (wall) => Math.abs(Math.abs(wall.to.x - wall.from.x) - Math.abs(wall.to.z - wall.from.z)) < 30,
    );
    expect(diagonal).toBeDefined();
  });

  it('proposes nothing from a blank sheet', () => {
    expect(detectWalls(sheet(200, 200), { workingSize: 200 })).toEqual([]);
  });

  it('proposes nothing from speckle', () => {
    // Scanner dirt: a few hundred isolated dots and no lines at all.
    const image = sheet(300, 300);
    let seed = 7;
    for (let i = 0; i < 400; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const x = seed % 300;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const y = seed % 300;
      band(image, x, y, x, y);
    }

    const walls = detectWalls(image, { workingSize: 300, minLength: 80, minThickness: 3, maxThickness: 20 });
    expect(walls).toEqual([]);
  });

  it('gives back coordinates in the original image, whatever size it worked at', () => {
    // Detection runs on a reduced copy; the answers must still be in the
    // caller's pixels or every traced wall lands at a fraction of its size.
    const image = sheet(1200, 800);
    band(image, 100, 400, 1100, 410);

    const walls = detectWalls(image, { workingSize: 300, minLength: 200, minThickness: 4, maxThickness: 40 });
    expect(walls.length).toBeGreaterThan(0);

    const longest = walls.reduce((best, wall) =>
      Math.hypot(wall.to.x - wall.from.x, wall.to.z - wall.from.z) >
      Math.hypot(best.to.x - best.from.x, best.to.z - best.from.z)
        ? wall
        : best,
    );
    /*
     * The drawn wall is 1000 px. What comes back is a little shorter, and on
     * purpose: where two faces are paired, the centreline spans only the part
     * they agree on. Overshooting would push walls into their neighbours at
     * every corner, and a short wall is dragged out in a second where a long
     * one has to be noticed first.
     */
    const length = Math.hypot(longest.to.x - longest.from.x, longest.to.z - longest.from.z);
    expect(length).toBeGreaterThan(750);
    expect(length).toBeLessThanOrEqual(1010);
    expect(Math.abs(longest.from.z - 405)).toBeLessThan(30);
  });
});

describe('pairing faces', () => {
  const line = (x0: number, y0: number, x1: number, y1: number, coverage = 1) => ({
    from: { x: x0, z: y0 },
    to: { x: x1, z: y1 },
    coverage,
  });

  it('leaves a lone line alone, and marks it down', () => {
    const walls = pairFaces([line(0, 0, 100, 0)], 4, 20);
    expect(walls).toHaveLength(1);
    expect(walls[0]!.thicknessPixels).toBeNull();
    // An unpaired line is as likely to be a dimension line as a wall.
    expect(walls[0]!.confidence).toBeLessThan(1);
  });

  it('will not pair lines that are too far apart to be one wall', () => {
    const walls = pairFaces([line(0, 0, 100, 0), line(0, 200, 100, 200)], 4, 20);
    expect(walls.every((wall) => wall.thicknessPixels === null)).toBe(true);
  });

  it('will not pair lines that barely overlap', () => {
    // Two faces of a wall run alongside each other for their whole length. Two
    // lines that share ten pixels at the end are a corner, not a wall.
    const walls = pairFaces([line(0, 0, 100, 0), line(95, 10, 200, 10)], 4, 20);
    expect(walls.every((wall) => wall.thicknessPixels === null)).toBe(true);
  });

  it('will not pair lines that are not parallel', () => {
    const walls = pairFaces([line(0, 0, 100, 0), line(0, 10, 100, 40)], 4, 60);
    expect(walls.every((wall) => wall.thicknessPixels === null)).toBe(true);
  });

  it('gives a corner its wall rather than letting one steal the other face', () => {
    // Two walls meeting at a corner, each drawn as two faces. Greedy on the
    // longest agreement first is what keeps them apart.
    const walls = pairFaces(
      [
        line(0, 0, 200, 0),
        line(0, 10, 200, 10),
        line(0, 0, 0, 150),
        line(10, 0, 10, 150),
      ],
      4,
      20,
    );

    const paired = walls.filter((wall) => wall.thicknessPixels !== null);
    expect(paired).toHaveLength(2);
  });
});

/**
 * Tests for straightening a photographed plan.
 *
 * The transform is checked by construction: build a known projective mapping,
 * push points through it, and ask the solver to find it again. Then the whole
 * round trip is run on a synthetic image — a rectangle photographed at an angle
 * — and the straightened result is checked for being straight.
 */

import { describe, expect, it } from 'vitest';

import type { Point2 } from '@/state/types';

import {
  applyHomography,
  orderCorners,
  resampleThrough,
  solveHomography,
  straightenedSize,
} from './perspective';

const p = (x: number, z: number): Point2 => ({ x, z });

const square: Point2[] = [p(0, 0), p(100, 0), p(100, 100), p(0, 100)];

describe('solving the transform', () => {
  it('finds the identity when nothing moved', () => {
    const h = solveHomography(square, square)!;
    for (const point of [p(13, 47), p(99, 1)]) {
      const mapped = applyHomography(h, point);
      expect(mapped.x).toBeCloseTo(point.x, 6);
      expect(mapped.z).toBeCloseTo(point.z, 6);
    }
  });

  it('finds a plain scale and shift', () => {
    const moved = square.map((point) => p(point.x * 2 + 30, point.z * 2 - 10));
    const h = solveHomography(square, moved)!;

    const mapped = applyHomography(h, p(50, 50));
    expect(mapped.x).toBeCloseTo(130, 6);
    expect(mapped.z).toBeCloseTo(90, 6);
  });

  it('finds a genuine perspective, where parallel lines stop being parallel', () => {
    // A trapezium: the far edge is half the width of the near one, which is
    // what a sheet on a table looks like from a person's eye height.
    const photo: Point2[] = [p(25, 0), p(75, 0), p(100, 100), p(0, 100)];
    const h = solveHomography(square, photo)!;

    for (let i = 0; i < 4; i++) {
      const mapped = applyHomography(h, square[i]!);
      expect(mapped.x).toBeCloseTo(photo[i]!.x, 4);
      expect(mapped.z).toBeCloseTo(photo[i]!.z, 4);
    }

    /*
     * The middle of the square does NOT land at the middle of the trapezium —
     * that is the whole difference between a perspective and a stretch. The
     * short edge is the FAR one, so the far half of the sheet is squashed into
     * less of the picture and the object's midline appears nearer to it.
     */
    const middle = applyHomography(h, p(50, 50));
    expect(middle.x).toBeCloseTo(50, 4);
    expect(middle.z).toBeLessThan(50);
  });

  it('inverts: pushing back through undoes it', () => {
    const photo: Point2[] = [p(25, 0), p(75, 0), p(100, 100), p(0, 100)];
    const forward = solveHomography(square, photo)!;
    const backward = solveHomography(photo, square)!;

    for (const point of [p(10, 10), p(90, 40), p(50, 99)]) {
      const there = applyHomography(forward, point);
      const back = applyHomography(backward, there);
      expect(back.x).toBeCloseTo(point.x, 3);
      expect(back.z).toBeCloseTo(point.z, 3);
    }
  });

  it('refuses degenerate corners rather than producing a folded image', () => {
    // Three points in a line: there is no transform, and a solver that returns
    // one anyway hands back an image turned inside out.
    expect(solveHomography(square, [p(0, 0), p(50, 0), p(100, 0), p(0, 100)])).toBeNull();
    expect(solveHomography(square, [p(0, 0), p(0, 0), p(100, 100), p(0, 100)])).toBeNull();
    expect(solveHomography(square, [p(0, 0), p(1, 1)])).toBeNull();
  });
});

describe('ordering the corners', () => {
  it('puts them top-left, top-right, bottom-right, bottom-left, whatever order they were clicked', () => {
    const clicked = [p(100, 100), p(0, 100), p(0, 0), p(100, 0)];
    const ordered = orderCorners(clicked)!;

    expect(ordered[0]).toEqual(p(0, 0));
    expect(ordered[1]).toEqual(p(100, 0));
    expect(ordered[2]).toEqual(p(100, 100));
    expect(ordered[3]).toEqual(p(0, 100));
  });

  it('handles a photographed sheet, which is not a rectangle', () => {
    const clicked = [p(120, 480), p(90, 60), p(510, 100), p(560, 450)];
    const ordered = orderCorners(clicked)!;

    // Whatever it picks, it must go round the sheet rather than crossing it:
    // adjacent corners in the result are adjacent on the paper.
    const crosses = (a: Point2, b: Point2, c: Point2, d: Point2) => {
      const side = (p1: Point2, p2: Point2, q: Point2) =>
        Math.sign((p2.x - p1.x) * (q.z - p1.z) - (p2.z - p1.z) * (q.x - p1.x));
      return (
        side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b)
      );
    };
    expect(crosses(ordered[0]!, ordered[1]!, ordered[2]!, ordered[3]!)).toBe(false);
    expect(orderCorners([p(0, 0)])).toBeNull();
  });

  it('sizes the output from the longer of each pair of opposite sides', () => {
    // Near edge 400 px, far edge 200: keep the detail from the near one.
    const ordered = [p(100, 0), p(300, 0), p(400, 300), p(0, 300)];
    const size = straightenedSize(ordered);
    expect(size.width).toBe(400);
    expect(size.height).toBeGreaterThan(290);
  });
});

describe('resampling', () => {
  /** A tiny image with a single black pixel block in a known place. */
  function blank(width: number, height: number) {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    return { width, height, data };
  }

  function paint(image: ReturnType<typeof blank>, x: number, y: number) {
    const index = (y * image.width + x) * 4;
    image.data[index] = 0;
    image.data[index + 1] = 0;
    image.data[index + 2] = 0;
  }

  it('straightens a photographed rectangle back into a rectangle', () => {
    // A 40 x 40 "photo" holding a trapezium, with a mark at the middle of its
    // top edge; straightened, that mark must land at the middle of the top.
    const photo = blank(40, 40);
    for (let x = 14; x <= 26; x++) paint(photo, x, 4);

    const corners = [p(10, 4), p(30, 4), p(38, 36), p(2, 36)];
    const output = blank(40, 40);
    const inverse = solveHomography(
      [p(0, 0), p(40, 0), p(40, 40), p(0, 40)],
      corners,
    )!;
    resampleThrough(photo, output, inverse);

    const darkAt = (x: number, y: number) => output.data[(y * output.width + x) * 4]! < 128;
    // The mark ran across the middle of the top edge of the sheet, so it is
    // across the middle of the top of the straightened image.
    expect(darkAt(20, 0)).toBe(true);
    // And the corners of the sheet are paper, not ink.
    expect(darkAt(1, 38)).toBe(false);
  });

  it('fills anything off the photograph with paper white, not black', () => {
    const photo = blank(10, 10);
    const output = blank(10, 10);
    // A transform that sends everything off the edge.
    const inverse = solveHomography(
      [p(0, 0), p(10, 0), p(10, 10), p(0, 10)],
      [p(100, 100), p(110, 100), p(110, 110), p(100, 110)],
    )!;
    resampleThrough(photo, output, inverse);

    expect(output.data[0]).toBe(255);
    expect(output.data[3]).toBe(255);
  });
});

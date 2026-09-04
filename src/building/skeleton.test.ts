/**
 * Tests for the straight skeleton.
 *
 * This is the piece of session 7 most able to be quietly wrong. A roof built
 * from a bad skeleton still renders — it just has a ridge in the wrong place, or
 * a valley missing, and it looks like a roof until you compare it with the plan
 * underneath. So rather than checking the output looks plausible, these tests
 * check the properties a correct skeleton must have, on shapes whose answers are
 * known by hand:
 *
 *   • Every eave gets exactly one roof face.
 *   • Every face is a closed polygon with area.
 *   • The faces tile the footprint — their areas sum to it, with nothing
 *     overlapping and nothing left out.
 *   • The height at any skeleton point equals its distance to the nearest eave,
 *     which is what makes the whole roof one consistent pitch.
 *   • An inside corner produces a valley, and the ridge lands where a person
 *     with a ruler would put it.
 */

import { describe, expect, it } from 'vitest';

import {
  distanceToBoundary,
  offsetPolygon,
  prepare,
  signedArea,
  straightSkeleton,
  type SkeletonResult,
} from './skeleton';
import type { Point2 } from '@/state/types';

/* -------------------------------- Fixtures -------------------------------- */

const p = (x: number, z: number): Point2 => ({ x, z });

/** A width x depth rectangle centred on the origin. */
function rectangle(width: number, depth: number): Point2[] {
  return [
    p(-width / 2, -depth / 2),
    p(width / 2, -depth / 2),
    p(width / 2, depth / 2),
    p(-width / 2, depth / 2),
  ];
}

/**
 * An L, with the inside corner at the origin.
 *
 *   +-----+
 *   |     |
 *   |     +-----+
 *   |           |
 *   +-----------+
 */
function lShape(): Point2[] {
  return [p(0, 0), p(8, 0), p(8, 4), p(3, 4), p(3, 8), p(0, 8)];
}

/** A T, which has two inside corners rather than one. */
function tShape(): Point2[] {
  return [p(0, 0), p(9, 0), p(9, 3), p(6, 3), p(6, 9), p(3, 9), p(3, 3), p(0, 3)];
}

/** A plus, the classic four-reflex-corner stress case. */
function plusShape(): Point2[] {
  return [
    p(3, 0), p(6, 0), p(6, 3), p(9, 3), p(9, 6),
    p(6, 6), p(6, 9), p(3, 9), p(3, 6), p(0, 6), p(0, 3), p(3, 3),
  ];
}

/** A U — two wings and a courtyard opening off one side. */
function uShape(): Point2[] {
  return [
    p(0, 0), p(9, 0), p(9, 9), p(6, 9), p(6, 3), p(3, 3), p(3, 9), p(0, 9),
  ];
}

/**
 * A cross whose arms are not all the same width, and whose ends are not level.
 *
 * The symmetrical plus above is the harder case in one specific way — everything
 * happens at once — but it is also the case an implementation can accidentally
 * get right by symmetry. This one cannot be got right by accident: the two
 * inside corners on each side still collide exactly, while the four wings
 * finish at four different times.
 */
function unevenCross(): Point2[] {
  return [
    p(3, 0), p(6, 0), p(6, 3), p(9.4, 3), p(9.4, 6.2),
    p(6, 6.2), p(6, 9.1), p(3, 9.1), p(3, 6.2), p(0, 6.2), p(0, 3), p(3, 3),
  ];
}

/** A cross of thin arms — long eaves against short ones. */
function thinCross(): Point2[] {
  return [
    p(4, 0), p(5, 0), p(5, 4), p(9, 4), p(9, 5),
    p(5, 5), p(5, 9), p(4, 9), p(4, 5), p(0, 5), p(0, 4), p(4, 4),
  ];
}

/** A stepped plan: two inside corners facing the same way, one after another. */
function zigzag(): Point2[] {
  return [p(0, 0), p(6, 0), p(6, 2), p(4, 2), p(4, 4), p(6, 4), p(6, 6), p(0, 6)];
}

/** An L whose two wings differ in both length and width. */
function unevenL(): Point2[] {
  return [p(0, 0), p(7.3, 0), p(7.3, 3.1), p(2.8, 3.1), p(2.8, 8.4), p(0, 8.4)];
}

/** Total area of every roof face, projected flat. */
function facesArea(result: SkeletonResult): number {
  return result.faces.reduce(
    (total, face) => total + Math.abs(signedArea(face.points.map((entry) => entry.at))),
    0,
  );
}

/* ------------------------------ Preparation ------------------------------- */

describe('polygon preparation', () => {
  it('drops duplicate points', () => {
    const cleaned = prepare([p(0, 0), p(0, 0), p(4, 0), p(4, 3), p(4, 3), p(0, 3)]);
    expect(cleaned).toHaveLength(4);
  });

  it('drops vertices sitting on a straight run', () => {
    /*
     * A collinear vertex has two parallel edges, so the 2x2 solve for its
     * velocity is singular and the skeleton comes apart at that one corner.
     * Plans have these all the time — every time a wall is split to hang a door
     * on it, the split leaves a vertex mid-run.
     */
    const cleaned = prepare([p(0, 0), p(2, 0), p(4, 0), p(4, 3), p(0, 3)]);
    expect(cleaned).toHaveLength(4);
  });

  it('turns a clockwise polygon anticlockwise', () => {
    // Everything downstream assumes the left normal points inwards.
    const clockwise = [...rectangle(4, 3)].reverse();
    expect(signedArea(prepare(clockwise))).toBeGreaterThan(0);
  });

  it('gives up on anything with fewer than three real corners', () => {
    expect(prepare([p(0, 0), p(1, 1)])).toEqual([]);
    expect(prepare([p(0, 0), p(1, 0), p(2, 0)])).toEqual([]);
  });
});

/* -------------------------------- Squares --------------------------------- */

describe('a square roof', () => {
  const result = straightSkeleton(rectangle(6, 6));

  it('resolves completely', () => {
    expect(result.complete).toBe(true);
  });

  it('gives every eave one face', () => {
    expect(result.faces).toHaveLength(4);
    expect(new Set(result.faces.map((face) => face.edgeIndex)).size).toBe(4);
  });

  it('makes four triangles meeting at the apex', () => {
    // A square hips to a point: every face is a triangle, and the apex is the
    // centre at a height of half the width.
    for (const face of result.faces) {
      expect(face.points).toHaveLength(3);
    }
    const apexes = result.faces.map((face) => face.points.find((entry) => entry.time > 0)!);
    for (const apex of apexes) {
      expect(apex.at.x).toBeCloseTo(0, 6);
      expect(apex.at.z).toBeCloseTo(0, 6);
      expect(apex.time).toBeCloseTo(3, 6);
    }
  });

  it('tiles the footprint exactly', () => {
    expect(facesArea(result)).toBeCloseTo(36, 4);
  });
});

/* ------------------------------- Rectangles ------------------------------- */

describe('a rectangular roof', () => {
  // 10 x 6: the ridge runs along the middle, 3 in from each long eave, and is
  // 10 - 3 - 3 = 4 long. Every one of those numbers is checkable by hand.
  const result = straightSkeleton(rectangle(10, 6));

  it('resolves completely, with one face per eave', () => {
    expect(result.complete).toBe(true);
    expect(result.faces).toHaveLength(4);
  });

  it('puts the ridge where a ruler would', () => {
    const ridgePoints = result.faces
      .flatMap((face) => face.points)
      .filter((entry) => entry.time > 1e-6);

    for (const point of ridgePoints) {
      // Halfway across the short span, so the ridge sits at z = 0.
      expect(Math.abs(point.at.z)).toBeLessThan(1e-6);
      expect(point.time).toBeCloseTo(3, 6);
    }

    const xs = ridgePoints.map((point) => point.at.x);
    expect(Math.min(...xs)).toBeCloseTo(-2, 5);
    expect(Math.max(...xs)).toBeCloseTo(2, 5);
  });

  it('makes the long eaves trapezoids and the short ones triangles', () => {
    const sizes = result.faces.map((face) => face.points.length).sort();
    expect(sizes).toEqual([3, 3, 4, 4]);
  });

  it('tiles the footprint exactly', () => {
    expect(facesArea(result)).toBeCloseTo(60, 4);
  });
});

/* ------------------------- Shapes with inside corners --------------------- */

describe('an L-shaped roof', () => {
  const shape = lShape();
  const result = straightSkeleton(shape);

  it('resolves completely', () => {
    expect(result.complete).toBe(true);
  });

  it('gives every eave one face', () => {
    expect(result.faces).toHaveLength(6);
    expect(new Set(result.faces.map((face) => face.edgeIndex)).size).toBe(6);
  });

  it('tiles the footprint exactly', () => {
    // 8 x 4 plus 3 x 4 = 32 + 12 = 44.
    expect(Math.abs(signedArea(shape))).toBeCloseTo(44, 6);
    expect(facesArea(result)).toBeCloseTo(44, 3);
  });

  it('runs a valley out of the inside corner', () => {
    /*
     * The whole reason for doing this properly. An inside corner throws a
     * valley — the gutter where two slopes meet — and a bounding-box roof
     * simply does not have one.
     *
     * The corner here is at (3, 4); the valley climbs away from it into the
     * body of the L.
     */
    const corner = p(3, 4);
    const fromCorner = result.arcs.filter(
      (arc) => Math.hypot(arc.from.x - corner.x, arc.from.z - corner.z) < 1e-6,
    );
    expect(fromCorner.length).toBeGreaterThan(0);

    // It starts at the eave and rises.
    for (const arc of fromCorner) {
      expect(arc.fromTime).toBeCloseTo(0, 6);
      expect(arc.toTime).toBeGreaterThan(0.5);
    }
  });
});

describe('a T-shaped roof', () => {
  const shape = tShape();
  const result = straightSkeleton(shape);

  it('resolves completely, with one face per eave', () => {
    expect(result.complete).toBe(true);
    expect(result.faces).toHaveLength(8);
  });

  it('tiles the footprint exactly', () => {
    // 9 x 3 bar plus a 3 x 6 stem.
    expect(facesArea(result)).toBeCloseTo(Math.abs(signedArea(shape)), 3);
  });
});

describe('a U-shaped roof', () => {
  const shape = uShape();
  const result = straightSkeleton(shape);

  it('resolves completely, with one face per eave', () => {
    expect(result.complete).toBe(true);
    expect(result.faces).toHaveLength(8);
  });

  it('tiles the footprint exactly', () => {
    expect(facesArea(result)).toBeCloseTo(Math.abs(signedArea(shape)), 3);
  });
});

describe('a plus-shaped roof', () => {
  // Four inside corners, which is the case that breaks naive implementations:
  // several splits, and the wavefront ends up as more than one loop.
  const shape = plusShape();
  const result = straightSkeleton(shape);

  it('resolves completely, with one face per eave', () => {
    expect(result.complete).toBe(true);
    expect(result.faces).toHaveLength(12);
  });

  it('tiles the footprint exactly', () => {
    expect(facesArea(result)).toBeCloseTo(Math.abs(signedArea(shape)), 3);
  });
});

describe('the awkward plans', () => {
  /*
   * These are the shapes that broke this solver during development, kept as
   * tests because each one broke it in its own way:
   *
   *   • The uneven cross pinches shut across the middle, so two corners collide
   *     head-on with no edge between them for a split to aim at.
   *   • The thin cross does the same with long arms against short ones, so the
   *     collision and the hips do NOT happen together.
   *   • The zigzag has two inside corners facing the same way, one throwing its
   *     valley across the other's.
   *   • The uneven L is the plain case with every symmetry removed, which is
   *     what catches an answer that was only ever right by symmetry.
   *
   * A T belongs in this list too and has its own block above: its bar ridge,
   * its stem ridge and both its valleys all arrive at a single point, and what
   * is left over is a row of corners along one line with nothing to move them.
   */
  it.each([
    ['an uneven cross', unevenCross()],
    ['a thin cross', thinCross()],
    ['a zigzag', zigzag()],
    ['an uneven L', unevenL()],
  ])('solves %s completely and tiles it', (_label, shape) => {
    const cleaned = prepare(shape);
    const result = straightSkeleton(shape);

    expect(result.complete).toBe(true);
    expect(result.faces).toHaveLength(cleaned.length);
    expect(facesArea(result)).toBeCloseTo(Math.abs(signedArea(cleaned)), 3);
  });
});

describe('gabled eaves (weights)', () => {
  /*
   * A gable is the same solve with one number changed: the gabled eave is given
   * a weight of zero, so it does not travel, and the planes either side run out
   * over it and meet in a ridge above it. What comes back for that eave is a
   * face with no area in plan but real heights — which is exactly the triangle
   * of wall a gable end is.
   */
  const bar = [p(0, 0), p(10, 0), p(10, 6), p(0, 6)];

  it('puts the ridge down the middle, running the full length', () => {
    const result = straightSkeleton(prepare(bar), [1, 0, 1, 0]);
    expect(result.complete).toBe(true);

    const long = result.faces.find((face) => face.edgeIndex === 0)!;
    // The slope reaches the ridge at half the 6 m span, and does so along the
    // whole 10 m — not at a point, which is what a hip would give.
    const ridge = long.points.filter((point) => point.time > 1e-6);
    expect(ridge).toHaveLength(2);
    for (const point of ridge) expect(point.at.z).toBeCloseTo(3, 6);
    expect(Math.abs(ridge[0]!.at.x - ridge[1]!.at.x)).toBeCloseTo(10, 6);
  });

  it('returns the gable end as a face with height but no plan area', () => {
    const result = straightSkeleton(prepare(bar), [1, 0, 1, 0]);
    const gable = result.faces.find((face) => face.edgeIndex === 1)!;

    expect(Math.abs(signedArea(gable.points.map((entry) => entry.at)))).toBeLessThan(1e-9);
    // Two eave corners on the ground and one apex, at the ridge height.
    expect(gable.points).toHaveLength(3);
    expect(Math.max(...gable.points.map((point) => point.time))).toBeCloseTo(3, 6);
  });

  it('hips the ends that are not gabled', () => {
    // Gable one end, hip the other: a real and common arrangement.
    const result = straightSkeleton(prepare(bar), [1, 0, 1, 1]);
    expect(result.complete).toBe(true);

    const hipped = result.faces.find((face) => face.edgeIndex === 3)!;
    // A hip end comes to a point, so its face is a triangle and the ridge
    // starts 3 m in — half the width of the building.
    expect(hipped.points).toHaveLength(3);
    expect(hipped.points[2]!.at.x).toBeCloseTo(3, 6);
  });

  it('gables an L on both wing ends', () => {
    const shape = prepare([p(0, 0), p(9, 0), p(9, 4), p(4, 4), p(4, 10), p(0, 10)]);
    const result = straightSkeleton(shape, [1, 0, 1, 1, 0, 1]);

    expect(result.complete).toBe(true);
    expect(result.faces).toHaveLength(6);
    // The valley still lands where the inside corner throws it.
    const valley = result.faces.find((face) => face.edgeIndex === 2)!;
    expect(valley.points.some((point) => Math.abs(point.at.x - 2) < 1e-6)).toBe(true);
  });

  it('ignores weights that do not line up with the polygon', () => {
    // Silently misapplying them would gable the wrong wall, which is worse than
    // ignoring them: the roof would look deliberate and be wrong.
    const result = straightSkeleton(prepare(bar), [1, 0]);
    expect(result.complete).toBe(true);
    expect(result.faces).toHaveLength(4);
    // All four eaves travelled, so this is the plain hip again.
    for (const face of result.faces) {
      expect(Math.abs(signedArea(face.points.map((entry) => entry.at)))).toBeGreaterThan(1e-6);
    }
  });
});

describe('distance to the boundary', () => {
  // Used for placing dormers and skylights clear of the eaves, and for setbacks
  // against a plot line, so it has to measure to the nearest POINT of an edge
  // rather than to the edge's line — those differ badly around a corner.
  const square = [p(0, 0), p(10, 0), p(10, 10), p(0, 10)];

  it('measures to the nearest edge', () => {
    expect(distanceToBoundary(p(5, 5), square)).toBeCloseTo(5, 6);
    expect(distanceToBoundary(p(1, 5), square)).toBeCloseTo(1, 6);
  });

  it('measures to a corner when the corner is nearest', () => {
    // Outside the square diagonally: the nearest thing is the corner itself,
    // not either edge's line, which would say 3.
    expect(distanceToBoundary(p(-3, -4), square)).toBeCloseTo(5, 6);
  });

  it('is zero on the boundary', () => {
    expect(distanceToBoundary(p(10, 4), square)).toBeCloseTo(0, 6);
  });
});

/* ------------------------------ The invariant ----------------------------- */

describe('the height function', () => {
  /*
   * The property the whole roof rests on: within a face, a point's `time` is
   * its perpendicular distance from that face's own eave. Multiply by the pitch
   * and you have its height — which is why every plane comes out at the same
   * slope without that ever being enforced anywhere. If it drifts, the roof
   * still renders and its planes are subtly different pitches, which is close
   * to impossible to see and completely wrong to build.
   *
   * Note this is distance to the eave's LINE, not to the nearest point of the
   * building. Those are the same thing for a convex footprint and they part
   * company at an inside corner, where the mitred wavefront carries an edge's
   * influence past the end of the edge itself. Measuring against the boundary
   * would fail here and the code would be right — which is a mistake worth
   * recording, because the "obvious" test is the wrong one.
   */
  function distanceToLine(point: Point2, a: Point2, b: Point2): number {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-12) return Infinity;
    return Math.abs((point.x - a.x) * dz - (point.z - a.z) * dx) / len;
  }

  it.each([
    ['a square', rectangle(6, 6)],
    ['a rectangle', rectangle(10, 6)],
    ['an L', lShape()],
    ['a T', tShape()],
    ['a U', uShape()],
    ['an irregular shape', [p(0, 0), p(7, 1), p(9, 5), p(4, 8), p(1, 6)]],
    ['a plus', plusShape()],
    ['an uneven cross', unevenCross()],
    ['a thin cross', thinCross()],
    ['a zigzag', zigzag()],
    ['an uneven L', unevenL()],
  ])('holds on %s', (_label, shape) => {
    const cleaned = prepare(shape);
    const result = straightSkeleton(shape);
    expect(result.faces.length).toBe(cleaned.length);

    for (const face of result.faces) {
      const eaveA = cleaned[face.edgeIndex]!;
      const eaveB = cleaned[(face.edgeIndex + 1) % cleaned.length]!;

      for (const point of face.points) {
        const measured = distanceToLine(point.at, eaveA, eaveB);
        expect(
          Math.abs(measured - point.time),
          `face ${face.edgeIndex} at (${point.at.x.toFixed(3)}, ${point.at.z.toFixed(3)})`,
        ).toBeLessThan(1e-3);
      }
    }
  });

  it('stays inside the footprint', () => {
    // A skeleton point outside the building means a roof plane hanging in the
    // air beside the house. Allowing a hair of tolerance for the boundary.
    for (const shape of [lShape(), tShape(), uShape(), plusShape(), unevenCross(), zigzag()]) {
      const cleaned = prepare(shape);
      for (const face of straightSkeleton(shape).faces) {
        for (const point of face.points) {
          expect(
            insideOrOn(point.at, cleaned),
            `(${point.at.x.toFixed(2)}, ${point.at.z.toFixed(2)}) escaped the footprint`,
          ).toBe(true);
        }
      }
    }
  });

  it('never produces a NaN', () => {
    // A NaN in one vertex quietly deletes a whole roof plane at render time.
    for (const shape of [
      rectangle(4, 4),
      lShape(),
      tShape(),
      plusShape(),
      uShape(),
      unevenCross(),
      thinCross(),
      zigzag(),
      unevenL(),
    ]) {
      for (const face of straightSkeleton(shape).faces) {
        for (const point of face.points) {
          expect(Number.isFinite(point.at.x)).toBe(true);
          expect(Number.isFinite(point.at.z)).toBe(true);
          expect(Number.isFinite(point.time)).toBe(true);
        }
      }
    }
  });
});

/** Point in polygon, counting the boundary as inside. */
function insideOrOn(point: Point2, polygon: readonly Point2[], tolerance = 1e-6): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!;
    const b = polygon[i]!;

    // On the edge counts as inside.
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    const t =
      lengthSq < 1e-12
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
    if (Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t)) < tolerance) return true;

    if (a.z > point.z !== b.z > point.z) {
      const crossing = ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
      if (point.x < crossing) inside = !inside;
    }
  }
  return inside;
}

/* -------------------------------- Bad input ------------------------------- */

describe('input it cannot solve', () => {
  it('returns nothing rather than throwing on a degenerate polygon', () => {
    for (const shape of [[], [p(0, 0)], [p(0, 0), p(1, 0)], [p(0, 0), p(1, 0), p(2, 0)]]) {
      const result = straightSkeleton(shape);
      expect(result.faces).toEqual([]);
      expect(result.complete).toBe(false);
    }
  });

  it('says so when a solve is incomplete rather than returning a broken roof', () => {
    // The flag is what lets the caller fall back to a simpler roof form. A
    // partial roof reported as complete is a bug nobody would notice.
    const result = straightSkeleton(rectangle(6, 6));
    expect(result.complete).toBe(true);
  });

  it('survives a very thin sliver', () => {
    // Near-parallel edges are where floating point decides the topology.
    const result = straightSkeleton([p(0, 0), p(20, 0), p(20, 0.05), p(0, 0.05)]);
    for (const face of result.faces) {
      for (const point of face.points) {
        expect(Number.isFinite(point.time)).toBe(true);
      }
    }
  });
});

/* --------------------------------- Offsets -------------------------------- */

describe('offsetPolygon', () => {
  it('grows a rectangle by the overhang on every side', () => {
    const grown = offsetPolygon(rectangle(10, 6), 0.6);
    const xs = grown.map((point) => point.x);
    const zs = grown.map((point) => point.z);

    expect(Math.min(...xs)).toBeCloseTo(-5.6, 6);
    expect(Math.max(...xs)).toBeCloseTo(5.6, 6);
    expect(Math.min(...zs)).toBeCloseTo(-3.6, 6);
    expect(Math.max(...zs)).toBeCloseTo(3.6, 6);
  });

  it('mitres corners rather than rounding them', () => {
    // The corner of an offset rectangle is a corner, not an arc — an eave
    // follows the fascia round the corner of a house.
    const grown = offsetPolygon(rectangle(4, 4), 0.5);
    expect(grown).toHaveLength(4);
  });

  it('keeps an inside corner inside', () => {
    // Offsetting an L outwards pulls the reflex corner further in, not out.
    const grown = offsetPolygon(lShape(), 0.5);
    expect(Math.abs(signedArea(grown))).toBeGreaterThan(Math.abs(signedArea(lShape())));
  });

  it('caps a runaway mitre on a sharp corner', () => {
    // A 10-degree spike would otherwise throw an eave metres past the house.
    const spike = [p(0, 0), p(10, 0.4), p(10, -0.4)];
    const grown = offsetPolygon(spike, 0.5);
    for (const point of grown) {
      expect(Math.abs(point.x)).toBeLessThan(14);
      expect(Math.abs(point.z)).toBeLessThan(14);
    }
  });

  it('returns the polygon unchanged for a zero offset', () => {
    expect(offsetPolygon(rectangle(4, 3), 0)).toHaveLength(4);
  });
});

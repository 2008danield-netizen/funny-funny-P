/**
 * The shapes have to be solid, and solid the right way round.
 *
 * -----------------------------------------------------------------------------
 * WHY SIGNED VOLUME IS THE RIGHT TEST.
 *
 * Every shape in `profiles.ts` is a closed skin built by stitching rings, and
 * the one thing that silently goes wrong in that construction is the winding.
 * An inside-out solid is not a visible bug: back-face culling hides the near
 * surface and shows the far one, which under an environment map and a baked
 * ambient term renders as a slightly odd, slightly dark material rather than as
 * anything obviously broken. Four sessions of this project have now been spent
 * chasing defects that looked plausible on screen, so the check here is a number
 * rather than a picture.
 *
 * The divergence theorem gives it for free. For a closed triangulated surface,
 *
 *     V = (1/6) Σ  p0 · (p1 × p2)
 *
 * over every triangle, and the sign of V is the sign of the winding. Outward
 * normals give a positive volume; flip the winding and the same shape reports a
 * negative one of equal magnitude. That single scalar catches an inverted solid,
 * an unclosed one (the sum drifts away from the true volume) and a cap wound the
 * wrong way (the sum lands short by exactly the cap's contribution).
 *
 * Comparing it against the ANALYTIC volume then does the second job: it proves
 * the shape is the size it was asked for, which is the check that would have
 * caught the fielded door panel swelling 45 mm wider than its own stiles.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  circleSection,
  lathe,
  loft,
  roundedRectSection,
  sweep,
  taperedProfile,
} from './profiles';

/**
 * Every triangle, whether the geometry is indexed or not.
 *
 * `creaseNormals` runs at the end of almost every builder in `profiles.ts` and
 * it DE-INDEXES — it has to, because splitting a normal at a crease means
 * splitting the vertex. An earlier version of this file read `geometry.index`
 * and returned zero when it was absent, so every shape that creased reported a
 * volume of exactly 0 and the suite looked like it was failing on the maths
 * rather than on the instrument. Reading triangles through one accessor is the
 * fix, and it is the same lesson as the render probes: an instrument that
 * quietly returns nothing is worse than no instrument.
 */
function* triangles(geometry: THREE.BufferGeometry): Generator<[number, number, number]> {
  const position = geometry.getAttribute('position');
  if (!position) return;

  const index = geometry.index;
  const count = index ? index.count : position.count;
  for (let i = 0; i < count; i += 3) {
    if (index) yield [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    else yield [i, i + 1, i + 2];
  }
}

/** The enclosed volume, signed by the winding. Positive means outward. */
function signedVolume(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  if (!position) return 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();

  let total = 0;
  for (const [x, y, z] of triangles(geometry)) {
    a.fromBufferAttribute(position, x);
    b.fromBufferAttribute(position, y);
    c.fromBufferAttribute(position, z);
    cross.crossVectors(b, c);
    total += a.dot(cross);
  }
  return total / 6;
}

/**
 * Whether every edge is shared by exactly two triangles.
 *
 * A closed solid has no boundary. This catches a missing cap, which signed
 * volume alone can miss when the hole happens to sit near the origin.
 *
 * Edges are keyed by POSITION rather than by vertex index, because a de-indexed
 * geometry has a separate vertex for every corner of every triangle and no two
 * triangles would ever share an index. Rounded to a tenth of a millimetre,
 * which is far finer than any feature here and far coarser than the float error
 * from a rotation.
 */
function isWatertight(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  if (!position) return false;

  const key = (i: number) =>
    `${Math.round(position.getX(i) * 1e4)},${Math.round(position.getY(i) * 1e4)},${Math.round(position.getZ(i) * 1e4)}`;

  const counts = new Map<string, number>();
  const bump = (from: string, to: string) => {
    const edge = from < to ? `${from}|${to}` : `${to}|${from}`;
    counts.set(edge, (counts.get(edge) ?? 0) + 1);
  };

  for (const [x, y, z] of triangles(geometry)) {
    const a = key(x);
    const b = key(y);
    const c = key(z);
    // A cap fan on a profile that closes to the axis produces degenerate
    // triangles whose edges have zero length; they enclose no volume and have
    // no boundary to check.
    if (a === b || b === c || c === a) continue;
    bump(a, b);
    bump(b, c);
    bump(c, a);
  }

  for (const count of counts.values()) if (count !== 2) return false;
  return true;
}

/** Shoelace area of a 2D section. Positive means anticlockwise. */
function shoelace(points: readonly THREE.Vector2[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/**
 * Ring of `section` lifted to a horizontal plane at height `y`.
 *
 * Traversed backwards, for the reason written at length in `lathe`: laying a
 * section in world XZ and stacking up world +Y is a left-handed frame against
 * the one `loft` was derived for, so a ring taken in its original order comes
 * out wound inward. A caller of `loft` that stacks along +Y has to do this, and
 * the test does it the same way the library does so the test is exercising the
 * real convention rather than a convenient one.
 */
function ringAt(section: readonly THREE.Vector2[], y: number): THREE.Vector3[] {
  return [...section].reverse().map((point) => new THREE.Vector3(point.x, y, point.y));
}

describe('sections are anticlockwise, which is what the winding assumes', () => {
  it('draws a circle anticlockwise', () => {
    expect(shoelace(circleSection(0.5, 32))).toBeGreaterThan(0);
  });

  it('draws a rounded rectangle anticlockwise', () => {
    expect(shoelace(roundedRectSection(0.4, 0.2, 0.05))).toBeGreaterThan(0);
  });

  it('degenerates a rounded rectangle to a plain one, still anticlockwise', () => {
    expect(shoelace(roundedRectSection(0.4, 0.2, 0))).toBeGreaterThan(0);
  });

  it('clamps a corner radius larger than the section rather than self-intersecting', () => {
    // 24 mm square asking for a 20 mm radius is a circle. The area of the
    // clamped result must still be positive and must not exceed the square.
    const section = roundedRectSection(0.024, 0.024, 0.02);
    const area = shoelace(section);
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThanOrEqual(0.024 * 0.024 + 1e-9);
  });
});

describe('loft closes a solid the right way round', () => {
  const RADIUS = 0.3;
  const HEIGHT = 1.2;
  const cylinder = loft([ringAt(circleSection(RADIUS, 64), 0), ringAt(circleSection(RADIUS, 64), HEIGHT)]);

  it('encloses a positive volume, so the normals point outward', () => {
    expect(signedVolume(cylinder)).toBeGreaterThan(0);
  });

  it('encloses the volume a cylinder of that size actually has', () => {
    const exact = Math.PI * RADIUS * RADIUS * HEIGHT;
    // A 64-gon inscribes the circle, so the polygonal solid is very slightly
    // smaller. Half a per cent is the geometry, not an error.
    expect(signedVolume(cylinder)).toBeGreaterThan(exact * 0.99);
    expect(signedVolume(cylinder)).toBeLessThanOrEqual(exact);
  });

  it('is watertight', () => {
    expect(isWatertight(cylinder)).toBe(true);
  });

  it('refuses a stack whose rings disagree, rather than producing a torn skin', () => {
    const ragged = loft([ringAt(circleSection(RADIUS, 16), 0), ringAt(circleSection(RADIUS, 24), 1)]);
    expect(ragged.getAttribute('position')).toBeUndefined();
  });

  it('refuses a single ring', () => {
    expect(loft([ringAt(circleSection(RADIUS, 16), 0)]).getAttribute('position')).toBeUndefined();
  });
});

describe('lathe', () => {
  /*
   * A cone is the useful test case rather than a sphere, because its volume is
   * a third of the enclosing cylinder — a number a wrongly-capped solid cannot
   * accidentally land on.
   */
  const RADIUS = 0.25;
  const HEIGHT = 0.8;
  const cone = lathe(
    [
      { r: 0, y: 0 },
      { r: RADIUS, y: 0 },
      { r: 0, y: HEIGHT },
    ],
    64,
  );

  it('turns a solid of revolution the right way round', () => {
    expect(signedVolume(cone)).toBeGreaterThan(0);
  });

  it('turns one of the right size', () => {
    const exact = (Math.PI * RADIUS * RADIUS * HEIGHT) / 3;
    expect(signedVolume(cone)).toBeGreaterThan(exact * 0.98);
    expect(signedVolume(cone)).toBeLessThanOrEqual(exact);
  });

  it('closes a profile that does not return to the axis', () => {
    // A plain disc: both ends open, so both need caps.
    const disc = lathe(
      [
        { r: 0.2, y: 0 },
        { r: 0.2, y: 0.05 },
      ],
      48,
    );
    expect(signedVolume(disc)).toBeGreaterThan(0);
    expect(isWatertight(disc)).toBe(true);
  });
});

describe('sweep', () => {
  it('carries a section along a straight path as a prism of the right volume', () => {
    const LENGTH = 0.9;
    const RADIUS = 0.02;
    const path = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, LENGTH)];
    const rod = sweep(circleSection(RADIUS, 48), path, { crease: 0 });

    const exact = Math.PI * RADIUS * RADIUS * LENGTH;
    expect(signedVolume(rod)).toBeGreaterThan(exact * 0.98);
    expect(signedVolume(rod)).toBeLessThanOrEqual(exact);
  });

  it('does not twist the section along a planar curve', () => {
    /*
     * The failure this guards against is a Frenet frame spinning the section as
     * the curve inflects. A flat 60 x 8 mm laminate bent in the YZ plane must
     * stay 60 mm wide in X from end to end; a twist shows up as the X extent
     * collapsing toward 8 mm somewhere along it.
     *
     * Measured by walking the bounding box of each fifth of the sweep, because
     * an overall bounding box would be satisfied by the two ends alone.
     */
    const path: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const angle = t * Math.PI * 0.8;
      path.push(new THREE.Vector3(0, Math.sin(angle) * 0.6, Math.cos(angle) * 0.5));
    }

    const section = roundedRectSection(0.06, 0.008, 0.003);
    const laminate = sweep(section, path, {
      axis: new THREE.Vector3(1, 0, 0),
      crease: 0,
    });

    /*
     * Ring size comes from the SECTION, not from `position.count / path.length`.
     *
     * The buffer carries two extra vertices for the cap centroids, so dividing
     * by the path length gives a fractional stride, the window walks off the
     * end of the last ring, and the bound stays at Infinity — which surfaces as
     * `expected NaN to be greater than 0.058` and looks like a geometry failure
     * rather than an arithmetic one in the test.
     */
    const position = laminate.getAttribute('position')!;
    const ringSize = section.length;

    for (let ring = 0; ring < path.length; ring++) {
      let minX = Infinity;
      let maxX = -Infinity;
      for (let j = 0; j < ringSize; j++) {
        const i = ring * ringSize + j;
        minX = Math.min(minX, position.getX(i));
        maxX = Math.max(maxX, position.getX(i));
      }
      // Every ring keeps very nearly the full 60 mm across.
      expect(maxX - minX).toBeGreaterThan(0.058);
    }
  });

  it('produces nothing from a path too short to have a direction', () => {
    const none = sweep(circleSection(0.01, 8), [new THREE.Vector3(0, 0, 0)]);
    expect(none.getAttribute('position')).toBeUndefined();
  });
});

describe('taperedProfile', () => {
  it('narrows, and by the amount asked for', () => {
    const geometry = taperedProfile(circleSection(0.1, 64), 0, 1, { topScale: 0.5, crease: 0 });

    // Frustum volume: (πh/3)(R² + Rr + r²), with r = R/2.
    const R = 0.1;
    const r = 0.05;
    const exact = ((Math.PI * 1) / 3) * (R * R + R * r + r * r);
    expect(signedVolume(geometry)).toBeGreaterThan(exact * 0.98);
    expect(signedVolume(geometry)).toBeLessThanOrEqual(exact);
  });

  it('keeps both declared ends exactly, whatever the belly does in between', () => {
    /*
     * The entasis is what makes a turned leg look turned, and it must not change
     * the two dimensions the catalogue actually states. A sine hump is zero at
     * both ends by construction; this proves the construction.
     */
    const geometry = taperedProfile(circleSection(0.05, 32), 0, 0.7, {
      topScale: 1,
      steps: 8,
      belly: 0.15,
      crease: 0,
    });
    const position = geometry.getAttribute('position')!;

    const radiusNear = (targetY: number): number => {
      let widest = 0;
      for (let i = 0; i < position.count; i++) {
        if (Math.abs(position.getY(i) - targetY) > 1e-4) continue;
        widest = Math.max(widest, Math.hypot(position.getX(i), position.getZ(i)));
      }
      return widest;
    };

    expect(radiusNear(0)).toBeCloseTo(0.05, 3);
    expect(radiusNear(0.7)).toBeCloseTo(0.05, 3);
    // And genuinely swells in between, or the belly is doing nothing.
    expect(radiusNear(0.35)).toBeGreaterThan(0.05 * 1.05);
  });

  it('produces nothing for a zero height rather than a degenerate sliver', () => {
    const flat = taperedProfile(circleSection(0.05, 16), 0.4, 0.4);
    expect(flat.getAttribute('position')).toBeUndefined();
  });
});

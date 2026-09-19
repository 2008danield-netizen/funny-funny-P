/**
 * The canvas, and how big it is.
 *
 * Subdividing a surface changes the rendered picture by nothing at all, which
 * makes it exactly the kind of work that can silently fail to happen. These
 * tests check the two things that matter: that surfaces come out fine enough to
 * carry a gradient, and that making them fine enough has not quietly turned a
 * house into several million triangles.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { LIGHT_EDGE, longestEdge, subdivideForLight, triangleCount } from './subdivide';
import { buildFloorGeometry } from './floorBuilder';

/** A 6 x 5 m room, the size of the living room fixture. */
const ROOM = [
  { x: 0, z: 0 },
  { x: 6, z: 0 },
  { x: 6, z: 5 },
  { x: 0, z: 5 },
];

describe('surfaces are cut fine enough to carry light', () => {
  it('leaves no edge longer than the target', () => {
    const floor = buildFloorGeometry(ROOM);
    expect(longestEdge(floor)).toBeLessThanOrEqual(LIGHT_EDGE + 1e-6);
  });

  it('actually subdivides — a room floor was two triangles', () => {
    const floor = buildFloorGeometry(ROOM);
    // 30 m² at a quarter-metre grid is several hundred, not two.
    expect(triangleCount(floor)).toBeGreaterThan(200);
  });

  it('does not run away on a large surface', () => {
    // The site terrain is 72 m across. If this were subdivided at the same
    // pitch it would be 165,000 triangles, which is why only surfaces that
    // carry baked light get the treatment.
    const big = buildFloorGeometry([
      { x: 0, z: 0 },
      { x: 30, z: 0 },
      { x: 30, z: 20 },
      { x: 0, z: 20 },
    ]);
    expect(triangleCount(big)).toBeLessThan(30000);
  });

  it('leaves an already-fine surface alone rather than copying it', () => {
    // 0.1 m square, so even its diagonal (0.141) is inside the target. The
    // first version of this test used 0.2, whose diagonal is 0.283 — over the
    // limit, so it was correctly subdivided and the test was wrong.
    const fine = new THREE.PlaneGeometry(0.1, 0.1);
    expect(subdivideForLight(fine)).toBe(fine);
  });

  it('keeps the surface the same shape', () => {
    /*
     * The whole point is that this is invisible. Subdivision that moved a
     * vertex would be a modelling change wearing a performance change's
     * clothes, and it would show up as a wall that no longer meets its floor.
     */
    const coarse = new THREE.PlaneGeometry(4, 3);
    const fine = subdivideForLight(coarse);

    coarse.computeBoundingBox();
    fine.computeBoundingBox();
    const a = coarse.boundingBox!;
    const b = fine.boundingBox!;

    expect(b.min.x).toBeCloseTo(a.min.x, 6);
    expect(b.max.x).toBeCloseTo(a.max.x, 6);
    expect(b.min.y).toBeCloseTo(a.min.y, 6);
    expect(b.max.y).toBeCloseTo(a.max.y, 6);
  });
});

/**
 * Floor and ceiling geometry for an arbitrary room outline.
 *
 * Session 1's floor was a rectangle, so a `PlaneGeometry` did the job. A
 * detected room can be any simple polygon, so its floor is built from a
 * `THREE.Shape` and triangulated.
 *
 * The subtlety worth understanding is the coordinate flip. `Shape` lives in XY;
 * the floor lives in XZ. Rotating the finished geometry by -90 degrees about X
 * maps shape-space (x, y) onto world (x, -y), so a shape built from the room's
 * (x, z) outline would come out mirrored. Building the shape from (x, -z)
 * cancels that out. The ceiling rotates the other way (so it faces down into the
 * room) and therefore does NOT need the flip.
 */

import * as THREE from 'three';

import type { Point2 } from '@/state/types';

/**
 * Builds a horizontal surface from a room outline.
 *
 * UVs come out in metres of world space rather than normalised 0..1, which is
 * what lets a floor material keep a fixed real-world plank size regardless of
 * room shape — and lets floorboards run continuously across two rooms sharing
 * the same material instead of restarting at every doorway.
 */
function buildSurface(polygon: readonly Point2[], facing: 'up' | 'down'): THREE.BufferGeometry {
  const shape = new THREE.Shape();

  polygon.forEach((point, index) => {
    // See the note above on why the floor mirrors Z and the ceiling does not.
    const y = facing === 'up' ? -point.z : point.z;
    if (index === 0) shape.moveTo(point.x, y);
    else shape.lineTo(point.x, y);
  });
  shape.closePath();

  const geometry = new THREE.ShapeGeometry(shape);

  // ShapeGeometry emits every normal as +Z; the rotation turns that into +Y for
  // a floor or -Y for a ceiling, so both end up facing into the room.
  geometry.rotateX(facing === 'up' ? -Math.PI / 2 : Math.PI / 2);

  return geometry;
}

/** A floor for one room, lying on y = 0. */
export function buildFloorGeometry(polygon: readonly Point2[]): THREE.BufferGeometry {
  return buildSurface(polygon, 'up');
}

/** A ceiling for one room, lifted to the given height. */
export function buildCeilingGeometry(
  polygon: readonly Point2[],
  height: number,
): THREE.BufferGeometry {
  const geometry = buildSurface(polygon, 'down');
  geometry.translate(0, height, 0);
  return geometry;
}

/**
 * Builds the skirting board running around a room's outline.
 *
 * Drawn as a ribbon inset from the walls rather than as one box per wall,
 * because a room's corners are not necessarily right angles once the plan is
 * editable, and per-wall boxes leave a visible notch at every non-square corner.
 *
 * Returns null for a degenerate outline.
 */
export function buildSkirtingGeometry(
  polygon: readonly Point2[],
  height: number,
  depth: number,
): THREE.BufferGeometry | null {
  if (polygon.length < 3) return null;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  /** Inward normal of the edge starting at index i, for an anticlockwise loop. */
  const inwardNormal = (i: number): Point2 => {
    const current = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    const dx = next.x - current.x;
    const dz = next.z - current.z;
    const len = Math.hypot(dx, dz) || 1;
    // Regions are normalised anticlockwise by `findRegions`, so the left-hand
    // normal of each edge points into the room.
    return { x: -dz / len, z: dx / len };
  };

  let distanceAlong = 0;

  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    const normal = inwardNormal(i);

    const segmentLength = Math.hypot(next.x - current.x, next.z - current.z);
    if (segmentLength < 1e-6) continue;

    // The visible front face of the board, standing `depth` proud of the wall.
    const x0 = current.x + normal.x * depth;
    const z0 = current.z + normal.z * depth;
    const x1 = next.x + normal.x * depth;
    const z1 = next.z + normal.z * depth;

    const uStart = distanceAlong;
    const uEnd = distanceAlong + segmentLength;
    distanceAlong = uEnd;

    // Two triangles forming the front face, wound so the normal faces the room.
    const quad: Array<[number, number, number, number, number]> = [
      [x0, 0, z0, uStart, 0],
      [x1, 0, z1, uEnd, 0],
      [x1, height, z1, uEnd, height],

      [x0, 0, z0, uStart, 0],
      [x1, height, z1, uEnd, height],
      [x0, height, z0, uStart, height],
    ];

    for (const [x, y, z, u, v] of quad) {
      positions.push(x, y, z);
      normals.push(normal.x, 0, normal.z);
      uvs.push(u, v);
    }

    // The top of the board, so it does not read as a paper-thin sticker when
    // seen from above in the plan viewpoint.
    const topQuad: Array<[number, number, number, number, number]> = [
      [current.x, height, current.z, uStart, 0],
      [x0, height, z0, uStart, depth],
      [x1, height, z1, uEnd, depth],

      [current.x, height, current.z, uStart, 0],
      [x1, height, z1, uEnd, depth],
      [next.x, height, next.z, uEnd, 0],
    ];

    for (const [x, y, z, u, v] of topQuad) {
      positions.push(x, y, z);
      normals.push(0, 1, 0);
      uvs.push(u, v);
    }
  }

  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

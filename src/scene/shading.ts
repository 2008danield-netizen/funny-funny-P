/**
 * Smooth shading, with edges that are allowed to stay edges.
 *
 * -----------------------------------------------------------------------------
 * EVERY SURFACE IN THIS BUILDING IS FLAT-SHADED, AND MOST OF THEM SHOULD BE.
 *
 * That was measured before anything here was written, because the opposite was
 * assumed. A wall, an extruded roof plane, a merged furniture carcass and a
 * swept skirting board were all checked for vertex normals that had drifted
 * away from the face they belong to — the signature of a curve being faked
 * across a corner — and every one of them came back at zero degrees. Nothing in
 * the building is over-smoothed.
 *
 * The problem is the other one. Geometry built by sweeping a profile is stored
 * with every triangle carrying its own corners, so a cove moulding's curve is
 * drawn as a fan of flat strips and catches the light as a fan of flat strips.
 * A 65 mm cornice gets five or six of them. At arm's length that is not a
 * subtle defect: it is the thing that makes moulding look like a diagram of
 * moulding.
 *
 * -----------------------------------------------------------------------------
 * WHAT A CREASE ANGLE IS FOR.
 *
 * Averaging every face normal that meets at a point is the easy fix and it
 * ruins the other half of the profile. A skirting board is a curve at the top
 * and a square corner where it meets the wall; smooth the lot and the square
 * corner turns to jelly. The crease angle says where to stop: faces that turn
 * gently into one another are parts of one curve and share a normal, faces that
 * turn sharply are a real edge and keep their own.
 *
 * -----------------------------------------------------------------------------
 * WHY NOT `toCreasedNormals` FROM THREE'S EXAMPLES.
 *
 * It does exactly this and it cannot be used here, for a reason that is in its
 * source rather than its documentation: it hashes vertex positions onto a ONE
 * CENTIMETRE grid, by truncation.
 *
 * Architecture is not built at that scale. The points of the skirting profile
 * in `millwork.ts` are four millimetres apart; on a centimetre grid several of
 * them collapse into the same cell and get averaged together, which does not
 * smooth the profile so much as delete it. Truncation makes it worse again, by
 * putting 9.99 mm and 10.01 mm in different cells while claiming a tolerance of
 * ten.
 *
 * So this is the same idea at a tenth of a millimetre, rounded rather than
 * truncated, and weighted by area.
 */

import * as THREE from 'three';

/**
 * The default crease angle, in degrees.
 *
 * Thirty, which is lower than the sixty most tools default to, and the reason
 * is what this is used on. A swept moulding's curve is divided into segments
 * that turn by ten or fifteen degrees each, and its square corners turn by
 * ninety. Anywhere between those two works; thirty sits in the middle with room
 * on both sides, and — unlike sixty — it will not quietly smooth the forty-five
 * degree chamfer off the front of a stair nosing.
 */
export const CREASE_ANGLE = 30;

/**
 * How finely positions are matched, in metres.
 *
 * A tenth of a millimetre. Fine enough that two points of a moulding profile
 * four millimetres apart are never confused, coarse enough that two vertices
 * meant to be the same point always agree — which floating-point arithmetic
 * does not promise, especially after a matrix has been applied to both.
 */
const GRID = 0.0001;

/**
 * Recomputes a geometry's normals, smoothing only across gentle joins.
 *
 * Works in place and returns the geometry. Indexed geometry is de-indexed
 * first, because the result needs a normal per triangle CORNER rather than per
 * vertex: the whole point is that a vertex on a crease has two different
 * normals depending on which face is being drawn, and an index buffer has
 * nowhere to put the second.
 */
export function creaseNormals(
  geometry: THREE.BufferGeometry,
  degrees: number = CREASE_ANGLE,
): THREE.BufferGeometry {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = source.getAttribute('position');
  if (!position || position.count < 3) return source;

  const limit = Math.cos((degrees * Math.PI) / 180);
  const triangles = Math.floor(position.count / 3);

  /*
   * Face normals are NOT normalised here, and that is the area weighting.
   *
   * The cross product of two edges has a length of twice the triangle's area,
   * so summing the raw vectors lets a big face pull the average further than a
   * sliver does. That matters wherever a curve has been tessellated unevenly —
   * which, after `subdivideForLight` has been at it, is everywhere.
   */
  const faceX = new Float32Array(triangles);
  const faceY = new Float32Array(triangles);
  const faceZ = new Float32Array(triangles);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const cross = new THREE.Vector3();

  /** Every face touching a position, by position key. */
  const atPosition = new Map<string, number[]>();

  const keyOf = (v: THREE.Vector3): string =>
    `${Math.round(v.x / GRID)},${Math.round(v.y / GRID)},${Math.round(v.z / GRID)}`;

  for (let t = 0; t < triangles; t++) {
    a.fromBufferAttribute(position, t * 3);
    b.fromBufferAttribute(position, t * 3 + 1);
    c.fromBufferAttribute(position, t * 3 + 2);

    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    cross.crossVectors(edge1, edge2);

    faceX[t] = cross.x;
    faceY[t] = cross.y;
    faceZ[t] = cross.z;

    for (const corner of [a, b, c]) {
      const key = keyOf(corner);
      const list = atPosition.get(key);
      if (list) list.push(t);
      else atPosition.set(key, [t]);
    }
  }

  const normals = new Float32Array(position.count * 3);
  const own = new THREE.Vector3();
  const other = new THREE.Vector3();
  const sum = new THREE.Vector3();
  const corner = new THREE.Vector3();

  for (let t = 0; t < triangles; t++) {
    own.set(faceX[t]!, faceY[t]!, faceZ[t]!);
    const area = own.length();
    // A degenerate triangle has no direction to contribute or to receive. Its
    // corners get something pointing up rather than a NaN, which would render
    // as a black hole rather than as nothing.
    if (area < 1e-12) {
      for (let n = 0; n < 3; n++) normals[(t * 3 + n) * 3 + 1] = 1;
      continue;
    }
    own.divideScalar(area);

    for (let n = 0; n < 3; n++) {
      const index = t * 3 + n;
      corner.fromBufferAttribute(position, index);

      sum.set(0, 0, 0);
      for (const neighbour of atPosition.get(keyOf(corner)) ?? []) {
        other.set(faceX[neighbour]!, faceY[neighbour]!, faceZ[neighbour]!);
        const neighbourArea = other.length();
        if (neighbourArea < 1e-12) continue;

        /*
         * The crease test, on the UNIT normals, and the sum on the raw ones.
         *
         * Comparing the raw vectors would test their areas as much as their
         * directions — a large face and a small one pointing the same way have
         * a dot product of whatever their areas multiply to, which says nothing
         * about whether they form an edge.
         */
        if (other.dot(own) / neighbourArea < limit) continue;
        sum.add(other);
      }

      if (sum.lengthSq() < 1e-20) sum.copy(own);
      else sum.normalize();

      normals[index * 3] = sum.x;
      normals[index * 3 + 1] = sum.y;
      normals[index * 3 + 2] = sum.z;
    }
  }

  source.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return source;
}

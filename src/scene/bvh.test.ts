/**
 * The tree has to agree with the slow, obvious answer.
 *
 * A spatial index is the kind of code that fails silently: a wrong split or an
 * off-by-one in a leaf range does not crash, it just misses a triangle — and a
 * missed triangle in the sky bake looks like a room that is inexplicably bright
 * in one corner, which nobody would attribute to a tree traversal.
 *
 * So most of what follows compares the tree against brute force over the same
 * triangles with randomised rays. That is the one check that cannot be fooled by
 * a tree that is internally consistent and wrong.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { Bvh } from './bvh';

/** Triangle soup for a box, so the answers are ones anyone can check by hand. */
function boxTriangles(
  width: number, height: number, depth: number,
  at: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): Float32Array {
  const geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed();
  geometry.translate(at.x, at.y, at.z);
  return new Float32Array(geometry.getAttribute('position').array);
}

/** Brute force: the answer the tree must reproduce. */
function slowAnyHit(
  triangles: Float32Array,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
): boolean {
  const ray = new THREE.Ray(origin.clone(), direction.clone().normalize());
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const hit = new THREE.Vector3();

  for (let t = 0; t < triangles.length; t += 9) {
    a.set(triangles[t]!, triangles[t + 1]!, triangles[t + 2]!);
    b.set(triangles[t + 3]!, triangles[t + 4]!, triangles[t + 5]!);
    c.set(triangles[t + 6]!, triangles[t + 7]!, triangles[t + 8]!);
    // `false` is back-face culling off, matching the tree — see bvh.ts.
    if (ray.intersectTriangle(a, b, c, false, hit)) {
      const distance = hit.distanceTo(origin);
      if (distance > 1e-6 && distance < maxDistance) return true;
    }
  }
  return false;
}

/** A deterministic generator, so a failure can be reproduced. */
function randoms(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('Bvh', () => {
  it('counts the triangles it was given', () => {
    const bvh = new Bvh(boxTriangles(1, 1, 1));
    expect(bvh.triangleCount).toBe(12);
  });

  it('survives having nothing to index', () => {
    const bvh = new Bvh(new Float32Array(0));
    expect(bvh.triangleCount).toBe(0);
    expect(bvh.anyHit(0, 0, 0, 0, 1, 0, 100)).toBe(false);
  });

  it('hits a box the ray is aimed at', () => {
    const bvh = new Bvh(boxTriangles(2, 2, 2));
    expect(bvh.anyHit(0, -10, 0, 0, 1, 0, 100)).toBe(true);
  });

  it('misses a box the ray goes past', () => {
    const bvh = new Bvh(boxTriangles(2, 2, 2));
    expect(bvh.anyHit(5, -10, 0, 0, 1, 0, 100)).toBe(false);
  });

  it('respects the distance limit', () => {
    const bvh = new Bvh(boxTriangles(2, 2, 2));
    // The box's near face is at y = -1, so nine metres of travel falls short.
    expect(bvh.anyHit(0, -10, 0, 0, 1, 0, 8)).toBe(false);
    expect(bvh.anyHit(0, -10, 0, 0, 1, 0, 10)).toBe(true);
  });

  it('ignores geometry behind the ray', () => {
    const bvh = new Bvh(boxTriangles(2, 2, 2));
    expect(bvh.anyHit(0, -10, 0, 0, -1, 0, 100)).toBe(false);
  });

  it('hits the back of a face from inside, which the bake depends on', () => {
    /*
     * The reason `hitsTriangle` is double-sided. A ray leaving an interior
     * surface meets the BACK of the wall opposite; culling back faces would let
     * it sail out and report a sealed room as open sky.
     */
    const bvh = new Bvh(boxTriangles(4, 4, 4));
    expect(bvh.anyHit(0, 0, 0, 0, 1, 0, 100)).toBe(true);
    expect(bvh.anyHit(0, 0, 0, 1, 0, 0, 100)).toBe(true);
  });

  it('handles an axis-parallel ray, where the slab test divides by zero', () => {
    const bvh = new Bvh(boxTriangles(2, 2, 2));
    // dy and dz are exactly zero, so their reciprocals are infinite.
    expect(bvh.anyHit(-10, 0, 0, 1, 0, 0, 100)).toBe(true);
    expect(bvh.anyHit(-10, 5, 0, 1, 0, 0, 100)).toBe(false);
  });

  it('agrees with brute force over a scattering of boxes and rays', () => {
    const random = randoms(20260919);

    const parts: number[] = [];
    for (let i = 0; i < 40; i++) {
      const box = boxTriangles(
        0.3 + random() * 2,
        0.3 + random() * 2,
        0.3 + random() * 2,
        { x: (random() - 0.5) * 20, y: (random() - 0.5) * 8, z: (random() - 0.5) * 20 },
      );
      for (const value of box) parts.push(value);
    }
    const triangles = new Float32Array(parts);
    const bvh = new Bvh(triangles);

    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    let agreed = 0;
    let hits = 0;

    for (let i = 0; i < 400; i++) {
      origin.set((random() - 0.5) * 24, (random() - 0.5) * 10, (random() - 0.5) * 24);
      direction.set(random() - 0.5, random() - 0.5, random() - 0.5);
      if (direction.lengthSq() < 1e-6) continue;
      direction.normalize();

      const fast = bvh.anyHit(
        origin.x, origin.y, origin.z,
        direction.x, direction.y, direction.z,
        30,
      );
      const slow = slowAnyHit(triangles, origin, direction, 30);
      if (fast === slow) agreed++;
      if (slow) hits++;
    }

    expect(agreed).toBe(400);
    // A test where nothing was ever hit would pass on a tree that always says
    // no, so insist the rays actually found something.
    expect(hits).toBeGreaterThan(50);
  });

  it('collects meshes into world space, transforms and all', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(6, 0, 0);
    mesh.updateMatrixWorld(true);

    const bvh = Bvh.fromMeshes([mesh]);

    // Aimed at where the mesh was MOVED to, not where its geometry sits.
    expect(bvh.anyHit(0, 0, 0, 1, 0, 0, 100)).toBe(true);
    expect(bvh.anyHit(0, 0, 0, -1, 0, 0, 100)).toBe(false);
  });

  it('reads indexed and non-indexed geometry alike', () => {
    const indexed = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const loose = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2).toNonIndexed());

    expect(Bvh.fromMeshes([indexed]).triangleCount).toBe(12);
    expect(Bvh.fromMeshes([loose]).triangleCount).toBe(12);
    expect(Bvh.fromMeshes([indexed]).anyHit(0, -10, 0, 0, 1, 0, 100)).toBe(true);
    expect(Bvh.fromMeshes([loose]).anyHit(0, -10, 0, 0, 1, 0, 100)).toBe(true);
  });

  it('is dramatically cheaper than testing every triangle', () => {
    /*
     * Not a benchmark — a guard against the tree quietly degenerating into a
     * linear scan, which a broken split would do while still returning the
     * right answers.
     */
    const parts: number[] = [];
    const random = randoms(7);
    for (let i = 0; i < 300; i++) {
      const box = boxTriangles(0.5, 0.5, 0.5, {
        x: (random() - 0.5) * 40,
        y: (random() - 0.5) * 40,
        z: (random() - 0.5) * 40,
      });
      for (const value of box) parts.push(value);
    }
    const triangles = new Float32Array(parts);
    const bvh = new Bvh(triangles);
    expect(bvh.triangleCount).toBe(3600);

    const started = performance.now();
    for (let i = 0; i < 20000; i++) {
      bvh.anyHit(-40, 0, 0, 1, 0, 0, 5);
    }
    const elapsed = performance.now() - started;

    // A linear scan is 3,600 tests per ray, 72 million in total, which takes
    // seconds. Anything under half a second means the tree is pruning.
    expect(elapsed).toBeLessThan(500);
  });

  it('finds the NEAREST hit, not just any of them', () => {
    // Three walls in a line; a ray down the line must report the first.
    const parts: number[] = [];
    for (const x of [2, 6, 10]) {
      for (const value of boxTriangles(0.2, 4, 4, { x, y: 0, z: 0 })) parts.push(value);
    }
    const bvh = new Bvh(new Float32Array(parts));

    const hit = bvh.closestHit(0, 0, 0, 1, 0, 0, 100);
    expect(hit).not.toBeNull();
    // The first box's near face is at x = 1.9.
    expect(hit!.distance).toBeCloseTo(1.9, 4);
  });

  it('returns null when a closest-hit query finds nothing', () => {
    const bvh = new Bvh(boxTriangles(2, 2, 2));
    expect(bvh.closestHit(0, 20, 0, 0, 1, 0, 100)).toBeNull();
  });

  it('agrees with three.js about which triangle and how far', () => {
    const random = randoms(414243);

    const parts: number[] = [];
    for (let i = 0; i < 25; i++) {
      const box = boxTriangles(1 + random(), 1 + random(), 1 + random(), {
        x: (random() - 0.5) * 16,
        y: (random() - 0.5) * 6,
        z: (random() - 0.5) * 16,
      });
      for (const value of box) parts.push(value);
    }
    const triangles = new Float32Array(parts);
    const bvh = new Bvh(triangles);

    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const at = new THREE.Vector3();

    let compared = 0;

    for (let i = 0; i < 300; i++) {
      origin.set((random() - 0.5) * 20, (random() - 0.5) * 8, (random() - 0.5) * 20);
      direction.set(random() - 0.5, random() - 0.5, random() - 0.5).normalize();

      const ray = new THREE.Ray(origin.clone(), direction.clone());
      let slowest = Infinity;
      for (let t = 0; t < triangles.length; t += 9) {
        a.set(triangles[t]!, triangles[t + 1]!, triangles[t + 2]!);
        b.set(triangles[t + 3]!, triangles[t + 4]!, triangles[t + 5]!);
        c.set(triangles[t + 6]!, triangles[t + 7]!, triangles[t + 8]!);
        if (!ray.intersectTriangle(a, b, c, false, at)) continue;
        const distance = at.distanceTo(origin);
        if (distance > 1e-6 && distance < slowest) slowest = distance;
      }

      const hit = bvh.closestHit(
        origin.x, origin.y, origin.z,
        direction.x, direction.y, direction.z,
        40,
      );

      if (slowest === Infinity || slowest >= 40) {
        expect(hit).toBeNull();
      } else {
        expect(hit).not.toBeNull();
        expect(hit!.distance).toBeCloseTo(slowest, 3);
        compared++;
      }
    }

    expect(compared).toBeGreaterThan(30);
  });

  it('carries one linear albedo per triangle, in build order', () => {
    const red = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
    );
    red.position.set(-4, 0, 0);
    const white = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    white.position.set(4, 0, 0);

    const bvh = Bvh.fromMeshes([red, white]);
    expect(bvh.albedo).not.toBeNull();
    expect(bvh.albedo!.length).toBe(bvh.triangleCount * 3);

    // The hit object is REUSED between calls, so the first result has to be
    // read before the second query is made. Holding both at once silently
    // gives the same answer twice, which is worth a line of test on its own.
    const left = bvh.closestHit(-8, 0, 0, 1, 0, 0, 100)!.triangle;
    const right = bvh.closestHit(8, 0, 0, -1, 0, 0, 100)!.triangle;

    expect(bvh.albedo![left * 3]!).toBeCloseTo(1, 3);
    expect(bvh.albedo![left * 3 + 1]!).toBeCloseTo(0, 3);
    expect(bvh.albedo![right * 3 + 1]!).toBeCloseTo(1, 3);
  });

  it('converts sRGB material colours to linear, or every bounce is twice as bright', () => {
    const grey = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x808080 }),
    );
    const bvh = Bvh.fromMeshes([grey]);

    // Mid-grey reflects about 0.22 of the light that lands on it, not 0.5.
    expect(bvh.albedo![0]!).toBeGreaterThan(0.18);
    expect(bvh.albedo![0]!).toBeLessThan(0.28);
  });

  it('reports a triangle normal and centroid it can be asked about', () => {
    // One triangle in the xz plane, wound so its normal points up.
    const bvh = new Bvh(new Float32Array([0, 0, 0, 0, 0, 3, 3, 0, 0]));
    const normal = bvh.normalOf(0, new THREE.Vector3());
    expect(Math.abs(normal.y)).toBeCloseTo(1, 5);

    const centre = bvh.centroidOf(0, new THREE.Vector3());
    expect(centre.x).toBeCloseTo(1, 5);
    expect(centre.z).toBeCloseTo(1, 5);
  });
});

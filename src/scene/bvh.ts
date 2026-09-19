/**
 * A bounding-volume hierarchy, so rays stop testing every triangle.
 *
 * -----------------------------------------------------------------------------
 * WHY THE SKY BAKE NEEDED ONE BEFORE IT COULD SHIP.
 *
 * `THREE.Raycaster` tests a ray against every triangle of every object handed to
 * it, sorts the hits by distance, and returns them all. That is a reasonable
 * default for picking one object under a mouse pointer, which is what it is for,
 * and it is catastrophic for a bake: a few hundred thousand rays against a house
 * of a few thousand triangles is a few hundred million triangle tests, and the
 * sort throws away almost all of the work it did.
 *
 * Session 18 measured exactly that. The first sky bake locked the page so hard
 * the canvas never appeared, and two rounds of cutting the work — deduplicating
 * vertices, casting against coarse geometry — were not close to enough, because
 * neither changed the fundamental quantity: rays x triangles.
 *
 * A BVH changes that quantity to rays x log(triangles). The building is sorted
 * once into a tree of boxes; a ray then descends it, skipping any box it misses
 * along with everything inside. In a house that turns several thousand triangle
 * tests per ray into a couple of dozen.
 *
 * -----------------------------------------------------------------------------
 * AND IT ANSWERS A DIFFERENT QUESTION, WHICH IS MOST OF THE SAVING.
 *
 * The bake never needs to know WHAT a ray hit, or where, or which hit was
 * nearest. It only ever asks "did this ray get out of the building". So the
 * query here returns a boolean and stops at the first triangle it touches.
 *
 * That is worth as much as the tree. Any-hit lets a ray abandon the search the
 * moment it fails, and inside a room most rays fail almost immediately — they
 * are pointed at a wall a metre away.
 */

import * as THREE from 'three';

/** Triangles per leaf. Small enough to prune well, large enough not to bloat. */
const LEAF_SIZE = 4;

/** Guard against a degenerate split loop on coincident geometry. */
const MAX_DEPTH = 32;

interface Node {
  /** Bounding box, as six floats rather than a Box3 to keep traversal flat. */
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** Leaf: a range in the triangle index. Branch: both are -1. */
  start: number;
  count: number;
  left: Node | null;
  right: Node | null;
}

export class Bvh {
  /** Nine floats per triangle: three corners, world space. */
  private readonly tris: Float32Array;
  /** Triangle order, permuted by the build so leaves are contiguous ranges. */
  private readonly order: Uint32Array;
  private readonly root: Node | null;

  readonly triangleCount: number;

  constructor(triangles: Float32Array) {
    this.tris = triangles;
    this.triangleCount = triangles.length / 9;

    this.order = new Uint32Array(this.triangleCount);
    for (let i = 0; i < this.triangleCount; i++) this.order[i] = i;

    this.root = this.triangleCount > 0 ? this.build(0, this.triangleCount, 0) : null;
  }

  /**
   * Collects every triangle of a set of meshes into one world-space array.
   *
   * World space rather than each mesh's own, because a ray would otherwise have
   * to be transformed into every mesh's frame before testing — which is the
   * per-object cost this exists to remove.
   */
  static fromMeshes(meshes: readonly THREE.Mesh[]): Bvh {
    const chunks: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();

    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position');
      if (!position) continue;

      mesh.updateMatrixWorld(true);
      const matrix = mesh.matrixWorld;
      const index = geometry.index;
      const count = index ? index.count : position.count;

      for (let i = 0; i < count; i += 3) {
        const i0 = index ? index.getX(i) : i;
        const i1 = index ? index.getX(i + 1) : i + 1;
        const i2 = index ? index.getX(i + 2) : i + 2;

        a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
        b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
        c.fromBufferAttribute(position, i2).applyMatrix4(matrix);

        chunks.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    }

    return new Bvh(new Float32Array(chunks));
  }

  /* -------------------------------- Building ------------------------------ */

  private build(start: number, count: number, depth: number): Node {
    const node = this.boundsOf(start, count);
    node.start = start;
    node.count = count;
    node.left = null;
    node.right = null;

    if (count <= LEAF_SIZE || depth >= MAX_DEPTH) return node;

    /*
     * Split on the longest axis at the median centroid.
     *
     * A surface-area heuristic builds a better tree and costs markedly more to
     * construct. This is rebuilt on every plan edit and queried a few hundred
     * thousand times, so construction time is not free — and for architecture,
     * which is mostly axis-aligned slabs of similar size, a median split is
     * close to what the heuristic would have chosen anyway.
     */
    const spanX = node.maxX - node.minX;
    const spanY = node.maxY - node.minY;
    const spanZ = node.maxZ - node.minZ;
    const axis = spanX > spanY ? (spanX > spanZ ? 0 : 2) : spanY > spanZ ? 1 : 2;

    const slice = Array.from(this.order.subarray(start, start + count));
    slice.sort((p, q) => this.centroid(p, axis) - this.centroid(q, axis));
    this.order.set(slice, start);

    const half = count >> 1;
    node.left = this.build(start, half, depth + 1);
    node.right = this.build(start + half, count - half, depth + 1);
    // A branch owns no triangles directly; its children hold them all.
    node.count = 0;

    return node;
  }

  private centroid(triangle: number, axis: number): number {
    const base = triangle * 9;
    return (
      (this.tris[base + axis]! + this.tris[base + 3 + axis]! + this.tris[base + 6 + axis]!) / 3
    );
  }

  private boundsOf(start: number, count: number): Node {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = start; i < start + count; i++) {
      const base = this.order[i]! * 9;
      for (let corner = 0; corner < 3; corner++) {
        const x = this.tris[base + corner * 3]!;
        const y = this.tris[base + corner * 3 + 1]!;
        const z = this.tris[base + corner * 3 + 2]!;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }

    return { minX, minY, minZ, maxX, maxY, maxZ, start: 0, count: 0, left: null, right: null };
  }

  /* -------------------------------- Querying ------------------------------ */

  /**
   * Does anything block this ray within `maxDistance`?
   *
   * Returns as soon as one triangle is touched. Nothing here needs to know which
   * one, or how far away, and not computing that is most of the saving — inside
   * a room the great majority of rays hit a wall a metre away and can abandon
   * the search immediately.
   *
   * The direction must be normalised; the reciprocal is taken once and reused
   * down the whole traversal.
   */
  anyHit(
    originX: number, originY: number, originZ: number,
    dirX: number, dirY: number, dirZ: number,
    maxDistance: number,
  ): boolean {
    if (!this.root) return false;

    // Division by zero is deliberate: an axis-parallel ray gets an infinite
    // reciprocal, and the slab test below handles the infinities correctly.
    const invX = 1 / dirX;
    const invY = 1 / dirY;
    const invZ = 1 / dirZ;

    const stack: Node[] = [this.root];

    while (stack.length > 0) {
      const node = stack.pop()!;

      if (!this.hitsBox(node, originX, originY, originZ, invX, invY, invZ, maxDistance)) continue;

      if (node.left) {
        stack.push(node.left);
        if (node.right) stack.push(node.right);
        continue;
      }

      for (let i = node.start; i < node.start + node.count; i++) {
        if (
          this.hitsTriangle(
            this.order[i]!,
            originX, originY, originZ,
            dirX, dirY, dirZ,
            maxDistance,
          )
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /** The slab test: does the ray's interval overlap the box on all three axes? */
  private hitsBox(
    node: Node,
    ox: number, oy: number, oz: number,
    invX: number, invY: number, invZ: number,
    maxDistance: number,
  ): boolean {
    let near = 0;
    let far = maxDistance;

    let t0 = (node.minX - ox) * invX;
    let t1 = (node.maxX - ox) * invX;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return false;

    t0 = (node.minY - oy) * invY;
    t1 = (node.maxY - oy) * invY;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return false;

    t0 = (node.minZ - oz) * invZ;
    t1 = (node.maxZ - oz) * invZ;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;

    return near <= far;
  }

  /**
   * Möller–Trumbore, double-sided.
   *
   * Double-sided on purpose. Wall geometry is extruded and its faces point
   * outwards, so a ray leaving an interior surface meets the BACK of the wall
   * opposite. Culling back faces would let every such ray sail straight through
   * the building and report the room as open to the sky, which is the exact
   * opposite of the answer wanted.
   */
  private hitsTriangle(
    triangle: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
  ): boolean {
    const base = triangle * 9;
    const ax = this.tris[base]!, ay = this.tris[base + 1]!, az = this.tris[base + 2]!;
    const bx = this.tris[base + 3]!, by = this.tris[base + 4]!, bz = this.tris[base + 5]!;
    const cx = this.tris[base + 6]!, cy = this.tris[base + 7]!, cz = this.tris[base + 8]!;

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;

    const determinant = e1x * px + e1y * py + e1z * pz;
    // Parallel to the triangle's plane, or a degenerate triangle.
    if (determinant > -1e-9 && determinant < 1e-9) return false;

    const inverse = 1 / determinant;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;

    const u = (tx * px + ty * py + tz * pz) * inverse;
    if (u < 0 || u > 1) return false;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;

    const v = (dx * qx + dy * qy + dz * qz) * inverse;
    if (v < 0 || u + v > 1) return false;

    const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
    return distance > 1e-6 && distance < maxDistance;
  }
}

/**
 * Circulation analysis: can you actually walk around the room?
 *
 * -----------------------------------------------------------------------------
 * WHY A GRID
 *
 * The per-piece zones in `zones.ts` catch local problems — a drawer that cannot
 * open, a door that catches on a chair. They cannot catch the global one: a room
 * where every individual piece has its space, and yet there is no route from the
 * door to the window because the sofa and the bookcase between them leave a
 * 40 cm gap.
 *
 * Answering that needs to reason about the free floor as a whole, so the room is
 * rasterised into a grid of 10 cm cells, each marked blocked or free. Two things
 * then fall out cheaply:
 *
 *   REACHABILITY — a flood fill from the doorway. Any free floor it does not
 *   reach is marooned behind the furniture.
 *
 *   CLEAR WIDTH — a distance transform giving, for every free cell, how far it
 *   is to the nearest obstacle. Double that is the width of the gap the cell
 *   sits in, so the widest route through a gap is the largest such value along
 *   it. A pinch point is where the best available route is narrower than the
 *   walkway minimum.
 *
 * At 10 cm a large room is a few thousand cells, so both passes are trivially
 * fast — this runs happily on every edit.
 * -----------------------------------------------------------------------------
 */

import { obbCorners, type Collider, type Obb } from '@/physics/collision';
import { pointInPolygon, type Region } from '@/scene/planGraph';
import { CLEARANCE_DEFAULTS, type Point2 } from '@/state/types';

export interface Grid {
  /** Cells across (X) and down (Z). */
  width: number;
  height: number;
  cell: number;
  /** World position of cell (0, 0)'s centre. */
  origin: Point2;
  /** True where the cell is inside the room and unobstructed. */
  free: Uint8Array;
}

/** Converts a cell index to a world position. */
export function cellToWorld(grid: Grid, index: number): Point2 {
  const cx = index % grid.width;
  const cz = Math.floor(index / grid.width);
  return {
    x: grid.origin.x + cx * grid.cell,
    z: grid.origin.z + cz * grid.cell,
  };
}

/**
 * Rasterises a room's free floor.
 *
 * Obstacles are tested by point-in-box rather than by drawing the box, which is
 * slightly slower and much harder to get wrong — a rotated rectangle is fiddly
 * to scan-convert correctly, and an off-by-one there would silently under-report
 * how blocked a room is.
 */
export function buildGrid(
  region: Region,
  obstacles: readonly Collider[],
  cell = CLEARANCE_DEFAULTS.gridCell,
): Grid {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const point of region.polygon) {
    minX = Math.min(minX, point.x);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxZ = Math.max(maxZ, point.z);
  }

  const width = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const height = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const free = new Uint8Array(width * height);
  const origin = { x: minX, z: minZ };

  // Pre-compute each obstacle's axes so the inner loop is cheap.
  const boxes = obstacles.map((box) => ({
    center: box.center,
    halfWidth: box.halfWidth,
    halfDepth: box.halfDepth,
    cos: Math.cos(box.rotation),
    sin: Math.sin(box.rotation),
  }));

  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const point = { x: origin.x + cx * cell, z: origin.z + cz * cell };
      if (!pointInPolygon(point, region.polygon)) continue;

      let blocked = false;
      for (const box of boxes) {
        const dx = point.x - box.center.x;
        const dz = point.z - box.center.z;
        // Rotate the offset into the box's frame and compare against extents.
        const localX = dx * box.cos + dz * box.sin;
        const localZ = -dx * box.sin + dz * box.cos;
        if (Math.abs(localX) <= box.halfWidth && Math.abs(localZ) <= box.halfDepth) {
          blocked = true;
          break;
        }
      }

      if (!blocked) free[cz * width + cx] = 1;
    }
  }

  return { width, height, cell, origin, free };
}

/**
 * Distance from every free cell to the nearest blocked cell or room edge.
 *
 * Two-pass chamfer transform: a forward sweep propagating distances from the
 * top-left, then a backward sweep from the bottom-right. Using 1 for orthogonal
 * steps and √2 for diagonals keeps the error under about 4%, which at 10 cm
 * cells is a centimetre — far below anything that changes a verdict.
 */
export function distanceTransform(grid: Grid): Float32Array {
  const { width, height, free, cell } = grid;
  const distance = new Float32Array(width * height);

  const ORTHOGONAL = 1;
  const DIAGONAL = Math.SQRT2;
  const FAR = width * height * 2;

  for (let i = 0; i < distance.length; i++) distance[i] = free[i] ? FAR : 0;

  const relax = (index: number, fromIndex: number, cost: number) => {
    const candidate = distance[fromIndex]! + cost;
    if (candidate < distance[index]!) distance[index] = candidate;
  };

  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      const index = z * width + x;
      if (!free[index]) continue;
      if (x > 0) relax(index, index - 1, ORTHOGONAL);
      if (z > 0) relax(index, index - width, ORTHOGONAL);
      if (x > 0 && z > 0) relax(index, index - width - 1, DIAGONAL);
      if (x < width - 1 && z > 0) relax(index, index - width + 1, DIAGONAL);
    }
  }

  for (let z = height - 1; z >= 0; z--) {
    for (let x = width - 1; x >= 0; x--) {
      const index = z * width + x;
      if (!free[index]) continue;
      if (x < width - 1) relax(index, index + 1, ORTHOGONAL);
      if (z < height - 1) relax(index, index + width, ORTHOGONAL);
      if (x < width - 1 && z < height - 1) relax(index, index + width + 1, DIAGONAL);
      if (x > 0 && z < height - 1) relax(index, index + width - 1, DIAGONAL);
    }
  }

  // Convert from cell counts to metres.
  for (let i = 0; i < distance.length; i++) distance[i] = distance[i]! * cell;
  return distance;
}

/** Flood fill from a set of starting cells across free floor. */
export function reachableFrom(grid: Grid, starts: readonly number[]): Uint8Array {
  const seen = new Uint8Array(grid.width * grid.height);
  const queue: number[] = [];

  for (const start of starts) {
    if (start < 0 || start >= seen.length) continue;
    if (!grid.free[start] || seen[start]) continue;
    seen[start] = 1;
    queue.push(start);
  }

  // Iterative, with an index cursor rather than shift(), because shift() on a
  // large array is O(n) and turns this into a quadratic loop.
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor]!;
    const x = index % grid.width;
    const z = Math.floor(index / grid.width);

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= grid.width || nz >= grid.height) continue;
      const next = nz * grid.width + nx;
      if (!grid.free[next] || seen[next]) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }

  return seen;
}

/** The cell containing a world position, or -1 if outside the grid. */
export function worldToCell(grid: Grid, point: Point2): number {
  const cx = Math.round((point.x - grid.origin.x) / grid.cell);
  const cz = Math.round((point.z - grid.origin.z) / grid.cell);
  if (cx < 0 || cz < 0 || cx >= grid.width || cz >= grid.height) return -1;
  return cz * grid.width + cx;
}

export interface CirculationReport {
  /** Free floor area, in square metres. */
  freeArea: number;
  /**
   * The narrowest point on the BEST available route through the room, in metres.
   *
   * Not the narrowest gap anywhere — that would always be the few centimetres
   * between a wall and the skirting, in every room ever drawn, and the metric
   * would be useless. This is a widest-path (maximin) figure: of all the ways to
   * get from the doorway to the open parts of the room, take the one whose
   * tightest squeeze is widest, and report that squeeze. It answers "how narrow
   * does it get if you walk the sensible way round", which is the question.
   */
  narrowestRoute: number;
  /** Free cells that no entry point can reach, as world positions. */
  marooned: Point2[];
  /** Where that best route is at its narrowest. */
  pinchPoints: Point2[];
}

/**
 * A minimal max-heap, keyed by a number.
 *
 * The widest-path search is Dijkstra with max/min swapped for min/plus, so it
 * needs a priority queue. Sorting an array on every push would turn a linear
 * problem quadratic on the larger rooms.
 */
class MaxHeap {
  private keys: number[] = [];
  private values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! >= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { key: number; value: number } | null {
    if (this.keys.length === 0) return null;
    const key = this.keys[0]!;
    const value = this.values[0]!;

    const lastKey = this.keys.pop()!;
    const lastValue = this.values.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;

      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let largest = i;
        if (left < this.keys.length && this.keys[left]! > this.keys[largest]!) largest = left;
        if (right < this.keys.length && this.keys[right]! > this.keys[largest]!) largest = right;
        if (largest === i) break;
        this.swap(i, largest);
        i = largest;
      }
    }
    return { key, value };
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.values[a], this.values[b]] = [this.values[b]!, this.values[a]!];
  }
}

/**
 * For every free cell, the widest route that reaches it.
 *
 * `bottleneck[i]` is the maximum, over all paths from an entry to cell i, of the
 * narrowest clear width along that path. Standard widest-path search: same shape
 * as Dijkstra, with `min` where the sum would be and `max` where the comparison
 * would be.
 */
function widestPaths(
  grid: Grid,
  clearWidth: Float32Array,
  starts: readonly number[],
): Float32Array {
  const bottleneck = new Float32Array(grid.width * grid.height);
  const settled = new Uint8Array(grid.width * grid.height);
  const heap = new MaxHeap();

  for (const start of starts) {
    if (start < 0 || !grid.free[start]) continue;
    if (clearWidth[start]! > bottleneck[start]!) {
      bottleneck[start] = clearWidth[start]!;
      heap.push(bottleneck[start]!, start);
    }
  }

  while (heap.size > 0) {
    const top = heap.pop()!;
    const index = top.value;
    if (settled[index]) continue;
    settled[index] = 1;

    const x = index % grid.width;
    const z = Math.floor(index / grid.width);

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= grid.width || nz >= grid.height) continue;

      const next = nz * grid.width + nx;
      if (!grid.free[next] || settled[next]) continue;

      // Travelling into a cell is only as good as the tighter of the two.
      const candidate = Math.min(bottleneck[index]!, clearWidth[next]!);
      if (candidate > bottleneck[next]!) {
        bottleneck[next] = candidate;
        heap.push(candidate, next);
      }
    }
  }

  return bottleneck;
}

/**
 * Assesses circulation within one room.
 *
 * `entries` are the world positions of the doorways into the room. A room with
 * no doorway at all is assessed from its own interior point instead, so a
 * half-drawn plan still reports something useful rather than declaring every
 * square metre marooned.
 */
export function analyseCirculation(
  region: Region,
  obstacles: readonly Collider[],
  entries: readonly Point2[],
  walkwayWidth: number,
): CirculationReport {
  const grid = buildGrid(region, obstacles);
  const distance = distanceTransform(grid);

  // Clear width at a cell is twice its distance to the nearest obstacle.
  const clearWidth = new Float32Array(distance.length);
  for (let i = 0; i < distance.length; i++) clearWidth[i] = distance[i]! * 2;

  const startPoints = entries.length > 0 ? entries : [region.interiorPoint];
  const starts: number[] = [];
  for (const entry of startPoints) {
    const cell = worldToCell(grid, entry);
    if (cell >= 0 && grid.free[cell]) {
      starts.push(cell);
      continue;
    }
    // A doorway's own cell is usually inside the wall and so not free. Search
    // outwards for the nearest free cell instead of dropping the entry point.
    const nearby = nearestFreeCell(grid, entry);
    if (nearby >= 0) starts.push(nearby);
  }

  const reached = reachableFrom(grid, starts);
  const bottleneck = widestPaths(grid, clearWidth, starts);

  const cellArea = grid.cell * grid.cell;
  let freeCells = 0;
  const marooned: Point2[] = [];

  /*
   * Destinations are the open parts of the room — anywhere a person could
   * comfortably stand. Judging the route by how it reaches THOSE is what
   * excludes the sliver of floor behind a wardrobe, which is narrow by
   * definition and which nobody is trying to walk down.
   */
  let worstBottleneck = Infinity;
  let bestAnywhere = 0;
  let haveDestination = false;

  for (let i = 0; i < grid.free.length; i++) {
    if (!grid.free[i]) continue;
    freeCells += 1;

    if (!reached[i]) {
      marooned.push(cellToWorld(grid, i));
      continue;
    }

    if (bottleneck[i]! > bestAnywhere) bestAnywhere = bottleneck[i]!;

    if (clearWidth[i]! >= walkwayWidth) {
      haveDestination = true;
      if (bottleneck[i]! < worstBottleneck) worstBottleneck = bottleneck[i]!;
    }
  }

  // A room with no comfortable standing room at all (a corridor, or one packed
  // wall to wall) has no destinations, so fall back to the best route there is.
  const narrowestRoute = haveDestination
    ? worstBottleneck
    : freeCells > 0
      ? bestAnywhere
      : 0;

  // The pinch is where the limiting route is at its tightest, so pick out the
  // cells whose own clear width matches that figure.
  const pinchPoints: Point2[] = [];
  if (narrowestRoute < walkwayWidth) {
    for (let i = 0; i < grid.free.length; i++) {
      if (!grid.free[i] || !reached[i]) continue;
      if (Math.abs(clearWidth[i]! - narrowestRoute) <= grid.cell) {
        pinchPoints.push(cellToWorld(grid, i));
      }
    }
  }

  return {
    freeArea: freeCells * cellArea,
    narrowestRoute: Number.isFinite(narrowestRoute) ? narrowestRoute : 0,
    marooned,
    pinchPoints,
  };
}

/** Spiral outwards from a point to find the nearest free cell. */
function nearestFreeCell(grid: Grid, point: Point2): number {
  const cx = Math.round((point.x - grid.origin.x) / grid.cell);
  const cz = Math.round((point.z - grid.origin.z) / grid.cell);

  // A doorway sits in a wall roughly a wall-thickness thick, so a handful of
  // rings is always enough; the cap stops a pathological plan looping far.
  for (let radius = 1; radius <= 12; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= grid.width || nz >= grid.height) continue;
        const index = nz * grid.width + nx;
        if (grid.free[index]) return index;
      }
    }
  }
  return -1;
}

/** Turns a zone into a collider, so zones can block circulation too. */
export function zoneAsObstacle(zone: Obb, id: string): Collider {
  return { kind: 'furniture', id, ...zone };
}

/** Corners of a box, re-exported so callers need only this module. */
export { obbCorners };

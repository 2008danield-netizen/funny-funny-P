/**
 * Structural edits to the wall graph.
 *
 * Every function here MUTATES a draft plan in place, because they are designed
 * to be called inside `designStore.edit()` recipes, which hand out a private
 * clone. None of them may be called on the live document.
 *
 * The contract that keeps the graph trustworthy: any function that changes
 * structure finishes by calling `normalizePlan`. That pass merges coincident
 * vertices, drops degenerate and duplicate walls, prunes orphans, re-clamps
 * openings and discards stale room entries. Without it a few minutes of
 * dragging leaves behind zero-length walls and vertices connected to nothing,
 * and region detection starts producing nonsense.
 */

import {
  OPENING_LIMITS,
  PLAN_LIMITS,
  type Opening,
  type OpeningKind,
  type PlanModel,
  type Point2,
  type RoomSpec,
  type Vertex,
  type Wall,
} from './types';
import { clampOpening, distance, lerp, projectOntoSegment } from '@/scene/planGraph';

/* --------------------------------- IDs -------------------------------- */

/**
 * Mints an ID that is unique within a set.
 *
 * Counter-based rather than random: IDs end up in exported JSON that a human
 * may read, and "w7" is a great deal friendlier to debug than a UUID. Uniqueness
 * only has to hold within one document.
 */
function mintId(prefix: string, taken: ReadonlySet<string>): string {
  let n = taken.size + 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function newVertexId(plan: PlanModel): string {
  return mintId('v', new Set(plan.vertices.map((vertex) => vertex.id)));
}

export function newWallId(plan: PlanModel): string {
  return mintId('w', new Set(plan.walls.map((wall) => wall.id)));
}

function newOpeningId(plan: PlanModel): string {
  const taken = new Set<string>();
  for (const wall of plan.walls) for (const opening of wall.openings) taken.add(opening.id);
  return mintId('o', taken);
}

/* ------------------------------ Normalising --------------------------- */

/** Undirected key for a wall, so A-B and B-A collide. */
function wallPairKey(wall: Wall): string {
  return [wall.start, wall.end].sort().join('-');
}

/**
 * Repairs a plan after a structural edit.
 *
 * Order matters here. Vertices are merged first so that walls which have just
 * become degenerate are visible to the next step; walls are pruned before
 * orphan vertices, or every vertex of a removed wall would survive.
 */
export function normalizePlan(plan: PlanModel): void {
  mergeCoincidentVertices(plan);
  dropDegenerateWalls(plan);
  dropDuplicateWalls(plan);
  dropOrphanVertices(plan);
  clampAllOpenings(plan);
  pruneStaleRooms(plan);
}

/**
 * Snaps vertices that have been dragged onto each other into a single vertex.
 *
 * This is what makes drawing feel right: drag one corner onto another and the
 * two walls genuinely join, rather than merely overlapping visually while the
 * graph still thinks there is a gap and refuses to see an enclosed room.
 */
function mergeCoincidentVertices(plan: PlanModel): void {
  const survivors: Vertex[] = [];
  /** Old vertex ID -> the ID it was merged into. */
  const remap = new Map<string, string>();

  for (const vertex of plan.vertices) {
    const existing = survivors.find(
      (candidate) => distance(candidate, vertex) <= PLAN_LIMITS.vertexMergeDistance,
    );
    if (existing) {
      remap.set(vertex.id, existing.id);
    } else {
      survivors.push(vertex);
    }
  }

  if (remap.size === 0) return;

  plan.vertices = survivors;
  for (const wall of plan.walls) {
    wall.start = remap.get(wall.start) ?? wall.start;
    wall.end = remap.get(wall.end) ?? wall.end;
  }
}

/** Removes walls whose endpoints are missing, identical, or too close together. */
function dropDegenerateWalls(plan: PlanModel): void {
  const byId = new Map(plan.vertices.map((vertex) => [vertex.id, vertex]));
  plan.walls = plan.walls.filter((wall) => {
    if (wall.start === wall.end) return false;
    const start = byId.get(wall.start);
    const end = byId.get(wall.end);
    if (!start || !end) return false;
    return distance(start, end) >= PLAN_LIMITS.minWallLength;
  });
}

/**
 * Collapses walls that connect the same pair of vertices.
 *
 * Two walls in the same place render as z-fighting garbage and break face
 * traversal, which assumes at most one edge between any two vertices. The
 * survivor is the one carrying openings, so drawing over an existing wall
 * never silently deletes its door.
 */
function dropDuplicateWalls(plan: PlanModel): void {
  const seen = new Map<string, Wall>();
  for (const wall of plan.walls) {
    const key = wallPairKey(wall);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, wall);
      continue;
    }
    if (wall.openings.length > existing.openings.length) seen.set(key, wall);
  }
  if (seen.size !== plan.walls.length) {
    const keep = new Set(seen.values());
    plan.walls = plan.walls.filter((wall) => keep.has(wall));
  }
}

/** Removes vertices no wall refers to. */
function dropOrphanVertices(plan: PlanModel): void {
  const used = new Set<string>();
  for (const wall of plan.walls) {
    used.add(wall.start);
    used.add(wall.end);
  }
  plan.vertices = plan.vertices.filter((vertex) => used.has(vertex.id));
}

/** Re-fits every opening to its wall's current length and height. */
function clampAllOpenings(plan: PlanModel): void {
  const byId = new Map(plan.vertices.map((vertex) => [vertex.id, vertex]));
  for (const wall of plan.walls) {
    if (wall.openings.length === 0) continue;
    const start = byId.get(wall.start);
    const end = byId.get(wall.end);
    if (!start || !end) continue;
    const wallLength = distance(start, end);

    // An opening that no longer fits at all is removed rather than shrunk to a
    // slit: a 20 cm "door" left behind after shortening a wall is worse than no
    // door, and the user can see what happened.
    wall.openings = wall.openings
      .map((opening) => clampOpening(opening, wallLength, wall.height))
      .filter((opening) => opening.width >= OPENING_LIMITS.width.min * 0.75);
  }
}

/** Drops room entries whose bounding walls no longer all exist. */
function pruneStaleRooms(plan: PlanModel): void {
  const live = new Set(plan.walls.map((wall) => wall.id));
  for (const key of Object.keys(plan.rooms)) {
    const wallIds = key.split('|');
    // Keep entries that still share walls with the plan: they are the source
    // that `resolveRoomSpec` inherits from when a room is split or reshaped.
    if (!wallIds.some((id) => live.has(id))) delete plan.rooms[key];
  }
}

/* ------------------------------ Room lookup --------------------------- */

/**
 * The appearance to use for a region.
 *
 * Region keys change whenever the SET of walls enclosing a space changes, which
 * happens every time a room is split or a wall is added. Rather than trying to
 * migrate keys at edit time, appearance is resolved at read time:
 *
 *   1. An exact key match wins.
 *   2. Otherwise inherit from the stored room sharing the most walls — so
 *      splitting a sage-green room gives two sage-green rooms, not two default
 *      ones, which is what anybody would expect.
 *   3. Otherwise fall back to the plan's default.
 */
export function resolveRoomSpec(plan: PlanModel, key: string): RoomSpec {
  const exact = plan.rooms[key];
  if (exact) return exact;

  const wallIds = new Set(key.split('|'));
  let best: RoomSpec | null = null;
  let bestOverlap = 0;

  for (const [storedKey, spec] of Object.entries(plan.rooms)) {
    let overlap = 0;
    for (const id of storedKey.split('|')) if (wallIds.has(id)) overlap += 1;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = spec;
    }
  }

  // Require a meaningful share of walls, or an unrelated room across the plan
  // could donate its colour to a brand-new space.
  return bestOverlap >= 2 && best ? best : plan.defaultRoom;
}

/** Writes appearance for a region, materialising an inherited spec if needed. */
export function setRoomSpec(plan: PlanModel, key: string, update: Partial<RoomSpec>): void {
  const current = plan.rooms[key] ?? resolveRoomSpec(plan, key);
  plan.rooms[key] = {
    ...structuredClone(current),
    ...update,
  };
}

/* ---------------------------- Vertex editing -------------------------- */

/** Moves a vertex to a new position. Does not normalise — see `commitDrag`. */
export function moveVertex(plan: PlanModel, vertexId: string, to: Point2): void {
  const vertex = plan.vertices.find((candidate) => candidate.id === vertexId);
  if (!vertex) return;
  vertex.x = clampToPlan(to.x);
  vertex.z = clampToPlan(to.z);
}

/** Translates a whole wall by moving both of its endpoints. */
export function moveWall(plan: PlanModel, wallId: string, delta: Point2): void {
  const wall = plan.walls.find((candidate) => candidate.id === wallId);
  if (!wall) return;
  for (const id of [wall.start, wall.end]) {
    const vertex = plan.vertices.find((candidate) => candidate.id === id);
    if (!vertex) continue;
    vertex.x = clampToPlan(vertex.x + delta.x);
    vertex.z = clampToPlan(vertex.z + delta.z);
  }
}

function clampToPlan(value: number): number {
  const limit = PLAN_LIMITS.planExtent;
  return Math.min(limit, Math.max(-limit, value));
}

/**
 * Splits a wall at a fraction along its length, inserting a corner.
 *
 * Returns the new vertex's ID so the caller can select it — inserting a corner
 * and then having to hunt for it would be a poor interaction.
 *
 * Openings are handed to whichever half now contains them, with their offsets
 * rebased, so splitting a wall never destroys a door.
 */
export function splitWall(plan: PlanModel, wallId: string, t: number): string | null {
  const wall = plan.walls.find((candidate) => candidate.id === wallId);
  if (!wall) return null;

  const start = plan.vertices.find((v) => v.id === wall.start);
  const end = plan.vertices.find((v) => v.id === wall.end);
  if (!start || !end) return null;

  const clampedT = Math.min(0.9, Math.max(0.1, t));
  const wallLength = distance(start, end);
  const splitAt = wallLength * clampedT;
  const position = lerp(start, end, clampedT);

  const vertexId = newVertexId(plan);
  plan.vertices.push({ id: vertexId, x: position.x, z: position.z });

  // The original wall becomes the first half; a new wall covers the second.
  const secondId = newWallId(plan);
  const second: Wall = {
    id: secondId,
    start: vertexId,
    end: wall.end,
    thickness: wall.thickness,
    height: wall.height,
    faces: structuredClone(wall.faces),
    openings: wall.openings
      .filter((opening) => opening.offset > splitAt)
      .map((opening) => ({ ...opening, id: opening.id, offset: opening.offset - splitAt })),
  };

  wall.openings = wall.openings.filter((opening) => opening.offset <= splitAt);
  wall.end = vertexId;

  plan.walls.push(second);
  normalizePlan(plan);
  return vertexId;
}

/* ----------------------------- Wall editing --------------------------- */

/** Finds a vertex at a position, or creates one. Used when drawing walls. */
function vertexAt(plan: PlanModel, point: Point2, snapDistance: number): string {
  const existing = plan.vertices.find((vertex) => distance(vertex, point) <= snapDistance);
  if (existing) return existing.id;

  const id = newVertexId(plan);
  plan.vertices.push({ id, x: clampToPlan(point.x), z: clampToPlan(point.z) });
  return id;
}

/**
 * Draws a wall between two points, reusing nearby vertices.
 *
 * Reuse is the whole trick: drawing a new wall that ends on an existing corner
 * has to JOIN that corner, not sit next to it, or the plan looks closed while
 * the graph knows it is not and no room is detected.
 */
export function drawWall(plan: PlanModel, from: Point2, to: Point2): string | null {
  if (distance(from, to) < PLAN_LIMITS.minWallLength) return null;

  const snap = 0.25;
  const startId = vertexAt(plan, from, snap);
  const endId = vertexAt(plan, to, snap);
  if (startId === endId) {
    normalizePlan(plan);
    return null;
  }

  const wallId = newWallId(plan);
  plan.walls.push({
    id: wallId,
    start: startId,
    end: endId,
    thickness: plan.defaultWallThickness,
    height: plan.defaultWallHeight,
    faces: {},
    openings: [],
  });

  normalizePlan(plan);
  // The wall may have been merged away as a duplicate.
  return plan.walls.some((wall) => wall.id === wallId) ? wallId : null;
}

/** Deletes a wall and tidies up anything it left behind. */
export function deleteWall(plan: PlanModel, wallId: string): void {
  plan.walls = plan.walls.filter((wall) => wall.id !== wallId);
  normalizePlan(plan);
}

/**
 * Deletes a corner, healing the plan where possible.
 *
 * When exactly two walls meet at the vertex, they are joined into one rather
 * than both being deleted — removing a redundant corner from a straight run
 * should leave the run intact, not punch a hole in the room.
 */
export function deleteVertex(plan: PlanModel, vertexId: string): void {
  const attached = plan.walls.filter(
    (wall) => wall.start === vertexId || wall.end === vertexId,
  );

  if (attached.length === 2) {
    const [first, second] = attached as [Wall, Wall];
    const farEndOfSecond = second.start === vertexId ? second.end : second.start;

    // Re-point the first wall at the second's far end, then drop the second.
    if (first.start === vertexId) first.start = farEndOfSecond;
    else first.end = farEndOfSecond;

    plan.walls = plan.walls.filter((wall) => wall.id !== second.id);
  } else {
    plan.walls = plan.walls.filter(
      (wall) => wall.start !== vertexId && wall.end !== vertexId,
    );
  }

  plan.vertices = plan.vertices.filter((vertex) => vertex.id !== vertexId);
  normalizePlan(plan);
}

/**
 * Adds a free-standing rectangular room to the plan.
 *
 * The quickest way to go from one room to a two-room plan, and the fallback
 * when a user has deleted everything and needs a way back.
 */
export function addRectangle(
  plan: PlanModel,
  center: Point2,
  width: number,
  depth: number,
): string[] {
  const halfW = width / 2;
  const halfD = depth / 2;

  const corners: Point2[] = [
    { x: center.x - halfW, z: center.z - halfD },
    { x: center.x + halfW, z: center.z - halfD },
    { x: center.x + halfW, z: center.z + halfD },
    { x: center.x - halfW, z: center.z + halfD },
  ];

  const vertexIds = corners.map((corner) => {
    const id = newVertexId(plan);
    plan.vertices.push({ id, x: clampToPlan(corner.x), z: clampToPlan(corner.z) });
    return id;
  });

  const wallIds: string[] = [];
  for (let i = 0; i < vertexIds.length; i++) {
    const id = newWallId(plan);
    wallIds.push(id);
    plan.walls.push({
      id,
      start: vertexIds[i]!,
      end: vertexIds[(i + 1) % vertexIds.length]!,
      thickness: plan.defaultWallThickness,
      height: plan.defaultWallHeight,
      faces: {},
      openings: [],
    });
  }

  normalizePlan(plan);
  return wallIds;
}

/* ------------------------------- Openings ----------------------------- */

/** Inserts an opening into a wall at a given distance from its start. */
export function addOpening(
  plan: PlanModel,
  wallId: string,
  kind: OpeningKind,
  presetId: string,
  dimensions: { width: number; height: number; sillHeight: number },
  offset: number,
): string | null {
  const wall = plan.walls.find((candidate) => candidate.id === wallId);
  if (!wall) return null;

  const start = plan.vertices.find((v) => v.id === wall.start);
  const end = plan.vertices.find((v) => v.id === wall.end);
  if (!start || !end) return null;

  const wallLength = distance(start, end);
  const id = newOpeningId(plan);

  const opening: Opening = clampOpening(
    {
      id,
      kind,
      presetId,
      offset,
      width: dimensions.width,
      height: dimensions.height,
      sillHeight: dimensions.sillHeight,
      hinge: 'start',
      swing: 'a',
    },
    wallLength,
    wall.height,
  );

  // Refuse to stack openings on top of each other: two overlapping holes merge
  // into one ragged gap that reads as a modelling error rather than a design.
  const overlaps = wall.openings.some(
    (existing) =>
      Math.abs(existing.offset - opening.offset) < (existing.width + opening.width) / 2 + 0.05,
  );
  if (overlaps) return null;

  wall.openings.push(opening);
  return id;
}

/** Applies a partial update to an opening, re-clamping it to its wall. */
export function updateOpening(
  plan: PlanModel,
  openingId: string,
  update: Partial<Opening>,
): void {
  for (const wall of plan.walls) {
    const index = wall.openings.findIndex((opening) => opening.id === openingId);
    if (index === -1) continue;

    const start = plan.vertices.find((v) => v.id === wall.start);
    const end = plan.vertices.find((v) => v.id === wall.end);
    if (!start || !end) return;

    wall.openings[index] = clampOpening(
      { ...wall.openings[index]!, ...update },
      distance(start, end),
      wall.height,
    );
    return;
  }
}

export function removeOpening(plan: PlanModel, openingId: string): void {
  for (const wall of plan.walls) {
    wall.openings = wall.openings.filter((opening) => opening.id !== openingId);
  }
}

/** Finds which wall an opening belongs to. */
export function wallOfOpening(plan: PlanModel, openingId: string): Wall | null {
  return (
    plan.walls.find((wall) => wall.openings.some((opening) => opening.id === openingId)) ?? null
  );
}

/* ------------------------------- Queries ------------------------------ */

/**
 * The wall nearest a point in plan space, within a radius.
 *
 * Used for placing a door by clicking on a wall in the 3D view, where the
 * raycast gives a world position rather than a wall ID.
 */
export function nearestWall(
  plan: PlanModel,
  point: Point2,
  maxDistance: number,
): { wall: Wall; t: number; distance: number } | null {
  const byId = new Map(plan.vertices.map((vertex) => [vertex.id, vertex]));
  let best: { wall: Wall; t: number; distance: number } | null = null;

  for (const wall of plan.walls) {
    const start = byId.get(wall.start);
    const end = byId.get(wall.end);
    if (!start || !end) continue;

    const projection = projectOntoSegment(point, start, end);
    if (projection.distance > maxDistance) continue;
    if (!best || projection.distance < best.distance) {
      best = { wall, t: projection.t, distance: projection.distance };
    }
  }
  return best;
}

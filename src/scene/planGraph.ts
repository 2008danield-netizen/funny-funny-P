/**
 * The wall graph: plan maths, and the detection of enclosed rooms.
 *
 * -----------------------------------------------------------------------------
 * THIS MODULE REPLACES session 1's `roomGeometry.ts` -- and it is the seam that
 * file was written to anticipate. Everything downstream (meshes, materials,
 * camera framing, and eventually furniture collision) consumes the derived
 * `WallSegment[]` and `Region[]` produced here rather than reading raw plan data.
 *
 * The central problem this file solves: a user draws walls, and the app has to
 * work out what ROOMS those walls enclose. That is a planar-graph face-detection
 * problem, and `findRegions` is the implementation. Rooms are never stored -- they
 * are recomputed from the walls, so they can never drift out of sync with them.
 * -----------------------------------------------------------------------------
 */

import type { Opening, PlanModel, Point2, Vertex, Wall } from '@/state/types';
import { PLAN_LIMITS } from '@/state/types';

/* ----------------------------- Vector helpers ------------------------- */

export function subtract(a: Point2, b: Point2): Point2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

export function length(v: Point2): number {
  return Math.hypot(v.x, v.z);
}

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function normalize(v: Point2): Point2 {
  const len = length(v);
  return len < 1e-9 ? { x: 0, z: 0 } : { x: v.x / len, z: v.z / len };
}

/** Linear interpolation between two points. */
export function lerp(a: Point2, b: Point2, t: number): Point2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/* ------------------------------ Plan lookups -------------------------- */

/** Index of vertices by ID, so lookups inside loops stay O(1). */
export type VertexIndex = ReadonlyMap<string, Vertex>;

export function indexVertices(plan: PlanModel): VertexIndex {
  return new Map(plan.vertices.map((vertex) => [vertex.id, vertex]));
}

/**
 * A wall resolved into concrete geometry.
 *
 * The `a`/`b` naming is used consistently across the whole app: face "a" is the
 * side the wall's left normal points towards.
 */
export interface WallSegment {
  wall: Wall;
  start: Point2;
  end: Point2;
  /** Unit vector from start to end. */
  direction: Point2;
  /**
   * Unit normal, 90 degrees anticlockwise from `direction` in the XZ plane.
   * Points towards face "a".
   */
  normal: Point2;
  length: number;
  /** Midpoint of the wall's centreline. */
  center: Point2;
}

/**
 * Resolves a wall into world-space geometry, or null if it is degenerate.
 *
 * Degenerate walls (endpoints merged onto each other) are dropped rather than
 * rendered, because a zero-length wall produces a zero-area extrusion and NaN
 * normals downstream.
 */
export function resolveWall(wall: Wall, vertices: VertexIndex): WallSegment | null {
  const start = vertices.get(wall.start);
  const end = vertices.get(wall.end);
  if (!start || !end) return null;

  const delta = subtract(end, start);
  const len = length(delta);
  if (len < PLAN_LIMITS.minWallLength) return null;

  const direction = { x: delta.x / len, z: delta.z / len };

  return {
    wall,
    start: { x: start.x, z: start.z },
    end: { x: end.x, z: end.z },
    direction,
    // Rotating (x, z) by 90 degrees anticlockwise in a Y-up right-handed frame
    // gives (-z, x). This is the same basis used by `wallBasis` when building
    // meshes, so "face a" means the same thing in the geometry and in the data.
    normal: { x: -direction.z, z: direction.x },
    length: len,
    center: lerp(start, end, 0.5),
  };
}

/** Every non-degenerate wall in the plan, resolved. */
export function resolveWalls(plan: PlanModel, vertices = indexVertices(plan)): WallSegment[] {
  const segments: WallSegment[] = [];
  for (const wall of plan.walls) {
    const segment = resolveWall(wall, vertices);
    if (segment) segments.push(segment);
  }
  return segments;
}

/* ---------------------------- Region detection ------------------------ */

/** An enclosed room, derived from the wall graph. */
export interface Region {
  /**
   * Stable identity for this region: the sorted IDs of its bounding walls.
   *
   * Chosen so that MOVING walls keeps a room's identity (and therefore its
   * floor and paint), while genuinely changing which walls enclose a space
   * produces a new region. Splitting a room with a new wall yields two new
   * keys, which is why `inheritRoomSpec` falls back to the best-overlapping
   * previous region rather than resetting both halves to the default.
   */
  key: string;
  /** Bounding wall IDs in traversal order. */
  wallIds: string[];
  /** Corner points in anticlockwise order. */
  polygon: Point2[];
  /** Positive area, in square metres. */
  area: number;
  /**
   * A point guaranteed to lie INSIDE the room.
   *
   * Not the area-weighted centroid: for an L-shaped room that centroid can sit
   * in the notch, outside the room entirely (a 6x2 plus 2x6 L has its centroid
   * at 2.2, 2.2, which is in neither arm). Anything that needs "somewhere in
   * this room" -- camera framing, and later furniture drop points and room
   * labels -- needs a point that is actually in it.
   */
  interiorPoint: Point2;
  /**
   * For each bounding wall, which of its faces looks into this region.
   * Keyed by wall ID.
   */
  facing: Record<string, 'a' | 'b'>;
}

/** One direction of travel along a wall. */
interface HalfEdge {
  wallId: string;
  from: string;
  to: string;
  /** Angle of travel, for the angular sort around each vertex. */
  angle: number;
}

function halfEdgeKey(from: string, wallId: string): string {
  return `${from} ${wallId}`;
}

/** Shoelace signed area of a polygon in the XZ plane. */
function signedArea(polygon: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    sum += current.x * next.z - next.x * current.z;
  }
  return sum / 2;
}

/**
 * Area-weighted centroid of a polygon.
 *
 * NOTE: for a concave outline this can lie OUTSIDE the polygon -- an L made of a
 * 6x2 arm and a 2x6 arm has its centroid at (2.2, 2.2), which is in the notch
 * between the arms. Use `representativePoint` when a point must be inside.
 */
export function centroidOf(polygon: readonly Point2[]): Point2 {
  let cx = 0;
  let cz = 0;
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    const cross = current.x * next.z - next.x * current.z;
    area += cross;
    cx += (current.x + next.x) * cross;
    cz += (current.z + next.z) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-9) {
    const count = polygon.length || 1;
    return {
      x: polygon.reduce((sum, p) => sum + p.x, 0) / count,
      z: polygon.reduce((sum, p) => sum + p.z, 0) / count,
    };
  }
  return { x: cx / (6 * area), z: cz / (6 * area) };
}

/**
 * Finds every enclosed room in the plan.
 *
 * Standard planar-graph face traversal:
 *
 *  1. Split each wall into two half-edges, one per direction of travel.
 *  2. Around every vertex, sort the outgoing half-edges by angle.
 *  3. From a half-edge arriving at vertex V, the next edge of the same face is
 *     found by taking the REVERSE of the arriving edge and stepping to the next
 *     one clockwise around V. Following that rule repeatedly always returns to
 *     the start, having traced exactly one face.
 *  4. Every connected component of the graph produces one unbounded "outer"
 *     face alongside its rooms; that face is the one with the largest absolute
 *     area, and it is discarded.
 *
 * Faces are traced per connected component, so a plan containing two separate
 * structures does not lose the rooms of one to the other's outer face.
 */
/** One traced face of the planar graph: a room, or a component's outer boundary. */
interface Face {
  component: number;
  wallIds: string[];
  /**
   * For each entry of `wallIds`, whether the face traverses that wall from
   * its start vertex to its end vertex. This is what determines which side of
   * the wall the room is on -- see the note in the region assembly below.
   */
  forward: boolean[];
  vertexIds: string[];
  polygon: Point2[];
  signed: number;
}

/**
 * Traces every face of the plan's planar graph, outer faces included.
 *
 * Shared by room-finding, which throws the outer faces away, and by the roof,
 * which wants nothing else: the outline a roof covers is precisely the boundary
 * of the unbounded face around the building.
 */
function traceFaces(plan: PlanModel): { faces: Face[]; componentCount: number } {
  const vertices = indexVertices(plan);
  const segments = resolveWalls(plan, vertices);
  if (segments.length === 0) return { faces: [], componentCount: 0 };

  const segmentById = new Map(segments.map((segment) => [segment.wall.id, segment]));

  // Outgoing half-edges per vertex, sorted anticlockwise by angle.
  const outgoing = new Map<string, HalfEdge[]>();
  const addHalfEdge = (from: string, to: string, wallId: string) => {
    const a = vertices.get(from);
    const b = vertices.get(to);
    if (!a || !b) return;
    const list = outgoing.get(from) ?? [];
    list.push({ wallId, from, to, angle: Math.atan2(b.z - a.z, b.x - a.x) });
    outgoing.set(from, list);
  };

  for (const segment of segments) {
    addHalfEdge(segment.wall.start, segment.wall.end, segment.wall.id);
    addHalfEdge(segment.wall.end, segment.wall.start, segment.wall.id);
  }
  for (const list of outgoing.values()) list.sort((p, q) => p.angle - q.angle);

  // Position of each half-edge within its origin vertex's sorted ring.
  const ringPosition = new Map<string, number>();
  for (const [vertexId, list] of outgoing) {
    list.forEach((edge, index) => ringPosition.set(halfEdgeKey(vertexId, edge.wallId), index));
  }

  /** Given a half-edge arriving at `to`, the next half-edge of the same face. */
  const nextHalfEdge = (edge: HalfEdge): HalfEdge | null => {
    const ring = outgoing.get(edge.to);
    if (!ring || ring.length === 0) return null;

    // The reverse of the arriving edge, as seen from the vertex we arrived at.
    const reverseIndex = ringPosition.get(halfEdgeKey(edge.to, edge.wallId));
    if (reverseIndex === undefined) return null;

    // Step one place clockwise (backwards through the anticlockwise ring).
    const nextIndex = (reverseIndex - 1 + ring.length) % ring.length;
    return ring[nextIndex] ?? null;
  };

  // Partition the graph into connected components so each contributes its own
  // outer face -- otherwise a detached structure's rooms would be swallowed.
  const componentOf = new Map<string, number>();
  let componentCount = 0;
  for (const vertexId of outgoing.keys()) {
    if (componentOf.has(vertexId)) continue;
    const stack = [vertexId];
    componentOf.set(vertexId, componentCount);
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const edge of outgoing.get(current) ?? []) {
        if (componentOf.has(edge.to)) continue;
        componentOf.set(edge.to, componentCount);
        stack.push(edge.to);
      }
    }
    componentCount += 1;
  }

  const visited = new Set<string>();
  const faces: Face[] = [];
  const maxSteps = segments.length * 2 + 1;

  for (const ring of outgoing.values()) {
    for (const start of ring) {
      const startKey = halfEdgeKey(start.from, start.wallId);
      if (visited.has(startKey)) continue;

      const wallIds: string[] = [];
      const forward: boolean[] = [];
      const vertexIds: string[] = [];
      let edge: HalfEdge | null = start;
      let steps = 0;

      // Guarded against a malformed graph looping forever.
      while (edge && steps < maxSteps) {
        const key = halfEdgeKey(edge.from, edge.wallId);
        if (visited.has(key)) break;
        visited.add(key);
        wallIds.push(edge.wallId);
        forward.push(segmentById.get(edge.wallId)?.wall.start === edge.from);
        vertexIds.push(edge.from);
        edge = nextHalfEdge(edge);
        steps += 1;
        if (edge && halfEdgeKey(edge.from, edge.wallId) === startKey) break;
      }

      if (vertexIds.length < 3) continue;

      const polygon: Point2[] = [];
      for (const id of vertexIds) {
        const vertex = vertices.get(id);
        if (vertex) polygon.push({ x: vertex.x, z: vertex.z });
      }
      if (polygon.length < 3) continue;

      faces.push({
        component: componentOf.get(start.from) ?? 0,
        wallIds,
        forward,
        vertexIds,
        polygon,
        signed: signedArea(polygon),
      });
    }
  }

  return { faces, componentCount };
}

/**
 * The outer face of each connected component: the one enclosing everything
 * else, and so the one with the largest absolute area within that component.
 */
function outerFacesOf(faces: readonly Face[], componentCount: number): Set<Face> {
  const outerFaces = new Set<Face>();
  for (let component = 0; component < componentCount; component++) {
    const componentFaces = faces.filter((face) => face.component === component);
    if (componentFaces.length === 0) continue;

    let outer = componentFaces[0]!;
    for (const face of componentFaces) {
      const bigger = Math.abs(face.signed) > Math.abs(outer.signed) + 1e-9;
      // On a tie (a single enclosed room, where the room and the outer face have
      // equal area) the outer face is the negatively-wound one.
      const tieBreak =
        Math.abs(Math.abs(face.signed) - Math.abs(outer.signed)) <= 1e-9 &&
        face.signed < outer.signed;
      if (bigger || tieBreak) outer = face;
    }
    outerFaces.add(outer);
  }
  return outerFaces;
}

/**
 * The outline around the outside of the plan, anticlockwise.
 *
 * One entry per free-standing structure — a detached garage drawn beside the
 * house is its own outline and gets its own roof, rather than one roof being
 * stretched over both with a bridge of nothing in between.
 *
 * This is the CENTRELINE of the outermost walls. A roof needs the outside face
 * instead, which is this pushed out by half a wall's thickness; the roof builder
 * does that itself, because it also has to add the overhang and doing both at
 * once keeps the mitred corners consistent.
 */
export interface Outline {
  /** Corner points, anticlockwise. */
  polygon: Point2[];
  /**
   * The wall along each edge: edge i runs from `polygon[i]` to `polygon[i + 1]`.
   *
   * Aligned with the polygon rather than merely listed, because everything the
   * roof does with this — how thick the wall is, whether that eave is gabled —
   * is a question about one particular edge.
   */
  wallIds: string[];
}

export function outerBoundaries(plan: PlanModel): Outline[] {
  const { faces, componentCount } = traceFaces(plan);
  const outer = outerFacesOf(faces, componentCount);

  const outlines: Outline[] = [];
  for (const face of outer) {
    // Dangling walls are traced out-and-back and enclose nothing.
    if (Math.abs(face.signed) < 1e-6) continue;

    if (face.signed > 0) {
      outlines.push({ polygon: face.polygon, wallIds: face.wallIds });
      continue;
    }

    /*
     * Outer faces come out clockwise and every consumer here expects
     * anticlockwise, so the loop is reversed — and the wall list has to be
     * reversed to MATCH, which is not the same as reversing it.
     *
     * Reversed, edge j runs from v[n-1-j] to v[n-2-j], which is the original
     * edge n-2-j: the reversed list rotated one place. Reversing alone puts
     * every wall one edge out, which quietly hands each eave its neighbour's
     * thickness and gables the wrong end of the house.
     */
    const count = face.polygon.length;
    const wallIds = face.wallIds.map((_, index) => face.wallIds[(count - 2 - index + count) % count]!);
    outlines.push({ polygon: [...face.polygon].reverse(), wallIds });
  }

  // Largest first, so the main building leads.
  outlines.sort(
    (a, b) => Math.abs(signedArea(b.polygon)) - Math.abs(signedArea(a.polygon)),
  );
  return outlines;
}

export function findRegions(plan: PlanModel): Region[] {
  const { faces, componentCount } = traceFaces(plan);
  const outerFaces = outerFacesOf(faces, componentCount);

  const regions: Region[] = [];
  for (const face of faces) {
    if (outerFaces.has(face)) continue;
    // Dangling walls are traced out-and-back and enclose nothing.
    if (Math.abs(face.signed) < 1e-6) continue;

    // Normalise every room to anticlockwise winding so downstream geometry
    // (floor triangulation, skirting normals) can assume one orientation.
    // Reversing the loop also reverses the direction each wall is traversed in,
    // so the `forward` flags have to be flipped alongside it.
    const anticlockwise = face.signed > 0;
    const polygon = anticlockwise ? face.polygon : [...face.polygon].reverse();
    const wallIds = anticlockwise ? face.wallIds : [...face.wallIds].reverse();
    const forward = anticlockwise
      ? face.forward
      : [...face.forward].reverse().map((value) => !value);

    /*
     * Which face of each wall looks into this room?
     *
     * With the loop normalised anticlockwise, the room's interior is always on
     * the LEFT of the direction each wall is traversed in. A wall's own normal
     * is the left normal of its start-to-end direction and points towards face
     * "a". So the interior is face "a" exactly when the room traverses the wall
     * forwards, and face "b" when it traverses it backwards.
     *
     * This replaces an earlier test of which side of the wall the room's
     * centroid fell on, which was subtly wrong: for a concave room the centroid
     * can lie outside the room, putting paint on the wrong side of a wall.
     */
    const facing: Record<string, 'a' | 'b'> = {};
    wallIds.forEach((wallId, index) => {
      facing[wallId] = forward[index] ? 'a' : 'b';
    });

    regions.push({
      key: regionKey(face.wallIds),
      wallIds,
      polygon,
      area: Math.abs(face.signed),
      interiorPoint: representativePoint(polygon),
      facing,
    });
  }

  // Largest room first, so UI listings are stable and lead with the main space.
  regions.sort((a, b) => b.area - a.area);
  return regions;
}

/**
 * A point that is definitely inside a polygon.
 *
 * The area-weighted centroid is tried first, since for the convex rooms that
 * make up most plans it is both inside and the most natural centre. When it
 * falls outside a concave room, the polygon is sampled with horizontal
 * scanlines and the midpoint of the widest interior span is taken instead --
 * which lands in the middle of the room's largest arm, exactly where a person
 * would point at to say "this room".
 */
export function representativePoint(polygon: readonly Point2[]): Point2 {
  const centroid = centroidOf(polygon);
  if (pointInPolygon(centroid, polygon)) return centroid;

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of polygon) {
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }

  let best: Point2 = centroid;
  let bestWidth = -1;
  const samples = 21;

  for (let i = 1; i < samples; i++) {
    // Offset off exact fractions so a scanline is unlikely to graze a vertex,
    // where the crossing count becomes ambiguous.
    const z = minZ + ((maxZ - minZ) * (i + 0.5)) / samples;

    const crossings: number[] = [];
    for (let j = 0, k = polygon.length - 1; j < polygon.length; k = j++) {
      const a = polygon[j]!;
      const b = polygon[k]!;
      if (a.z > z === b.z > z) continue;
      crossings.push(((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x);
    }
    crossings.sort((p, q) => p - q);

    // Crossings pair up into interior spans: [0,1], [2,3], and so on.
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = crossings[pair]!;
      const to = crossings[pair + 1]!;
      const width = to - from;
      if (width > bestWidth) {
        bestWidth = width;
        best = { x: (from + to) / 2, z };
      }
    }
  }

  return best;
}

/** The stable identity of a region: its bounding walls, sorted. */
export function regionKey(wallIds: readonly string[]): string {
  return [...wallIds].sort().join('|');
}

/* --------------------------- Derived measurements --------------------- */

/** Total enclosed floor area across every room, in square metres. */
export function totalFloorArea(regions: readonly Region[]): number {
  return regions.reduce((sum, region) => sum + region.area, 0);
}

/** Perimeter of a polygon, in metres. */
export function polygonPerimeter(polygon: readonly Point2[]): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i++) {
    total += distance(polygon[i]!, polygon[(i + 1) % polygon.length]!);
  }
  return total;
}

/** Axis-aligned bounds of the whole plan. */
export interface PlanBounds {
  min: Point2;
  max: Point2;
  center: Point2;
  /** Radius of a sphere enclosing the plan and its wall height. */
  radius: number;
  width: number;
  depth: number;
  height: number;
}

export function planBounds(plan: PlanModel): PlanBounds {
  const height = plan.walls.reduce(
    (tallest, wall) => Math.max(tallest, wall.height),
    plan.defaultWallHeight,
  );

  if (plan.vertices.length === 0) {
    const origin = { x: 0, z: 0 };
    return {
      min: origin,
      max: origin,
      center: origin,
      radius: 4,
      width: 0,
      depth: 0,
      height,
    };
  }

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const vertex of plan.vertices) {
    minX = Math.min(minX, vertex.x);
    minZ = Math.min(minZ, vertex.z);
    maxX = Math.max(maxX, vertex.x);
    maxZ = Math.max(maxZ, vertex.z);
  }

  const width = maxX - minX;
  const depth = maxZ - minZ;

  return {
    min: { x: minX, z: minZ },
    max: { x: maxX, z: maxZ },
    center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
    radius: Math.max(1.5, Math.hypot(width, depth, height) / 2),
    width,
    depth,
    height,
  };
}

/** True when a point lies inside a polygon (ray-casting parity test). */
export function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const straddles = a.z > point.z !== b.z > point.z;
    if (!straddles) continue;
    const crossingX = ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (point.x < crossingX) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a line segment, and where along it the foot lies. */
export function projectOntoSegment(
  point: Point2,
  start: Point2,
  end: Point2,
): { distance: number; t: number; point: Point2 } {
  const delta = subtract(end, start);
  const lengthSquared = delta.x * delta.x + delta.z * delta.z;
  if (lengthSquared < 1e-12) {
    return { distance: distance(point, start), t: 0, point: start };
  }
  const raw = ((point.x - start.x) * delta.x + (point.z - start.z) * delta.z) / lengthSquared;
  const t = Math.min(1, Math.max(0, raw));
  const foot = lerp(start, end, t);
  return { distance: distance(point, foot), t, point: foot };
}

/* ------------------------------- Openings ----------------------------- */

/**
 * Clamps an opening so it fits within its wall.
 *
 * Called whenever a wall changes length: shortening a wall must not leave a
 * door hanging off the end, and an opening wider than its wall would produce a
 * hole that splits the wall into two floating pieces.
 */
export function clampOpening(opening: Opening, wallLength: number, wallHeight: number): Opening {
  const margin = 0.06;
  const maxWidth = Math.max(0.3, wallLength - margin * 2);
  const width = Math.min(opening.width, maxWidth);

  const half = width / 2;
  const minOffset = half + margin;
  const maxOffset = Math.max(minOffset, wallLength - half - margin);

  const maxHeight = Math.max(0.3, wallHeight - 0.05);
  const height = Math.min(opening.height, maxHeight);
  const sillHeight = Math.min(opening.sillHeight, Math.max(0, wallHeight - height - 0.02));

  return {
    ...opening,
    width,
    height,
    sillHeight,
    offset: Math.min(maxOffset, Math.max(minOffset, opening.offset)),
  };
}

/** World-space centre of an opening, at floor level. */
export function openingCenter(segment: WallSegment, opening: Opening): Point2 {
  const t = segment.length < 1e-9 ? 0 : opening.offset / segment.length;
  return lerp(segment.start, segment.end, Math.min(1, Math.max(0, t)));
}

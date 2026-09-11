/**
 * Cutting the building open.
 *
 * -----------------------------------------------------------------------------
 * WHAT A SECTION IS, AND WHY IT IS THE DRAWING THAT MATTERS.
 *
 * A plan tells you where things are. An elevation tells you what it looks like
 * from outside. Neither tells you how TALL anything is on the inside, how thick
 * the floor is, whether the stair fits under the ceiling it passes through, or
 * whether the duct and the joist want the same 200 mm. Those are section
 * questions, and they are the questions that stop a building being buildable.
 *
 * So this module takes a vertical plane through the model and works out
 * everything it passes through: which walls are cut and where, which openings
 * fall in those walls, where each floor slab sits, where the roof crosses, and
 * what is visible standing behind the cut.
 *
 * -----------------------------------------------------------------------------
 * TWO KINDS OF GEOMETRY, AND THEY ARE DRAWN COMPLETELY DIFFERENTLY.
 *
 *   CUT — the plane passes through the material. Drawn heavy and filled,
 *         because a cut surface is solid matter you are looking at the raw end
 *         of. This is where the construction layers show.
 *   BEYOND — behind the plane, seen in elevation. Drawn light, unfilled,
 *         because it is a surface seen at a distance rather than a cut.
 *
 * Getting those two confused is the single most common way a section drawing
 * misleads: a wall drawn heavy that is actually ten metres behind you reads as
 * an enclosure that is not there.
 *
 * -----------------------------------------------------------------------------
 * THE COORDINATE FRAME.
 *
 * Everything comes back in section coordinates: `u` along the cut line from its
 * start, and `y` the real world height above the site datum. That makes the
 * drawing code a straight mapping with no geometry left in it, and it makes the
 * live clipping plane in the 3D view read the same numbers — which is what
 * stops the drawing and the model disagreeing about where the cut is.
 *
 * `depth` is the third axis: how far BEHIND the cut plane something is. Zero is
 * on the plane, positive is away from the viewer, negative is between the
 * viewer and the plane — which is the half that gets thrown away.
 */

import {
  indexVertices,
  outerBoundaries,
  resolveWalls,
  type WallSegment,
} from '@/scene/planGraph';
import { roofGeometry, roofHeightAt } from '@/building/roof';
import { groundHeightAt } from '@/building/site';
import { elevationOf } from '@/state/levels';
import { stairGeometry } from '@/building/stairs';
import type { DesignDocument, Level, Point2, SectionCut } from '@/state/types';

/* -------------------------------- The frame ------------------------------- */

export interface SectionFrame {
  /** Where u = 0 sits in plan. */
  origin: Point2;
  /** Unit vector along the cut, in the direction of increasing u. */
  along: Point2;
  /**
   * Unit vector pointing AWAY from the viewer — into the drawing.
   *
   * This is the whole of what `looks` means, reduced to a vector, so nothing
   * downstream has to remember which side 'left' was.
   */
  away: Point2;
  length: number;
}

export function sectionFrame(cut: SectionCut): SectionFrame {
  const dx = cut.to.x - cut.from.x;
  const dz = cut.to.z - cut.from.z;
  const length = Math.hypot(dx, dz);

  // A degenerate line has no direction to speak of. The validator drops these
  // before they are stored, so this is belt and braces for a hand-made cut.
  if (length < 1e-6) {
    return { origin: cut.from, along: { x: 1, z: 0 }, away: { x: 0, z: 1 }, length: 0 };
  }

  const along = { x: dx / length, z: dz / length };

  /*
   * The left-hand normal, walking from `from` towards `to`.
   *
   * In this app's coordinates x is right and z is INTO the screen in plan, so
   * the left-hand side of that walk is (along.z, -along.x). If the viewer
   * stands on the left they look towards the right, and vice versa — so `away`
   * is the normal pointing at the half being kept.
   */
  const left = { x: along.z, z: -along.x };
  const away = cut.looks === 'left' ? { x: -left.x, z: -left.z } : left;

  return { origin: cut.from, along, away, length };
}

/** A world point in section coordinates. */
export function toSection(frame: SectionFrame, point: Point2): { u: number; depth: number } {
  const dx = point.x - frame.origin.x;
  const dz = point.z - frame.origin.z;
  return {
    u: dx * frame.along.x + dz * frame.along.z,
    depth: dx * frame.away.x + dz * frame.away.z,
  };
}

/** A section coordinate back in the world, at the cut plane. */
export function toWorld(frame: SectionFrame, u: number, depth = 0): Point2 {
  return {
    x: frame.origin.x + frame.along.x * u + frame.away.x * depth,
    z: frame.origin.z + frame.along.z * u + frame.away.z * depth,
  };
}

/* -------------------------------- The model ------------------------------- */

/** A run along the cut, in section coordinates. */
export interface Span {
  from: number;
  to: number;
}

export interface CutOpening {
  id: string;
  kind: 'door' | 'window';
  span: Span;
  /** World heights of the opening's bottom and top. */
  sill: number;
  head: number;
}

export interface CutWall {
  wallId: string;
  levelId: string;
  /** Where the wall's thickness crosses the cut, along u. */
  span: Span;
  /** World height of the wall's bottom and top. */
  base: number;
  top: number;
  thickness: number;
  /** Whether this wall separates inside from outside, which sets its build-up. */
  exterior: boolean;
  openings: CutOpening[];
}

export interface CutFloor {
  levelId: string;
  levelName: string;
  /** Where the floor exists along u. Several spans for an L-shaped plan. */
  spans: Span[];
  /** World height of the finished floor. */
  top: number;
  thickness: number;
}

/** Where a surface crosses the cut, as a height profile along u. */
export interface Profile {
  points: Array<{ u: number; y: number }>;
}

export interface CutRoof {
  roofId: string;
  /** The roof surface where the plane crosses it. */
  profile: Profile;
  thickness: number;
}

export interface CutStair {
  stairId: string;
  /** The nosing line, which is what a section through a stair actually shows. */
  profile: Profile;
  /** The headroom available above each tread, for the check that reads it. */
  minHeadroom: number;
}

/** A surface behind the cut plane, seen in elevation rather than cut. */
export interface BeyondWall {
  wallId: string;
  levelId: string;
  span: Span;
  base: number;
  top: number;
  /** How far behind the plane, for the depth sort. */
  depth: number;
  openings: CutOpening[];
}

export interface SectionModel {
  cut: SectionCut;
  frame: SectionFrame;
  walls: CutWall[];
  floors: CutFloor[];
  roofs: CutRoof[];
  stairs: CutStair[];
  beyond: BeyondWall[];
  /** The ground profile along the cut, which a section is measured up from. */
  ground: Profile;
  extent: { minU: number; maxU: number; minY: number; maxY: number };
  /** What could not be worked out, in the same style as every other service. */
  notes: string[];
}

/* ------------------------------ Intersection ------------------------------ */

/**
 * Where a wall's rectangle crosses the cut line.
 *
 * A wall is not a line — it has thickness, and the section cuts through that
 * thickness. So the wall is treated as its four corners projected into section
 * coordinates, and the answer is the range of u over which the wall straddles
 * depth = 0. A wall that the line merely touches at a corner gives a span of
 * almost nothing and is dropped, because drawing it would put a hairline of
 * solid material where there is none.
 */
function wallCrossing(frame: SectionFrame, segment: WallSegment): Span | null {
  const half = segment.wall.thickness / 2;

  const corners: Point2[] = [];
  for (const end of [segment.start, segment.end]) {
    for (const side of [1, -1]) {
      corners.push({
        x: end.x + segment.normal.x * half * side,
        z: end.z + segment.normal.z * half * side,
      });
    }
  }

  const projected = corners.map((corner) => toSection(frame, corner));

  // The rectangle straddles the plane only if it has corners on both sides.
  const front = projected.some((point) => point.depth < -1e-9);
  const back = projected.some((point) => point.depth > 1e-9);
  if (!front || !back) return null;

  /*
   * Walk the rectangle's edges and collect where each crosses depth = 0. The
   * corners are in the order (start+, start-, end+, end-), so the rectangle's
   * perimeter is 0-1-3-2.
   */
  const order = [0, 1, 3, 2];
  const crossings: number[] = [];

  for (let i = 0; i < order.length; i += 1) {
    const a = projected[order[i]!]!;
    const b = projected[order[(i + 1) % order.length]!]!;
    if (a.depth === b.depth) continue;
    if (a.depth > 0 === b.depth > 0) continue;

    const t = a.depth / (a.depth - b.depth);
    crossings.push(a.u + (b.u - a.u) * t);
  }

  if (crossings.length < 2) return null;

  const from = Math.min(...crossings);
  const to = Math.max(...crossings);
  return to - from < 1e-6 ? null : { from, to };
}

/** Whether a wall has outside on one of its faces. */
function isExterior(level: Level, wallId: string): boolean {
  // A wall on an outer boundary has the world on one side of it. The boundary
  // tracer already knows which walls those are, so this asks it rather than
  // re-deriving the answer and risking a different one.
  for (const outline of outerBoundaries(level.plan)) {
    if (outline.wallIds.includes(wallId)) return true;
  }
  return false;
}

/**
 * Samples a height function along the cut and simplifies the result.
 *
 * Used for the roof and the ground, both of which are piecewise flat but not in
 * any way this module should have to know about. Sampling finely and then
 * dropping points that sit on the line between their neighbours turns a hip
 * roof into exactly the four or five points it really is, without this file
 * needing to understand straight skeletons or terrain meshes.
 */
function sampleProfile(
  frame: SectionFrame,
  from: number,
  to: number,
  step: number,
  height: (point: Point2) => number | null,
): Profile {
  const points: Array<{ u: number; y: number }> = [];
  const count = Math.max(2, Math.ceil((to - from) / step));

  for (let i = 0; i <= count; i += 1) {
    const u = from + ((to - from) * i) / count;
    const y = height(toWorld(frame, u));
    if (y === null) {
      // A gap — past the end of the roof. Close the run so the next stretch
      // starts fresh rather than being joined across thin air.
      if (points.length > 0 && points[points.length - 1]!.y !== null) {
        points.push({ u, y: Number.NaN });
      }
      continue;
    }
    points.push({ u, y });
  }

  return { points: simplify(points.filter((point) => Number.isFinite(point.y))) };
}

/** Drops points that lie on the straight line between their neighbours. */
function simplify(points: Array<{ u: number; y: number }>): Array<{ u: number; y: number }> {
  if (points.length <= 2) return points;

  const result = [points[0]!];
  for (let i = 1; i < points.length - 1; i += 1) {
    const previous = result[result.length - 1]!;
    const current = points[i]!;
    const next = points[i + 1]!;

    const span = next.u - previous.u;
    if (Math.abs(span) < 1e-9) continue;

    const expected = previous.y + ((current.u - previous.u) / span) * (next.y - previous.y);
    // 5 mm: finer than any line weight on the drawing, so nothing visible is lost.
    if (Math.abs(current.y - expected) > 0.005) result.push(current);
  }
  result.push(points[points.length - 1]!);
  return result;
}

/* ------------------------------- The builder ------------------------------ */

/**
 * Cuts the whole building open along one plane.
 *
 * Derived every time, never stored — the same rule the pipe and duct sizes
 * follow. A stored section is a section that is right until somebody moves a
 * wall, and a stale drawing is worse than no drawing.
 */
export function buildSection(doc: DesignDocument, cut: SectionCut): SectionModel {
  const frame = sectionFrame(cut);
  const notes: string[] = [];

  const model: SectionModel = {
    cut,
    frame,
    walls: [],
    floors: [],
    roofs: [],
    stairs: [],
    beyond: [],
    ground: { points: [] },
    extent: { minU: 0, maxU: frame.length, minY: 0, maxY: 0 },
    notes,
  };

  if (frame.length < 1e-6) {
    notes.push('The cut line has no length, so there is nothing to draw.');
    return model;
  }

  /* ---- Walls: cut, or seen beyond ---- */

  for (const level of doc.levels) {
    const base = elevationOf(doc, level.id);
    const vertices = indexVertices(level.plan);

    for (const segment of resolveWalls(level.plan, vertices)) {
      const span = wallCrossing(frame, segment);
      const top = base + (segment.wall.height || level.wallHeight);

      if (span) {
        model.walls.push({
          wallId: segment.wall.id,
          levelId: level.id,
          span,
          base,
          top,
          thickness: segment.wall.thickness,
          exterior: isExterior(level, segment.wall.id),
          openings: openingsInCut(frame, segment, base, span),
        });
        continue;
      }

      /*
       * Not cut. It is drawn as "beyond" only if it is entirely on the far
       * side — a wall between the viewer and the cut is in the half that was
       * removed, and drawing it would show something the section says is not
       * there.
       */
      const ends = [segment.start, segment.end].map((point) => toSection(frame, point));
      if (!ends.every((end) => end.depth > 0)) continue;

      const us = ends.map((end) => end.u);
      model.beyond.push({
        wallId: segment.wall.id,
        levelId: level.id,
        span: { from: Math.min(...us), to: Math.max(...us) },
        base,
        top,
        depth: Math.min(...ends.map((end) => end.depth)),
        openings: openingsBeyond(frame, segment, base),
      });
    }
  }

  /* ---- Floors ---- */

  for (const level of doc.levels) {
    const spans = floorSpans(frame, level);
    if (spans.length === 0) continue;

    model.floors.push({
      levelId: level.id,
      levelName: level.name,
      spans,
      top: elevationOf(doc, level.id),
      thickness: level.slabThickness,
    });
  }

  /* ---- The roof ---- */

  for (const roof of doc.roofs) {
    const geometry = roofGeometry(doc, roof);
    if (!geometry) continue;

    const profile = sampleProfile(frame, 0, frame.length, 0.05, (point) =>
      roofHeightAt(geometry, point),
    );
    if (profile.points.length < 2) continue;

    model.roofs.push({ roofId: roof.id, profile, thickness: 0.25 });
  }

  /* ---- Stairs, which are the reason half of all sections get drawn ---- */

  for (const stair of doc.stairs) {
    const cutStair = stairCrossing(doc, frame, stair.id);
    if (cutStair) model.stairs.push(cutStair);
  }

  /* ---- The ground ---- */

  model.ground = sampleProfile(frame, 0, frame.length, 0.25, (point) =>
    groundHeightAt(doc.site, point),
  );

  /* ---- The extent everything has to fit in ---- */

  let minY = 0;
  let maxY = 0;
  for (const point of model.ground.points) minY = Math.min(minY, point.y);
  for (const wall of model.walls) maxY = Math.max(maxY, wall.top);
  for (const wall of model.beyond) maxY = Math.max(maxY, wall.top);
  for (const roof of model.roofs) {
    for (const point of roof.profile.points) maxY = Math.max(maxY, point.y);
  }
  for (const floor of model.floors) {
    minY = Math.min(minY, floor.top - floor.thickness);
    maxY = Math.max(maxY, floor.top);
  }

  model.extent = { minU: 0, maxU: frame.length, minY, maxY };

  if (model.walls.length === 0) {
    notes.push('The cut line does not pass through any wall. Drag it across the building.');
  }

  return model;
}

/* -------------------------------- Openings -------------------------------- */

/**
 * Openings in a cut wall that the cut line actually passes through.
 *
 * -----------------------------------------------------------------------------
 * THIS HAS TO BE TESTED ALONG THE WALL, NOT IN SECTION COORDINATES.
 *
 * The obvious version — project the opening into `u` and see whether it
 * overlaps the wall's cut span — is wrong, and wrong in a way that looks
 * plausible. Take a wall running square across the cut line. Every point along
 * that wall projects to almost the same `u`, because moving along it moves
 * perpendicular to the cut. So every opening in it overlaps the cut span, and
 * a section through the blank end of a wall would draw a doorway that is four
 * metres away.
 *
 * The real question is where along the WALL the cut crosses, and whether an
 * opening is at that point. So the crossing is solved on the wall's own
 * centreline and compared against each opening's offset.
 */
function openingsInCut(
  frame: SectionFrame,
  segment: WallSegment,
  base: number,
  wallSpan: Span,
): CutOpening[] {
  const found: CutOpening[] = [];

  // How fast depth changes as you walk the wall. Near zero means the wall runs
  // parallel to the cut and there is no single crossing point.
  const rate = segment.direction.x * frame.away.x + segment.direction.z * frame.away.z;
  const parallel = Math.abs(rate) < 1e-6;

  const startDepth = toSection(frame, segment.start).depth;
  const crossingAlongWall = parallel ? null : -startDepth / rate;

  for (const opening of segment.wall.openings) {
    if (crossingAlongWall !== null) {
      // Half the opening's width either side of its centre, along the wall.
      if (Math.abs(crossingAlongWall - opening.offset) > opening.width / 2) continue;
    }

    const centre = {
      x: segment.start.x + segment.direction.x * opening.offset,
      z: segment.start.z + segment.direction.z * opening.offset,
    };
    const at = toSection(frame, centre);

    /*
     * How wide the void is along u.
     *
     * The opening's half-width projected onto the cut: a wall at an angle
     * presents a wider face than its true width, which is correct — that is
     * what you would see.
     *
     * But never narrower than the wall's own cut span. Square across the cut
     * the projection collapses to nothing, which would reject every opening
     * that the along-wall test just correctly identified as cut. Physically
     * the hole goes through the full thickness, and what you see looking at it
     * is the reveal — so the void is at least the wall's cut span, and wider
     * only where the wall runs at an angle.
     */
    const alongU = Math.abs(
      segment.direction.x * frame.along.x + segment.direction.z * frame.along.z,
    );
    const halfSpan = Math.max(
      (opening.width / 2) * alongU,
      (wallSpan.to - wallSpan.from) / 2 + 1e-6,
    );

    const from = Math.max(wallSpan.from, at.u - halfSpan);
    const to = Math.min(wallSpan.to, at.u + halfSpan);
    if (to - from < 1e-6) continue;

    found.push({
      id: opening.id,
      kind: opening.kind === 'door' ? 'door' : 'window',
      span: { from, to },
      sill: base + opening.sillHeight,
      head: base + opening.sillHeight + opening.height,
    });
  }

  return found;
}

/** Openings in a wall seen beyond, at their true position along the cut. */
function openingsBeyond(
  frame: SectionFrame,
  segment: WallSegment,
  base: number,
): CutOpening[] {
  const alongU = Math.abs(
    segment.direction.x * frame.along.x + segment.direction.z * frame.along.z,
  );

  return segment.wall.openings.map((opening) => {
    const centre = {
      x: segment.start.x + segment.direction.x * opening.offset,
      z: segment.start.z + segment.direction.z * opening.offset,
    };
    const at = toSection(frame, centre);
    const half = (opening.width / 2) * alongU;

    return {
      id: opening.id,
      kind: opening.kind === 'door' ? ('door' as const) : ('window' as const),
      span: { from: at.u - half, to: at.u + half },
      sill: base + opening.sillHeight,
      head: base + opening.sillHeight + opening.height,
    };
  });
}

/* --------------------------------- Floors --------------------------------- */

/**
 * Where a storey's floor exists along the cut.
 *
 * Taken from the outer boundary rather than from the rooms, because a floor
 * slab spans the whole footprint including under the internal walls — and a
 * section that showed the floor stopping at each partition would be nonsense.
 */
function floorSpans(frame: SectionFrame, level: Level): Span[] {
  const spans: Span[] = [];

  for (const outline of outerBoundaries(level.plan)) {
    const crossings: number[] = [];
    const points = outline.polygon;

    for (let i = 0; i < points.length; i += 1) {
      const a = toSection(frame, points[i]!);
      const b = toSection(frame, points[(i + 1) % points.length]!);
      if (a.depth === b.depth) continue;
      if (a.depth > 0 === b.depth > 0) continue;

      const t = a.depth / (a.depth - b.depth);
      crossings.push(a.u + (b.u - a.u) * t);
    }

    crossings.sort((a, b) => a - b);
    // Crossings come in pairs: in, out, in, out. An odd count means the cut
    // clipped a corner exactly, which is not a span worth drawing.
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = crossings[i]!;
      const to = crossings[i + 1]!;
      if (to - from > 1e-6) spans.push({ from, to });
    }
  }

  return spans;
}

/* --------------------------------- Stairs --------------------------------- */

/**
 * A stair where the cut passes through it.
 *
 * The profile is the nosing line — the sawtooth a section through a flight
 * actually shows — because that is what makes the rise and going legible and
 * what the headroom is measured from.
 */
function stairCrossing(
  doc: DesignDocument,
  frame: SectionFrame,
  stairId: string,
): CutStair | null {
  const stair = doc.stairs.find((entry) => entry.id === stairId);
  if (!stair) return null;

  const geometry = stairGeometry(doc, stair);
  if (!geometry || geometry.treads.length === 0) return null;

  const base = elevationOf(doc, stair.fromLevelId);
  const points: Array<{ u: number; y: number }> = [];

  for (const tread of geometry.treads) {
    const at = toSection(frame, tread.nosing);

    /*
     * How far off the plane still counts as cut.
     *
     * Half the tread's own width, worked out from its polygon rather than
     * assumed: a winder is much wider at its outer end than a straight tread,
     * and a fixed tolerance would either miss the cut or catch a flight two
     * metres away.
     */
    let half = 0;
    for (const corner of tread.polygon) {
      half = Math.max(half, Math.abs(toSection(frame, corner).depth - at.depth));
    }
    if (Math.abs(at.depth) > half + 1e-6) continue;

    // Riser then tread, which is what draws the sawtooth a section shows.
    points.push({ u: at.u, y: base + tread.height - (geometry.riserHeight || 0) });
    points.push({ u: at.u, y: base + tread.height });
  }

  if (points.length < 2) return null;

  points.sort((a, b) => a.u - b.u || a.y - b.y);

  /*
   * Headroom is left at zero here on purpose.
   *
   * It is a real measurement against a real ceiling, and `stairCode.ts` already
   * computes it properly against the floor opening above. Working it out a
   * second time from the section would give a second answer to one question,
   * which is the thing this codebase keeps refusing to do.
   */
  return { stairId, profile: { points }, minHeadroom: 0 };
}

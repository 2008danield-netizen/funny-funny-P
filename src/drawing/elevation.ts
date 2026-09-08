/**
 * Elevations: the building seen square-on from each side.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS DRAWN, AND WHAT IS DELIBERATELY NOT.
 *
 * An elevation is an orthographic projection — no perspective, everything at
 * true scale — of what you would see standing far enough away on one side. It
 * is built here from three things the model genuinely knows:
 *
 *   • THE ENVELOPE of each storey, as the union of the outer walls projected
 *     onto the viewing axis. An L-shaped plan gives an L-shaped outline in
 *     elevation, because the union is computed as intervals rather than as a
 *     bounding box.
 *   • THE OPENINGS in the walls that face this way, at their true position,
 *     sill height and head height.
 *   • THE ROOF, as its silhouette: for each position across the building, the
 *     highest point the roof reaches anywhere behind it. That gives a true
 *     ridge, true eaves, and true gable ends, from the same straight-skeleton
 *     geometry the 3D view is built from.
 *
 * WHAT IS NOT DRAWN is hidden-line removal within a storey. A facade that steps
 * in and out shows as one plane, not as a near face and a far face with a
 * shadow line between them. Doing that properly needs a depth sort of every
 * surface, and a half-done version would draw lines in places there are none —
 * which on a drawing somebody builds from is worse than a plainer elevation.
 * The set says so on the sheet rather than leaving it to be discovered.
 */

import { PdfPage, type Colour } from './pdf';
import { GREY, LIGHT, WEIGHTS, drawDimension, drawWitness } from './sheet';
import type { DrawingScale, Frame } from './scale';
import { pointsPerMetre } from './scale';
import { outerBoundaries, resolveWalls } from '@/scene/planGraph';
import { roofGeometry, roofHeightAt } from '@/building/roof';
import { elevationOf } from '@/state/levels';
import { groundHeightAt } from '@/building/site';
import type { DesignDocument, Point2 } from '@/state/types';

const WALL_FILL: Colour = [0.93, 0.93, 0.92];
const ROOF_FILL: Colour = [0.86, 0.86, 0.85];

export type Side = 'north' | 'south' | 'east' | 'west';

export const SIDES: readonly Side[] = ['north', 'south', 'east', 'west'];

/**
 * The viewing frame for one side.
 *
 * `forward` is the direction the viewer LOOKS, and `right` is what appears to
 * their right — which is the axis the elevation is drawn along. North is up the
 * screen in plan, so looking at the north face means looking towards +z.
 */
function frameFor(side: Side): { forward: Point2; right: Point2 } {
  switch (side) {
    case 'north':
      return { forward: { x: 0, z: 1 }, right: { x: 1, z: 0 } };
    case 'south':
      return { forward: { x: 0, z: -1 }, right: { x: -1, z: 0 } };
    case 'east':
      return { forward: { x: -1, z: 0 }, right: { x: 0, z: 1 } };
    case 'west':
      return { forward: { x: 1, z: 0 }, right: { x: 0, z: -1 } };
  }
}

const dot = (a: Point2, b: Point2) => a.x * b.x + a.z * b.z;

/* ------------------------------ The silhouette ---------------------------- */

/** A closed run along the viewing axis. */
interface Interval {
  from: number;
  to: number;
}

/** Merges overlapping runs, which is what makes an L-shape read as an L. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const merged: Interval[] = [{ ...sorted[0]! }];

  for (const interval of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (interval.from <= last.to + 1e-6) last.to = Math.max(last.to, interval.to);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Where each storey's walls sit along the viewing axis. */
function storeyIntervals(doc: DesignDocument, levelId: string, side: Side): Interval[] {
  const level = doc.levels.find((entry) => entry.id === levelId);
  if (!level) return [];
  const { right } = frameFor(side);

  const intervals: Interval[] = [];
  for (const segment of resolveWalls(level.plan)) {
    const half = segment.wall.thickness / 2;
    const values: number[] = [];
    for (const end of [segment.start, segment.end]) {
      for (const across of [1, -1]) {
        values.push(
          dot({ x: end.x + segment.normal.x * half * across, z: end.z + segment.normal.z * half * across }, right),
        );
      }
    }
    intervals.push({ from: Math.min(...values), to: Math.max(...values) });
  }
  return mergeIntervals(intervals);
}

/* ------------------------------- The extent ------------------------------- */

export interface ElevationExtent {
  /** Along the viewing axis. */
  minU: number;
  maxU: number;
  /** Above the site datum. */
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

/** How big this elevation is, so a scale can be chosen before it is drawn. */
export function elevationExtent(doc: DesignDocument, side: Side): ElevationExtent {
  const { right } = frameFor(side);

  let minU = Infinity;
  let maxU = -Infinity;
  let maxY = 0;

  for (const level of doc.levels) {
    for (const interval of storeyIntervals(doc, level.id, side)) {
      minU = Math.min(minU, interval.from);
      maxU = Math.max(maxU, interval.to);
    }
    maxY = Math.max(maxY, elevationOf(doc, level.id) + level.wallHeight);
  }

  for (const roof of doc.roofs) {
    const geometry = roofGeometry(doc, roof);
    if (!geometry) continue;
    for (const plane of geometry.planes) {
      for (const point of plane.points) {
        const u = dot({ x: point.x, z: point.z }, right);
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        maxY = Math.max(maxY, point.y);
      }
    }
  }

  if (!Number.isFinite(minU)) return { minU: 0, maxU: 0, minY: 0, maxY: 0, width: 0, height: 0 };

  // The ground under the building, which is where the elevation is measured up
  // from and which is below zero on a site that falls away.
  let minY = 0;
  for (const level of doc.levels) {
    for (const segment of resolveWalls(level.plan)) {
      minY = Math.min(minY, groundHeightAt(doc.site, segment.center));
    }
  }

  return { minU, maxU, minY, maxY, width: maxU - minU, height: maxY - minY };
}

/* -------------------------------- Drawing --------------------------------- */

export interface ElevationOptions {
  format: (metres: number) => string;
  showDimensions: boolean;
}

/**
 * Draws one elevation, centred in the frame at the given scale.
 *
 * Order matters: the roof is drawn first and the storeys over it, so a wall
 * that rises past an eave — a gable end, a parapet — covers the roof behind it
 * rather than being covered by it.
 */
export function drawElevation(
  page: PdfPage,
  doc: DesignDocument,
  side: Side,
  scale: DrawingScale,
  frame: Frame,
  options: ElevationOptions,
): void {
  const extent = elevationExtent(doc, side);
  if (extent.width <= 0) return;

  const perMetre = pointsPerMetre(scale);
  const originX = frame.x + frame.width / 2 - ((extent.minU + extent.maxU) / 2) * perMetre;
  // The ground line sits a little above the bottom of the frame.
  const groundY = frame.y + 34;
  const at = (u: number, y: number) => ({ x: originX + u * perMetre, y: groundY + (y - extent.minY) * perMetre });

  drawRoofSilhouette(page, doc, side, at, extent);
  drawStoreys(page, doc, side, at);
  drawGround(page, doc, side, at, extent, frame);

  if (options.showDimensions) drawHeights(page, doc, at, extent, frame, options);
}

/** Each storey as a filled outline, with its openings cut into it. */
function drawStoreys(
  page: PdfPage,
  doc: DesignDocument,
  side: Side,
  at: (u: number, y: number) => { x: number; y: number },
): void {
  const { forward, right } = frameFor(side);

  for (const level of doc.levels) {
    const base = elevationOf(doc, level.id);
    const top = base + level.wallHeight;

    page.save().lineWidth(WEIGHTS.outline).strokeColour([0, 0, 0]).fillColour(WALL_FILL).dash(null);
    for (const interval of storeyIntervals(doc, level.id, side)) {
      page
        .path(
          [at(interval.from, base), at(interval.to, base), at(interval.to, top), at(interval.from, top)],
          true,
        )
        .fillAndStroke();
    }
    page.restore();

    /* ---- Openings in the walls that face this way ---- */
    const boundaryWalls = new Set(outerBoundaries(level.plan).flatMap((outline) => outline.wallIds));

    page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);
    for (const segment of resolveWalls(level.plan)) {
      if (!boundaryWalls.has(segment.wall.id)) continue;
      // A wall square to the view shows its face; one edge-on shows nothing.
      if (Math.abs(dot(segment.normal, forward)) < 0.7) continue;

      for (const opening of segment.wall.openings) {
        const centre = {
          x: segment.start.x + segment.direction.x * opening.offset,
          z: segment.start.z + segment.direction.z * opening.offset,
        };
        const u = dot(centre, right);
        // Which way along the axis the opening's width runs.
        const halfU = (Math.abs(dot(segment.direction, right)) * opening.width) / 2;
        const sill = base + opening.sillHeight;
        const head = sill + opening.height;

        // Fill colour set before the path starts — see the note in
        // `electricalSheet.ts`: a state operator inside a path object is
        // illegal and costs a reader everything after it.
        page.fillColour([0.99, 0.99, 0.99]);
        page
          .path([at(u - halfU, sill), at(u + halfU, sill), at(u + halfU, head), at(u - halfU, head)], true)
          .fillAndStroke();

        if (opening.kind === 'window') {
          // The glazing bar, which is what makes a window read as a window and
          // not as a hole.
          page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY);
          page.path([at(u, sill), at(u, head)]).stroke();
          page.path([at(u - halfU, (sill + head) / 2), at(u + halfU, (sill + head) / 2)]).stroke();
          page.restore();
        }
      }
    }
    page.restore();
  }
}

/**
 * The roof, as the highest thing anywhere behind each point across the front.
 *
 * Sampled rather than solved because the silhouette of a hipped roof seen from
 * an angle its planes do not share is genuinely a sampled curve — and at a
 * centimetre of building per sample it is finer than the line weight it is
 * drawn with.
 */
function drawRoofSilhouette(
  page: PdfPage,
  doc: DesignDocument,
  side: Side,
  at: (u: number, y: number) => { x: number; y: number },
  extent: ElevationExtent,
): void {
  const geometries = doc.roofs
    .map((roof) => roofGeometry(doc, roof))
    .filter((geometry): geometry is NonNullable<typeof geometry> => geometry !== null);
  if (geometries.length === 0) return;

  const { forward, right } = frameFor(side);

  // The range to look along, behind each point across the front.
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const geometry of geometries) {
    for (const plane of geometry.planes) {
      for (const point of plane.points) {
        const depth = dot({ x: point.x, z: point.z }, forward);
        minDepth = Math.min(minDepth, depth);
        maxDepth = Math.max(maxDepth, depth);
      }
    }
  }
  if (!Number.isFinite(minDepth)) return;

  const across = Math.max(60, Math.min(400, Math.round(extent.width * 25)));
  const deep = Math.max(20, Math.min(120, Math.round((maxDepth - minDepth) * 20)));

  const profile: Array<{ u: number; y: number }> = [];
  let lowest = Infinity;

  for (let i = 0; i <= across; i++) {
    const u = extent.minU + ((extent.maxU - extent.minU) * i) / across;
    let highest = -Infinity;

    for (let j = 0; j <= deep; j++) {
      const depth = minDepth + ((maxDepth - minDepth) * j) / deep;
      // Back from the viewing axes to a point in the plan.
      const point = {
        x: right.x * u + forward.x * depth,
        z: right.z * u + forward.z * depth,
      };
      for (const geometry of geometries) {
        const height = roofHeightAt(geometry, point);
        if (height !== null) highest = Math.max(highest, height);
      }
    }

    if (highest > -Infinity) {
      profile.push({ u, y: highest });
      lowest = Math.min(lowest, highest);
    }
  }

  if (profile.length < 2) return;

  page.save().lineWidth(WEIGHTS.outline).strokeColour([0, 0, 0]).fillColour(ROOF_FILL).dash(null);
  const base = Math.max(extent.minY, lowest - 0.6);
  page.path(
    [
      at(profile[0]!.u, base),
      ...profile.map((point) => at(point.u, point.y)),
      at(profile[profile.length - 1]!.u, base),
    ],
    true,
  );
  page.fillAndStroke();
  page.restore();
}

/** The ground line, and the site's own fall across the elevation. */
function drawGround(
  page: PdfPage,
  doc: DesignDocument,
  side: Side,
  at: (u: number, y: number) => { x: number; y: number },
  extent: ElevationExtent,
  frame: Frame,
): void {
  const { forward, right } = frameFor(side);

  const points: Array<{ x: number; y: number }> = [];
  const steps = 40;
  const overhang = Math.max(1, extent.width * 0.06);

  for (let i = 0; i <= steps; i++) {
    const u = extent.minU - overhang + ((extent.width + overhang * 2) * i) / steps;
    // Sampled on the middle of the building's depth, which is the section the
    // ground line represents.
    const point = { x: right.x * u, z: right.z * u };
    points.push(at(u, groundHeightAt(doc.site, { x: point.x + forward.x * 0, z: point.z })));
  }

  page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
  page.path(points).stroke();
  page.restore();

  void frame;
}

/**
 * The heights: each finished floor level, and the overall height.
 *
 * Floor levels rather than a chain of storey heights, because that is what a
 * builder sets out from and what a plan checker measures the height limit
 * against.
 */
function drawHeights(
  page: PdfPage,
  doc: DesignDocument,
  at: (u: number, y: number) => { x: number; y: number },
  extent: ElevationExtent,
  frame: Frame,
  options: ElevationOptions,
): void {
  const rightEdge = at(extent.maxU, 0).x;
  const stringX = rightEdge + 30;

  const leftEdge = at(extent.minU, 0).x;

  page.save().lineWidth(WEIGHTS.thin).strokeColour(LIGHT).dash([2, 2]);
  for (const level of doc.levels) {
    const y = at(extent.minU, elevationOf(doc, level.id)).y;
    // The level line runs right across and OUT of the building on the left,
    // where its label goes — printed over the facade it competes with the
    // openings and reads as something built rather than as an annotation.
    page.path([{ x: leftEdge - 74, y }, { x: stringX, y }]).stroke();
    page.text(
      `${level.name} ${options.format(elevationOf(doc, level.id))}`,
      leftEdge - 72,
      y + 3,
      { size: 6, colour: GREY },
    );
  }
  page.restore();

  const bottom = at(extent.maxU, extent.minY);
  const top = at(extent.maxU, extent.maxY);
  drawWitness(page, bottom, { x: stringX, y: bottom.y });
  drawWitness(page, top, { x: stringX, y: top.y });
  drawDimension(page, { x: stringX, y: bottom.y }, { x: stringX, y: top.y }, extent.height, {
    format: options.format,
  });

  void frame;
}

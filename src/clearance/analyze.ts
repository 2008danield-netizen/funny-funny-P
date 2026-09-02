/**
 * The clearance report: everything wrong with a layout, in plain language.
 *
 * Pure and deterministic — it takes a design and returns a list of issues, with
 * no reference to the renderer or to React. That keeps it testable, lets the UI
 * and the 3D overlay work from exactly the same data, and means the AI design
 * advisor in session 5 can be handed this report rather than re-deriving it.
 *
 * Every issue names the guideline it is judged against and the measurement that
 * failed. "Too tight" is not useful; "the walkway narrows to 62 cm, guideline is
 * 90 cm" tells a designer whether to care.
 */

import { getCatalogEntry } from '@/furniture/catalog';
import { collidersFor, itemFootprint } from '@/physics/colliders';
import { obbIntersects, type Collider } from '@/physics/collision';
import { findRegions, openingCenter, resolveWalls, type Region } from '@/scene/planGraph';
import { analyseCirculation, type CirculationReport } from './circulation';
import { furnitureZones, openingZones, type ClearanceZone } from './zones';
import type { DesignDocument, Point2 } from '@/state/types';

export type IssueSeverity = 'required' | 'advisory';

export interface ClearanceIssue {
  id: string;
  severity: IssueSeverity;
  /** One sentence naming the problem. */
  title: string;
  /** The measurement and the guideline it failed. */
  detail: string;
  /** Region key of the room it is in, when it belongs to one. */
  roomKey: string | null;
  /** What to select when the user clicks the issue. */
  focus:
    | { kind: 'furniture'; id: string }
    | { kind: 'opening'; id: string }
    | { kind: 'floor'; id: string }
    | null;
  /** A world position to look at, for the overlay marker. */
  at: Point2;
}

export interface ClearanceReport {
  issues: ClearanceIssue[];
  /** Every zone, whether or not it is violated — the overlay draws all of them. */
  zones: ClearanceZone[];
  /** Zone IDs currently intruded upon. */
  violatedZoneIds: Set<string>;
  /** Per-room circulation figures, keyed by region key. */
  circulation: Map<string, CirculationReport>;
  counts: { required: number; advisory: number };
}

/** Formats a metre value the way the issue text wants it. */
function metres(value: number): string {
  return value >= 1 ? `${value.toFixed(2)} m` : `${Math.round(value * 100)} cm`;
}

/**
 * Runs every clearance check over a design.
 *
 * The expensive part is the circulation grid, which is per-room and only worth
 * running when a room actually contains something — an empty room has nothing
 * to obstruct it and would report a spurious "narrowest route" equal to its own
 * width.
 */
export function analyseClearance(doc: DesignDocument): ClearanceReport {
  const regions = findRegions(doc.plan);
  const issues: ClearanceIssue[] = [];

  const zones = [...furnitureZones(doc.furniture), ...openingZones(doc.plan)];
  const violatedZoneIds = new Set<string>();

  /* ---------------- Zone intrusions ---------------- */

  for (const zone of zones) {
    for (const item of doc.furniture) {
      // A zone's owner never violates its own zone, and rugs lie flat under
      // everything — a doormat in a door swing is not a problem.
      if (zone.owner.kind === 'furniture' && zone.owner.id === item.id) continue;
      if (getCatalogEntry(item.catalogId).layer === 'floor') continue;

      if (!obbIntersects(itemFootprint(item), zone)) continue;

      violatedZoneIds.add(zone.id);

      const blocker = getCatalogEntry(item.catalogId);
      const ownerName =
        zone.owner.kind === 'furniture'
          ? getCatalogEntry(zone.owner.catalogId).name
          : 'the doorway';

      issues.push({
        id: `zone:${zone.id}:${item.id}`,
        severity: zone.severity,
        title: `${blocker.name} blocks ${ownerName}`,
        detail: `${zone.label}. Needs ${metres(zone.halfDepth * 2)} clear.`,
        roomKey: roomKeyAt(regions, zone.center),
        focus: { kind: 'furniture', id: item.id },
        at: zone.center,
      });
    }
  }

  /* ---------------- Circulation, per room ---------------- */

  const circulation = new Map<string, CirculationReport>();
  const walkway = doc.clearance.walkwayWidth;

  for (const region of regions) {
    const itemsHere = doc.furniture.filter(
      (item) =>
        getCatalogEntry(item.catalogId).layer !== 'floor' &&
        roomKeyAt(regions, { x: item.x, z: item.z }) === region.key,
    );
    if (itemsHere.length === 0) continue;

    // Walls bound the room, so only furniture inside it obstructs circulation.
    const obstacles: Collider[] = itemsHere.map((item) => ({
      kind: 'furniture',
      id: item.id,
      ...itemFootprint(item),
    }));

    const report = analyseCirculation(region, obstacles, doorwaysOf(doc, region), walkway);
    circulation.set(region.key, report);

    if (report.marooned.length > 0) {
      // A couple of stray cells behind a bookcase is noise; a real marooned
      // pocket is at least a fifth of a square metre.
      const area = report.marooned.length * 0.01;
      if (area >= 0.2) {
        issues.push({
          id: `marooned:${region.key}`,
          severity: 'advisory',
          title: 'Some floor cannot be reached',
          detail: `${area.toFixed(1)} m² of floor is walled in by the furniture around it.`,
          roomKey: region.key,
          focus: { kind: 'floor', id: region.key },
          at: report.marooned[0]!,
        });
      }
    }

    if (report.narrowestRoute > 0 && report.narrowestRoute < walkway) {
      issues.push({
        id: `walkway:${region.key}`,
        severity: report.narrowestRoute < walkway * 0.75 ? 'required' : 'advisory',
        title: 'The route through the room is tight',
        detail: `Narrows to ${metres(report.narrowestRoute)}; the guideline is ${metres(walkway)}.`,
        roomKey: region.key,
        focus: { kind: 'floor', id: region.key },
        at: report.pinchPoints[0] ?? region.interiorPoint,
      });
    }
  }

  /* ---------------- Furniture that ended up nowhere ---------------- */

  for (const item of doc.furniture) {
    if (roomKeyAt(regions, { x: item.x, z: item.z }) !== null) continue;
    issues.push({
      id: `stranded:${item.id}`,
      severity: 'required',
      title: `${getCatalogEntry(item.catalogId).name} is outside every room`,
      detail: 'Reshaping the plan left it with nowhere to go. Drag it back inside.',
      roomKey: null,
      focus: { kind: 'furniture', id: item.id },
      at: { x: item.x, z: item.z },
    });
  }

  // Required problems first; within a severity, keep detection order so the
  // list does not reshuffle under the user as they drag something.
  issues.sort((a, b) => rank(a.severity) - rank(b.severity));

  return {
    issues,
    zones,
    violatedZoneIds,
    circulation,
    counts: {
      required: issues.filter((issue) => issue.severity === 'required').length,
      advisory: issues.filter((issue) => issue.severity === 'advisory').length,
    },
  };
}

function rank(severity: IssueSeverity): number {
  return severity === 'required' ? 0 : 1;
}

/** The region key containing a point, or null. */
function roomKeyAt(regions: readonly Region[], point: Point2): string | null {
  for (const region of regions) {
    if (pointInside(point, region)) return region.key;
  }
  return null;
}

function pointInside(point: Point2, region: Region): boolean {
  let inside = false;
  const polygon = region.polygon;
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

/** World positions of the doorways opening into a room. */
function doorwaysOf(doc: DesignDocument, region: Region): Point2[] {
  const points: Point2[] = [];
  const wallIds = new Set(region.wallIds);

  for (const segment of resolveWalls(doc.plan)) {
    if (!wallIds.has(segment.wall.id)) continue;
    for (const opening of segment.wall.openings) {
      if (opening.kind !== 'door') continue;
      // Step a little into the room, since the doorway's own centre sits inside
      // the wall and would land on a blocked cell.
      const centre = openingCenter(segment, opening);
      const side = region.facing[segment.wall.id] === 'a' ? 1 : -1;
      const inset = segment.wall.thickness / 2 + 0.15;
      points.push({
        x: centre.x + segment.normal.x * inset * side,
        z: centre.z + segment.normal.z * inset * side,
      });
    }
  }

  return points;
}

/**
 * Whether a position would violate a required clearance — used by strict mode.
 *
 * Only 'required' zones are enforced. Advisory guidance (legroom in front of a
 * sofa, room to walk around a bed) is exactly the sort of thing a designer
 * trades away in a small flat, and enforcing it would make the app unusable in
 * the rooms that need the most help.
 */
export function violatesRequiredClearance(
  doc: DesignDocument,
  itemId: string,
  footprint: Parameters<typeof obbIntersects>[0],
): boolean {
  const zones = [...furnitureZones(doc.furniture), ...openingZones(doc.plan)];

  for (const zone of zones) {
    if (zone.severity !== 'required') continue;
    if (zone.owner.kind === 'furniture' && zone.owner.id === itemId) continue;
    if (obbIntersects(footprint, zone)) return true;
  }

  return false;
}

/** Re-exported so callers need only this module. */
export { collidersFor };

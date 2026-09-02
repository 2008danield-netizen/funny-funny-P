/**
 * Tests for clearance analysis.
 *
 * Clearance is judgement rather than physics, so the thing that must be right is
 * that the judgement is CORRECTLY MEASURED. A rule that fires when it shouldn't
 * trains the user to ignore the panel; one that stays silent when it should fire
 * is worse than not having it. Neither failure is visible in a screenshot.
 */

import { describe, expect, it } from 'vitest';

import { analyseClearance, violatesRequiredClearance } from './analyze';
import { furnitureZones, openingZones } from './zones';
import { analyseCirculation, buildGrid, distanceTransform } from './circulation';
import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle } from '@/state/planOps';
import { placeFurniture, moveFurniture } from '@/state/furnitureOps';
import { itemFootprint } from '@/physics/colliders';
import { findRegions } from '@/scene/planGraph';
import type { Collider } from '@/physics/collision';
import type { DesignDocument } from '@/state/types';

function roomDocument(width = 8, depth = 6): DesignDocument {
  const doc = createDefaultDocument();
  doc.plan.vertices = [];
  doc.plan.walls = [];
  doc.plan.rooms = {};
  addRectangle(doc.plan, { x: 0, z: 0 }, width, depth);
  return doc;
}

describe('furnitureZones', () => {
  it('gives a chest of drawers space to open them', () => {
    const doc = roomDocument();
    placeFurniture(doc, 'malm-chest-6', { x: 0, z: -2.8 });

    const zones = furnitureZones(doc.furniture);
    expect(zones.some((zone) => zone.id.endsWith(':pull-out'))).toBe(true);
  });

  it('puts the zone in FRONT of the piece, wherever it is facing', () => {
    const doc = roomDocument();
    placeFurniture(doc, 'malm-chest-6', { x: 0, z: -2.8 });

    const item = doc.furniture[0]!;
    const zone = furnitureZones(doc.furniture).find((candidate) =>
      candidate.id.endsWith(':pull-out'),
    )!;

    // The piece's own front direction, and the direction to the zone. They must
    // agree — a pull-out zone behind a chest is worse than no zone at all.
    const front = { x: -Math.sin(item.rotation), z: Math.cos(item.rotation) };
    const toZone = { x: zone.center.x - item.x, z: zone.center.z - item.z };
    const alignment =
      (front.x * toZone.x + front.z * toZone.z) / Math.hypot(toZone.x, toZone.z);

    expect(alignment).toBeGreaterThan(0.95);
  });

  it('gives a bed access down both sides and at the foot', () => {
    const doc = roomDocument();
    placeFurniture(doc, 'malm-bed-140', { x: 0, z: -2.5 });

    const ids = furnitureZones(doc.furniture).map((zone) => zone.id);
    expect(ids.some((id) => id.endsWith(':bed-side-left'))).toBe(true);
    expect(ids.some((id) => id.endsWith(':bed-side-right'))).toBe(true);
    expect(ids.some((id) => id.endsWith(':bed-foot'))).toBe(true);
  });

  it('gives a coffee table no zone of its own', () => {
    // Nothing needs to open or be sat at, so it should not clutter the overlay.
    const doc = roomDocument();
    placeFurniture(doc, 'lack-coffee', { x: 0, z: 0 });
    expect(furnitureZones(doc.furniture)).toHaveLength(0);
  });
});

describe('openingZones', () => {
  it('reserves the swing of a hinged door', () => {
    const doc = roomDocument();
    const wall = doc.plan.walls[0]!;
    addOpening(doc.plan, wall.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 2);

    const zones = openingZones(doc.plan);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.severity).toBe('required');
    // The reserved depth equals the door's width, which is the radius its leaf
    // sweeps through.
    expect(zones[0]!.halfDepth * 2).toBeCloseTo(0.9, 5);
  });

  it('reserves both sides of a cased opening with no door in it', () => {
    const doc = roomDocument();
    const wall = doc.plan.walls[0]!;
    addOpening(doc.plan, wall.id, 'door', 'door-opening', { width: 1.1, height: 2.1, sillHeight: 0 }, 2);

    // People walk through a cased opening from either side.
    expect(openingZones(doc.plan)).toHaveLength(2);
  });

  it('reserves nothing for a window', () => {
    const doc = roomDocument();
    const wall = doc.plan.walls[0]!;
    addOpening(doc.plan, wall.id, 'window', 'window-casement', { width: 1.2, height: 1.2, sillHeight: 0.9 }, 2);

    expect(openingZones(doc.plan)).toHaveLength(0);
  });
});

describe('analyseClearance', () => {
  it('reports nothing wrong with an empty room', () => {
    expect(analyseClearance(roomDocument()).issues).toHaveLength(0);
  });

  it('flags a piece parked in a door swing', () => {
    const doc = roomDocument(8, 6);
    const northWall = doc.plan.walls[0]!;
    addOpening(doc.plan, northWall.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 4);

    const zone = openingZones(doc.plan)[0]!;
    // Drop a bookcase right in the swing.
    placeFurniture(doc, 'billy-80', { x: zone.center.x, z: zone.center.z });

    const report = analyseClearance(doc);
    const blocked = report.issues.find((issue) => issue.title.includes('doorway'));

    expect(blocked).toBeDefined();
    expect(blocked!.severity).toBe('required');
    expect(report.violatedZoneIds.size).toBeGreaterThan(0);
  });

  it('does not flag a rug lying in a door swing', () => {
    const doc = roomDocument(8, 6);
    const northWall = doc.plan.walls[0]!;
    addOpening(doc.plan, northWall.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 4);

    const zone = openingZones(doc.plan)[0]!;
    placeFurniture(doc, 'morum-rug', { x: zone.center.x, z: zone.center.z + 0.5 });

    // A doormat in a doorway is not a clearance problem.
    const report = analyseClearance(doc);
    expect(report.issues.filter((issue) => issue.title.includes('doorway'))).toHaveLength(0);
  });

  it('never reports a piece as blocking its own zone', () => {
    const doc = roomDocument();
    placeFurniture(doc, 'malm-chest-6', { x: 0, z: -2.8 });
    expect(analyseClearance(doc).issues).toHaveLength(0);
  });

  it('names the measurement and the guideline, not just "too tight"', () => {
    const doc = roomDocument(8, 6);
    const wall = doc.plan.walls[0]!;
    addOpening(doc.plan, wall.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 4);
    const zone = openingZones(doc.plan)[0]!;
    placeFurniture(doc, 'billy-80', { x: zone.center.x, z: zone.center.z });

    const issue = analyseClearance(doc).issues[0]!;
    // A number the user can act on has to be in there somewhere.
    expect(issue.detail).toMatch(/\d/);
    expect(issue.focus).not.toBeNull();
  });

  it('flags furniture stranded outside every room', () => {
    const doc = roomDocument();
    placeFurniture(doc, 'lack-coffee', { x: 0, z: 0 });
    // Shove it out of the building behind the analyser's back.
    doc.furniture[0]!.x = 30;
    doc.furniture[0]!.z = 30;

    const report = analyseClearance(doc);
    expect(report.issues.some((issue) => issue.title.includes('outside every room'))).toBe(true);
  });

  it('sorts required problems above advisory ones', () => {
    const doc = roomDocument(4, 3.2);
    const wall = doc.plan.walls[0]!;
    addOpening(doc.plan, wall.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 2);

    placeFurniture(doc, 'skogsta-table', { x: 0, z: 0.4 });
    const zone = openingZones(doc.plan)[0]!;
    placeFurniture(doc, 'billy-80', { x: zone.center.x, z: zone.center.z });

    const severities = analyseClearance(doc).issues.map((issue) => issue.severity);
    const firstAdvisory = severities.indexOf('advisory');
    const lastRequired = severities.lastIndexOf('required');
    if (firstAdvisory !== -1 && lastRequired !== -1) {
      expect(lastRequired).toBeLessThan(firstAdvisory);
    }
  });
});

describe('circulation', () => {
  const room = () => findRegions(roomDocument(6, 4).plan)[0]!;

  it('measures free floor with nothing in the room', () => {
    const report = analyseCirculation(room(), [], [], 0.9);
    // A 6 x 4 room, sampled on a 10 cm grid, is about 24 m².
    expect(report.freeArea).toBeGreaterThan(22);
    expect(report.freeArea).toBeLessThan(26);
    expect(report.marooned).toHaveLength(0);
  });

  it('finds the gap between two obstacles', () => {
    /*
     * Two blocks spanning the width of the room with a 60 cm gap between them,
     * so the only way from one half to the other is through that gap.
     *
     * The geometry matters. An earlier version of this fixture used two blocks
     * running the full DEPTH of the room, which reads like a slot and is
     * actually three sealed corridors with no route between them at all — the
     * test passed on a fallback value rather than on a measured route, and the
     * five square metres it had marooned went unnoticed because nothing
     * checked. A squeeze and a barrier are different findings and the fixture
     * has to be one or the other on purpose.
     */
    const obstacles: Collider[] = [
      { kind: 'furniture', id: 'a', center: { x: -1.65, z: 0 }, halfWidth: 1.35, halfDepth: 0.3, rotation: 0 },
      { kind: 'furniture', id: 'b', center: { x: 1.65, z: 0 }, halfWidth: 1.35, halfDepth: 0.3, rotation: 0 },
    ];

    const report = analyseCirculation(room(), obstacles, [], 0.9);

    // Both halves are open, so nothing is cut off — this is a squeeze.
    expect(report.marooned).toHaveLength(0);
    // And getting between them means passing through the 60 cm gap.
    expect(report.narrowestRoute).toBeLessThan(0.9);
    expect(report.narrowestRoute).toBeGreaterThan(0.4);
    expect(report.pinchPoints.length).toBeGreaterThan(0);
  });

  it('finds floor walled off behind furniture', () => {
    // A block spanning the full depth of the room, cutting it in two. Entering
    // from the left, the right-hand half is unreachable.
    const obstacles: Collider[] = [
      { kind: 'furniture', id: 'divider', center: { x: 0, z: 0 }, halfWidth: 0.3, halfDepth: 2.5, rotation: 0 },
    ];

    const report = analyseCirculation(room(), obstacles, [{ x: -2.5, z: 0 }], 0.9);
    expect(report.marooned.length).toBeGreaterThan(50);
  });

  it('reports nothing marooned when a gap is left to squeeze through', () => {
    const obstacles: Collider[] = [
      { kind: 'furniture', id: 'divider', center: { x: 0, z: -0.9 }, halfWidth: 0.3, halfDepth: 1.1, rotation: 0 },
    ];

    const report = analyseCirculation(room(), obstacles, [{ x: -2.5, z: 0 }], 0.9);
    expect(report.marooned).toHaveLength(0);
  });
});

describe('distanceTransform', () => {
  it('grows outwards from the obstacles', () => {
    const region = findRegions(roomDocument(4, 4).plan)[0]!;
    const grid = buildGrid(region, [
      { kind: 'furniture', id: 'x', center: { x: 0, z: 0 }, halfWidth: 0.3, halfDepth: 0.3, rotation: 0 },
    ]);
    const distance = distanceTransform(grid);

    // A cell right beside the block is closer to an obstacle than one in the
    // far corner of the room.
    const near = distance[indexAt(grid, { x: 0.5, z: 0 })]!;
    const far = distance[indexAt(grid, { x: -1.6, z: -1.6 })]!;
    expect(near).toBeLessThan(far);
  });
});

/** Cell index for a world point, for readability in the assertions above. */
function indexAt(grid: ReturnType<typeof buildGrid>, point: { x: number; z: number }): number {
  const cx = Math.round((point.x - grid.origin.x) / grid.cell);
  const cz = Math.round((point.z - grid.origin.z) / grid.cell);
  return cz * grid.width + cx;
}

describe('strict mode', () => {
  it('refuses a move into a door swing when strict, and allows it when not', () => {
    const build = (strict: boolean) => {
      const doc = roomDocument(8, 6);
      doc.clearance.strict = strict;
      const wall = doc.plan.walls[0]!;
      addOpening(doc.plan, wall.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 4);
      return doc;
    };

    const lenient = build(false);
    const zone = openingZones(lenient.plan)[0]!;
    const placed = placeFurniture(lenient, 'lack-side', { x: 0, z: 0 });
    moveFurniture(lenient, placed.id!, { x: zone.center.x, z: zone.center.z });

    // Advisory: the table goes where it was told, and the panel complains.
    expect(
      violatesRequiredClearance(lenient, placed.id!, itemFootprint(lenient.furniture[0]!)),
    ).toBe(true);

    const strict = build(true);
    const strictZone = openingZones(strict.plan)[0]!;
    const strictPlaced = placeFurniture(strict, 'lack-side', { x: 0, z: 0 });
    expect(strictPlaced.id).not.toBeNull();

    moveFurniture(strict, strictPlaced.id!, { x: strictZone.center.x, z: strictZone.center.z });

    // Strict: the solver pushed it out of the swing, so it is not in violation.
    expect(
      violatesRequiredClearance(strict, strictPlaced.id!, itemFootprint(strict.furniture[0]!)),
    ).toBe(false);
  });

  it('never enforces advisory guidance, even when strict', () => {
    const doc = roomDocument(8, 6);
    doc.clearance.strict = true;

    // A sofa's legroom is advisory. A coffee table 20 cm in front of it is
    // tight, and a designer is entitled to do it.
    const sofa = placeFurniture(doc, 'kivik-3', { x: 0, z: -2.8 });
    expect(sofa.id).not.toBeNull();

    const sofaItem = doc.furniture[0]!;
    const table = placeFurniture(doc, 'lack-coffee', { x: sofaItem.x, z: sofaItem.z + 0.8 });
    expect(table.id).not.toBeNull();
  });
});

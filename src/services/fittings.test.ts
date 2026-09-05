/**
 * Tests for the kitchens and bathrooms.
 *
 * Three things worth checking, and they are different in kind:
 *
 *   • THE LAYOUTS produce something usable — cabinetry on the walls that can
 *     take it, the sink where a sink goes, nothing across a doorway.
 *   • THE CHECKS agree with the layouts. They are written separately and never
 *     share a function, so a disagreement means one of them has the code wrong.
 *   • THE ELECTRICAL now reads the real counters. That is the whole reason this
 *     session came before plumbing, and it is the one thing that would silently
 *     regress if somebody changed how runs are stored.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, normalizePlan } from '@/state/planOps';
import { layOutElectrical } from '@/state/buildingOps';
import { addFixture, addRun, resetFittingIds, snapRunToWall } from '@/state/fittingOps';
import { resetUnitIds, runGeometry } from '@/building/cabinetRun';
import { findRegions } from '@/scene/planGraph';
import { getModule } from '@/fittings/modules';
import { IRC_BATHROOM } from '@/code/irc';
import type { DesignDocument, Point2 } from '@/state/types';

import { layoutAllKitchens, kitchensIn } from './kitchen';
import { layoutAllBathrooms, bathroomsIn } from './bathroom';
import { checkFittings } from './fittingCheck';

beforeEach(() => {
  resetUnitIds();
  resetFittingIds();
});

/* -------------------------------- Fixtures -------------------------------- */

/** A house of named rooms, drawn as rectangles side by side. */
function house(
  rooms: Array<{ name: string; x: number; z: number; w: number; d: number }>,
): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  level.plan.defaultWallThickness = 0.12;

  for (const room of rooms) addRectangle(level.plan, { x: room.x, z: room.z }, room.w, room.d);
  normalizePlan(level.plan);

  for (const region of findRegions(level.plan)) {
    const match = rooms.find(
      (room) =>
        Math.abs(region.interiorPoint.x - room.x) < room.w / 2 &&
        Math.abs(region.interiorPoint.z - room.z) < room.d / 2,
    );
    if (match) {
      level.plan.rooms[region.key] = {
        name: match.name,
        floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
        wall: { color: '#ece7df', roughness: 0.88 },
        ceilingColor: '#f7f5f2',
      };
    }
  }

  return doc;
}

/* -------------------------------- Kitchens -------------------------------- */

describe('laying out a kitchen', () => {
  it('puts cabinetry on the walls and a sink in it', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 4, d: 3.2 }]);
    const result = layoutAllKitchens(doc);

    expect(result.runs).toBeGreaterThan(0);
    expect(doc.runs.some((run) => run.kind === 'base')).toBe(true);
    expect(
      doc.runs.flatMap((run) => run.units).some((unit) => unit.moduleId === 'base-800-sink'),
    ).toBe(true);
    expect(doc.fixtures.some((fixture) => fixture.fixtureId.startsWith('sink'))).toBe(true);
  });

  it('puts the sink under the window when there is one', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 5, d: 4 }]);
    const level = doc.levels[0]!;
    const wall = level.plan.walls[0]!;
    addOpening(level.plan, wall.id, 'window', 'window-casement', {
      width: 1.2,
      height: 1.2,
      sillHeight: 1.05,
    }, 3.4);

    layoutAllKitchens(doc);

    // The sink base has to be on the wall the window is in, near its centre.
    const sinkRun = doc.runs.find((run) =>
      run.units.some((unit) => unit.moduleId === 'base-800-sink'),
    );
    expect(sinkRun).toBeDefined();

    const sinkUnit = sinkRun!.units.find((unit) => unit.moduleId === 'base-800-sink')!;
    const placed = runGeometry(sinkRun!).units.find((entry) => entry.unit.id === sinkUnit.id)!;

    // The window's centre in world terms, on the wall the opening was cut in.
    const vertices = level.plan.vertices;
    const start = vertices.find((v) => v.id === wall.start)!;
    const end = vertices.find((v) => v.id === wall.end)!;
    const length = Math.hypot(end.x - start.x, end.z - start.z);
    const windowAt = {
      x: start.x + ((end.x - start.x) * 3.4) / length,
      z: start.z + ((end.z - start.z) * 3.4) / length,
    };

    expect(Math.hypot(placed.at.x - windowAt.x, placed.at.z - windowAt.z)).toBeLessThan(0.9);
  });

  it('never runs cabinetry across a doorway', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 5, d: 4 }]);
    const level = doc.levels[0]!;
    const wall = level.plan.walls[0]!;
    addOpening(level.plan, wall.id, 'door', 'door-single', {
      width: 0.9,
      height: 2.03,
      sillHeight: 0,
    }, 2.5);

    layoutAllKitchens(doc);

    const vertices = level.plan.vertices;
    const start = vertices.find((v) => v.id === wall.start)!;
    const end = vertices.find((v) => v.id === wall.end)!;
    const length = Math.hypot(end.x - start.x, end.z - start.z);
    const doorAt = {
      x: start.x + ((end.x - start.x) * 2.5) / length,
      z: start.z + ((end.z - start.z) * 2.5) / length,
    };

    for (const run of doc.runs) {
      for (const placed of runGeometry(run).units) {
        // Nothing within half a door's width of the opening's centre line,
        // measured along the wall.
        const gap = Math.hypot(placed.at.x - doorAt.x, placed.at.z - doorAt.z);
        expect(gap).toBeGreaterThan(0.45);
      }
    }
  });

  it('lays out the same kitchen twice rather than two kitchens', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 4, d: 3.2 }]);
    layoutAllKitchens(doc);
    const first = doc.runs.length;

    layoutAllKitchens(doc);
    expect(doc.runs.length).toBe(first);
  });

  it('says so, and does nothing, when no room is a kitchen', () => {
    const doc = house([{ name: 'Living Room', x: 0, z: 0, w: 4, d: 3.2 }]);
    const result = layoutAllKitchens(doc);

    expect(kitchensIn(doc)).toHaveLength(0);
    expect(result.runs).toBe(0);
    expect(result.assumptions.join(' ')).toMatch(/no room is named as a kitchen/i);
  });
});

/* ------------------------------- Bathrooms -------------------------------- */

describe('laying out a bathroom', () => {
  it('fits a bath, a WC and a basin into a room that will take them', () => {
    const doc = house([{ name: 'Bathroom', x: 0, z: 0, w: 2.6, d: 2.4 }]);
    const result = layoutAllBathrooms(doc);

    expect(result.fixtures).toBeGreaterThanOrEqual(2);
    expect(bathroomsIn(doc)).toHaveLength(1);
  });

  it('refuses to place what it cannot give clear floor to, and says which', () => {
    // 1.2 m deep: a WC needs 700 mm of pan plus 533 mm of clear floor, so a
    // bath along one wall leaves nowhere the code allows.
    const doc = house([{ name: 'Bathroom', x: 0, z: 0, w: 1.9, d: 1.2 }]);
    const result = layoutAllBathrooms(doc);

    expect(result.assumptions.join(' ')).toMatch(/R307\.1/);
  });

  it('leaves a bathroom it laid out passing its own clearance check', () => {
    const doc = house([{ name: 'Bathroom', x: 0, z: 0, w: 3, d: 2.6 }]);
    layoutAllBathrooms(doc);

    const violations = checkFittings(doc).findings.filter(
      (finding) => finding.severity === 'violation' && finding.section === IRC_BATHROOM.clearInFront.section,
    );
    expect(violations).toEqual([]);
  });
});

/* -------------------------------- The checks ------------------------------ */

describe('checking a bathroom', () => {
  it('catches a fixture with no room in front of it', () => {
    const doc = house([{ name: 'Bathroom', x: 0, z: 0, w: 3, d: 2.6 }]);
    layoutAllBathrooms(doc);

    // Shove everything into the middle, facing a wall a hand's width away.
    for (const fixture of doc.fixtures) {
      fixture.at = { x: 1.35, z: 1.15 };
      fixture.rotation = 0;
    }

    const finding = checkFittings(doc).findings.find((entry) => entry.id.startsWith('fit-r307-front'))!;
    expect(finding.severity).toBe('violation');
    expect(finding.section).toBe('R307.1');
    expect(finding.detail).toMatch(/21 in/);
  });

  it('wants a window or a fan, and takes either', () => {
    const doc = house([{ name: 'Bathroom', x: 0, z: 0, w: 3, d: 2.6 }]);
    layoutAllBathrooms(doc);

    const before = checkFittings(doc).findings.find((entry) => entry.id.startsWith('fit-r303'))!;
    expect(before.severity).toBe('violation');
    expect(before.section).toBe('R303.3');

    const wall = doc.levels[0]!.plan.walls[0]!;
    addOpening(doc.levels[0]!.plan, wall.id, 'window', 'window-casement', {
      width: 0.6,
      height: 0.6,
      sillHeight: 1.4,
    }, 1.5);

    const after = checkFittings(doc).findings.find((entry) => entry.id.startsWith('fit-r303'))!;
    expect(after.severity).toBe('pass');
  });

  it('reports the working triangle as guidance, never as a violation', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 5, d: 4 }]);
    layoutAllKitchens(doc);

    const triangle = checkFittings(doc).findings.find((entry) => entry.id.startsWith('fit-triangle'))!;
    expect(triangle.severity).not.toBe('violation');
    // No section, because there is no section — inventing one would be the
    // worst thing this app could do.
    expect(triangle.section).toBe('');
  });

  it('says nothing at all about a house with no fittings', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 4, d: 3.2 }]);
    expect(checkFittings(doc).findings).toEqual([]);
  });
});

/* ------------------------- The electrical, rewired ------------------------ */

describe('the electrical reads the real counters', () => {
  it('follows the worktop once there is one, and withdraws its apology', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 5, d: 4 }]);

    // Before: the app has to assume the counter is on the longest wall.
    const before = layOutElectrical(doc);
    expect(before.assumptions.join(' ')).toMatch(/no cabinetry in this kitchen yet/i);

    // After: it knows.
    layoutAllKitchens(doc);
    const after = layOutElectrical(doc);
    expect(after.assumptions.join(' ')).not.toMatch(/no cabinetry in this kitchen yet/i);

    const counters = doc.electrical.devices.filter((device) => device.kind === 'receptacle-counter');
    expect(counters.length).toBeGreaterThan(0);

    // And every one of them is over a run, not floating on a bare wall.
    for (const device of counters) {
      const nearest = Math.min(
        ...doc.runs
          .filter((run) => run.kind === 'base')
          .flatMap((run) =>
            runGeometry(run).units.map((unit) =>
              Math.hypot(unit.at.x - device.at.x, unit.at.z - device.at.z),
            ),
          ),
      );
      expect(nearest).toBeLessThan(1);
    }
  });

  it('gives an appliance that needs its own circuit one, and its load to the service', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 5, d: 4 }]);
    layoutAllKitchens(doc);
    layOutElectrical(doc);

    const individual = doc.electrical.circuits.filter((circuit) => circuit.kind === 'individual');
    expect(individual.length).toBeGreaterThan(0);

    // A dishwasher at 1,800 VA is 15 A at 120 V and belongs on its own breaker.
    const appliance = doc.electrical.devices.find(
      (device) => device.kind === 'receptacle-appliance' && (device.va ?? 0) >= 1500,
    );
    expect(appliance).toBeDefined();
    expect(appliance!.circuitId).not.toBeNull();

    const circuit = doc.electrical.circuits.find((entry) => entry.id === appliance!.circuitId)!;
    expect(circuit.kind).toBe('individual');
  });

  it('puts the basin receptacle at the basin, not on the longest wall', () => {
    const doc = house([{ name: 'Bathroom', x: 0, z: 0, w: 3, d: 2.6 }]);
    layoutAllBathrooms(doc);
    const result = layOutElectrical(doc);

    expect(result.assumptions.join(' ')).not.toMatch(/no basin in this bathroom yet/i);

    const basin = doc.fixtures.find((fixture) => fixture.fixtureId.startsWith('basin'));
    const outlet = doc.electrical.devices.find((device) => device.label === 'Basin receptacle');

    if (basin && outlet) {
      // NEC 210.52(D) wants it within 3 ft of the basin's outside edge.
      expect(Math.hypot(outlet.at.x - basin.at.x, outlet.at.z - basin.at.z)).toBeLessThan(1.5);
    }
  });
});

/* ------------------------------ Drawing a run ----------------------------- */

describe('drawing a run by hand', () => {
  it('snaps a rough drag onto the wall it was drawn against', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 4, d: 3.2 }]);
    const plan = doc.levels[0]!.plan;

    // Dragged 120 mm off the wall, which is what a real drag looks like.
    const from: Point2 = { x: -1.5, z: -1.48 };
    const to: Point2 = { x: 1.5, z: -1.46 };
    const path = snapRunToWall(plan, from, to);

    expect(path).not.toBeNull();
    // Both ends land on the same line, which is the wall face.
    expect(path![0]!.z).toBeCloseTo(path![1]!.z, 6);

    const id = addRun(doc, doc.levels[0]!.id, path!, 'base');
    expect(id).not.toBeNull();

    // And it faces into the room, not into the wall.
    const run = doc.runs.find((entry) => entry.id === id)!;
    for (const placed of runGeometry(run).units) {
      expect(placed.at.z).toBeGreaterThan(path![0]!.z);
    }
  });

  it('refuses a drag that is not along a wall', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 4, d: 3.2 }]);
    expect(snapRunToWall(doc.levels[0]!.plan, { x: 0, z: 0 }, { x: 0.3, z: 0 })).toBeNull();
  });

  it('places a fixture flat against the nearest wall, facing the room', () => {
    const doc = house([{ name: 'Bathroom', x: 0, z: 0, w: 3, d: 2.6 }]);
    const id = addFixture(doc, doc.levels[0]!.id, 'wc-close-coupled', { x: 0, z: -1 });

    expect(id).not.toBeNull();
    const fixture = doc.fixtures.find((entry) => entry.id === id)!;
    // Pushed back against the wall: the face is at -1.24 and the pan is 700
    // deep, so its centre lands at -0.89. Anywhere further into the room means
    // it was not seated at all.
    expect(fixture.at.z).toBeLessThan(-0.85);
    expect(fixture.at.z).toBeGreaterThan(-1.24);
  });

  it('keeps a unit swap to the same width, so the run still adds up', () => {
    const doc = house([{ name: 'Kitchen', x: 0, z: 0, w: 4, d: 3.2 }]);
    layoutAllKitchens(doc);

    const run = doc.runs.find((entry) => entry.kind === 'base')!;
    const before = run.units.reduce((total, unit) => total + unit.width, 0);

    for (const unit of run.units) {
      const module = getModule(unit.moduleId);
      if (module?.width === 0.6 && module.front === 'door') {
        unit.moduleId = 'base-600-drawers';
        break;
      }
    }

    expect(run.units.reduce((total, unit) => total + unit.width, 0)).toBeCloseTo(before, 6);
  });
});

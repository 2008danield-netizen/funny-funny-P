/**
 * Tests for the water and drainage.
 *
 * Four things worth checking, and like the fittings they are different in kind:
 *
 *   • THE TABLES read the way the code book reads. A sizing table transcribed
 *     wrong produces a plausible drawing that is one pipe size out everywhere,
 *     and nothing downstream can detect it.
 *   • THE ARITHMETIC is the formula it claims to be. Hazen–Williams with a
 *     wrong exponent gives an answer that looks reasonable and is off by a
 *     factor of two, which is exactly the kind of error a check cannot catch by
 *     being suspicious.
 *   • THE ROUTER produces something buildable — pipes that fall the right way,
 *     a stack inside the building on every storey, a vent through the roof.
 *   • THE CHECKER agrees with the router. They are written separately and share
 *     only the code tables, so a disagreement means one of them has the rule
 *     wrong — and on past form it is the router.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, normalizePlan } from '@/state/planOps';
import { addFixture, resetFittingIds } from '@/state/fittingOps';
import { addLevel } from '@/state/buildingOps';
import { findRegions } from '@/scene/planGraph';
import {
  DRAIN_SIZES,
  branchSizeFor,
  buildingDrainSizeFor,
  flowForWsfu,
  frictionLossPerMetre,
  inches,
  minSlopeFor,
  stackSizeFor,
  serviceSizeFor,
  supplySizeFor,
  trapArmFor,
  velocityFor,
  ventSizeFor,
  asDfu,
  asWsfu,
} from '@/code/ipc';
import { routeAll, clearPlumbing, resetPlumbingCounters, setSewerConnection } from '@/state/plumbingOps';
import type { DesignDocument } from '@/state/types';

import { checkPlumbing } from './plumbingCheck';
import {
  accumulateDfu,
  drainageLoadOf,
  plumbingTotals,
  sizeAllDrainage,
  sizeAllSupply,
  slopeOf,
  supplyLoadOf,
} from './plumbingSize';
import { storageFor } from './supply';

beforeEach(() => {
  resetFittingIds();
  resetPlumbingCounters();
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

/** A one-bathroom house with a WC, basin and bath actually placed. */
function bathroomHouse(): DesignDocument {
  const doc = house([
    { name: 'Bathroom', x: 0, z: 0, w: 3, d: 2.4 },
    { name: 'Kitchen', x: 4, z: 0, w: 3.6, d: 3 },
  ]);
  const level = doc.levels[0]!;

  addFixture(doc, level.id, 'wc-close-coupled', { x: -0.9, z: -0.8 });
  addFixture(doc, level.id, 'basin-pedestal', { x: 0.4, z: -0.9 });
  addFixture(doc, level.id, 'bath-1700', { x: 0, z: 0.8 });
  addFixture(doc, level.id, 'sink-1.5-bowl', { x: 4, z: -1.1 });

  return doc;
}

/* ------------------------------- The tables ------------------------------- */

describe('the IPC tables', () => {
  it('sizes a branch off the drainage fixture units, not the flow', () => {
    // Table 710.1(2): 1 1/2 in takes 3 DFU, 2 in takes 6.
    expect(branchSizeFor(asDfu(3), false).asWritten).toBe('1 1/2 in');
    expect(branchSizeFor(asDfu(4), false).asWritten).toBe('2 in');
    expect(branchSizeFor(asDfu(6), false).asWritten).toBe('2 in');
    expect(branchSizeFor(asDfu(7), false).asWritten).toBe('2 1/2 in');
  });

  it('never puts a water closet on less than 3 in, whatever the arithmetic says', () => {
    // A single WC is 3 DFU, which a 1 1/2 in pipe would carry on the table.
    expect(branchSizeFor(asDfu(3), false).asWritten).toBe('1 1/2 in');
    expect(branchSizeFor(asDfu(3), true).asWritten).toBe('3 in');
  });

  it('applies the two-water-closet rule that no DFU total expresses', () => {
    // Three WCs is 9 DFU — trivially inside a 3 in stack's 48 DFU limit — and
    // is still a violation, because Table 710.1(1) footnote a is a COUNT.
    expect(stackSizeFor(asDfu(9), 2).asWritten).toBe('3 in');
    expect(stackSizeFor(asDfu(9), 3).asWritten).toBe('4 in');
  });

  it('sizes the building drain off its own column', () => {
    // A 3 in building drain takes 42 DFU, less than the 48 a 3 in STACK takes.
    // Reading the wrong column is the classic transcription error.
    expect(buildingDrainSizeFor(asDfu(42), 1).asWritten).toBe('3 in');
    expect(buildingDrainSizeFor(asDfu(45), 1).asWritten).toBe('4 in');
    expect(stackSizeFor(asDfu(45), 1).asWritten).toBe('3 in');
  });

  it('falls more steeply for small pipe than for large', () => {
    // 704.1: 1/4 in per foot up to 2 1/2 in, 1/8 in per foot above.
    expect(minSlopeFor(inches(2)).minSlope).toBeCloseTo(0.25 / 12, 6);
    expect(minSlopeFor(inches(4)).minSlope).toBeCloseTo(0.125 / 12, 6);
    expect(minSlopeFor(inches(2)).minSlope).toBeGreaterThan(minSlopeFor(inches(4)).minSlope);
  });

  it('limits a trap arm by its size', () => {
    // Table 906.1: 6 ft on 1 1/2 in, 12 ft on 3 in.
    expect(trapArmFor(inches(1.5)).maxAsWritten).toBe('6 ft');
    expect(trapArmFor(inches(3)).maxAsWritten).toBe('12 ft');
    expect(trapArmFor(inches(1.5)).maxLength).toBeLessThan(trapArmFor(inches(3)).maxLength);
  });

  it('sizes a vent at half its drain, but never below 1 1/4 in', () => {
    expect(ventSizeFor(inches(4))).toBeCloseTo(inches(2), 6);
    // Half of 1 1/2 in is 3/4 in, which is below the floor.
    expect(ventSizeFor(inches(1.5))).toBeCloseTo(inches(1.25), 6);
  });

  it('keeps drainage and supply fixture units apart', () => {
    // A WC is 3 DFU out and 2.2 WSFU in. Mixing the currencies is the one
    // mistake that produces a plausible pipe that is a size too small.
    expect(drainageLoadOf('wc-close-coupled')?.dfu).toBe(3);
    expect(supplyLoadOf('wc-close-coupled')?.cold).toBe(2.2);
    expect(supplyLoadOf('wc-close-coupled')?.hot).toBe(0);
  });

  it('does not let a basin’s hot and cold sum to its total', () => {
    // E103.3(2): 0.5 + 0.5 = 1.0, but the total is 0.7. Summing the columns
    // oversizes every cold main in the building.
    const basin = supplyLoadOf('basin-pedestal')!;
    expect(basin.cold + basin.hot).toBeGreaterThan(basin.total);
    expect(basin.total).toBe(0.7);
  });

  it('has no drainage load for a fixture that does not drain', () => {
    expect(drainageLoadOf('fridge-freezer-600')).toBeNull();
    expect(supplyLoadOf('fridge-freezer-600')).toBeNull();
  });

  it('lists the drain sizes in ascending order', () => {
    for (let i = 1; i < DRAIN_SIZES.length; i += 1) {
      expect(DRAIN_SIZES[i]!.size).toBeGreaterThan(DRAIN_SIZES[i - 1]!.size);
    }
  });
});

/* ----------------------------- The arithmetic ----------------------------- */

describe('the supply arithmetic', () => {
  it('follows Hunter’s curve, which is strongly concave', () => {
    // The whole reason a 3/4 in pipe can feed a house: ten fixtures do not draw
    // ten times one fixture. A linear fit here would oversize everything.
    const one = flowForWsfu(asWsfu(1));
    const ten = flowForWsfu(asWsfu(10));
    const hundred = flowForWsfu(asWsfu(100));

    expect(ten).toBeLessThan(one * 10);
    expect(hundred).toBeLessThan(ten * 10);
    expect(flowForWsfu(asWsfu(0))).toBe(0);
  });

  it('loses more pressure in a small pipe than a large one', () => {
    const small = frictionLossPerMetre(0.5, inches(0.545));
    const large = frictionLossPerMetre(0.5, inches(1.025));
    expect(small).toBeGreaterThan(large * 5);
  });

  it('scales friction with flow the way Hazen–Williams does', () => {
    // Loss goes as flow^1.852, so doubling the flow multiplies it by ~3.6.
    const single = frictionLossPerMetre(0.5, inches(0.785));
    const double = frictionLossPerMetre(1, inches(0.785));
    expect(double / single).toBeCloseTo(Math.pow(2, 1.852), 1);
  });

  it('computes velocity from the bore, not the nominal size', () => {
    // 0.5 l/s through a 1/2 in copper bore is about 3.3 m/s — comfortably over
    // the 2.4 m/s erosion limit, which is exactly why 1/2 in is a branch to one
    // fixture and never a trunk.
    const velocity = velocityFor(0.5, inches(0.545));
    expect(velocity).toBeGreaterThan(3);
    expect(velocity).toBeLessThan(3.6);

    // The same flow through 1 in is unremarkable.
    expect(velocityFor(0.5, inches(1.025))).toBeLessThan(1);
  });

  it('sizes the service off the fixture unit total', () => {
    expect(supplySizeFor(asWsfu(3)).asWritten).toBe('1/2 in');
    expect(supplySizeFor(asWsfu(4)).asWritten).toBe('3/4 in');
    expect(supplySizeFor(asWsfu(30)).asWritten).toBe('1 1/4 in');
  });

  it('never sizes the service below the 3/4 in the code insists on', () => {
    /*
     * A one-bathroom house computes to 1/2 in on the fixture-unit table alone,
     * and 1/2 in is not a legal service — IPC 603.1 puts a floor under it. The
     * router used to size the service with the general function and the checker
     * then reported the app's own routing as a violation.
     */
    expect(supplySizeFor(asWsfu(2)).asWritten).toBe('1/2 in');
    expect(serviceSizeFor(asWsfu(2)).asWritten).toBe('3/4 in');

    // The floor is a floor, not a fixed size: a big house still goes up.
    expect(serviceSizeFor(asWsfu(30)).asWritten).toBe('1 1/4 in');
  });

  it('rounds a cylinder up to a size somebody sells', () => {
    const two = storageFor(2);
    expect(two).toBeGreaterThanOrEqual(210);
    // And it is a real size, not an arithmetic result.
    expect([80, 120, 150, 180, 210, 250, 300]).toContain(two);
  });
});

/* ------------------------------- The routing ------------------------------ */

describe('routing the drainage', () => {
  it('routes a bathroom and a kitchen to one stack', () => {
    const doc = bathroomHouse();
    const result = routeAll(doc);

    expect(result.stacks).toBe(1);
    expect(doc.plumbing.stacks).toHaveLength(1);
    expect(doc.plumbing.drainage.length).toBeGreaterThan(4);
    expect(doc.plumbing.connections).toHaveLength(4);
  });

  it('puts the stack inside the building', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const stack = doc.plumbing.stacks[0]!;
    const level = doc.levels[0]!;
    const inside = findRegions(level.plan).some((region) => {
      const polygon = region.polygon;
      let hit = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const a = polygon[i]!;
        const b = polygon[j]!;
        if (
          a.z > stack.at.z !== b.z > stack.at.z &&
          stack.at.x < ((b.x - a.x) * (stack.at.z - a.z)) / (b.z - a.z) + a.x
        ) {
          hit = !hit;
        }
      }
      return hit;
    });
    expect(inside).toBe(true);
  });

  it('makes every branch fall towards the stack', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const branches = doc.plumbing.drainage.filter(
      (run) => run.system !== 'vent' && run.serves.length > 0,
    );
    expect(branches.length).toBeGreaterThan(0);

    for (const branch of branches) {
      const slope = slopeOf(doc, branch);
      expect(slope).not.toBeNull();
      // Positive means downhill from the upstream end. A branch that runs
      // uphill is the single defect this whole session exists to prevent.
      expect(slope!).toBeGreaterThan(0);
    }
  });

  it('gives every branch at least the fall its size requires', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    for (const entry of sizeAllDrainage(doc)) {
      if (entry.role !== 'branch' || entry.horizontalLength < 0.05) continue;
      expect(entry.slope!).toBeGreaterThanOrEqual(entry.requiredSlope - 1e-9);
    }
  });

  it('carries a vent above the top of the walls', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const vents = doc.plumbing.drainage.filter((run) => run.system === 'vent');
    expect(vents.length).toBeGreaterThan(0);

    const level = doc.levels[0]!;
    const highest = Math.max(
      ...vents.flatMap((run) => run.points.map((point) => point.height)),
    );
    expect(highest).toBeGreaterThan(level.wallHeight);
  });

  it('accumulates the load downstream, not just on the pipe itself', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const totals = accumulateDfu(doc);
    const buildingDrain = doc.plumbing.drainage.find((run) => run.downstreamId === null)!;
    const branch = doc.plumbing.drainage.find((run) => run.serves.length === 1)!;

    // WC 3 + basin 1 + bath 2 + sink 2 = 8 DFU at the bottom.
    expect(totals.get(buildingDrain.id)).toBe(8);
    expect(totals.get(branch.id)).toBeLessThan(totals.get(buildingDrain.id)!);
  });

  it('sizes the building drain for the whole house and the branch for one fixture', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const sized = sizeAllDrainage(doc);
    const drain = sized.find((entry) => entry.role === 'building-drain')!;
    const basin = sized.find(
      (entry) =>
        entry.run.serves.length === 1 &&
        doc.fixtures.find((f) => f.id === entry.run.serves[0])?.fixtureId === 'basin-pedestal',
    )!;

    // A WC in the house forces the drain to 3 in minimum.
    expect(drain.size.size).toBeGreaterThanOrEqual(inches(3) - 1e-9);
    expect(basin.size.size).toBeLessThan(drain.size.size);
  });

  it('leaves a hand-edited run alone when it re-routes', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const branch = doc.plumbing.drainage.find((run) => run.serves.length === 1)!;
    branch.manual = true;
    const kept = branch.id;
    const points = JSON.stringify(branch.points);

    routeAll(doc);

    const after = doc.plumbing.drainage.find((run) => run.id === kept);
    expect(after).toBeDefined();
    expect(JSON.stringify(after!.points)).toBe(points);
  });

  it('says so rather than routing nothing when there are no fixtures', () => {
    const doc = house([{ name: 'Bedroom', x: 0, z: 0, w: 4, d: 3 }]);
    const result = routeAll(doc);

    expect(result.stacks).toBe(0);
    expect(result.assumptions.join(' ')).toMatch(/nothing/i);
  });

  it('clears everything when asked', () => {
    const doc = bathroomHouse();
    routeAll(doc);
    expect(doc.plumbing.drainage.length).toBeGreaterThan(0);

    clearPlumbing(doc);
    expect(doc.plumbing.drainage).toHaveLength(0);
    expect(doc.plumbing.supply).toHaveLength(0);
    expect(doc.plumbing.stacks).toHaveLength(0);
    expect(doc.plumbing.heater).toBeNull();
  });
});

describe('routing the supply', () => {
  it('places a heater and feeds every tap', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    expect(doc.plumbing.heater).not.toBeNull();
    expect(doc.plumbing.supply.length).toBeGreaterThan(0);

    // Basin, bath and sink take hot; the WC takes only cold.
    const wc = doc.fixtures.find((fixture) => fixture.fixtureId === 'wc-close-coupled')!;
    const connection = doc.plumbing.connections.find((entry) => entry.fixtureId === wc.id)!;
    expect(connection.coldRunId).not.toBeNull();
    expect(connection.hotRunId).toBeNull();

    const bath = doc.fixtures.find((fixture) => fixture.fixtureId === 'bath-1700')!;
    const bathConnection = doc.plumbing.connections.find((entry) => entry.fixtureId === bath.id)!;
    expect(bathConnection.hotRunId).not.toBeNull();
  });

  it('carries the whole building’s load on the service, hot included', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const totals = plumbingTotals(doc);
    // WC 2.2 + basin 0.7 + bath 1.4 + sink 1.4 = 5.7 WSFU total.
    expect(totals.totalWsfu).toBeCloseTo(5.7, 5);
    expect(totals.coldWsfu).toBeGreaterThan(totals.hotWsfu);
  });

  it('does not route supply for a house with no taps', () => {
    const doc = house([{ name: 'Bedroom', x: 0, z: 0, w: 4, d: 3 }]);
    routeAll(doc);
    expect(doc.plumbing.supply).toHaveLength(0);
  });
});

/* ------------------------------- The checker ------------------------------ */

describe('checking the plumbing', () => {
  it('passes a routed house it laid out itself', () => {
    const doc = bathroomHouse();
    setSewerConnection(doc, { x: 0, z: 6 }, 1.2);
    routeAll(doc);

    const report = checkPlumbing(doc);
    const violations = report.findings.filter((finding) => finding.severity === 'violation');

    // The router and the checker are written separately and share only the
    // code tables. A violation here means one of them has a rule wrong.
    expect(violations.map((finding) => `${finding.title}: ${finding.detail}`)).toEqual([]);
    expect(report.compliant).toBe(true);
  });

  it('says nothing at all about an unrouted document', () => {
    const doc = bathroomHouse();
    const report = checkPlumbing(doc);
    expect(report.findings).toHaveLength(0);
    expect(report.compliant).toBe(true);
  });

  it('catches a drain laid uphill', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    // Tip one branch the wrong way.
    const branch = doc.plumbing.drainage.find((run) => run.serves.length === 1)!;
    const last = branch.points.length - 1;
    branch.points[last] = { ...branch.points[last]!, height: branch.points[0]!.height + 0.1 };

    const report = checkPlumbing(doc);
    expect(report.findings.some((finding) => finding.id.startsWith('fall-uphill'))).toBe(true);
    expect(report.compliant).toBe(false);
  });

  it('catches a drain that falls, but not enough', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const branch = doc.plumbing.drainage.find(
      (run) => run.serves.length === 1 && run.points.length > 1,
    )!;
    const last = branch.points.length - 1;
    // A millimetre of fall: downhill, and nowhere near 1/4 in per foot.
    branch.points[last] = { ...branch.points[last]!, height: branch.points[0]!.height - 0.001 };

    const report = checkPlumbing(doc);
    const finding = report.findings.find((entry) => entry.id.startsWith('fall-flat'));
    expect(finding).toBeDefined();
    expect(finding!.section).toBe('704.1');
    expect(finding!.severity).toBe('violation');
  });

  it('catches a trap with no vent', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    doc.plumbing.connections[0]!.ventRunId = null;

    const report = checkPlumbing(doc);
    expect(report.findings.some((finding) => finding.id.startsWith('trap-unvented'))).toBe(true);
  });

  it('reports guidance without a section, and code with one', () => {
    const doc = bathroomHouse();
    routeAll(doc);
    const report = checkPlumbing(doc);

    for (const finding of report.findings) {
      if (finding.severity === 'violation') {
        // A violation without a citation is unarguable-with, which is the one
        // thing a compliance report must never be.
        expect(finding.section).not.toBe('');
      }
    }

    // The street pressure warning is guidance: nothing in the IPC requires
    // anybody to measure it.
    const assumed = report.findings.find((finding) => finding.id === 'pressure-assumed');
    expect(assumed).toBeDefined();
    expect(assumed!.section).toBe('');
  });

  it('works out what is left at the worst fixture', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const report = checkPlumbing(doc);
    expect(report.pressure).not.toBeNull();

    const pressure = report.pressure!;
    // The budget has to add up: what is left is what came in, less both losses.
    expect(pressure.residualKpa).toBeCloseTo(
      pressure.mainKpa - pressure.staticKpa - pressure.frictionKpa,
      6,
    );
    expect(pressure.residualKpa).toBeLessThan(pressure.mainKpa);
  });

  it('fails a house on street pressure too low to reach the top', () => {
    const doc = bathroomHouse();
    routeAll(doc);
    doc.plumbing.mainPressureKpa = 100;
    doc.plumbing.mainPressureMeasured = true;

    const report = checkPlumbing(doc);
    // 100 kPa is about 14 psi. It gets nowhere once friction is paid.
    expect(report.pressure!.residualKpa).toBeLessThan(report.pressure!.mainKpa);
  });

  it('sizes the service legally, so it does not fail its own check', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const report = checkPlumbing(doc);
    expect(report.findings.some((finding) => finding.id === 'service-small')).toBe(false);

    const service = sizeAllSupply(doc).find((entry) => entry.run.downstreamId === null)!;
    expect(service.size.asWritten).toBe('3/4 in');
  });

  it('requires a pressure-reducing valve above 80 psi', () => {
    const doc = bathroomHouse();
    routeAll(doc);
    doc.plumbing.mainPressureKpa = 700;
    doc.plumbing.mainPressureMeasured = true;

    const report = checkPlumbing(doc);
    const finding = report.findings.find((entry) => entry.id === 'pressure-high');
    expect(finding).toBeDefined();
    expect(finding!.section).toBe('604.8');
  });

  it('asks for scald protection wherever there is a bath or a shower', () => {
    const doc = bathroomHouse();
    routeAll(doc);

    const report = checkPlumbing(doc);
    const scald = report.findings.find((finding) => finding.id === 'scald');
    expect(scald).toBeDefined();
    expect(scald!.section).toBe('607.2');
  });
});

/* ------------------------------ Two storeys ------------------------------- */

describe('a two-storey house', () => {
  it('takes one stack through both floors', () => {
    const doc = bathroomHouse();
    // `copyWalls` traces the storey below, so the footprint is the same
    // upstairs and the stack has somewhere to go.
    const upper = addLevel(doc, { copyWalls: true });
    expect(upper.id).not.toBeNull();

    const level = doc.levels[1]!;
    addFixture(doc, level.id, 'wc-close-coupled', { x: -0.9, z: -0.8 });
    addFixture(doc, level.id, 'basin-pedestal', { x: 0.4, z: -0.9 });

    routeAll(doc);

    expect(doc.plumbing.stacks).toHaveLength(1);
    const stack = doc.plumbing.stacks[0]!;
    expect(stack.fromLevelId).toBe(doc.levels[0]!.id);
    expect(stack.toLevelId).toBe(doc.levels[1]!.id);

    // Six fixtures now, all connected.
    expect(doc.plumbing.connections).toHaveLength(6);
  });

  it('sizes the stack for both storeys, not just the one it is on', () => {
    const doc = bathroomHouse();
    addLevel(doc, { copyWalls: true });

    const level = doc.levels[1]!;
    addFixture(doc, level.id, 'wc-close-coupled', { x: -0.9, z: -0.8 });
    routeAll(doc);

    const totals = accumulateDfu(doc);
    const drain = doc.plumbing.drainage.find((run) => run.downstreamId === null)!;
    // Both WCs, both basins, bath and sink: 3+1+2+2+3 = 11 DFU.
    expect(totals.get(drain.id)).toBe(11);
  });
});

/* ------------------------------ Openings ---------------------------------- */

describe('the vent and the windows', () => {
  it('warns when the vent comes out near a window', () => {
    const doc = bathroomHouse();
    const level = doc.levels[0]!;
    // A window in the bathroom, which is where the stack will end up.
    const wall = level.plan.walls[0]!;
    addOpening(
      level.plan,
      wall.id,
      'window',
      'window-casement',
      { width: 0.9, height: 1, sillHeight: 1.2 },
      1.5,
    );

    routeAll(doc);
    const report = checkPlumbing(doc);

    const finding = report.findings.find((entry) => entry.id.startsWith('vent-near-window'));
    expect(finding).toBeDefined();
    // A caution, not a violation: 904.5 is satisfied by height as well as
    // distance, and this only measures the plan distance.
    expect(finding!.severity).toBe('caution');
    expect(finding!.section).toBe('904.5');
  });
});

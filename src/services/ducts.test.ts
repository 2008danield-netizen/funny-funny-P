/**
 * Tests for the duct layout and Manual D sizing.
 *
 * A duct system is easy to get plausibly wrong: a plan full of lines that
 * connect up and carry the wrong amount of air. So these check the two things
 * that matter and are invisible on a drawing — that every room with a load
 * gets air, and that the air adds up correctly from the registers back to the
 * plant.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, drawWall, normalizePlan } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import { calculateLoad } from './manualJ';
import { selectSystem } from './manualS';
import { resetDuctIds, routeDucts } from './ducts';
import { accumulateCfm, ductRole, roomAirflows, sizeAllDucts, ductTotals } from './ductSize';
import { ROUND_DUCTS } from '@/code/acca';
import type { DesignDocument } from '@/state/types';

/**
 * A three-room house: one rectangle split twice, so the rooms differ in size
 * and orientation and the trunk has something real to run along.
 */
function house(city = 'Chicago, IL'): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  // Centred at (6, 4) so the house spans x 0-12 and z 0-8 and the partitions
  // below land inside it. `addRectangle` takes the CENTRE, not a corner — at
  // the origin the partitions fall outside as dangling walls enclosing
  // nothing, which still yields a plan, still yields one room, and silently
  // stops this fixture being the multi-room house it claims to be.
  addRectangle(level.plan, { x: 6, z: 4 }, 12, 8);
  // Two cross walls, making a living room, a bedroom and a hall.
  drawWall(level.plan, { x: 5, z: 0 }, { x: 5, z: 8 });
  drawWall(level.plan, { x: 9, z: 0 }, { x: 9, z: 8 });
  normalizePlan(level.plan);

  const names = ['Living Room', 'Hall', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3'];
  findRegions(level.plan).forEach((region, index) => {
    level.plan.rooms[region.key] = {
      name: names[index] ?? `Room ${index}`,
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  });

  // Windows on the outside walls, which is where the registers should end up.
  for (const wall of level.plan.walls.slice(0, 4)) {
    addOpening(level.plan, wall.id, 'window', 'window-casement', { width: 1.5, height: 1.4, sillHeight: 0.9 }, 2);
  }

  doc.hvac.locationKey = city;
  doc.hvac.system = 'forced-air';
  return doc;
}

function laidOut(city = 'Chicago, IL'): DesignDocument {
  const doc = house(city);
  const load = calculateLoad(doc);
  const selection = selectSystem(load, doc.hvac.system);
  const layout = routeDucts(doc, load, selection);
  doc.hvac.ducts = layout.ducts;
  doc.hvac.registers = layout.registers;
  doc.hvac.airHandler = layout.airHandler;
  return doc;
}

describe('duct layout', () => {
  beforeEach(() => resetDuctIds());

  it('gives every room with a load a supply register', () => {
    const doc = laidOut();
    const load = calculateLoad(doc);
    const selection = selectSystem(load, doc.hvac.system);
    const airflows = roomAirflows(load, selection);

    const served = new Set(
      doc.hvac.registers.filter((r) => r.system === 'supply').map((r) => r.roomKey),
    );

    for (const flow of airflows) {
      if (flow.designCfm > 10) expect(served.has(flow.roomKey)).toBe(true);
    }
  });

  it('puts a return on every storey that has supply air', () => {
    // Not decoration: a storey with supply and no return pressurises and
    // pushes conditioned air out through the structure.
    const doc = laidOut();
    const supplyLevels = new Set(
      doc.hvac.registers.filter((r) => r.system === 'supply').map((r) => r.levelId),
    );
    const returnLevels = new Set(
      doc.hvac.registers.filter((r) => r.system === 'return').map((r) => r.levelId),
    );

    for (const levelId of supplyLevels) expect(returnLevels.has(levelId)).toBe(true);
  });

  it('puts the supply registers low and the returns high', () => {
    const doc = laidOut();
    const supplies = doc.hvac.registers.filter((r) => r.system === 'supply');
    const returns = doc.hvac.registers.filter((r) => r.system === 'return');

    expect(supplies.length).toBeGreaterThan(0);
    for (const supply of supplies) expect(supply.height).toBeLessThan(0.5);
    for (const back of returns) expect(back.height).toBeGreaterThan(1.5);
  });

  it('runs the supply ducts in the void below the floor, rising only at the register', () => {
    // Everything but the last point of a branch is below the finished floor;
    // the last point is the boot climbing into the register.
    const doc = laidOut();
    const supplies = doc.hvac.ducts.filter((duct) => duct.system === 'supply');
    expect(supplies.length).toBeGreaterThan(0);

    for (const duct of supplies) {
      // A riser climbs between storeys by definition, so it is not part of
      // this claim.
      if (ductRole(duct) === 'riser') continue;

      const horizontal = duct.serves.length > 0 ? duct.points.slice(0, -1) : duct.points;
      for (const point of horizontal) expect(point.height).toBeLessThan(0);

      if (duct.serves.length > 0) {
        const boot = duct.points[duct.points.length - 1]!;
        expect(boot.height).toBeGreaterThan(0);
      }
    }
  });

  it('hangs every branch off a trunk, and roots exactly one trunk', () => {
    const doc = laidOut();
    const supplies = doc.hvac.ducts.filter((duct) => duct.system === 'supply');
    const roots = supplies.filter((duct) => duct.upstreamId === null);

    expect(roots).toHaveLength(1);
    expect(ductRole(roots[0]!)).toBe('trunk');

    const ids = new Set(supplies.map((duct) => duct.id));
    for (const duct of supplies) {
      if (duct.upstreamId) expect(ids.has(duct.upstreamId)).toBe(true);
    }
  });

  it('routes nothing when there is no equipment to route for', () => {
    const doc = house();
    doc.hvac.system = 'load-only';
    const load = calculateLoad(doc);
    const layout = routeDucts(doc, load, selectSystem(load, 'load-only'));

    expect(layout.ducts).toHaveLength(0);
    expect(layout.registers).toHaveLength(0);
    expect(layout.assumptions.join(' ')).toMatch(/no equipment/i);
  });

  it('routes nothing for a ductless system, and says why', () => {
    const doc = house();
    doc.hvac.system = 'mini-split';
    const load = calculateLoad(doc);
    const layout = routeDucts(doc, load, selectSystem(load, 'mini-split'));

    expect(layout.ducts).toHaveLength(0);
    expect(layout.assumptions.join(' ')).toMatch(/no ductwork/i);
  });

  it('never leaves a zero-length duct behind', () => {
    // Two identical points is a duct that draws as nothing, sizes as nothing
    // and quietly breaks the accumulation.
    const doc = laidOut();
    for (const duct of doc.hvac.ducts) {
      expect(duct.points.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < duct.points.length; i += 1) {
        const a = duct.points[i - 1]!;
        const b = duct.points[i]!;
        const moved =
          Math.hypot(b.at.x - a.at.x, b.at.z - a.at.z) > 0.01 ||
          Math.abs(b.height - a.height) > 0.01 ||
          a.levelId !== b.levelId;
        expect(moved).toBe(true);
      }
    }
  });
});

describe('Manual D sizing', () => {
  beforeEach(() => resetDuctIds());

  it('sizes a room for its worst season, not its average', () => {
    // A room can be a big share of the heating load and a small share of the
    // cooling load. The branch has to carry whichever is larger.
    const doc = laidOut();
    const load = calculateLoad(doc);
    const selection = selectSystem(load, doc.hvac.system);

    for (const flow of roomAirflows(load, selection)) {
      expect(flow.designCfm).toBe(Math.max(flow.heatingCfm, flow.coolingCfm));
    }
  });

  it('carries every branch’s air in the trunk, up to what the blower moves', () => {
    const doc = laidOut();
    const load = calculateLoad(doc);
    const selection = selectSystem(load, doc.hvac.system);
    const sized = sizeAllDucts(doc, load, selection);

    const trunk = sized.find((duct) => duct.role === 'trunk' && duct.run.system === 'supply');
    expect(trunk).toBeDefined();

    const branchTotal = sized
      .filter((duct) => duct.role === 'branch' && duct.run.system === 'supply')
      .reduce((sum, duct) => sum + duct.cfm, 0);

    expect(trunk!.cfm).toBeCloseTo(Math.min(branchTotal, selection.supplyCfm), 6);
  });

  it('never sizes the trunk for a flow that happens in no season', () => {
    /*
     * Branch airflows can add up to more than the blower moves, because each
     * branch is sized for its own worst season and a north bedroom's January
     * share plus a west living room's July share is not a quantity of air that
     * exists at any one moment. A branch may be sized for a flow that only
     * happens in one season. A trunk may not be sized for one that happens in
     * none.
     *
     * On this fixture the cap genuinely binds: the branch flows sum to a few
     * percent over what the blower moves. It took a real multi-room house to
     * show that — an earlier version of this fixture had its partitions
     * outside the rectangle, so it was a one-room house wearing a three-room
     * comment, and the cap never bound.
     */
    const doc = laidOut();
    const load = calculateLoad(doc);
    const selection = selectSystem(load, doc.hvac.system);
    const sized = sizeAllDucts(doc, load, selection);

    for (const duct of sized) {
      expect(duct.cfm).toBeLessThanOrEqual(selection.supplyCfm + 1e-6);
    }
  });

  it('makes the trunk bigger than any branch', () => {
    const doc = laidOut();
    const load = calculateLoad(doc);
    const sized = sizeAllDucts(doc, load, selectSystem(load, doc.hvac.system));

    const trunk = sized.find((duct) => duct.role === 'trunk' && duct.run.system === 'supply')!;
    for (const branch of sized.filter((duct) => duct.role === 'branch')) {
      expect(trunk.size.inches).toBeGreaterThanOrEqual(branch.size.inches);
    }
  });

  it('picks the smallest duct that carries the air', () => {
    const doc = laidOut();
    const load = calculateLoad(doc);
    const sized = sizeAllDucts(doc, load, selectSystem(load, doc.hvac.system));

    for (const duct of sized) {
      expect(duct.size.maxCfm).toBeGreaterThanOrEqual(duct.cfm);

      const smaller = [...ROUND_DUCTS]
        .filter((size) => size.inches < duct.size.inches)
        .sort((a, b) => b.inches - a.inches)[0];
      // Anything smaller must genuinely be too small, or the sizing is padding.
      if (smaller && duct.size.inches < 20) expect(smaller.maxCfm).toBeLessThan(duct.cfm);
    }
  });

  it('survives a cycle in a corrupt document without hanging', () => {
    // A hand-edited JSON file can absolutely contain one, and the accumulation
    // walks upstream links.
    const doc = laidOut();
    const [first, second] = doc.hvac.ducts;
    if (first && second) {
      first.upstreamId = second.id;
      second.upstreamId = first.id;
    }

    const totals = accumulateCfm(doc.hvac.ducts, new Map());
    expect(totals.size).toBe(doc.hvac.ducts.length);
  });

  it('reports totals that match the runs it sized', () => {
    const doc = laidOut();
    const load = calculateLoad(doc);
    const sized = sizeAllDucts(doc, load, selectSystem(load, doc.hvac.system));
    const totals = ductTotals(sized, doc);

    expect(totals.supplyRuns + totals.returnRuns).toBe(doc.hvac.ducts.length);
    expect(totals.length).toBeGreaterThan(0);
    expect(totals.registers).toBeGreaterThan(0);
    expect(totals.returns).toBeGreaterThan(0);
  });
});

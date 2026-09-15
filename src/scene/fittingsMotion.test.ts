/**
 * Tests for the fronts that move.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS WORTH TESTING AT ALL.
 *
 * Every one of these is a sign. A door hinged on the wrong edge, a swing that
 * goes the wrong way, a drawer that slides INTO the carcass rather than out of
 * it — none of them throws, none of them fails a typecheck, and all of them
 * look like a modelling error in a screenshot nobody will take. The cheapest
 * place to pin a sign is a unit test.
 *
 * `Fittings` builds meshes but touches no WebGL context, so it runs here.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { createDefaultDocument } from '@/state/defaults';
import { addRectangle, normalizePlan } from '@/state/planOps';
import { addFixture, addRun } from '@/state/fittingOps';
import { Fittings } from './Fittings';
import type { DesignDocument } from '@/state/types';

/**
 * A kitchen run along z = 0.4, facing south (towards +z).
 *
 * A run drawn left to right along the top of the room has its outward normal
 * pointing down the page, which is the direction everything here should move.
 */
function kitchen(required: readonly string[]): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  addRectangle(level.plan, { x: 6, z: 4 }, 12, 8);
  normalizePlan(level.plan);

  addRun(doc, level.id, [{ x: 0.5, z: 0.4 }, { x: 4.5, z: 0.4 }], 'base', { required });
  return doc;
}

function unitOf(doc: DesignDocument, moduleId: string): string {
  const unit = doc.runs[0]!.units.find((entry) => entry.moduleId === moduleId);
  expect(unit, `the run should contain a ${moduleId}`).toBeDefined();
  return unit!.id;
}

/** Every panel and handle belonging to a unit, in world space. */
function partsOf(fittings: Fittings, unitId: string): THREE.Vector3[] {
  const found: THREE.Vector3[] = [];
  fittings.group.updateMatrixWorld(true);

  for (const child of fittings.group.children) {
    if (!(child instanceof THREE.Group)) continue;
    // Only the pivots have children; everything else is a bare mesh.
    if (child.children.length === 0) continue;
    if (child.userData.unitId !== unitId) continue;

    for (const part of child.children) {
      found.push(part.getWorldPosition(new THREE.Vector3()));
    }
  }
  return found;
}

function build(doc: DesignDocument): Fittings {
  const fittings = new Fittings();
  fittings.update(doc, doc.levels[0]!.id);
  return fittings;
}

describe('fronts that move', () => {
  it('swings a cabinet door out of the carcass, not into it', () => {
    const doc = kitchen(['base-600-door']);
    const unitId = unitOf(doc, 'base-600-door');
    const fittings = build(doc);

    const shut = partsOf(fittings, unitId);
    expect(shut.length).toBeGreaterThan(0);
    const shutDepth = Math.max(...shut.map((point) => point.z));

    fittings.setUnitOpenness(unitId, 1);
    const open = partsOf(fittings, unitId);
    const openDepth = Math.max(...open.map((point) => point.z));

    // The run faces +z, so a door that opens comes towards the viewer.
    expect(openDepth).toBeGreaterThan(shutDepth + 0.2);
    fittings.dispose();
  });

  it('hinges a pair of doors on opposite edges so they part in the middle', () => {
    const doc = kitchen(['base-1000-double']);
    const unitId = unitOf(doc, 'base-1000-double');
    const fittings = build(doc);

    fittings.setUnitOpenness(unitId, 1);
    fittings.group.updateMatrixWorld(true);

    const pivots = fittings.group.children.filter(
      (child) => child instanceof THREE.Group && child.userData.unitId === unitId,
    );
    expect(pivots).toHaveLength(2);

    // One turns one way and one the other. Both the same way would be two
    // doors hinged on the same edge, which is a cupboard with a hole in it.
    const [a, b] = pivots as THREE.Group[];
    const turnA = a!.rotation.y - (a!.userData.shutAngle as number);
    const turnB = b!.rotation.y - (b!.userData.shutAngle as number);
    expect(Math.sign(turnA)).toBe(-Math.sign(turnB));
    fittings.dispose();
  });

  it('slides a drawer straight out, the way a runner allows', () => {
    const doc = kitchen(['base-600-drawers']);
    const unitId = unitOf(doc, 'base-600-drawers');
    const fittings = build(doc);

    const shut = partsOf(fittings, unitId);
    fittings.setUnitOpenness(unitId, 1);
    const open = partsOf(fittings, unitId);

    expect(open).toHaveLength(shut.length);

    for (let i = 0; i < shut.length; i += 1) {
      // Out, and nowhere else: a drawer does not move sideways or upwards.
      expect(open[i]!.z - shut[i]!.z).toBeGreaterThan(0.3);
      expect(Math.abs(open[i]!.x - shut[i]!.x)).toBeLessThan(1e-6);
      expect(Math.abs(open[i]!.y - shut[i]!.y)).toBeLessThan(1e-6);
    }
    fittings.dispose();
  });

  it('puts a half-open drawer half-way out', () => {
    const doc = kitchen(['base-600-drawers']);
    const unitId = unitOf(doc, 'base-600-drawers');
    const fittings = build(doc);

    const shut = partsOf(fittings, unitId)[0]!;
    fittings.setUnitOpenness(unitId, 1);
    const full = partsOf(fittings, unitId)[0]!.z - shut.z;

    fittings.setUnitOpenness(unitId, 0.5);
    const half = partsOf(fittings, unitId)[0]!.z - shut.z;

    expect(half).toBeCloseTo(full / 2, 6);
    fittings.dispose();
  });

  it('remembers what was open across a rebuild', () => {
    /*
     * Editing anything on the storey rebuilds every mesh. A drawer that shut
     * itself because somebody moved a wall would be a bug that is very hard
     * to describe and very easy to ship.
     */
    const doc = kitchen(['base-600-drawers']);
    const unitId = unitOf(doc, 'base-600-drawers');
    const fittings = build(doc);

    const shut = partsOf(fittings, unitId)[0]!.z;
    fittings.setUnitOpenness(unitId, 1);
    const open = partsOf(fittings, unitId)[0]!.z;

    // Something changes that forces a rebuild.
    doc.runs[0]!.finishId = 'anthracite';
    fittings.update(doc, doc.levels[0]!.id);

    expect(partsOf(fittings, unitId)[0]!.z).toBeCloseTo(open, 6);
    expect(open).toBeGreaterThan(shut);
    fittings.dispose();
  });
});

describe('running water', () => {
  it('hangs a stream over a sink and none over a WC', () => {
    const doc = kitchen(['base-600-sink']);
    const levelId = doc.levels[0]!.id;
    const sink = addFixture(doc, levelId, 'sink-1.5-bowl', { x: 2, z: 1 });
    const wc = addFixture(doc, levelId, 'wc-close-coupled', { x: 9, z: 6 });

    const fittings = build(doc);
    const taps = fittings.tapFixtures();

    expect(taps).toContain(sink);
    expect(taps).not.toContain(wc);
    fittings.dispose();
  });

  it('shows the water only while the tap runs', () => {
    const doc = kitchen(['base-600-sink']);
    const levelId = doc.levels[0]!.id;
    const sink = addFixture(doc, levelId, 'sink-1.5-bowl', { x: 2, z: 1 })!;

    const fittings = build(doc);
    const water = () =>
      fittings.group.children.filter((child) => child.userData.tapFixtureId === sink);

    expect(water().length).toBeGreaterThan(0);
    expect(water().every((part) => part.visible)).toBe(false);

    fittings.setTapRunning(sink, true);
    expect(water().every((part) => part.visible)).toBe(true);

    fittings.setTapRunning(sink, false);
    expect(water().some((part) => part.visible)).toBe(false);
    fittings.dispose();
  });
});

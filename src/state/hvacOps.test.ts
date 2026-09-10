/**
 * Tests for the HVAC edits.
 *
 * These are about the small number of things the document actually stores, and
 * mostly about the rules that keep it honest: a changed envelope figure cannot
 * stay "confirmed", a changed system kind cannot leave the old ductwork lying
 * in the model, and deleting a trunk cannot leave its branches floating.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, drawWall, normalizePlan } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import {
  clearHvac,
  deriveHvac,
  layoutHvac,
  layoutUnderfloor,
  removeDuct,
  resetHvacCounters,
  releaseDuct,
  setDesignLocation,
  setEnvelope,
  setEquipment,
  setSystemKind,
  confirmEnvelope,
  moveDuctPoint,
} from './hvacOps';
import type { DesignDocument } from './types';

function house(): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  addRectangle(level.plan, { x: 0, z: 0 }, 12, 8);
  drawWall(level.plan, { x: 6, z: 0 }, { x: 6, z: 8 });
  normalizePlan(level.plan);

  const names = ['Living Room', 'Bedroom 1'];
  findRegions(level.plan).forEach((region, index) => {
    level.plan.rooms[region.key] = {
      name: names[index] ?? `Room ${index}`,
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  });

  for (const wall of level.plan.walls.slice(0, 4)) {
    addOpening(level.plan, wall.id, 'window', 'window-casement', { width: 1.5, height: 1.4, sillHeight: 0.9 }, 2);
  }
  return doc;
}

describe('the design location', () => {
  it('refuses a key that is not in the table', () => {
    // A key that does not resolve produces a null load, and a null load looks
    // in the UI exactly like "you have not chosen yet" — so a typo would be
    // completely invisible.
    const doc = house();
    setDesignLocation(doc, 'Atlantis, XX');
    expect(doc.hvac.locationKey).toBe('');

    setDesignLocation(doc, 'Chicago, IL');
    expect(doc.hvac.locationKey).toBe('Chicago, IL');
  });

  it('allows clearing it back to nothing', () => {
    const doc = house();
    setDesignLocation(doc, 'Chicago, IL');
    setDesignLocation(doc, '');
    expect(doc.hvac.locationKey).toBe('');
  });
});

describe('the envelope', () => {
  it('un-confirms itself when any figure changes', () => {
    /*
     * "Confirmed" is a claim about the real building. Changing one of the
     * numbers behind it has to retract the claim, or the word degrades into
     * "somebody clicked this once" and every check that leans on it is leaning
     * on nothing.
     */
    const doc = house();
    confirmEnvelope(doc, true);
    expect(doc.hvac.envelope.confirmed).toBe(true);

    setEnvelope(doc, { wallAssemblyId: 'wall-double-r38' });
    expect(doc.hvac.envelope.confirmed).toBe(false);
  });

  it('stays confirmed when the same value is set again', () => {
    const doc = house();
    const current = doc.hvac.envelope.wallAssemblyId;
    confirmEnvelope(doc, true);

    setEnvelope(doc, { wallAssemblyId: current });
    expect(doc.hvac.envelope.confirmed).toBe(true);
  });
});

describe('laying it out', () => {
  beforeEach(() => resetHvacCounters());

  it('routes ducts for an air system and emitters for a wet one', () => {
    const doc = house();
    setDesignLocation(doc, 'Chicago, IL');

    setSystemKind(doc, 'forced-air');
    layoutHvac(doc);
    expect(doc.hvac.ducts.length).toBeGreaterThan(0);
    expect(doc.hvac.emitters).toHaveLength(0);

    setSystemKind(doc, 'hydronic');
    // Changing the kind throws the old installation away rather than leaving
    // ducts in a house that has none — the drawings would still print them.
    expect(doc.hvac.ducts).toHaveLength(0);

    layoutHvac(doc);
    expect(doc.hvac.emitters.length).toBeGreaterThan(0);
    expect(doc.hvac.ducts).toHaveLength(0);
  });

  it('lays out underfloor when asked, and radiators when it cannot', () => {
    const doc = house();
    setDesignLocation(doc, 'Chicago, IL');
    setSystemKind(doc, 'hydronic');
    setEnvelope(doc, { roofAssemblyId: 'roof-r60', glazingId: 'triple-lowe' });

    layoutUnderfloor(doc, 'condensing-45');
    expect(doc.hvac.emitters.some((emitter) => emitter.kind === 'underfloor')).toBe(true);
  });

  it('clears the installation but keeps the decisions', () => {
    const doc = house();
    setDesignLocation(doc, 'Chicago, IL');
    setSystemKind(doc, 'forced-air');
    layoutHvac(doc);

    clearHvac(doc);
    expect(doc.hvac.ducts).toHaveLength(0);
    expect(doc.hvac.registers).toHaveLength(0);
    expect(doc.hvac.airHandler).toBeNull();
    // The location and the envelope are decisions, not an installation.
    expect(doc.hvac.locationKey).toBe('Chicago, IL');
  });

  it('gives the same ids from the same input', () => {
    const first = house();
    setDesignLocation(first, 'Chicago, IL');
    setSystemKind(first, 'forced-air');
    resetHvacCounters();
    layoutHvac(first);

    const second = house();
    setDesignLocation(second, 'Chicago, IL');
    setSystemKind(second, 'forced-air');
    resetHvacCounters();
    layoutHvac(second);

    expect(second.hvac.ducts.map((duct) => duct.id)).toEqual(
      first.hvac.ducts.map((duct) => duct.id),
    );
  });
});

describe('hand editing', () => {
  beforeEach(() => resetHvacCounters());

  function laidOut(): DesignDocument {
    const doc = house();
    setDesignLocation(doc, 'Chicago, IL');
    setSystemKind(doc, 'forced-air');
    layoutHvac(doc);
    return doc;
  }

  it('marks a moved duct as hand-edited, and can hand it back', () => {
    // The whole point of being able to move a duct is that the app then leaves
    // it alone. An app that helpfully re-routes over a correction is one people
    // stop correcting.
    const doc = laidOut();
    const run = doc.hvac.ducts[0]!;
    expect(run.manual).toBe(false);

    moveDuctPoint(doc, run.id, 0, { x: 1, z: 1 });
    expect(doc.hvac.ducts[0]!.manual).toBe(true);

    releaseDuct(doc, run.id);
    expect(doc.hvac.ducts[0]!.manual).toBe(false);
  });

  it('takes a trunk’s branches with it when the trunk is deleted', () => {
    /*
     * A branch left floating would size correctly and connect to nothing,
     * which is worse than either having it or not having it.
     */
    const doc = laidOut();
    const trunk = doc.hvac.ducts.find(
      (duct) => duct.system === 'supply' && duct.upstreamId === null,
    )!;
    const branches = doc.hvac.ducts.filter((duct) => duct.upstreamId === trunk.id);
    expect(branches.length).toBeGreaterThan(0);

    removeDuct(doc, trunk.id);

    expect(doc.hvac.ducts.find((duct) => duct.id === trunk.id)).toBeUndefined();
    for (const branch of branches) {
      expect(doc.hvac.ducts.find((duct) => duct.id === branch.id)).toBeUndefined();
    }
    // And the registers those branches fed go with them.
    expect(doc.hvac.registers.filter((register) => register.system === 'supply')).toHaveLength(0);
  });

  it('does not hang on a cycle while deleting', () => {
    // A hand-edited JSON file can absolutely contain one, and the delete walks
    // downstream links to find what to take with it.
    const doc = laidOut();
    const before = doc.hvac.ducts.length;
    const [first, second] = doc.hvac.ducts;
    expect(first && second).toBeTruthy();

    first!.upstreamId = second!.id;
    second!.upstreamId = first!.id;

    removeDuct(doc, first!.id);

    // It terminated, and it took both ends of the cycle.
    expect(doc.hvac.ducts.length).toBeLessThan(before);
    expect(doc.hvac.ducts.find((duct) => duct.id === first!.id)).toBeUndefined();
    expect(doc.hvac.ducts.find((duct) => duct.id === second!.id)).toBeUndefined();
  });
});

describe('the equipment override', () => {
  it('takes a hand-picked model and gives it back', () => {
    const doc = house();
    setDesignLocation(doc, 'Chicago, IL');
    setSystemKind(doc, 'forced-air');

    setEquipment(doc, 'furnace-120', null);
    expect(doc.hvac.equipmentManual).toBe(true);
    expect(deriveHvac(doc).selection.heating!.model.id).toBe('furnace-120');

    // Null for both is the way back to the automatic choice. Without it the
    // only escape would be changing the system kind and losing the ductwork.
    setEquipment(doc, null, null);
    expect(doc.hvac.equipmentManual).toBe(false);
    expect(deriveHvac(doc).selection.heating!.model.id).not.toBe('furnace-120');
  });

  it('ignores a model that does not exist', () => {
    const doc = house();
    setDesignLocation(doc, 'Chicago, IL');
    setEquipment(doc, 'furnace-invented', null);
    expect(doc.hvac.equipmentManual).toBe(false);
  });
});

/**
 * Tests for placing and editing the section cuts.
 *
 * Mostly about the one rule that shapes the file: the presets follow the
 * building, and anything drawn by hand is never moved for the person who drew
 * it.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addRectangle, normalizePlan } from '@/state/planOps';
import {
  addSection,
  buildingBounds,
  flipSection,
  moveSection,
  moveSectionEnd,
  nextMark,
  presetSections,
  refreshPresets,
  removeSection,
  resetSectionIds,
} from './sectionOps';
import type { DesignDocument } from './types';

/** A 12 × 8 house spanning x 0–12 and z 0–8. */
function house(width = 12, depth = 8): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  addRectangle(level.plan, { x: width / 2, z: depth / 2 }, width, depth);
  normalizePlan(level.plan);
  return doc;
}

describe('the building bounds', () => {
  it('measures the walls that are there', () => {
    const bounds = buildingBounds(house())!;
    expect(bounds.minX).toBeCloseTo(0, 1);
    expect(bounds.maxX).toBeCloseTo(12, 1);
    expect(bounds.minZ).toBeCloseTo(0, 1);
    expect(bounds.maxZ).toBeCloseTo(8, 1);
  });

  it('gives nothing for an empty plan', () => {
    const doc = createDefaultDocument();
    doc.levels[0]!.plan.walls = [];
    doc.levels[0]!.plan.vertices = [];
    expect(buildingBounds(doc)).toBeNull();
  });
});

describe('the presets', () => {
  it('cuts through the middle each way', () => {
    const [first, second] = presetSections(house());

    expect(first!.from.z).toBeCloseTo(4, 1);
    expect(first!.to.z).toBeCloseTo(4, 1);
    expect(second!.from.x).toBeCloseTo(6, 1);
    expect(second!.to.x).toBeCloseTo(6, 1);
  });

  it('runs the line past the building at both ends', () => {
    // A section line is drawn out past the walls so the arrowheads and the mark
    // sit in clear space. Clipping it to the footprint would bury both.
    const [first] = presetSections(house());
    expect(first!.from.x).toBeLessThan(0);
    expect(first!.to.x).toBeGreaterThan(12);
  });

  it('calls the long one the long section, whichever axis that is', () => {
    const wide = presetSections(house(14, 6));
    const deep = presetSections(house(6, 14));

    expect(wide[0]!.name).toBe('Long section');
    expect(deep[0]!.name).toBe('Long section');
    // And the long one really does run along the long axis.
    expect(Math.abs(wide[0]!.to.x - wide[0]!.from.x)).toBeGreaterThan(
      Math.abs(wide[0]!.to.z - wide[0]!.from.z),
    );
    expect(Math.abs(deep[0]!.to.z - deep[0]!.from.z)).toBeGreaterThan(
      Math.abs(deep[0]!.to.x - deep[0]!.from.x),
    );
  });

  it('follows the building when it changes shape', () => {
    const doc = house();
    refreshPresets(doc);
    const before = doc.sections[0]!.from.z;

    // Grow the house; the automatic cut should move to the new middle.
    addRectangle(doc.levels[0]!.plan, { x: 6, z: 14 }, 12, 8);
    normalizePlan(doc.levels[0]!.plan);
    refreshPresets(doc);

    expect(doc.sections[0]!.from.z).not.toBeCloseTo(before, 1);
  });

  it('never moves a cut somebody drew', () => {
    /*
     * The rule the whole file is shaped around. An app that helpfully moves a
     * correction is one people stop correcting.
     */
    const doc = house();
    refreshPresets(doc);
    addSection(doc, { x: -1, z: 2 }, { x: 13, z: 2 });

    const drawn = doc.sections.find((section) => !section.automatic)!;
    const where = { ...drawn.from };

    addRectangle(doc.levels[0]!.plan, { x: 6, z: 14 }, 12, 8);
    normalizePlan(doc.levels[0]!.plan);
    refreshPresets(doc);

    const after = doc.sections.find((section) => section.id === drawn.id)!;
    expect(after.from).toEqual(where);
  });

  it('lets a hand-drawn cut keep its mark when the presets are rebuilt', () => {
    // Somebody has looked at "Section C" on a printed sheet. Renumbering it
    // because the building grew is worse than the presets taking later letters.
    const doc = house();
    refreshPresets(doc);
    const id = addSection(doc, { x: -1, z: 2 }, { x: 13, z: 2 })!;
    const mark = doc.sections.find((section) => section.id === id)!.mark;

    refreshPresets(doc);
    expect(doc.sections.find((section) => section.id === id)!.mark).toBe(mark);

    // And nothing ends up sharing a mark.
    const marks = doc.sections.map((section) => section.mark);
    expect(new Set(marks).size).toBe(marks.length);
  });

  it('drops the presets when there is nothing to cut', () => {
    const doc = house();
    refreshPresets(doc);
    expect(doc.sections.length).toBe(2);

    doc.levels[0]!.plan.walls = [];
    doc.levels[0]!.plan.vertices = [];
    refreshPresets(doc);
    expect(doc.sections).toHaveLength(0);
  });
});

describe('editing a cut', () => {
  beforeEach(() => resetSectionIds());

  it('refuses a line too short to be a section', () => {
    const doc = house();
    expect(addSection(doc, { x: 1, z: 1 }, { x: 1.1, z: 1 })).toBeNull();
    expect(doc.sections).toHaveLength(0);
  });

  it('gives each new cut its own mark', () => {
    const doc = house();
    addSection(doc, { x: -1, z: 2 }, { x: 13, z: 2 });
    addSection(doc, { x: -1, z: 6 }, { x: 13, z: 6 });

    expect(doc.sections[0]!.mark).toBe('A');
    expect(doc.sections[1]!.mark).toBe('B');
  });

  it('reuses a mark freed by a deletion', () => {
    // A set with sections A, B and D in it invites everybody to go looking
    // for C.
    const doc = house();
    addSection(doc, { x: -1, z: 2 }, { x: 13, z: 2 });
    addSection(doc, { x: -1, z: 4 }, { x: 13, z: 4 });
    removeSection(doc, doc.sections[0]!.id);

    expect(nextMark(doc)).toBe('A');
  });

  it('turns an automatic cut into a hand-drawn one when it is dragged', () => {
    const doc = house();
    refreshPresets(doc);
    const preset = doc.sections[0]!;
    expect(preset.automatic).toBe(true);

    moveSectionEnd(doc, preset.id, 'from', { x: -3, z: 1 });
    expect(doc.sections[0]!.automatic).toBe(false);

    // And it now survives a rebuild.
    refreshPresets(doc);
    expect(doc.sections.some((section) => section.id === preset.id)).toBe(true);
  });

  it('refuses to drag one end onto the other', () => {
    const doc = house();
    const id = addSection(doc, { x: -1, z: 2 }, { x: 13, z: 2 })!;
    moveSectionEnd(doc, id, 'from', { x: 13, z: 2 });

    expect(doc.sections[0]!.from.x).toBeCloseTo(-1, 6);
  });

  it('slides a whole cut without changing its direction', () => {
    const doc = house();
    const id = addSection(doc, { x: -1, z: 2 }, { x: 13, z: 2 })!;
    moveSection(doc, id, { x: 0, z: 3 });

    const section = doc.sections[0]!;
    expect(section.from.z).toBeCloseTo(5, 6);
    expect(section.to.z).toBeCloseTo(5, 6);
    expect(section.to.x - section.from.x).toBeCloseTo(14, 6);
  });

  it('flips which way it looks', () => {
    const doc = house();
    const id = addSection(doc, { x: -1, z: 2 }, { x: 13, z: 2 })!;
    expect(doc.sections[0]!.looks).toBe('left');

    flipSection(doc, id);
    expect(doc.sections[0]!.looks).toBe('right');
  });
});

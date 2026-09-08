/**
 * Tests for the exterior takeoff.
 *
 * These are the numbers somebody would price a job from, so what is checked is
 * that they are measured the way a builder measures: wall area net of its
 * openings, roof by the slope and not the plan, and every total carrying the
 * label that says it is an estimate rather than a quote.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument, defaultRoofFor } from '@/state/defaults';
import { addOpening, addRectangle, normalizePlan } from '@/state/planOps';
import type { DesignDocument } from '@/state/types';

import { claddingAreaOf, exteriorTakeoff, gableAreaOf, roofLineLengths } from './exterior';
import { roofGeometry } from './roof';

function house(width = 12, depth = 8, height = 2.6): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  level.wallHeight = height;
  level.plan.defaultWallThickness = 0.2;
  level.plan.defaultWallHeight = height;
  addRectangle(level.plan, { x: 0, z: 0 }, width, depth);
  normalizePlan(level.plan);
  return doc;
}

describe('how much wall there is to clad', () => {
  it('measures the outside walls, and only those', () => {
    const doc = house(12, 8);
    // 2 x (12 + 8) of centreline at 2.6 high.
    expect(claddingAreaOf(doc.levels[0]!)).toBeCloseTo(40 * 2.6, 6);
  });

  it('leaves out the doors and windows', () => {
    const doc = house(12, 8);
    const level = doc.levels[0]!;
    const wall = level.plan.walls[0]!;
    addOpening(
      level.plan,
      wall.id,
      'window',
      'casement-single',
      { width: 1.2, height: 1.4, sillHeight: 0.9 },
      2,
    );

    const opening = level.plan.walls.find((w) => w.id === wall.id)!.openings[0]!;
    expect(claddingAreaOf(level)).toBeCloseTo(40 * 2.6 - opening.width * opening.height, 6);
  });

  it('does not count an interior partition', () => {
    const doc = house(12, 8);
    const level = doc.levels[0]!;
    const before = claddingAreaOf(level);

    // A room drawn well inside the house: every wall of it is interior, so
    // none of it is clad. Drawn 6 x 4 rather than 6 x 8 on purpose — a 6 x 8
    // would put its own two long walls exactly on top of the house's, which is
    // a different situation entirely and not what this test is about.
    addRectangle(level.plan, { x: 0, z: 0 }, 6, 4);
    normalizePlan(level.plan);

    expect(claddingAreaOf(level)).toBeCloseTo(before, 6);
  });
});

describe('gable ends', () => {
  it('counts the triangle above the eaves as wall', () => {
    const doc = house(12, 8);
    const geometry = roofGeometry(doc, {
      ...defaultRoofFor(doc.levels[0]!.id),
      kind: 'gable',
      pitch: 0.5,
      overhang: 0.4,
    })!;

    // Eave outline is 13 x 9, so each gable is a triangle 9 wide and 2.25 high.
    expect(gableAreaOf(geometry)).toBeCloseTo(2 * (9 * 2.25) / 2, 4);
  });

  it('is nothing on a hip, which has no gable ends at all', () => {
    const doc = house(12, 8);
    const geometry = roofGeometry(doc, { ...defaultRoofFor(doc.levels[0]!.id), kind: 'hip' })!;
    expect(gableAreaOf(geometry)).toBe(0);
  });
});

describe('roof lines', () => {
  it('measures the eave all the way round, and the ridge along the top', () => {
    const doc = house(12, 8);
    const geometry = roofGeometry(doc, {
      ...defaultRoofFor(doc.levels[0]!.id),
      kind: 'gable',
      pitch: 0.5,
      overhang: 0.4,
    })!;

    const lengths = roofLineLengths(geometry);
    // Two eaves of 13 m; the two gable ends are rakes, not eaves.
    expect(lengths.eave).toBeCloseTo(26, 4);
    expect(lengths.ridge).toBeCloseTo(13, 4);
  });

  it('measures a gable rake up the slope, not along the bottom of the gable', () => {
    const doc = house(12, 8);
    const geometry = roofGeometry(doc, {
      ...defaultRoofFor(doc.levels[0]!.id),
      kind: 'gable',
      pitch: 0.5,
      overhang: 0.4,
    })!;

    // Four rakes — two per gable end — each running 4.5 m in plan from the
    // eave corner to the apex and climbing 2.25 with it. The horizontal line
    // at the bottom of a gable is neither an eave nor a rake: nothing is
    // fitted along it, and counting it would sell somebody the wrong timber.
    const lengths = roofLineLengths(geometry);
    expect(lengths.rake).toBeCloseTo(4 * Math.hypot(4.5, 2.25), 4);
    expect(lengths.eave).toBeCloseTo(26, 4);
  });

  it('measures a hip along the slope, not across the plan', () => {
    const doc = house(12, 8);
    const geometry = roofGeometry(doc, {
      ...defaultRoofFor(doc.levels[0]!.id),
      kind: 'hip',
      pitch: 0.5,
      overhang: 0.4,
    })!;

    const lengths = roofLineLengths(geometry);
    // Each hip runs 4.5 m in plan diagonally and climbs 2.25: longer than
    // either. Four of them.
    const planRun = Math.hypot(4.5, 4.5);
    expect(lengths.hip).toBeCloseTo(4 * Math.hypot(planRun, 2.25), 3);
  });
});

describe('the takeoff', () => {
  it('prices the cladding and the roof, and says they are estimates', () => {
    const doc = house(12, 8);
    doc.roofs = [{ ...defaultRoofFor(doc.levels[0]!.id), kind: 'gable', pitch: 0.5 }];

    const takeoff = exteriorTakeoff(doc);
    const claddingLine = takeoff.lines.find((line) => line.id === 'cladding')!;
    const roofLine = takeoff.lines.find((line) => line.id.startsWith('roof-'))!;

    expect(claddingLine.basis).toBe('estimate');
    expect(claddingLine.quantity).toBeGreaterThan(40 * 2.6);
    expect(roofLine.basis).toBe('estimate');
    // Measured on the slope: more than the plan area under it.
    expect(roofLine.quantity).toBeGreaterThan(13 * 9);
  });

  it('never lets an unpriced line make the total look complete', () => {
    const doc = house(12, 8);
    doc.roofs = [defaultRoofFor(doc.levels[0]!.id)];

    const takeoff = exteriorTakeoff(doc);
    // The fascia has no rate, so the whole takeoff is labelled 'unknown' — a
    // total that is missing a line has to say so.
    expect(takeoff.lines.some((line) => line.total === null)).toBe(true);
    expect(takeoff.basis).toBe('unknown');
    expect(takeoff.total).toBeGreaterThan(0);
  });

  it('works on a building with no roof yet', () => {
    const doc = house(8, 6);
    const takeoff = exteriorTakeoff(doc);

    expect(takeoff.roofArea).toBe(0);
    expect(takeoff.claddingArea).toBeCloseTo(28 * 2.6, 6);
  });
});

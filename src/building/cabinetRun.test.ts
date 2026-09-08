/**
 * Tests for filling a run.
 *
 * The interesting property is not "does it produce units" — it is that the
 * units ADD UP: the widths plus the fillers must equal the run's length
 * exactly, on every length, or the kitchen either overhangs the wall or leaves
 * a gap nobody drew. That is checked by walking lengths in millimetre steps
 * rather than by picking a few convenient ones.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CARCASS, WORKTOP, fillerFor, getModule, widthsOfKind } from '@/fittings/modules';
import type { CabinetRun, Point2 } from '@/state/types';

import {
  counterLines,
  fillRun,
  resetUnitIds,
  runGeometry,
  runLength,
  runSegments,
  solveWidths,
} from './cabinetRun';

beforeEach(() => resetUnitIds());

/** A straight run along +x, starting at the origin. */
const straight = (length: number): Point2[] => [
  { x: 0, z: 0 },
  { x: length, z: 0 },
];

/** An L: along +x, then along +z. */
const elbow = (a: number, b: number): Point2[] => [
  { x: 0, z: 0 },
  { x: a, z: 0 },
  { x: a, z: b },
];

function runOf(path: Point2[], kind: 'base' | 'wall' | 'tall' = 'base'): CabinetRun {
  return {
    id: 'run1',
    levelId: 'lv1',
    path,
    kind,
    units: fillRun(path, kind),
    worktop:
      kind === 'base' ? { material: 'laminate', colour: '#d9d2c6', splashback: true } : null,
    finishId: 'white',
  };
}

/* -------------------------------- Widths ---------------------------------- */

describe('choosing widths', () => {
  it('fills a length exactly when the widths allow it', () => {
    // 3.05 m is 1000 + 1000 + 600 + 450. Greedy takes three 1000s and leaves
    // 50 mm of blank panel in the middle of the kitchen.
    const result = solveWidths(3.05, widthsOfKind('base'));
    expect(result.covered).toBeCloseTo(3.05, 6);
    expect(result.widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(3.05, 6);
  });

  it('leaves as little as possible when it cannot fill exactly', () => {
    // Nothing is narrower than 200 mm, so 150 mm of wall is all filler.
    expect(solveWidths(0.15, widthsOfKind('base')).covered).toBe(0);
    // And 3.13 m can be covered to within one 5 mm step of itself.
    expect(3.13 - solveWidths(3.13, widthsOfKind('base')).covered).toBeLessThanOrEqual(0.03);
  });

  it('returns the widest units first, so a run reads as a few big cupboards', () => {
    const result = solveWidths(2.4, widthsOfKind('base'));
    for (let i = 1; i < result.widths.length; i++) {
      expect(result.widths[i]!).toBeLessThanOrEqual(result.widths[i - 1]!);
    }
  });

  it('gives nothing back for nothing', () => {
    expect(solveWidths(0, widthsOfKind('base')).widths).toEqual([]);
    expect(solveWidths(-1, widthsOfKind('base')).widths).toEqual([]);
  });
});

/* ------------------------------- Filling ---------------------------------- */

describe('filling a run', () => {
  it('adds up to the length of the run, at every length', () => {
    for (let length = 0.2; length <= 6; length += 0.011) {
      const units = fillRun(straight(length), 'base');
      const total = units.reduce((sum, unit) => sum + unit.width, 0);
      expect(total).toBeCloseTo(length, 6);
    }
  });

  it('never overlaps two units', () => {
    const units = fillRun(straight(4.37), 'base');
    for (let i = 1; i < units.length; i++) {
      expect(units[i]!.offset).toBeCloseTo(units[i - 1]!.offset + units[i - 1]!.width, 6);
    }
  });

  it('puts the leftover at the ends, not in the middle', () => {
    // 2.63 m: 2600 of modules and 30 mm over, which becomes 15 mm at each end.
    const units = fillRun(straight(2.63), 'base');
    const fillerId = fillerFor('base').id;
    const fillers = units.filter((unit) => unit.moduleId === fillerId);

    expect(fillers.length).toBeGreaterThan(0);
    for (const unit of fillers) {
      const atStart = unit.offset < 1e-6;
      const atEnd = unit.offset + unit.width > 2.63 - 1e-6;
      expect(atStart || atEnd).toBe(true);
    }
  });

  it('is one blank panel when the wall is too short for any cupboard', () => {
    const units = fillRun(straight(0.15), 'base');
    expect(units).toHaveLength(1);
    expect(getModule(units[0]!.moduleId)?.front).toBe('filler');
  });

  it('puts the modules it was told to put in, in the order asked', () => {
    const units = fillRun(straight(4), 'base', {
      required: ['base-600-sink', 'base-600-hob'],
    });
    const ids = units.map((unit) => unit.moduleId);
    expect(ids.indexOf('base-600-sink')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('base-600-hob')).toBeGreaterThan(ids.indexOf('base-600-sink'));
    expect(units.reduce((sum, unit) => sum + unit.width, 0)).toBeCloseTo(4, 6);
  });

  it('puts an anchored module where it was asked for', () => {
    // "The sink goes under the window" — the window is at 2.4 m along.
    const units = fillRun(straight(5), 'base', {
      anchored: [{ moduleId: 'base-800-sink', at: 2.4 }],
    });

    const sink = units.find((unit) => unit.moduleId === 'base-800-sink')!;
    expect(sink.offset + sink.width / 2).toBeCloseTo(2.4, 2);
    expect(units.reduce((sum, unit) => sum + unit.width, 0)).toBeCloseTo(5, 6);
  });

  it('pushes two anchors apart rather than overlapping them', () => {
    const units = fillRun(straight(5), 'base', {
      anchored: [
        { moduleId: 'base-800-sink', at: 2.0 },
        { moduleId: 'base-600-hob', at: 2.2 },
      ],
    });

    const sink = units.find((unit) => unit.moduleId === 'base-800-sink')!;
    const hob = units.find((unit) => unit.moduleId === 'base-600-hob')!;
    expect(hob.offset).toBeGreaterThanOrEqual(sink.offset + sink.width - 1e-6);
    expect(units.reduce((sum, unit) => sum + unit.width, 0)).toBeCloseTo(5, 6);
  });

  it('slides an anchor inside the run rather than hanging it off the end', () => {
    const units = fillRun(straight(2), 'base', {
      anchored: [{ moduleId: 'base-800-sink', at: 1.9 }],
    });
    const sink = units.find((unit) => unit.moduleId === 'base-800-sink')!;
    expect(sink.offset + sink.width).toBeLessThanOrEqual(2 + 1e-6);
    expect(units.reduce((sum, unit) => sum + unit.width, 0)).toBeCloseTo(2, 6);
  });

  it('drops a required module that will not fit rather than overrunning', () => {
    const units = fillRun(straight(0.5), 'base', { required: ['base-1000-double'] });
    expect(units.some((unit) => unit.moduleId === 'base-1000-double')).toBe(false);
    expect(units.reduce((sum, unit) => sum + unit.width, 0)).toBeCloseTo(0.5, 6);
  });
});

/* -------------------------------- Corners --------------------------------- */

describe('turning a corner', () => {
  it('puts exactly one corner unit at the vertex of an L', () => {
    const units = fillRun(elbow(3, 3), 'base');
    const corners = units.filter((unit) => getModule(unit.moduleId)?.front === 'corner');
    expect(corners).toHaveLength(1);
  });

  it('still adds up, with the corner taking a bite out of both legs', () => {
    const path = elbow(3, 2.5);
    const units = fillRun(path, 'base');
    expect(units.reduce((sum, unit) => sum + unit.width, 0)).toBeCloseTo(runLength(path), 6);
  });

  it('leaves no cupboard where the corner unit is', () => {
    // The whole point: two runs meeting would otherwise both fill the same
    // square, and neither door would open.
    const units = fillRun(elbow(3, 3), 'base');
    const corner = units.find((unit) => getModule(unit.moduleId)?.front === 'corner')!;
    const cornerEnd = corner.offset + corner.width;

    for (const unit of units) {
      if (unit === corner) continue;
      const overlaps = unit.offset < cornerEnd - 1e-6 && unit.offset + unit.width > corner.offset + 1e-6;
      expect(overlaps).toBe(false);
    }
  });

  it('can be told not to turn the corner at all', () => {
    const units = fillRun(elbow(3, 3), 'base', { corners: false });
    expect(units.some((unit) => getModule(unit.moduleId)?.front === 'corner')).toBe(false);
  });
});

/* ------------------------------- Geometry --------------------------------- */

describe('placing what fills it', () => {
  it('stands every unit on the run, facing into the room', () => {
    const run = runOf(straight(3.6));
    const geometry = runGeometry(run);

    expect(geometry.units.length).toBe(run.units.length);
    for (const placed of geometry.units) {
      // The path runs along +x, so its anticlockwise normal is +z and the
      // units stand at half their depth in front of it.
      expect(placed.at.z).toBeCloseTo(CARCASS.base.depth / 2, 6);
      expect(placed.polygons[0]).toHaveLength(4);
    }
  });

  it('gives a corner unit two footprints, one on each leg', () => {
    const geometry = runGeometry(runOf(elbow(3, 3)));
    const corner = geometry.units.find((placed) => placed.module.front === 'corner')!;
    expect(corner.polygons).toHaveLength(2);
  });

  it('lays a worktop over a base run and none over a wall run', () => {
    const base = runGeometry(runOf(straight(3)));
    expect(base.worktop).toHaveLength(1);
    expect(base.worktopArea).toBeCloseTo(3 * WORKTOP.depth, 6);

    const wall = runGeometry(runOf(straight(3), 'wall'));
    expect(wall.worktop).toEqual([]);
    expect(wall.worktopArea).toBe(0);
  });

  it('does not charge for the corner of a worktop twice', () => {
    const geometry = runGeometry(runOf(elbow(3, 3)));
    const naive = 6 * WORKTOP.depth;
    expect(geometry.worktopArea).toBeCloseTo(naive - WORKTOP.depth * WORKTOP.depth, 6);
  });

  it('reports the counter line the six-foot rule is measured along', () => {
    const lines = counterLines(runOf(straight(3)));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeCloseTo(3, 6);
    // Down the middle of the worktop, not along the wall.
    expect(lines[0]!.from.z).toBeCloseTo(WORKTOP.depth / 2, 6);
  });

  it('has nothing to say about a run with no length', () => {
    expect(runSegments([{ x: 1, z: 1 }, { x: 1, z: 1 }])).toEqual([]);
    expect(fillRun([{ x: 0, z: 0 }], 'base')).toEqual([]);
  });
});

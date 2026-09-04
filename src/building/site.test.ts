/**
 * Tests for the ground and the plot.
 *
 * Terrain is the kind of thing that looks right and is wrong by a sign: a slope
 * that falls uphill, a north point ninety degrees out, a cut volume that is
 * really a fill. Every test here pins a direction as well as a magnitude.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument, defaultSite } from '@/state/defaults';
import { addRectangle, normalizePlan } from '@/state/planOps';
import type { Level, Site } from '@/state/types';

import {
  bearingOf,
  buildableArea,
  compassPoint,
  earthworks,
  facingOf,
  groundHeightAt,
  groundSlopeAt,
  lotCoverage,
  plotArea,
} from './site';

function levelWith(width: number, depth: number): Level {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  level.plan.defaultWallThickness = 0.2;
  addRectangle(level.plan, { x: 0, z: 0 }, width, depth);
  normalizePlan(level.plan);
  return level;
}

function siteWith(changes: Partial<Site>): Site {
  return { ...defaultSite(), ...changes };
}

describe('the ground surface', () => {
  it('is the datum everywhere when it is flat', () => {
    const site = siteWith({ terrain: { ...defaultSite().terrain, datum: -0.3 } });
    expect(groundHeightAt(site, { x: 0, z: 0 })).toBeCloseTo(-0.3, 9);
    expect(groundHeightAt(site, { x: 40, z: -20 })).toBeCloseTo(-0.3, 9);
  });

  it('falls in the direction it says it falls, not the other way', () => {
    // Falling due +X at 1 in 10, from a datum of zero at the origin.
    const site = siteWith({
      terrain: { kind: 'slope', fall: 0.1, fallDirection: 0, spots: [], datum: 0 },
    });

    expect(groundHeightAt(site, { x: 10, z: 0 })).toBeCloseTo(-1, 9);
    expect(groundHeightAt(site, { x: -10, z: 0 })).toBeCloseTo(1, 9);
    // Across the fall, nothing changes.
    expect(groundHeightAt(site, { x: 0, z: 10 })).toBeCloseTo(0, 9);
  });

  it('reads its own slope back', () => {
    const site = siteWith({
      terrain: { kind: 'slope', fall: 0.1, fallDirection: Math.PI / 2, spots: [], datum: 0 },
    });

    const measured = groundSlopeAt(site, { x: 3, z: 3 });
    expect(measured.fall).toBeCloseTo(0.1, 6);
    expect(Math.cos(measured.direction - Math.PI / 2)).toBeCloseTo(1, 6);
  });

  it('honours a surveyed height exactly, and blends between them', () => {
    const site = siteWith({
      terrain: {
        kind: 'spots',
        fall: 0,
        fallDirection: 0,
        datum: 0,
        spots: [
          { id: 'a', at: { x: -10, z: 0 }, height: 0 },
          { id: 'b', at: { x: 10, z: 0 }, height: 2 },
        ],
      },
    });

    // A measurement is not something to interpolate over.
    expect(groundHeightAt(site, { x: -10, z: 0 })).toBeCloseTo(0, 9);
    expect(groundHeightAt(site, { x: 10, z: 0 })).toBeCloseTo(2, 9);
    // Halfway between two equal weights is the average.
    expect(groundHeightAt(site, { x: 0, z: 0 })).toBeCloseTo(1, 6);
    // And it is monotonic between them, which is the least an interpolation owes.
    expect(groundHeightAt(site, { x: 5, z: 0 })).toBeGreaterThan(
      groundHeightAt(site, { x: -5, z: 0 }),
    );
  });

  it('falls back to the datum when nobody has surveyed anything', () => {
    const site = siteWith({
      terrain: { kind: 'spots', fall: 0, fallDirection: 0, datum: -0.5, spots: [] },
    });
    expect(groundHeightAt(site, { x: 1, z: 1 })).toBeCloseTo(-0.5, 9);
  });
});

describe('the plot', () => {
  const square: Site = siteWith({
    boundary: [
      { x: -10, z: -10 },
      { x: 10, z: -10 },
      { x: 10, z: 10 },
      { x: -10, z: 10 },
    ],
  });

  it('measures its area', () => {
    expect(plotArea(square)).toBeCloseTo(400, 6);
    expect(plotArea(defaultSite())).toBe(0);
  });

  it('is entirely buildable until setbacks are entered', () => {
    expect(buildableArea(square)).toHaveLength(4);
    expect(Math.abs(shoelace(buildableArea(square)))).toBeCloseTo(400, 6);
  });

  it("pulls the buildable area in by each edge's own setback", () => {
    const withSetbacks: Site = {
      ...square,
      setbacks: { front: 6, rear: 4, side: 2, frontAt: { x: 0, z: -10 } },
    };

    const area = buildableArea(withSetbacks);
    const xs = area.map((point) => point.x);
    const zs = area.map((point) => point.z);

    // Sides pulled in 2 each: 16 wide. Front 6 and rear 4: 10 deep.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(16, 6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(10, 6);
    // And the front is the edge the user pointed at, so the deeper bite is
    // taken from the -z side.
    expect(Math.min(...zs)).toBeCloseTo(-4, 6);
  });

  it('reports a plot that its own setbacks have eaten', () => {
    // The trap here: pulling all four sides of a square in past the middle
    // gives a smaller square with a perfectly respectable positive area. Area
    // cannot detect it; the direction each edge now runs in can.
    const impossible: Site = {
      ...square,
      setbacks: { front: 15, rear: 15, side: 15, frontAt: { x: 0, z: -10 } },
    };
    // Not a failure: some plots genuinely cannot be built on.
    expect(buildableArea(impossible)).toEqual([]);
  });

  it('works out lot coverage from the walls', () => {
    const level = levelWith(10, 8);
    // 80 square metres of building on 400 of plot.
    expect(lotCoverage(square, level)).toBeCloseTo(0.2, 6);
    expect(lotCoverage(defaultSite(), level)).toBe(0);
  });
});

describe('earthworks', () => {
  it('is nothing at all on flat ground at the pad level', () => {
    const level = levelWith(10, 8);
    const result = earthworks(defaultSite(), level);

    expect(result.cut).toBeCloseTo(0, 6);
    expect(result.fill).toBeCloseTo(0, 6);
    expect(result.area).toBeCloseTo(80, 0);
  });

  it('cuts the high side and fills the low one, in the right proportions', () => {
    const level = levelWith(10, 8);
    const site = siteWith({
      terrain: { kind: 'slope', fall: 0.1, fallDirection: 0, spots: [], datum: 0 },
    });

    const result = earthworks(site, level);
    // Symmetrical about the origin, so cut and fill balance.
    expect(result.cut).toBeCloseTo(result.fill, 1);
    // Ground runs from +0.5 to -0.5 across the 10 m width.
    expect(result.highest).toBeCloseTo(0.5, 1);
    expect(result.lowest).toBeCloseTo(-0.5, 1);
    // Two triangular prisms: 2 x (1/2 x 5 x 0.5 x 8) = 20 cubic metres.
    expect(result.cut + result.fill).toBeCloseTo(20, 0);
  });

  it('is all fill when the whole plot is below the floor', () => {
    const level = levelWith(6, 6);
    const site = siteWith({ terrain: { ...defaultSite().terrain, datum: -1 } });

    const result = earthworks(site, level);
    expect(result.cut).toBeCloseTo(0, 6);
    expect(result.fill).toBeCloseTo(36, 0);
  });
});

describe('the compass', () => {
  it('reads +Z as north when north has not been turned', () => {
    const site = defaultSite();
    expect(bearingOf(site, { x: 0, z: 1 })).toBeCloseTo(0, 6);
    expect(bearingOf(site, { x: 1, z: 0 })).toBeCloseTo(90, 6);
    expect(bearingOf(site, { x: 0, z: -1 })).toBeCloseTo(180, 6);
    expect(bearingOf(site, { x: -1, z: 0 })).toBeCloseTo(270, 6);
  });

  it('turns everything when north is turned', () => {
    // North is now 90 degrees round, so world +Z points east.
    const site = siteWith({ northAngle: Math.PI / 2 });
    expect(bearingOf(site, { x: 0, z: 1 })).toBeCloseTo(90, 6);
    expect(facingOf(site, { x: 0, z: 1 })).toBe('E');
  });

  it('names the sixteen points', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(45)).toBe('NE');
    expect(compassPoint(202.5)).toBe('SSW');
    expect(compassPoint(359)).toBe('N');
  });

  it('tells a designer which way a wall faces', () => {
    const site = defaultSite();
    // South-facing glazing is the whole point of asking.
    expect(facingOf(site, { x: 0, z: -1 })).toBe('S');
  });
});

function shoelace(polygon: readonly { x: number; z: number }[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const here = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    sum += here.x * next.z - next.x * here.z;
  }
  return sum / 2;
}

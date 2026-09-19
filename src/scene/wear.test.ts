/**
 * Wear is placed by what happens to a place, so what is checked is placement:
 * the right value in the right spot, and — the part that was wrong — NO value
 * where nothing has happened.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { GRIME_DEPTH, SCUFF_HEIGHT, computeWear } from './wear';

/**
 * A strip of vertices at given heights, with a given sky visibility each.
 *
 * Built by hand rather than by baking, so the input to the rule is exactly what
 * the test says it is.
 */
function surface(points: { y: number; sky: number }[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const baked: number[] = [];
  points.forEach((point, index) => {
    positions.push(index * 0.25, point.y, 0);
    baked.push(point.sky);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('bakedAmbient', new THREE.Float32BufferAttribute(baked, 1));
  return geometry;
}

const IDENTITY = new THREE.Matrix4();

describe('computeWear', () => {
  it('leaves a uniformly enclosed surface completely clean', () => {
    /*
     * The bug this rule was rewritten for. A ceiling in an enclosed room sees
     * almost no sky ANYWHERE, and an absolute threshold called all of it a
     * crevice: measured in the browser, the whole ceiling came back at 0.78
     * grime — uniformly twelve per cent darker and a quarter rougher, which is
     * not a dirty ceiling but a differently painted one.
     *
     * Dirt is local. A surface that is dark everywhere has no crevices.
     */
    const ceiling = surface(
      Array.from({ length: 12 }, () => ({ y: 2.4, sky: 0.012 })),
    );
    const wear = computeWear(ceiling, IDENTITY, { floorY: 0, walked: false })!;

    for (const value of wear) expect(Math.abs(value)).toBeLessThan(0.001);
  });

  it('finds the crevice on a surface that has one', () => {
    // Open across most of it, with two points tucked into a corner.
    const wall = surface([
      { y: 1.5, sky: 0.5 },
      { y: 1.5, sky: 0.5 },
      { y: 1.5, sky: 0.5 },
      { y: 1.5, sky: 0.5 },
      { y: 1.5, sky: 0.05 },
      { y: 1.5, sky: 0.05 },
    ]);
    const wear = computeWear(wall, IDENTITY, { floorY: 0, walked: false })!;

    expect(wear[0]!).toBeLessThan(0.05);
    expect(wear[4]!).toBeGreaterThan(0.5);
  });

  it('scuffs a wall at shin height and nowhere above it', () => {
    const wall = surface([
      { y: 0.05, sky: 0.45 },
      { y: 0.3, sky: 0.45 },
      { y: 1.2, sky: 0.45 },
      { y: 2.2, sky: 0.45 },
    ]);
    const wear = computeWear(wall, IDENTITY, { floorY: 0, walked: false })!;

    expect(wear[0]!).toBeGreaterThan(wear[1]!);
    expect(wear[1]!).toBeGreaterThan(wear[2]!);
    expect(wear[2]!).toBeCloseTo(0, 3);
    expect(wear[3]!).toBeCloseTo(0, 3);
  });

  it('measures the scuff band from the storey, not from the world origin', () => {
    /*
     * An upstairs wall is four metres above the ground and its skirting is
     * still at its own floor. Measuring from zero would put the scuffs in the
     * ceiling of the room below.
     */
    const wall = surface([
      { y: 4.05, sky: 0.45 },
      { y: 5.2, sky: 0.45 },
    ]);
    const wear = computeWear(wall, IDENTITY, { floorY: 4, walked: false })!;

    expect(wear[0]!).toBeGreaterThan(0.3);
    expect(wear[1]!).toBeCloseTo(0, 3);
  });

  it('polishes a floor where it is walked and dirties it where it is not', () => {
    const floor = surface([
      { y: 0, sky: 0.08 },
      { y: 0, sky: 0.3 },
      { y: 0, sky: 0.3 },
      { y: 0, sky: 0.55 },
    ]);
    const wear = computeWear(floor, IDENTITY, { floorY: 0, walked: true })!;

    // The middle of the room, which sees the most sky, is burnished.
    expect(wear[3]!).toBeLessThan(0);
    // The edge against a skirting, which a hoover does not reach, is not.
    expect(wear[0]!).toBeGreaterThan(0);
  });

  it('does not scuff a floor, which gets walked on instead', () => {
    // Everything on a floor is at shin height by definition; treating that as a
    // scuff band would put a kick mark over every square metre of it.
    const floor = surface([
      { y: 0, sky: 0.4 },
      { y: 0, sky: 0.4 },
      { y: 0, sky: 0.4 },
    ]);
    const wear = computeWear(floor, IDENTITY, { floorY: 0, walked: true })!;
    for (const value of wear) expect(value).toBeLessThanOrEqual(0);
  });

  it('stays inside the range the shader expects', () => {
    const wild = surface([
      { y: 0, sky: 0 },
      { y: 0.01, sky: 0 },
      { y: 3, sky: 1 },
      { y: -5, sky: 1 },
    ]);
    for (const walked of [false, true]) {
      const wear = computeWear(wild, IDENTITY, { floorY: 0, walked })!;
      for (const value of wear) {
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('says nothing about a surface that has not been baked', () => {
    // Without knowing what can reach a point there is nothing to say about what
    // settles on it, and a guess would be worse than silence.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    expect(computeWear(geometry, IDENTITY, { floorY: 0, walked: false })).toBeNull();
  });

  it('keeps the effect at lived-in rather than derelict', () => {
    // Everything past about a fifth reads as damp rather than as dust.
    expect(GRIME_DEPTH).toBeLessThan(0.2);
    expect(GRIME_DEPTH).toBeGreaterThan(0);
    expect(SCUFF_HEIGHT).toBeGreaterThan(0.2);
    expect(SCUFF_HEIGHT).toBeLessThan(0.7);
  });
});

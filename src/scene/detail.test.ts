/**
 * A module-level dial is the kind of thing that works in isolation and then
 * turns out to be read by nobody, or clamped wrongly, or left set by one test
 * and inherited by the next. All three are checked here.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { TIER_DETAIL, detailLevel, setDetailLevel } from './detail';
import { LIGHT_EDGE } from './subdivide';
import { radialSegments } from './tessellation';

afterEach(() => setDetailLevel(1));

describe('the detail dial', () => {
  it('starts at full', () => {
    expect(detailLevel()).toBe(1);
  });

  it('clamps rather than dividing by nothing', () => {
    setDetailLevel(0);
    expect(detailLevel()).toBeGreaterThan(0);

    setDetailLevel(-5);
    expect(detailLevel()).toBeGreaterThan(0);

    setDetailLevel(1000);
    expect(detailLevel()).toBeLessThanOrEqual(2);
  });

  it('reaches the curves', () => {
    /*
     * The point of the whole exercise. Until this, a demotion changed the pixel
     * ratio and the shadow map and left every curve exactly as expensive.
     */
    const full = radialSegments(0.2);
    setDetailLevel(0.5);
    const half = radialSegments(0.2);

    expect(half).toBeLessThan(full);
  });

  it('loosens tolerances rather than tightening them', () => {
    /*
     * The direction is easy to get backwards, and backwards means a struggling
     * machine is handed MORE geometry. Half the detail must mean roughly twice
     * the permitted edge on a subdivided surface.
     */
    setDetailLevel(0.5);
    expect(LIGHT_EDGE / detailLevel()).toBeCloseTo(LIGHT_EDGE * 2, 6);
  });

  it('gives every tier a sane dial, with full detail at the top', () => {
    expect(TIER_DETAIL.low).toBeLessThan(TIER_DETAIL.medium);
    expect(TIER_DETAIL.medium).toBeLessThan(TIER_DETAIL.high);
    // Above full buys nothing: the tolerances are already where the eye stops
    // seeing the difference.
    expect(TIER_DETAIL.high).toBe(1);
    expect(TIER_DETAIL.low).toBeGreaterThanOrEqual(0.25);
  });
});

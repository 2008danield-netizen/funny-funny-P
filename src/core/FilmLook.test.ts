/**
 * A full-screen shader cannot be run without a GL context, so what is checked
 * here is the seam rather than the arithmetic: the names the pipeline writes
 * to, and the strengths the effect is set at.
 *
 * That is not a consolation prize. Twice this session a pass has been wired up
 * and had no effect, and both times the symptom was indistinguishable from "the
 * effect is subtle". A uniform renamed in one file and set in another is
 * exactly that failure, and it is the one a test can catch.
 */

import { describe, expect, it } from 'vitest';

import {
  BLOOM_RADIUS,
  BLOOM_STRENGTH,
  BLOOM_THRESHOLD,
  FilmLookShader,
  GRAIN_AMOUNT,
  VIGNETTE_AMOUNT,
} from './FilmLook';

describe('FilmLookShader', () => {
  it('declares every uniform the pipeline writes to', () => {
    // RenderPipeline sets `aspect` and `seed` by name. A rename here would
    // leave both writing to nothing, silently.
    for (const name of ['tDiffuse', 'grain', 'vignette', 'seed', 'aspect']) {
      expect(FilmLookShader.uniforms).toHaveProperty(name);
    }
  });

  it('starts at the strengths the constants declare', () => {
    expect(FilmLookShader.uniforms.grain.value).toBe(GRAIN_AMOUNT);
    expect(FilmLookShader.uniforms.vignette.value).toBe(VIGNETTE_AMOUNT);
  });

  it('uses every uniform it declares', () => {
    /*
     * The other half of the same failure: a uniform that exists, is written to,
     * and is never read. `aspect` in particular is easy to leave out of the
     * shader body, and its absence shows only as a vignette that darkens a band
     * across a wide window instead of shading its corners.
     */
    for (const name of Object.keys(FilmLookShader.uniforms)) {
      expect(FilmLookShader.fragmentShader).toContain(name);
    }
  });

  it('keeps the grain out of the highlights', () => {
    // Real sensor noise lives in the shadows. Applying it flat puts speckle on
    // a bright window, which no camera records.
    expect(FilmLookShader.fragmentShader).toContain('luma');
  });
});

describe('the strengths', () => {
  it('blooms only what is genuinely over-bright', () => {
    /*
     * A threshold well below 1 makes ordinary lit surfaces bleed, which reads
     * as a smeared lens rather than as light. Above 1 nothing ever blooms,
     * because the tone mapping has already brought the frame under one.
     */
    expect(BLOOM_THRESHOLD).toBeGreaterThan(0.7);
    expect(BLOOM_THRESHOLD).toBeLessThan(1);
  });

  it('keeps every effect at camera strength rather than demo strength', () => {
    // Each of these is the cheapest possible way to make a picture worse if
    // turned up. The numbers are roughly what a decent camera actually does.
    expect(BLOOM_STRENGTH).toBeLessThan(0.4);
    expect(BLOOM_RADIUS).toBeGreaterThan(0);
    expect(BLOOM_RADIUS).toBeLessThanOrEqual(1);
    expect(GRAIN_AMOUNT).toBeLessThan(0.05);
    expect(GRAIN_AMOUNT).toBeGreaterThan(0);
    expect(VIGNETTE_AMOUNT).toBeLessThan(0.35);
    expect(VIGNETTE_AMOUNT).toBeGreaterThan(0);
  });
});

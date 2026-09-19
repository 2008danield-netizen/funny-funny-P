/**
 * There are no images to test, which is the point. What is tested is the gate:
 * that a texture set with unrecorded terms cannot be registered, because that
 * is how the mistake actually happens — not by anybody deciding to take
 * something, but by a file arriving in a folder and being forgotten about by
 * the time anyone asks.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearPhotographed,
  photographedMaterials,
  registerPhotographed,
  requiredAttributions,
  type TextureSet,
} from './photographed';

afterEach(() => clearPhotographed());

function good(): TextureSet {
  return {
    tileMetres: 2,
    albedo: '/textures/oak/albedo.jpg',
    licence: {
      spdx: 'CC0-1.0',
      source: 'https://example.invalid/oak-scan',
      attribution: null,
      verifiedAt: '2026-09-19',
    },
  };
}

describe('registerPhotographed', () => {
  it('accepts a set that says who owns it and on what terms', () => {
    expect(registerPhotographed('oak', good()).ok).toBe(true);
    expect(photographedMaterials()).toHaveLength(1);
  });

  it('refuses a set with no licence', () => {
    const set = good();
    set.licence.spdx = '';
    const result = registerPhotographed('oak', set);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('no-licence');
  });

  it('refuses a set that does not say where it came from', () => {
    const set = good();
    set.licence.source = '   ';
    const result = registerPhotographed('oak', set);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('no-source');
  });

  it('distinguishes "no attribution needed" from "nobody looked"', () => {
    /*
     * The distinction this file exists for. `null` is an assertion that
     * somebody established none is required; `undefined` is silence, and
     * silence is what a forgotten file produces.
     */
    const decided = good();
    decided.licence.attribution = null;
    expect(registerPhotographed('decided', decided).ok).toBe(true);

    const silent = good();
    delete (silent.licence as { attribution?: string | null }).attribution;
    const result = registerPhotographed('silent', silent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('no-attribution-decision');
  });

  it('refuses a set that does not say what size it covers', () => {
    /*
     * There is no sensible default. This app's floors carry UVs in metres of
     * world space, so a scan of two metres of oak and a scan of a 600 mm tile
     * tile completely differently — and nothing about an image says which it
     * is.
     */
    for (const size of [0, -1, Number.NaN]) {
      const set = good();
      set.tileMetres = size;
      const result = registerPhotographed(`oak-${size}`, set);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe('no-scale');
    }
  });

  it('refuses to register the same id twice', () => {
    expect(registerPhotographed('oak', good()).ok).toBe(true);
    const again = registerPhotographed('oak', good());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe('duplicate');
  });

  it('collects the attribution lines that must actually be shown', () => {
    const free = good();
    free.licence.attribution = null;
    registerPhotographed('free', free);

    const credited = good();
    credited.licence.spdx = 'CC-BY-4.0';
    credited.licence.attribution = 'Oak scan by A. Photographer (CC BY 4.0)';
    registerPhotographed('credited', credited);

    expect(requiredAttributions()).toEqual(['Oak scan by A. Photographer (CC BY 4.0)']);
  });

  it('ships with nothing registered, so every material stays generated', () => {
    /*
     * The state this file is committed in. Photographed material is somebody's
     * work and using it in a product meant to be sold is a licensing decision
     * rather than a technical one, so the machinery is here and no images are.
     */
    expect(photographedMaterials()).toEqual([]);
    expect(requiredAttributions()).toEqual([]);
  });
});

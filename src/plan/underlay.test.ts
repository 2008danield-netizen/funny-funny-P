/**
 * Tests for placing a plan image.
 *
 * The mapping between pixels and metres is the foundation everything traced
 * sits on, and it is the kind of code that is wrong by a sign or by half an
 * image without looking wrong: a plan that is mirrored, or off by half its own
 * width, still renders as a plan. So these check the mapping both ways, at the
 * corners and the middle, rotated and not.
 */

import { describe, expect, it } from 'vitest';

import type { Point2, Underlay } from '@/state/types';

import {
  boundsOf,
  calibrateUnderlay,
  calibrationSpan,
  imageToWorld,
  isCalibrated,
  placeNewUnderlay,
  suggestAlignment,
  underlayBounds,
  underlayCorners,
  underlaySize,
  worldToImage,
} from './underlay';

/** A 1000 x 600 image at a centimetre to the pixel, centred on the origin. */
function underlay(changes: Partial<Underlay> = {}): Underlay {
  return {
    imageId: 'img-1',
    pixelWidth: 1000,
    pixelHeight: 600,
    at: { x: 0, z: 0 },
    metresPerPixel: 0.01,
    rotation: 0,
    opacity: 0.5,
    locked: false,
    calibration: null,
    ...changes,
  };
}

const near = (a: Point2, b: Point2, digits = 9) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
};

describe('pixels to metres', () => {
  it('puts the middle of the image where the underlay is', () => {
    near(imageToWorld(underlay(), { x: 500, z: 300 }), { x: 0, z: 0 });
    near(imageToWorld(underlay({ at: { x: 3, z: -2 } }), { x: 500, z: 300 }), { x: 3, z: -2 });
  });

  it('puts the top-left corner up and to the left', () => {
    // 500 px left of centre at a centimetre each is 5 m; 300 px up is 3 m.
    near(imageToWorld(underlay(), { x: 0, z: 0 }), { x: -5, z: -3 });
    near(imageToWorld(underlay(), { x: 1000, z: 600 }), { x: 5, z: 3 });
  });

  it('is not mirrored', () => {
    // A point to the RIGHT in the image is to the right in the world, and one
    // FURTHER DOWN the image is further along +z. Getting either backwards
    // gives a plan that traces into a mirror-image house.
    const right = imageToWorld(underlay(), { x: 900, z: 300 });
    const down = imageToWorld(underlay(), { x: 500, z: 550 });
    expect(right.x).toBeGreaterThan(0);
    expect(down.z).toBeGreaterThan(0);
  });

  it('comes back to the same pixel', () => {
    for (const spot of [{ x: 0, z: 0 }, { x: 999, z: 1 }, { x: 250, z: 480 }]) {
      near(worldToImage(underlay(), imageToWorld(underlay(), spot)), spot, 6);
    }
  });

  it('round-trips through a rotation too', () => {
    const turned = underlay({ rotation: 0.7, at: { x: -4, z: 9 } });
    for (const spot of [{ x: 12, z: 34 }, { x: 780, z: 590 }]) {
      near(worldToImage(turned, imageToWorld(turned, spot)), spot, 6);
    }
  });

  it('turns the image about its own centre', () => {
    const turned = underlay({ rotation: Math.PI / 2 });
    // A quarter turn takes the right-hand edge of the image to +z.
    const edge = imageToWorld(turned, { x: 1000, z: 300 });
    expect(edge.x).toBeCloseTo(0, 6);
    expect(edge.z).toBeCloseTo(5, 6);
    // And the centre does not move.
    near(imageToWorld(turned, { x: 500, z: 300 }), { x: 0, z: 0 });
  });

  it('measures the image on the ground', () => {
    expect(underlaySize(underlay()).width).toBeCloseTo(10, 9);
    expect(underlaySize(underlay()).depth).toBeCloseTo(6, 9);
    expect(underlayCorners(underlay())).toHaveLength(4);

    const bounds = underlayBounds(underlay());
    expect(bounds.minX).toBeCloseTo(-5, 9);
    expect(bounds.maxZ).toBeCloseTo(3, 9);
  });
});

describe('calibration', () => {
  it('sets the scale from a known distance', () => {
    // 400 pixels declared to be 4.2 m.
    const calibrated = calibrateUnderlay(
      underlay(),
      { x: 100, z: 200 },
      { x: 500, z: 200 },
      4.2,
      'the front wall',
    );

    expect(calibrated.metresPerPixel).toBeCloseTo(4.2 / 400, 12);
    expect(isCalibrated(calibrated)).toBe(true);
    expect(calibrated.calibration!.label).toBe('the front wall');
    // And that distance now measures what the user said it was.
    const a = imageToWorld(calibrated, { x: 100, z: 200 });
    const b = imageToWorld(calibrated, { x: 500, z: 200 });
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(4.2, 9);
  });

  it('leaves the middle of the plan where it was', () => {
    // Rescaling must not send the drawing flying across the site.
    const placed = underlay({ at: { x: 7, z: -3 } });
    const calibrated = calibrateUnderlay(placed, { x: 0, z: 0 }, { x: 800, z: 0 }, 9);
    near(imageToWorld(calibrated, { x: 500, z: 300 }), { x: 7, z: -3 });
  });

  it('refuses nonsense rather than producing an infinite scale', () => {
    const same = calibrateUnderlay(underlay(), { x: 10, z: 10 }, { x: 10, z: 10 }, 4);
    expect(same.metresPerPixel).toBe(underlay().metresPerPixel);
    expect(isCalibrated(same)).toBe(false);

    const zero = calibrateUnderlay(underlay(), { x: 0, z: 0 }, { x: 400, z: 0 }, 0);
    expect(isCalibrated(zero)).toBe(false);
  });

  it('reports how far apart the two points were', () => {
    // Short calibrations are worth warning about: a pixel of slop over 40 px is
    // half a metre in a ten-metre house.
    const short = calibrateUnderlay(underlay(), { x: 0, z: 0 }, { x: 40, z: 0 }, 1);
    expect(calibrationSpan(short)).toBeCloseTo(40, 6);
    expect(calibrationSpan(underlay())).toBe(0);
  });
});

describe('lining a plan up with what is already drawn', () => {
  it('scales and shifts it onto the storey below', () => {
    // The drawing occupies the middle of the sheet; the storey below is a
    // 12 x 8 m rectangle sitting off to one side.
    const content = { minX: 200, maxX: 800, minZ: 100, maxZ: 500 };
    const target = { minX: 4, maxX: 16, minZ: -4, maxZ: 4 };

    const aligned = suggestAlignment(underlay(), content, target);

    // 600 px of drawing across 12 m, and 400 px across 8 m: both give the same
    // scale here, so nothing is stretched.
    expect(aligned.metresPerPixel).toBeCloseTo(0.02, 9);

    const middle = imageToWorld(aligned, { x: 500, z: 300 });
    near(middle, { x: 10, z: 0 }, 6);
  });

  it('fits by the tighter side rather than stretching the picture', () => {
    // A drawing twice as wide as it is tall, over a square target: fitting both
    // would need two different scales, which would distort the house.
    const content = { minX: 0, maxX: 800, minZ: 0, maxZ: 400 };
    const target = { minX: 0, maxX: 8, minZ: 0, maxZ: 8 };

    const aligned = suggestAlignment(underlay(), content, target);
    expect(aligned.metresPerPixel).toBeCloseTo(0.01, 9);
  });

  it('leaves a degenerate request alone', () => {
    const before = underlay();
    expect(suggestAlignment(before, { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, {
      minX: 0, maxX: 8, minZ: 0, maxZ: 8,
    })).toEqual(before);
  });
});

describe('a freshly imported plan', () => {
  it('lands centred, at a house-sized guess, and says it is uncalibrated', () => {
    const fresh = placeNewUnderlay('img-9', 2400, 1600);

    expect(fresh.at).toEqual({ x: 0, z: 0 });
    expect(isCalibrated(fresh)).toBe(false);
    // A house-sized guess: the long side lands at about 12 m, not 12 cm and
    // not 12 km. An image that appears off screen looks like a failed import.
    expect(underlaySize(fresh).width).toBeCloseTo(12, 6);
    expect(fresh.opacity).toBeLessThan(1);
  });
});

describe('bounds', () => {
  it('is null for nothing at all', () => {
    expect(boundsOf([])).toBeNull();
  });
});

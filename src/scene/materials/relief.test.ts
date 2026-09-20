/**
 * The normal maps have to be normal maps, not mirrors.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS.
 *
 * Every procedural surface in this app produces a greyscale height field, and
 * `heightToNormalMap` runs a Sobel operator over it to get a normal. That means
 * the normal map is a DERIVATIVE of the height field, and derivatives are where
 * things go wrong quietly: a height field can look completely reasonable as a
 * picture and still be catastrophic once differentiated.
 *
 * Which is exactly what happened. For sixteen sessions every generator wrote
 * relief that looked fine as a greyscale image, and several of them were built
 * out of features narrower than a single texel:
 *
 *   • plank joints measured in plank cells, so the same number meant 6.6 mm
 *     across a board and 70 mm along it;
 *   • a grout channel with a two-texel bevel climbing 95% of the height range;
 *   • carpet pile at full amplitude and a frequency of one cycle per seven
 *     texels, multiplied by a normal strength of 3.4;
 *   • masonry that branched on a BOOLEAN — full height on the brick, quarter
 *     height in the mortar, nothing in between.
 *
 * Differentiated, all of those produce normals lying almost flat to the surface.
 * A normal lying flat to a surface is a mirror, and a mirror under a low sun is
 * a bright streak. That is what the floor was doing, and it took a screenshot
 * from a user to notice, because nothing in the code said it.
 *
 * So this file measures the thing that actually matters — how far the finished
 * normal map tilts off the surface — rather than the height field it came from.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE NUMBERS MEAN, AND WHY THEY ARE WHERE THEY ARE.
 *
 * These are not aesthetic limits. They are the point past which a normal map
 * stops describing micro-relief and starts describing geometry it cannot hold:
 *
 *   MEAN_TILT      the surface as a whole. A floor whose AVERAGE texel points
 *                  20° off vertical is not a floor with texture, it is a floor
 *                  made of gravel. The old carpet averaged 45°.
 *   EXTREME_TILT   the worst texel anywhere. Past about 75° a texel reflects
 *                  the sun straight back at grazing incidence, which is the
 *                  bright-streak failure itself. Five of the old generators
 *                  exceeded 80°.
 *   TAIL_TILT      the 99.9th percentile, which catches the case a maximum
 *                  misses: not one stray texel but a whole structural band of
 *                  them, like every mortar joint in a brick wall.
 *
 * Measured at 256 px rather than the 1024 the app ships, which is the harder
 * test — fewer texels across the same metre of surface means steeper relief per
 * texel, so anything that passes here passes at the real resolution too.
 */

import { describe, expect, it } from 'vitest';

import { CLADDING_PRESETS } from './cladding';
import { FLOOR_PRESETS } from './presets';
import { heightToNormalMap } from './textureUtils';
import { generateWeave } from './generators';
import type { SurfaceMaps } from './generators';

/** Resolution under test. Deliberately lower than production — see the header. */
const SIZE = 256;

const MEAN_TILT = 32;
const TAIL_TILT = 70;
const EXTREME_TILT = 75;

/**
 * `ImageData` is a browser type and these are node tests.
 *
 * The generators only ever construct one and write bytes into `.data`, so the
 * three fields they touch are the whole contract.
 */
class NodeImageData {
  readonly data: Uint8ClampedArray;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as { ImageData?: unknown }).ImageData = NodeImageData;
}

interface Relief {
  meanTilt: number;
  tailTilt: number;
  maxTilt: number;
  /** Lowest and highest byte in the height field, to catch clipping. */
  heightMin: number;
  heightMax: number;
}

/** Measures the finished normal map's angle off the surface, texel by texel. */
function measure(maps: SurfaceMaps): Relief {
  const normal = heightToNormalMap(maps.height, maps.normalStrength);
  const tilts = new Float64Array(normal.data.length / 4);

  let sum = 0;
  let heightMin = 255;
  let heightMax = 0;

  for (let i = 0, t = 0; i < normal.data.length; i += 4, t++) {
    // Undo the standard tangent-space bias to get the normal back.
    const nx = (normal.data[i]! / 255) * 2 - 1;
    const ny = (normal.data[i + 1]! / 255) * 2 - 1;
    const nz = (normal.data[i + 2]! / 255) * 2 - 1;

    // Angle between the texel's normal and the surface's own normal, which in
    // tangent space is straight up the Z axis.
    const cosine = nz / Math.hypot(nx, ny, nz);
    const tilt = (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
    tilts[t] = tilt;
    sum += tilt;

    const level = maps.height.data[i]!;
    if (level < heightMin) heightMin = level;
    if (level > heightMax) heightMax = level;
  }

  tilts.sort();
  return {
    meanTilt: sum / tilts.length,
    tailTilt: tilts[Math.floor(tilts.length * 0.999)]!,
    maxTilt: tilts[tilts.length - 1]!,
    heightMin,
    heightMax,
  };
}

const SURFACES = [
  ...FLOOR_PRESETS.map((preset) => ({ id: preset.id, build: preset.build })),
  ...CLADDING_PRESETS.map((preset) => ({ id: preset.id, build: preset.build })),
];

describe('relief maps stay within what a texture can carry', () => {
  for (const surface of SURFACES) {
    describe(surface.id, () => {
      const relief = measure(surface.build(SIZE));

      it('does not average like gravel', () => {
        expect(relief.meanTilt).toBeLessThan(MEAN_TILT);
      });

      it('has no band of near-mirror texels', () => {
        expect(relief.tailTilt).toBeLessThan(TAIL_TILT);
      });

      it('has no single texel lying flat to the surface', () => {
        expect(relief.maxTilt).toBeLessThan(EXTREME_TILT);
      });

      /*
       * A height field that touches 0 or 255 has been flattened against the end
       * of the byte range, and a flat region has no gradient, so whatever detail
       * was there is simply gone from the normal map. The old plank floor sat at
       * 0.90 and added grain on top of it: every bright grain line clipped, and
       * the figuring vanished from the relief entirely while remaining perfectly
       * visible in the albedo. That mismatch is its own kind of wrong — the
       * floor you could see was not the floor the light was hitting.
       */
      it('does not clip at either end of the byte range', () => {
        expect(relief.heightMin).toBeGreaterThan(0);
        expect(relief.heightMax).toBeLessThan(255);
      });
    });
  }
});

describe('joints are measured in metres, not in plank cells', () => {
  /*
   * The regression that started all this.
   *
   * A plank is six times longer than it is wide, so a joint width expressed as
   * a fraction of the plank was six times wider across the ends than down the
   * sides. The test is simply: make a floor of very long thin boards, and the
   * joint should still be the same size in both directions.
   *
   * It is checked through the ALBEDO rather than the height field, because the
   * albedo is where a joint is unambiguous — it is the dark line.
   */
  it('draws the same joint on a board that is ten times longer than it is wide', async () => {
    const { generateWood } = await import('./generators');
    const maps = generateWood(512, {
      darkColor: '#8a5f33',
      lightColor: '#d8ab74',
      plankWidth: 0.2,
      plankLength: 2,
      grainContrast: 0,
      baseRoughness: 0.5,
      seed: 7,
      tileMetres: 2,
    });

    /** Counts how many texels along a line fall in shadow under a joint. */
    const darkRun = (read: (step: number) => number, length: number): number => {
      let levels: number[] = [];
      for (let i = 0; i < length; i++) levels.push(read(i));
      const brightest = Math.max(...levels);
      return levels.filter((level) => level < brightest * 0.7).length;
    };

    const size = maps.albedo.width;
    const at = (x: number, y: number) => maps.albedo.data[(y * size + x) * 4]!;

    // Down a column: crosses every long joint. Across a row: crosses every end
    // joint. Both lines are the same length in texels but cover the same 2 m of
    // floor, so the joint texels either side should be comparable.
    const down = darkRun((y) => at(size >> 2, y), size);
    const across = darkRun((x) => at(x, size >> 2), size);

    // There are ten boards across the tile and one along it, so the column
    // crosses ten joints to the row's one. Normalise by that.
    const perJointDown = down / 10;
    const perJointAcross = across / 1;

    expect(perJointDown).toBeGreaterThan(0);
    expect(perJointAcross).toBeGreaterThan(0);
    // Before the fix this ratio was about six. Anything near one means the
    // joint is a physical width rather than a fraction of a board.
    expect(perJointAcross / perJointDown).toBeLessThan(2.5);
  });
});

/**
 * The weave, measured the same way everything else in this file is.
 *
 * Every relief bug this project has had was an amplitude too large for its
 * frequency — a height field that drops most of its range across two texels is
 * a mirror, not a texture. That is what made the wood floor gleam like wet
 * paint and the carpet catch glints wool has never had. A weave is the finest
 * field here, so it is the easiest one to get wrong in that direction.
 */
describe('woven upholstery', () => {
  function weave(coarseness = 0.8): SurfaceMaps {
    return generateWeave(SIZE, {
      baseColor: '#d7cdba',
      coarseness,
      seed: 4471,
      tileMetres: 0.35,
    });
  }

  it('keeps its normals nearly flat, because threads are not spikes', () => {
    const relief = measure(weave());
    // Cloth breaks a sheen up; it does not face the light in six directions.
    expect(relief.meanTilt).toBeLessThan(20);
    expect(relief.tailTilt).toBeLessThan(TAIL_TILT);
  });

  it('does not clip, which is what a field too steep for its texels does', () => {
    const relief = measure(weave());
    expect(relief.heightMin).toBeGreaterThan(0);
    expect(relief.heightMax).toBeLessThan(255);
  });

  it('puts the weave in the light, not in the colour', () => {
    /*
     * Dyed cloth is dyed all the way through. Painting the weave into the
     * albedo is the usual shortcut and it reads as wallpaper, because the
     * pattern then stays put when the light moves.
     */
    const albedo = weave().albedo.data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < albedo.length; i += 4) {
      min = Math.min(min, albedo[i]!);
      max = Math.max(max, albedo[i]!);
    }
    expect(max - min).toBeLessThan(30);
  });

  it('varies its roughness, which is where the effect actually lives', () => {
    const rough = weave().roughness.data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < rough.length; i += 4) {
      min = Math.min(min, rough[i]!);
      max = Math.max(max, rough[i]!);
    }
    expect(max - min).toBeGreaterThan(10);
    // And never reaches a gloss: upholstery has no sharp highlight anywhere.
    expect(min).toBeGreaterThan(0.8 * 255);
  });

  it('gets flatter as the cloth gets finer', () => {
    // Velvet is nearly smooth; linen is not. The knob has to do something.
    expect(measure(weave(0.1)).meanTilt).toBeLessThan(measure(weave(1)).meanTilt);
  });
});

/**
 * The lighting presets have to keep their contrast.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS A TEST AND NOT A MATTER OF TASTE.
 *
 * Session 17 spent most of a day hunting a shadow bug that did not exist. The
 * shadow map was rendering correctly, the shaders could sample it, the meshes
 * cast and received, and the shadows landed exactly where they should. They were
 * invisible because the ambient light was nearly as bright as the sun: the
 * "Daylight" preset ran a sun of 1.9 against an ambient of 1.32, a ratio of 1.4
 * to 1, where real midday sun against real skylight is five to ten.
 *
 * At that ratio a surface in shadow loses about a third of its light, which the
 * eye reads as no shadow at all. It is also why the whole model looked like
 * coloured cardboard — shape is read almost entirely from the difference between
 * lit and unlit, and there was barely a difference to read.
 *
 * The reason it drifted there is worth recording, because it will happen again.
 * Every individual adjustment that flattened a preset was defensible on its own:
 * a wall was clipping, so the sun came down; a corner was too dark, so the fill
 * went up. Nobody ever decided the light should be flat. It just ended up that
 * way, one reasonable tweak at a time, and nothing in the code noticed because
 * contrast is a relationship between four numbers and each was edited alone.
 *
 * So the relationship is now declared next to the numbers and checked here.
 */

import { describe, expect, it } from 'vitest';

import { LIGHTING_PRESETS } from './Lighting';

/**
 * How far a preset may sit from its declared ratio.
 *
 * Loose enough that ordinary colour and intensity work does not trip it, tight
 * enough that it catches the drift that actually happened — every one of the old
 * four was out by more than a factor of two.
 */
const TOLERANCE = 0.25;

/**
 * The ambient floor.
 *
 * Contrast is raised by lowering ambient, and taken far enough that becomes its
 * own bug: this app renders interiors, where in reality almost all of the light
 * is bounced rather than direct, and none of that bounce is simulated. Strip the
 * ambient out entirely and a room with the sun on the far side of it goes black.
 * The environment map and the hemisphere are standing in for global illumination
 * we do not compute, so they are not decoration and cannot go to zero.
 */
const MINIMUM_AMBIENT = 0.1;

/** Everything lighting the scene that is not the sun. */
const ambientOf = (preset: (typeof LIGHTING_PRESETS)[keyof typeof LIGHTING_PRESETS]) =>
  preset.hemisphereIntensity + preset.fillIntensity + preset.environmentIntensity;

const entries = Object.entries(LIGHTING_PRESETS);

describe('lighting presets keep the contrast they declare', () => {
  for (const [id, preset] of entries) {
    describe(id, () => {
      it('matches its declared sun-to-ambient ratio', () => {
        const actual = preset.sunIntensity / ambientOf(preset);
        expect(Math.abs(actual - preset.ratio)).toBeLessThan(TOLERANCE);
      });

      it('keeps enough ambient to stand in for the bounce we do not compute', () => {
        expect(ambientOf(preset)).toBeGreaterThan(MINIMUM_AMBIENT);
      });

      /*
       * The constraint that was already in the file, now enforced rather than
       * described. Total illuminance has to stay under the shoulder of the ACES
       * curve or saturated paint desaturates towards white — a user picking
       * terracotta must see terracotta, not salmon. Raising contrast must
       * therefore come out of the ambient, never out of a bigger sun.
       */
      it('stays under the tone curve, so paint colours survive', () => {
        expect(preset.sunIntensity + ambientOf(preset)).toBeLessThan(3);
      });
    });
  }

  /*
   * A shadow that reads.
   *
   * The ratio is the cause; this is the consequence, and it is the number a
   * person actually sees. It asks how much light a surface loses when the sun
   * is taken off it — which is what a shadow IS — and requires that on the lit
   * presets it is enough to notice. A third is not.
   *
   * Overcast is excluded on purpose rather than by accident: an overcast sky has
   * no sun to lose, and the whole point of that preset is judging colour with
   * nothing falling across it.
   */
  it('drops enough light in shadow to be visible, on every preset with a sun', () => {
    for (const [id, preset] of entries) {
      if (id === 'overcast') continue;
      const lost = preset.sunIntensity / (preset.sunIntensity + ambientOf(preset));
      expect(lost, `${id} loses only ${Math.round(lost * 100)}% of its light in shadow`)
        .toBeGreaterThan(0.55);
    }
  });

  it('keeps overcast flat, because an overcast sky is flat', () => {
    const overcast = LIGHTING_PRESETS.overcast;
    expect(overcast.sunIntensity).toBeLessThan(ambientOf(overcast));
  });
});

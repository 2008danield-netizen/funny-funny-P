/**
 * The last thing that happens to a frame, and the reason renders look like
 * renders.
 *
 * -----------------------------------------------------------------------------
 * A PHOTOGRAPH IS NOT A PERFECT RECORD OF THE LIGHT.
 *
 * Everything before this pass is trying to be physically right: how much sky a
 * point can see, what colour the floor throws back, where the sun falls. That
 * is the correct thing to aim at and it is not what a photograph looks like.
 *
 * A real camera adds three things on top, none of which are in the scene:
 *
 *   BLOOM — bright things bleed into their surroundings, because the lens
 *   scatters light. Without it, a sunlit patch of floor and a white wall both
 *   clip to the same white and the picture has no sense of one being brighter
 *   than the other. It is the single strongest cue that something is REALLY
 *   bright rather than merely light-coloured.
 *
 *   GRAIN — every sensor has noise, and every frame's noise is different. Its
 *   absence is oddly conspicuous: a perfectly smooth gradient across a wall is
 *   something no camera has ever produced, and the eye reads it as synthetic
 *   long before it can say why.
 *
 *   VIGNETTE — a lens passes less light at the edge of the frame than at the
 *   middle. Very slight, and it pulls the eye to the centre of the picture.
 *
 * All three are small. Used heavily they are the cheapest way to make something
 * look worse, so each is kept at roughly the strength a decent camera actually
 * applies rather than the strength that shows up in a side-by-side.
 *
 * -----------------------------------------------------------------------------
 * GRAIN HAS TO BE STABLE WHEN THE PICTURE IS.
 *
 * This app draws a still frame once and then sleeps, so the "every frame is
 * different" part of real grain would mean a still image whose noise is frozen
 * — which is fine — but any redraw would reshuffle it and the wall would appear
 * to crawl for one frame. The seed is therefore held still unless the caller
 * advances it, which the accumulating path does and the still path does not.
 */

import * as THREE from 'three';

/**
 * How much the highlights bleed, 0 to 1.
 *
 * Small. Bloom is the effect most often overdone, and what it is for here is
 * making a sunlit patch on a floor read as sunlit — not making the room glow.
 */
export const BLOOM_STRENGTH = 0.18;

/**
 * How bright a pixel must be before it blooms at all.
 *
 * Just under 1, so an ordinary lit wall does not bleed and only genuinely
 * over-bright things — direct sun, a lamp, a specular hit on chrome — do. Set
 * this much lower and the whole image softens, which reads as a smeared lens
 * rather than as light.
 */
export const BLOOM_THRESHOLD = 0.85;

/** How far the bleed spreads, as a fraction of the frame. */
export const BLOOM_RADIUS = 0.4;

/**
 * Grain amplitude, as a fraction of full scale.
 *
 * 0.02 is about ISO 400 on a decent sensor: invisible as dots, clearly present
 * as texture. At 0.05 it starts to look like a deliberate effect.
 */
export const GRAIN_AMOUNT = 0.022;

/** How dark the corners of the frame get, 0 to 1. */
export const VIGNETTE_AMOUNT = 0.22;

/**
 * The combined grain and vignette shader.
 *
 * One pass rather than two, because both are cheap per-pixel arithmetic and a
 * second full-screen pass costs a whole read and write of the frame for no
 * reason. Bloom is separate because it genuinely needs its own blur chain.
 */
export const FilmLookShader = {
  name: 'FilmLookShader',

  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    grain: { value: GRAIN_AMOUNT },
    vignette: { value: VIGNETTE_AMOUNT },
    seed: { value: 0 },
    aspect: { value: 1 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float grain;
    uniform float vignette;
    uniform float seed;
    uniform float aspect;
    varying vec2 vUv;

    /*
     * A hash, not a noise texture.
     *
     * Grain must not tile, and any texture small enough to be worth uploading
     * repeats across a 4K frame often enough to see. This is the standard
     * sine-fract hash: it is not a good random number generator by any
     * statistical measure and it is a perfectly good one for this, because all
     * that is wanted is a different value at every pixel with no visible
     * structure.
     */
    float hash(vec2 at) {
      return fract(sin(dot(at, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 colour = texture2D(tDiffuse, vUv);

      /*
       * The vignette, measured from the centre in a frame that has been made
       * square first.
       *
       * Without the aspect correction the falloff is elliptical and reaches the
       * top and bottom edges long before the sides, which on a wide window
       * darkens a band across the picture rather than shading its corners.
       */
      vec2 fromCentre = (vUv - 0.5) * vec2(aspect, 1.0);
      float radius = length(fromCentre) / length(vec2(aspect, 1.0) * 0.5);
      // smoothstep rather than a linear falloff: a lens loses nothing in the
      // middle of the frame and most of it right at the corner.
      colour.rgb *= 1.0 - vignette * smoothstep(0.45, 1.0, radius);

      /*
       * Grain, scaled by how dark the pixel is.
       *
       * Real sensor noise is most visible in the shadows and is swamped in the
       * highlights, and applying it flat puts speckle on a bright window that
       * no camera would record. The 0.25 floor keeps a little in the highlights
       * so a blown-out area does not become suspiciously clean.
       */
      float luma = dot(colour.rgb, vec3(0.2126, 0.7152, 0.0722));
      float weight = mix(1.0, 0.25, clamp(luma, 0.0, 1.0));
      float noise = hash(vUv + seed) - 0.5;
      colour.rgb += noise * grain * weight;

      gl_FragColor = colour;
    }
  `,
};

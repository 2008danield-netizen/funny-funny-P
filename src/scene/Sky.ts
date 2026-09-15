/**
 * The sky, as a gradient rather than a flat colour.
 *
 * -----------------------------------------------------------------------------
 * WHY A FLAT BACKGROUND COLOUR LOOKS WRONG.
 *
 * A single colour behind the building is the reason an otherwise decent render
 * reads as a 3D model on a coloured card rather than as a building outdoors.
 * The eye takes a great deal of its sense of *outdoors* from the fact that the
 * sky is not uniform: deepest overhead, paling towards the horizon, with a warm
 * band where the sun is. A flat fill removes all three cues at once, and no
 * amount of work on the building itself puts them back.
 *
 * -----------------------------------------------------------------------------
 * A TEXTURE, NOT A SHADED SPHERE.
 *
 * The obvious implementation is a large inverted sphere with a gradient shader
 * on it. That was tried first and it is a worse idea than it looks: the sphere
 * has to be excluded from depth testing, kept centred on the camera, ordered
 * before everything else, and excluded from the ambient-occlusion pass — four
 * separate ways for it to end up invisible or to swallow the scene, and it did.
 *
 * Painting the same gradient into an equirectangular texture and handing it to
 * `scene.background` has none of those failure modes. Three draws it behind
 * everything, at infinity, with no depth interaction, because that is what a
 * background texture IS. It is regenerated only when the lighting preset
 * changes — four times in a session at most — so the cost is irrelevant.
 *
 * The same texture is a good candidate for the environment map later, which
 * would make windows reflect a sky that matches the one behind them.
 */

import * as THREE from 'three';

export interface SkyColours {
  /** Straight up. */
  zenith: number;
  /** At the horizon. */
  horizon: number;
  /** Below the horizon — the haze the ground plane sits against. */
  ground: number;
  /** The glow around the sun. */
  sun: number;
  /** How tightly the glow hugs the sun. Higher is tighter. */
  sunFocus: number;
}

/**
 * Equirectangular, so it maps to the sphere of directions without distortion
 * at the horizon, which is the band that is actually looked at. Small, because
 * a gradient has no detail to lose and this is stretched over the whole sky.
 */
const WIDTH = 1024;
const HEIGHT = 512;

export class Sky {
  private texture: THREE.DataTexture | null = null;
  private data = new Uint8Array(WIDTH * HEIGHT * 4);

  /**
   * Paints the sky and installs it as the scene background.
   *
   * Written pixel by pixel into a data texture rather than drawn with a canvas
   * gradient, because the sun's glow is a function of the angle between a
   * direction and the sun — which is not something a linear or radial canvas
   * gradient can express, and approximating it with a radial one puts the glow
   * in the wrong place as soon as the sun is not on the horizon.
   */
  apply(scene: THREE.Scene, colours: SkyColours, sunDirection: THREE.Vector3): void {
    const zenith = new THREE.Color(colours.zenith);
    const horizon = new THREE.Color(colours.horizon);
    const ground = new THREE.Color(colours.ground);
    const sun = new THREE.Color(colours.sun);
    const sunDir = sunDirection.clone().normalize();

    const colour = new THREE.Color();

    for (let y = 0; y < HEIGHT; y += 1) {
      /*
       * Equirectangular: the row is the polar angle from straight up, the
       * column is the azimuth. `phi` runs 0 at the zenith to PI at the nadir.
       */
      const phi = (y / (HEIGHT - 1)) * Math.PI;
      const height = Math.cos(phi);

      for (let x = 0; x < WIDTH; x += 1) {
        const theta = (x / WIDTH) * Math.PI * 2;

        /*
         * Above the horizon, blend zenith to horizon on a CURVE rather than
         * linearly. A linear blend puts the midtone halfway up the sky and
         * looks like paint; the real thing changes fastest near the horizon,
         * which this exponent reproduces.
         */
        const t = Math.pow(Math.max(0, Math.min(1, height)), 0.45);
        colour.copy(horizon).lerp(zenith, t);

        // Below the horizon, fade into haze so the terrain plane does not end
        // against a hard edge of sky.
        if (height < 0) {
          colour.lerp(ground, Math.min(1, -height * 6));
        }

        /*
         * The sun's glow: a power of the cosine between this direction and the
         * sun. The same shape as a specular highlight because it is the same
         * phenomenon — forward scattering concentrated around one direction.
         */
        const dx = Math.sin(phi) * Math.sin(theta);
        const dy = height;
        const dz = Math.sin(phi) * Math.cos(theta);
        const cosAngle = Math.max(0, dx * sunDir.x + dy * sunDir.y + dz * sunDir.z);

        const glow = Math.pow(cosAngle, colours.sunFocus);
        // A second, much wider term for the general brightening of the half of
        // the sky the sun is in.
        const wash = Math.pow(cosAngle, 3) * 0.1;
        const add = glow + wash;

        const index = (y * WIDTH + x) * 4;
        this.data[index] = clamp255((colour.r + sun.r * add) * 255);
        this.data[index + 1] = clamp255((colour.g + sun.g * add) * 255);
        this.data[index + 2] = clamp255((colour.b + sun.b * add) * 255);
        this.data[index + 3] = 255;
      }
    }

    this.texture?.dispose();
    const texture = new THREE.DataTexture(this.data, WIDTH, HEIGHT, THREE.RGBAFormat);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    /*
     * A DataTexture does NOT flip on upload, where an image texture does. Row 0
     * of this array is the zenith, and without this the sky is painted upside
     * down — ground haze overhead and blue underfoot, which is exactly what
     * happened the first time.
     */
    texture.flipY = true;
    // The gradient is authored in sRGB, so it has to be declared as such or
    // the renderer's linear workflow washes it out.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    this.texture = texture;
    scene.background = texture;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
  }
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/**
 * Dirt, scuffs and polish, worked out from how a surface is used.
 *
 * -----------------------------------------------------------------------------
 * NOTHING IN A REAL ROOM IS UNIFORM, AND EVERYTHING HERE IS.
 *
 * A wall is one colour from the skirting to the cornice. A floor is the same
 * everywhere, including the strip by the door that ten thousand feet have
 * crossed. Every corner is as clean as the middle of the ceiling. That
 * uniformity is one of the loudest remaining tells: it is not that the surfaces
 * look wrong, it is that they look NEW, and unused, in a way no inhabited room
 * has ever been.
 *
 * -----------------------------------------------------------------------------
 * DIRT IS NOT RANDOM, WHICH IS WHY NOISE IS THE WRONG TOOL.
 *
 * The obvious approach is a grunge texture, and it produces exactly the thing
 * it is trying to avoid — a uniform layer of non-uniformity, the same speckle
 * on the ceiling as on the floor, sitting on the surface rather than belonging
 * to it. Real wear is placed by what happens to a place, and that is something
 * this app already knows about every point in the building:
 *
 *   GRIME COLLECTS WHERE NOTHING CAN REACH. The top of a skirting, the inside
 *   of a reveal, the angle between a wall and a ceiling. These are precisely
 *   the points with low sky visibility — which the sky bake has already
 *   computed, per vertex, for entirely different reasons. Dirt accumulates
 *   where light does not, because the same geometry excludes both a cloth and
 *   a photon.
 *
 *   SCUFFS HAPPEN AT SHIN HEIGHT. Every mark on a painted wall below about
 *   400 mm was made by a foot, a hoover or a chair leg, and there are almost
 *   none above a metre until you reach the height where hands go.
 *
 *   TRAFFIC POLISHES. A floor does not get dirtier where it is walked on, it
 *   gets SMOOTHER — the finish burnishes. So the wear term has to drive
 *   roughness in both directions, not just darken.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS PRODUCES.
 *
 * One float per vertex, signed. Positive is grime — darker and duller.
 * Negative is polish — slightly lighter and smoother. Zero is a surface nobody
 * has touched and nothing has settled on, which is most of a wall and should be.
 */

import * as THREE from 'three';

/**
 * How dark the dirtiest crevice goes, as a fraction of the surface's colour.
 *
 * Twelve per cent. Small, and small on purpose: the effect is meant to be
 * noticed as "this room is lived in" rather than as "this room is filthy", and
 * everything above about a fifth reads as damp rather than as dust.
 */
export const GRIME_DEPTH = 0.12;

/**
 * How much rougher a grimy surface is than a clean one.
 *
 * Dust kills a sheen — which is most of why a neglected room looks flat in
 * photographs — so this is proportionally larger than the darkening.
 */
export const GRIME_ROUGHNESS = 0.25;

/**
 * How much smoother a polished patch is.
 *
 * A worn floorboard or a rubbed handrail is measurably shinier than the wood
 * beside it, and this is the one part of wear that makes a surface look BETTER
 * used rather than merely older.
 */
export const POLISH_ROUGHNESS = 0.18;

/**
 * The height band where scuffs happen, in metres above the floor.
 *
 * Everything below 400 mm on a painted wall was hit by a foot, a hoover or a
 * chair. Above it, almost nothing until hand height.
 */
export const SCUFF_HEIGHT = 0.4;

/**
 * How much darker than its own surface a point must be to count as a crevice.
 *
 * -----------------------------------------------------------------------------
 * THE FIRST VERSION USED AN ABSOLUTE THRESHOLD AND DIRTIED THE WHOLE CEILING.
 *
 * "A point that can see less than a third of the sky is somewhere a cloth does
 * not go" sounds right and is wrong, because a ceiling in an enclosed room sees
 * almost no sky ANYWHERE. Measured, the whole ceiling came back at 0.78 grime —
 * uniformly twelve per cent darker and a quarter rougher, which is not a dirty
 * ceiling but a differently painted one.
 *
 * Dirt is LOCAL. What makes the angle between a wall and a ceiling collect
 * grime is not that it is dark in absolute terms, it is that it is darker than
 * the ceiling either side of it — the same geometry that excludes the light
 * excludes the cloth, relative to its own surroundings. So the comparison is
 * against the surface's own mean, and a uniformly enclosed surface gets nothing
 * at all, which is the correct answer for a ceiling.
 */
const CREVICE_SHARE = 0.5;

export interface WearInputs {
  /**
   * Height of the surface's own floor, in metres, so the scuff band is measured
   * from where somebody stands rather than from the world origin.
   */
  floorY: number;
  /**
   * Whether this surface is walked on.
   *
   * A floor polishes where it is used and a wall does not, so the two get
   * opposite treatment from the same traffic.
   */
  walked: boolean;
}

/**
 * Computes a wear value for every vertex of a baked mesh.
 *
 * Reads the `bakedAmbient` attribute the sky bake left behind, so it must run
 * after it — which is free, because the expensive part has already happened.
 * A mesh with no bake gets no wear rather than a guess: without knowing what
 * can reach a point there is nothing to say about what settles on it.
 */
export function computeWear(
  geometry: THREE.BufferGeometry,
  toWorld: THREE.Matrix4,
  inputs: WearInputs,
): Float32Array | null {
  const position = geometry.getAttribute('position');
  const baked = geometry.getAttribute('bakedAmbient');
  if (!position || !baked) return null;

  const wear = new Float32Array(position.count);
  const at = new THREE.Vector3();

  /*
   * This surface's own average exposure, which every point is judged against.
   *
   * One cheap pass, and it is what makes the rule local. A wall averages around
   * 0.4 and its junction with the floor drops to 0.1, so the junction is a
   * crevice; a ceiling averages 0.012 everywhere and nothing on it is.
   */
  let total = 0;
  for (let v = 0; v < position.count; v++) total += baked.getX(v);
  const average = total / Math.max(1, position.count);
  const span = Math.max(0.02, average * CREVICE_SHARE);

  for (let v = 0; v < position.count; v++) {
    at.fromBufferAttribute(position, v).applyMatrix4(toWorld);
    const height = at.y - inputs.floorY;
    const sky = baked.getX(v);

    /*
     * Grime, from the bake's own occlusion.
     *
     * Squared, because dirt is not linear in how enclosed a place is: the
     * difference between an open wall and a shallow recess is almost nothing,
     * and the difference between a shallow recess and a deep one is most of the
     * effect.
     */
    const enclosed = Math.min(1, Math.max(0, (average - sky) / span));
    let value = enclosed * enclosed;

    /*
     * Scuffs, in the band a foot can reach — and only on things that are not
     * walked on. A floor does not get scuffed at floor level; it gets walked on,
     * which is the other case.
     */
    if (!inputs.walked && height >= 0 && height < SCUFF_HEIGHT) {
      const band = 1 - height / SCUFF_HEIGHT;
      value = Math.max(value, band * band * 0.55);
    }

    /*
     * Traffic polish, on a floor, away from the walls.
     *
     * The middle of a room is where people walk; the last few centimetres
     * against a skirting are where a hoover does not reach. Sky visibility
     * stands in for "away from the walls" again, and it is the right quantity:
     * the part of a floor that can see the most sky is the part in the middle
     * of the room. Measured against the floor's own average for the same reason
     * the grime is — a windowless room's floor is uniformly dark and should be
     * uniformly unpolished, not uniformly polished.
     */
    if (inputs.walked && sky > average) {
      value = -Math.min(1, (sky - average) / Math.max(0.02, average)) * 0.6;
    }

    wear[v] = Math.max(-1, Math.min(1, value));
  }

  return wear;
}

/**
 * Teaches a material to read the wear attribute.
 *
 * -----------------------------------------------------------------------------
 * COLOUR AND ROUGHNESS, NOT COLOUR ALONE.
 *
 * Darkening on its own gives a stain — a flat patch of a different colour that
 * sits on the surface. What makes dirt look like dirt is that it changes how
 * the surface RESPONDS to light: dust scatters a sheen into nothing, and a
 * polished patch tightens it. Half of this effect is in the roughness, and it
 * is the half that survives being seen from a different angle.
 */
export function useWear(material: THREE.Material): void {
  const hooked = material.userData.wearHook as ((shader: THREE.WebGLProgramParametersWithUniforms) => void) | undefined;
  if (hooked) return;

  const previous = material.onBeforeCompile.bind(material);

  const hook = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    previous(shader, undefined as never);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float surfaceWear;
        varying float vWear;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWear = surfaceWear;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vWear;`,
      )
      /*
       * Hooked at the ROUGHNESS chunk rather than at the colour, because the
       * roughness has to be changed before the lighting is computed and the
       * colour can be changed at the same moment. Doing it after would tint a
       * surface that had already been lit as though it were clean.
       */
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float grime = max(0.0, vWear);
        float polish = max(0.0, -vWear);
        roughnessFactor = clamp(
          roughnessFactor + grime * ${GRIME_ROUGHNESS.toFixed(3)} - polish * ${POLISH_ROUGHNESS.toFixed(3)},
          0.02,
          1.0
        );
        diffuseColor.rgb *= 1.0 - grime * ${GRIME_DEPTH.toFixed(3)};
        // A burnished patch is very slightly lighter as well as smoother.
        diffuseColor.rgb *= 1.0 + polish * 0.04;`,
      );
  };

  material.onBeforeCompile = hook as THREE.Material['onBeforeCompile'];
  material.userData.wearHook = hook;

  /*
   * The cache key has to change, and it has to change ALONGSIDE the bake's.
   *
   * Three caches compiled programs by a key that knows nothing about either
   * hook, so two materials that differ only in whether they have been hooked
   * share a program and one of them silently gets the wrong shader. The bake
   * already sets a key; appending rather than replacing is what keeps both
   * facts in it.
   */
  const existing = material.customProgramCacheKey?.() ?? '';
  material.customProgramCacheKey = () => `${existing}|wear`;
  material.needsUpdate = true;
}

/** Ones for the attribute on geometry that has not been measured. */
export function fillNoWear(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute('surfaceWear')) return;
  const position = geometry.getAttribute('position');
  if (!position) return;
  // Zero, not one: zero is "nobody has touched this", which is the right thing
  // for anything the pass has not looked at.
  geometry.setAttribute(
    'surfaceWear',
    new THREE.BufferAttribute(new Float32Array(position.count), 1),
  );
}

/**
 * What the shiny things in this building are reflecting.
 *
 * -----------------------------------------------------------------------------
 * UNTIL NOW, SOMEBODY ELSE'S ROOM.
 *
 * Every reflective surface here — the glazing, a stone worktop, a polished
 * floor, the chrome on a tap — has been reflecting `RoomEnvironment`, which is
 * three's stock studio: a grey box with a few emissive panels in it, built to
 * make material demos look decent against nothing in particular.
 *
 * It is a reasonable default and it is wrong in a specific, visible way. A
 * window reflects a studio light that is not in the room. A worktop under a
 * kitchen window shows a grey ceiling instead of the sky. Nothing reflects the
 * wall it is standing against, and nothing changes when the plan does — which
 * is the tell, because a reflection that does not move when the room moves
 * stops being a reflection and becomes a texture.
 *
 * -----------------------------------------------------------------------------
 * SO RENDER THE ACTUAL BUILDING, SIX WAYS.
 *
 * A cube camera at a point inside the plan, one render per face, then through
 * the same pre-filter three uses on its own environments. Out comes a map that
 * has this building's walls, this building's windows and this daylight in it.
 *
 * It buys more than reflections, and that is the part worth stating. In a
 * physically based renderer `scene.environment` supplies the indirect specular
 * for EVERY material, shiny or not — the faint sheen along a grazing wall, the
 * highlight on a skirting board's round. All of that has been coming from a
 * studio box.
 *
 * -----------------------------------------------------------------------------
 * COST, AND WHY IT IS NOT PAID PER FRAME.
 *
 * Six renders of the whole scene. That is six times a frame, which is far too
 * much to do continuously and nothing at all to do once when the plan settles —
 * the same trade the sky bake makes, for the same reason.
 */

import * as THREE from 'three';

/**
 * Resolution of each cube face.
 *
 * 256 is plenty and is not a compromise. The map is pre-filtered into roughness
 * levels immediately afterwards, and every level but the sharpest is a heavy
 * blur — so detail beyond this is thrown away by the next step. Only a mirror
 * would show it, and there are no mirrors in a house that this renders.
 */
const FACE_SIZE = 256;

/** How far the probe camera can see, in metres. */
const REACH = 200;

/**
 * How smooth a surface has to be before a real reflection is worth giving it.
 *
 * Roughness is exactly how much a surface scatters what it reflects, so this is
 * a physical threshold rather than a taste one: below a quarter the reflection
 * is a picture of something, above it a smear indistinguishable from ambient
 * light — which the baked bounce already supplies, per vertex and better.
 */
export const REFLECTIVE_ROUGHNESS = 0.25;

/**
 * Whether a material should be given the captured probe.
 *
 * Three cases, and the first is the one that is easy to miss. A roughness MAP
 * can make a surface far smoother than `material.roughness` says: a floor here
 * reads 0.6 and is really about 0.31 once its map is multiplied in. So a
 * material may be MARKED reflective by whichever file built it and knows what
 * it is, and a floor is marked, because every floor preset in this app is a
 * sealed surface.
 *
 * Exported and pure so the rule can be checked without a GL context, which is
 * the only part of this file that can be.
 */
export function wantsReflections(material: THREE.Material | null | undefined): boolean {
  if (!material) return false;

  const standard = material as THREE.MeshStandardMaterial;
  if (material.userData?.reflective === true) return true;
  if ((standard as THREE.MeshPhysicalMaterial).transmission > 0) return true;

  // A material with no roughness at all is not a physically based one, and
  // has nowhere to put a reflection.
  if (typeof standard.roughness !== 'number') return false;
  return standard.roughness <= REFLECTIVE_ROUGHNESS;
}

export interface ProbeResult {
  /** Milliseconds taken. */
  ms: number;
  /** Where the probe was taken from. */
  at: { x: number; y: number; z: number };
}

export class EnvironmentProbe {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly pmrem: THREE.PMREMGenerator;
  private target: THREE.WebGLCubeRenderTarget;
  private camera: THREE.CubeCamera;
  private filtered: THREE.Texture | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);

    /*
     * A half-float target, because the sky is much brighter than the room.
     *
     * An 8-bit cube would clip everything above white, and the whole point of
     * an environment map is the RATIO between the bright things in it and the
     * dark ones. Clip the sky to the same value as a lit wall and a window
     * stops reading as a light source.
     */
    this.target = new THREE.WebGLCubeRenderTarget(FACE_SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.camera = new THREE.CubeCamera(0.1, REACH, this.target);
  }

  /** The map built by the last capture, or null before the first. */
  get texture(): THREE.Texture | null {
    return this.filtered;
  }

  /**
   * Captures the scene from a point and pre-filters it.
   *
   * `hidden` is anything that must not appear in the reflection — the pick
   * proxies, which are invisible to the eye and would otherwise be six large
   * grey slabs in every shiny surface, and the sky mesh's own backdrop where
   * that is drawn as geometry.
   *
   * The previous map is released only after the new one exists, so a failed
   * capture leaves the scene with the reflections it had rather than none.
   */
  capture(
    scene: THREE.Scene,
    at: { x: number; y: number; z: number },
    hidden: readonly THREE.Object3D[] = [],
  ): ProbeResult {
    const started = Date.now();

    const restore: THREE.Object3D[] = [];
    for (const object of hidden) {
      if (!object.visible) continue;
      object.visible = false;
      restore.push(object);
    }

    /*
     * The scene's own environment is removed for the capture.
     *
     * Otherwise each capture reflects the one before it, and a room with two
     * facing windows brightens a little every time the plan changes — a
     * feedback loop that is slow enough to look like a bug in something else.
     */
    const previousEnvironment = scene.environment;
    scene.environment = null;

    const previousTarget = this.renderer.getRenderTarget();

    try {
      this.camera.position.set(at.x, at.y, at.z);
      this.camera.update(this.renderer, scene);

      const next = this.pmrem.fromCubemap(this.target.texture).texture;
      this.filtered?.dispose();
      this.filtered = next;
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      scene.environment = previousEnvironment;
      for (const object of restore) object.visible = true;
    }

    return { ms: Date.now() - started, at: { ...at } };
  }

  dispose(): void {
    this.filtered?.dispose();
    this.filtered = null;
    this.target.dispose();
    this.pmrem.dispose();
  }
}

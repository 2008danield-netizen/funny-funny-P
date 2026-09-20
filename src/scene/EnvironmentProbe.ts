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

/** `performance.now` where there is one, so a sub-millisecond face is visible. */
const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

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
    this.begin(scene, at, hidden);
    while (!this.step());
    return this.lastResult!;
  }

  /* --------------------------- One face at a time ------------------------- */

  private pending: {
    scene: THREE.Scene;
    at: { x: number; y: number; z: number };
    restore: THREE.Object3D[];
    previousEnvironment: THREE.Texture | null;
    previousTarget: THREE.WebGLRenderTarget | null;
    face: number;
    spent: number;
  } | null = null;

  private lastResult: ProbeResult | null = null;

  /**
   * Starts a capture, to be advanced one face at a time.
   *
   * -----------------------------------------------------------------------------
   * SIX FULL RENDERS OF THE SCENE IS ONE VERY LONG FRAME.
   *
   * Measured on the software rasteriser: about 700 milliseconds, which was the
   * one remaining freeze once the sky bake had been spread over frames. Even on
   * real hardware six renders in a single frame is six frames' worth of work
   * arriving at once, which is a dropped frame at best.
   *
   * There is no reason for them to be in the same frame. A cube face is an
   * independent render into an independent slice of the target, and the
   * pre-filter at the end does not care when they were drawn.
   *
   * The scene is held in a state it must not be left in while this runs — pick
   * proxies hidden, `scene.environment` cleared — so `step` must keep being
   * called until it reports done. `abandon` exists for the one case where it
   * cannot: the plan changing underneath a capture.
   */
  begin(
    scene: THREE.Scene,
    at: { x: number; y: number; z: number },
    hidden: readonly THREE.Object3D[] = [],
  ): void {
    if (this.pending) this.abandon();

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

    this.camera.position.set(at.x, at.y, at.z);
    this.camera.updateMatrixWorld(true);

    this.pending = {
      scene,
      at: { ...at },
      restore,
      previousEnvironment,
      previousTarget: this.renderer.getRenderTarget(),
      face: 0,
      spent: 0,
    };
  }

  /**
   * Renders one face, or pre-filters and finishes. True when the capture is done.
   *
   * The faces are drawn in the order three's own `CubeCamera` keeps its
   * children, which is the order the cube target's slices are indexed in. They
   * are not interchangeable: swapping two would mirror the reflections about an
   * axis, which looks like nothing in particular and is impossible to attribute.
   */
  step(): boolean {
    const job = this.pending;
    if (!job) return true;

    const started = now();

    if (job.face < 6) {
      const camera = this.camera.children[job.face] as THREE.PerspectiveCamera | undefined;
      if (camera) {
        this.renderer.setRenderTarget(this.target, job.face);
        this.renderer.clear();
        this.renderer.render(job.scene, camera);
      }
      job.face++;
      job.spent += now() - started;
      return false;
    }

    try {
      const next = this.pmrem.fromCubemap(this.target.texture).texture;
      this.filtered?.dispose();
      this.filtered = next;
    } finally {
      this.restore(job);
    }

    job.spent += now() - started;
    this.lastResult = { ms: Math.round(job.spent), at: job.at };
    this.pending = null;
    return true;
  }

  /** Whether a capture is part way through. */
  get capturing(): boolean {
    return this.pending !== null;
  }

  /** What the last finished capture cost. */
  get result(): ProbeResult | null {
    return this.lastResult;
  }

  /**
   * Gives up on a capture in progress and puts the scene back.
   *
   * The half-written cube target is simply left; the previous filtered map
   * stays in use, which is the right answer — reflections one edit out of date
   * are very much better than none, and the next capture overwrites every face
   * anyway.
   */
  abandon(): void {
    if (!this.pending) return;
    this.restore(this.pending);
    this.pending = null;
  }

  private restore(job: NonNullable<EnvironmentProbe['pending']>): void {
    this.renderer.setRenderTarget(job.previousTarget);
    job.scene.environment = job.previousEnvironment;
    for (const object of job.restore) object.visible = true;
  }

  dispose(): void {
    this.abandon();
    this.filtered?.dispose();
    this.filtered = null;
    this.target.dispose();
    this.pmrem.dispose();
  }
}

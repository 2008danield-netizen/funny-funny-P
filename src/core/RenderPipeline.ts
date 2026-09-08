/**
 * The render pipeline: what actually happens between "draw" and pixels.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE ARE TWO PATHS.
 *
 * A frame is drawn one of two ways depending on whether the camera is moving,
 * and the difference is not a quality slider — they are different algorithms.
 *
 *   MOVING     — render straight to the screen at reduced resolution. No post
 *                processing, no accumulation. Cheapest possible path, because
 *                the only thing that matters mid-drag is that the next frame
 *                arrives soon.
 *
 *   STILL      — render into a float buffer with ambient occlusion applied,
 *                jitter the camera and the sun a little each time, and average
 *                the results. Every extra sample makes the shadows softer, the
 *                occlusion smoother and the edges cleaner.
 *
 * -----------------------------------------------------------------------------
 * AMBIENT OCCLUSION IS THE POINT.
 *
 * Of everything here, ground-truth ambient occlusion is what stops the model
 * looking like flat coloured shapes. The eye reads depth from the darkening
 * where two surfaces meet — the line where a wall meets the floor, the shade
 * under a worktop, the crease inside a window reveal. Without it, a perfectly
 * lit white wall meeting a perfectly lit white floor is one continuous white
 * region and the corner is invisible.
 *
 * GTAO is used rather than the older SSAO because SSAO's occlusion is a
 * heuristic that darkens by counting nearby depth samples, and it famously
 * puts a dark halo around every object. GTAO computes a real horizon angle, so
 * its output is closer to what the light actually does and it survives being
 * turned up far enough to see.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

import { Progressive } from './Progressive';
import type { QualitySettings } from './FrameLoop';

export class RenderPipeline {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private gtao: GTAOPass | null = null;

  readonly progressive: Progressive;

  private width = 1;
  private height = 1;
  private quality: QualitySettings;
  private aoEnabled = true;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    quality: QualitySettings,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.quality = quality;
    this.progressive = new Progressive(renderer, {
      maxSamples: quality.maxSamples,
      sunAngularRadius: THREE.MathUtils.degToRad(1.6),
    });

    this.buildComposer(camera);
  }

  private buildComposer(camera: THREE.PerspectiveCamera): void {
    this.composer?.dispose();
    this.composer = null;
    this.gtao = null;

    /*
     * No post chain at all when there is no post effect to run.
     *
     * An EffectComposer holding nothing but a RenderPass is not free: it is two
     * extra full-resolution render targets and an extra pass of buffer
     * management per sample, for a result identical to rendering the scene
     * straight into the target. Skipping it is both faster and one fewer thing
     * that can go wrong.
     */
    if (!this.quality.ambientOcclusion) return;

    /*
     * The composer writes into a HALF-FLOAT target rather than the default
     * 8-bit one, because its output is averaged by the accumulator. Averaging
     * 8-bit samples quantises: each contributes well under one unit of 0–255,
     * most of them round to nothing, and the result bands instead of
     * converging.
     */
    const target = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.composer = new EffectComposer(this.renderer, target);
    // The composer must not tone-map or encode: the accumulator does both,
    // once, on the way to the screen. Doing it here would tone-map every
    // sample and then average tone-mapped values, which is not the same
    // number and washes the highlights out.
    this.composer.renderToScreen = false;

    this.renderPass = new RenderPass(this.scene, camera);
    this.composer.addPass(this.renderPass);

    if (this.quality.ambientOcclusion) {
      this.gtao = new GTAOPass(this.scene, camera, this.width, this.height);
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.configureAo();
      this.composer.addPass(this.gtao);
    }
  }

  /**
   * The occlusion settings.
   *
   * `distance` is in world metres and it is the number that matters most: too
   * small and only the very corner darkens, which reads as a drawn line rather
   * than shade; too large and whole walls go grey and the model looks dirty.
   * Half a metre is about right for rooms — it catches the wall-to-floor
   * junction, the underside of a worktop and a window reveal, and leaves the
   * middle of a wall alone.
   */
  private configureAo(): void {
    if (!this.gtao) return;
    this.gtao.updateGtaoMaterial({
      radius: 0.5,
      distanceExponent: 1,
      thickness: 1,
      scale: 1,
      samples: 16,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    });
    // Blending the AO under the colour rather than multiplying it flat keeps
    // lit surfaces from going muddy; only the crease darkens.
    this.gtao.blendIntensity = 1;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));

    this.composer?.setSize(this.width, this.height);
    this.gtao?.setSize(this.width, this.height);
    this.progressive.setSize(this.width, this.height);
  }

  setQuality(quality: QualitySettings, camera: THREE.PerspectiveCamera): void {
    const aoChanged = quality.ambientOcclusion !== this.quality.ambientOcclusion;
    this.quality = quality;
    if (aoChanged) this.buildComposer(camera);
    this.progressive.reset();
  }

  /** Turns AO off entirely, e.g. for a machine that cannot afford it. */
  setAmbientOcclusion(enabled: boolean, camera: THREE.PerspectiveCamera): void {
    if (enabled === this.aoEnabled) return;
    this.aoEnabled = enabled;
    this.quality = { ...this.quality, ambientOcclusion: enabled };
    this.buildComposer(camera);
  }

  /** The cheap path: straight to the screen, no post, no accumulation. */
  renderMoving(camera: THREE.PerspectiveCamera): void {
    clearJitter(camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, camera);
  }

  /**
   * One accumulated sample of the still image.
   *
   * `onSample` is called with the sample index before the render, so the
   * caller can move the sun to a different point on its disc — which is what
   * turns a hard shadow-map edge into a real penumbra.
   */
  renderSample(camera: THREE.PerspectiveCamera, onSample: (index: number) => void): void {
    const index = this.progressive.sampleCount;
    onSample(index);

    this.progressive.sample((jitterX, jitterY) => {
      applyJitter(camera, jitterX, jitterY, this.width, this.height);

      if (this.composer) {
        /*
         * The composer renders its chain into its own ping-pong buffers and
         * leaves the finished image in `readBuffer`. Handing that texture
         * straight to the accumulator avoids a fullscreen copy per sample —
         * which at 64 samples is 64 full-resolution blits saved.
         */
        this.composer.render();
        return this.composer.readBuffer.texture;
      }

      // No post chain: render the scene straight into the plain target.
      const target = this.plainTarget();
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, camera);
      this.renderer.setRenderTarget(null);
      return target.texture;
    });

    clearJitter(camera);
  }

  /**
   * A target for the no-post path, allocated only if it is ever needed.
   *
   * Half-float for the same reason the composer's is: its output is averaged,
   * and averaging 8-bit samples bands.
   */
  private plain: THREE.WebGLRenderTarget | null = null;

  private plainTarget(): THREE.WebGLRenderTarget {
    if (!this.plain) {
      this.plain = new THREE.WebGLRenderTarget(this.width, this.height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
    }
    if (this.plain.width !== this.width || this.plain.height !== this.height) {
      this.plain.setSize(this.width, this.height);
    }
    return this.plain;
  }

  /** Puts the accumulated image on the screen. */
  present(): void {
    this.progressive.present();
  }

  get sampleCount(): number {
    return this.progressive.sampleCount;
  }

  get converged(): boolean {
    return this.progressive.isConverged();
  }

  resetAccumulation(): void {
    this.progressive.reset();
  }

  /**
   * Declares the image finished wherever it got to.
   *
   * Used when a sample overran its budget: the accumulated image so far is
   * kept and presented, and no further samples are requested.
   */
  stopConverging(): void {
    this.progressive.stop();
  }

  /** The offset on the sun's disc for a given sample. */
  sunOffset(index: number): { x: number; y: number } {
    return this.progressive.sunOffset(index);
  }

  dispose(): void {
    this.composer?.dispose();
    this.plain?.dispose();
    this.progressive.dispose();
  }
}

/* ------------------------------ Camera jitter ----------------------------- */

/**
 * Nudges the projection by a sub-pixel amount.
 *
 * Done on the PROJECTION matrix rather than by moving the camera, because
 * moving the camera would change the view direction and therefore the
 * parallax — the samples would not be of the same image and averaging them
 * would blur rather than antialias. Offsetting the projection shifts where the
 * pixel grid falls on an unchanged view, which is exactly what is wanted.
 */
function applyJitter(
  camera: THREE.PerspectiveCamera,
  jitterX: number,
  jitterY: number,
  width: number,
  height: number,
): void {
  camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[8] += (2 * jitterX) / width;
  camera.projectionMatrix.elements[9] += (2 * jitterY) / height;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function clearJitter(camera: THREE.PerspectiveCamera): void {
  camera.updateProjectionMatrix();
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

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
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';

import {
  BLOOM_RADIUS,
  BLOOM_STRENGTH,
  BLOOM_THRESHOLD,
  FilmLookShader,
} from './FilmLook';

import { Progressive } from './Progressive';
import type { QualitySettings } from './FrameLoop';

export class RenderPipeline {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private gtao: GTAOPass | null = null;
  /**
   * Tone maps and encodes on the way to the screen.
   *
   * Only wanted on the path that goes straight to the screen. The accumulating
   * path needs the composer's output LINEAR, because it averages samples and
   * then tone maps once at the end — tone mapping each sample and averaging the
   * results is a different number, and a visibly flatter one.
   */
  private output: OutputPass | null = null;
  private probePass: ShaderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private bokeh: BokehPass | null = null;
  private film: ShaderPass | null = null;
  private filmEnabled = true;
  private depthOfField = false;

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

    /*
     * Bloom, before the film pass and after the occlusion.
     *
     * Order matters and this is the only one that does. Bloom has to see the
     * scene's own bright values, so it must come before anything that shapes
     * them; and it must come AFTER the occlusion, or a corner that the
     * occlusion is about to darken will already have bled light into its
     * neighbours.
     */
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.bloom.enabled = this.filmEnabled;
    this.composer.addPass(this.bloom);

    /*
     * Depth of field, off unless asked for.
     *
     * A real lens has it and an architectural tool mostly should not: blurring
     * the part of the room somebody is not looking at is exactly wrong when
     * they are trying to judge a layout, and there is no eye tracking here to
     * know where that is. So it exists, it is wired to focus on whatever is at
     * the middle of the frame, and it is opt-in for the moments — a presentation
     * still, a photograph of a finished design — when the picture matters more
     * than the plan.
     */
    this.bokeh = new BokehPass(this.scene, camera, {
      focus: 4,
      aperture: 0.0002,
      maxblur: 0.006,
    });
    this.bokeh.enabled = this.depthOfField;
    this.composer.addPass(this.bokeh);

    /* Grain and vignette, last before the output. */
    this.film = new ShaderPass(FilmLookShader);
    this.film.enabled = this.filmEnabled;
    this.film.uniforms.aspect!.value = this.width / Math.max(1, this.height);
    this.composer.addPass(this.film);

    /*
     * A deliberately unmissable pass, off by default.
     *
     * "The occlusion is very faint" and "the pass never runs" look identical
     * from outside, and two sessions have now been spent on the first
     * explanation. This tints the whole frame magenta when switched on, so the
     * question can be settled in one frame instead of by inference.
     */
    this.probePass = new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader:
        'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform sampler2D tDiffuse; varying vec2 vUv;' +
        'void main(){ vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(c.r, c.g * 0.2, c.b, c.a); }',
    });
    this.probePass.enabled = false;
    this.composer.addPass(this.probePass);

    // Last in the chain, and switched on only for the straight-to-screen path.
    this.output = new OutputPass();
    this.output.enabled = false;
    this.composer.addPass(this.output);
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
  /**
   * The occlusion settings actually in use, so a probe can sweep them.
   *
   * These are the best of a measured sweep, and the sweep was only possible
   * once a mistake in HOW it was measured was found. Session 18 read the canvas
   * a couple of seconds after changing a setting; under a software rasteriser
   * the view had not finished settling, so what it read was a cheap moving
   * frame with no post chain in it at all. Every conclusion drawn from that —
   * "blendIntensity does nothing", "scale past 2 makes it lighter" — was about
   * an image the pass had never touched. Rendering and reading inside a single
   * call fixed it.
   *
   * With that fixed, `scale` turned out to be the whole lever. Measured on the
   * AO buffer alone, where 255 is no occlusion: scale 1 gave a darkest-5% of
   * 220, scale 4 gave 195, scale 8 gave 147 and scale 16 gave 54. Sixteen is
   * far too much — the corner goes black and smears half a metre up the wall.
   *
   * -----------------------------------------------------------------------------
   * AND 0.6 m AT SCALE 6 WAS STILL TOO MUCH, WHICH TOOK A SOFA TO SHOW.
   *
   * That setting was chosen looking at a bare room corner, where it read
   * correctly. Nothing was checked against furniture at close range, and there
   * it was plainly wrong: grey clouds hanging in the air around the arms of a
   * sofa and between its cushions, a dark bar floating above the back, and
   * visible speckle through all of it. Not contact shadow — fog.
   *
   * Two changes, and the first is the one that allows the second. Furniture now
   * receives the sky bake, so its shading comes from the same place the walls'
   * does instead of from this pass alone. With that carrying the load, this can
   * go back to what screen-space occlusion is actually for: the tight dark line
   * where two things touch. A quarter of a metre at scale 3.
   *
   * Samples doubled to 32 at the same time. Sixteen was visibly noisy once the
   * effect was strong, and halving the strength would have hidden the noise
   * rather than fixed it.
   */
  private ao = {
    radius: 0.25,
    distanceExponent: 1,
    thickness: 1,
    scale: 3,
    samples: 32,
    distanceFallOff: 1,
    screenSpaceRadius: false,
  };

  setAoParams(patch: Partial<RenderPipeline['ao']> & { blend?: number }): void {
    const { blend, ...rest } = patch;
    this.ao = { ...this.ao, ...rest };
    if (blend !== undefined && this.gtao) this.gtao.blendIntensity = blend;
    this.configureAo();
  }

  get aoParams(): RenderPipeline['ao'] {
    return this.ao;
  }

  /**
   * What the post chain actually consists of right now.
   *
   * Reported because "the occlusion is very faint" and "there is no post chain
   * at all" look identical from outside, and session 18 spent a long time on
   * the first explanation before establishing the second.
   */
  get chain(): {
    composer: boolean;
    gtao: boolean;
    gtaoEnabled: boolean;
    film: boolean;
    bloom: boolean;
    bokeh: boolean;
    drawn: { moving: number; still: number; composed: number };
    passes: number;
    output: number | null;
  } {
    return {
      composer: this.composer !== null,
      gtao: this.gtao !== null,
      gtaoEnabled: this.gtao?.enabled ?? false,
      film: this.film?.enabled ?? false,
      bloom: this.bloom?.enabled ?? false,
      bokeh: this.bokeh?.enabled ?? false,
      drawn: { ...this.drawn },
      passes: this.composer?.passes.length ?? 0,
      output: this.gtao ? (this.gtao.output as number) : null,
    };
  }

  /**
   * How many frames each path has drawn.
   *
   * The one number that separates "the pass is faint" from "the pass never
   * runs", which every other symptom fails to distinguish.
   */
  readonly drawn = { moving: 0, still: 0, composed: 0 };

  /** Switches the magenta tint above on or off. */
  setProbePass(on: boolean): void {
    if (this.probePass) this.probePass.enabled = on;
  }

  /** Bloom, grain and vignette together. They are one look, not three knobs. */
  setFilmLook(on: boolean): void {
    this.filmEnabled = on;
    if (this.bloom) this.bloom.enabled = on;
    if (this.film) this.film.enabled = on;
  }

  get filmLook(): boolean {
    return this.filmEnabled;
  }

  /**
   * Depth of field, and what it should be focused on.
   *
   * `focus` is a distance in metres from the camera, which the caller works out
   * by asking what is in the middle of the frame. Passing nothing leaves the
   * focus where it was, so toggling the effect does not also rack the lens.
   */
  setDepthOfField(on: boolean, focus?: number): void {
    this.depthOfField = on;
    if (this.bokeh) {
      this.bokeh.enabled = on;
      if (focus !== undefined && focus > 0) {
        (this.bokeh.uniforms as Record<string, THREE.IUniform>).focus!.value = focus;
      }
    }
  }

  get depthOfFieldOn(): boolean {
    return this.depthOfField;
  }

  /**
   * Nudges the grain so a redrawn frame is not identical.
   *
   * Only the accumulating path calls this. A still frame that is simply redrawn
   * — because a panel opened, or the window was resized — keeps the same seed,
   * so the wall does not visibly crawl for one frame.
   */
  advanceGrain(index: number): void {
    if (this.film) this.film.uniforms.seed!.value = (index % 64) * 0.137;
  }

  private configureAo(): void {
    if (!this.gtao) return;
    this.gtao.updateGtaoMaterial({ ...this.ao });
    // Blending the AO under the colour rather than multiplying it flat keeps
    // lit surfaces from going muddy; only the crease darkens.
    this.gtao.blendIntensity = 1;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));

    this.composer?.setSize(this.width, this.height);
    this.gtao?.setSize(this.width, this.height);
    this.bloom?.setSize(this.width, this.height);
    this.bokeh?.setSize(this.width, this.height);
    if (this.film) this.film.uniforms.aspect!.value = this.width / Math.max(1, this.height);
    this.progressive.setSize(this.width, this.height);
  }

  setQuality(quality: QualitySettings, camera: THREE.PerspectiveCamera): void {
    const aoChanged = quality.ambientOcclusion !== this.quality.ambientOcclusion;
    this.quality = quality;
    if (aoChanged) this.buildComposer(camera);
    this.progressive.reset();
  }

  /**
   * Shows a stage of the occlusion pass on its own, for diagnosis.
   *
   * A post effect that contributes nothing looks exactly like one that is
   * switched off, and both look exactly like one that is working on a scene
   * with nothing to occlude. The only way to tell them apart is to look at the
   * buffer rather than at the composite.
   */
  setAoOutput(mode: 'default' | 'ao' | 'denoise' | 'normal' | 'depth'): void {
    if (!this.gtao) return;
    const modes = {
      default: GTAOPass.OUTPUT.Default,
      ao: GTAOPass.OUTPUT.AO,
      denoise: GTAOPass.OUTPUT.Denoise,
      normal: GTAOPass.OUTPUT.Normal,
      depth: GTAOPass.OUTPUT.Depth,
    } as const;
    this.gtao.output = modes[mode];
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
    this.drawn.moving++;
    clearJitter(camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, camera);
  }

  /**
   * The still frame, with ambient occlusion, once.
   *
   * -----------------------------------------------------------------------------
   * THE PATH THAT WAS MISSING, AND WHY IT MATTERED SO MUCH.
   *
   * There were two paths: cheap-while-moving, and accumulate-while-still. The
   * second was switched off by default because it had never been seen working on
   * real hardware. So in practice EVERY frame this app has ever drawn went down
   * the cheap path — and the cheap path has no post-processing at all.
   *
   * Which meant the ambient occlusion written in session 11 has never once been
   * on screen. Not because it was broken; because nothing called it.
   *
   * That is most of "the rooms look fake". Almost all of the shading information
   * the eye uses indoors is contact darkening: the line where a wall meets a
   * floor, the shade under a worktop, the gloom inside a window reveal, the dark
   * under a sofa. A perfectly lit white wall meeting a perfectly lit white floor
   * is one continuous white region, and the corner between them is invisible.
   * Every render before this had exactly that problem in every corner of every
   * room.
   *
   * This path costs one composited frame when the camera stops. It does not
   * accumulate, so it does not depend on the progressive renderer working, and
   * it is drawn once and then the loop sleeps.
   *
   * -----------------------------------------------------------------------------
   * AND IT IS NOT ENOUGH ON ITS OWN. MEASURED.
   *
   * With the pass running and tuned as well as a parameter sweep could manage,
   * the whole frame darkens by about 1.3 levels out of 255 — from a mean of 167
   * to 165.7. Looking at the AO buffer alone confirms it is computing the right
   * thing in the right places: the wall corner, under a chair, inside the window
   * reveal. It is simply very faint, `blendIntensity` has no effect on the
   * composite at all, and raising `scale` past 2 made it lighter rather than
   * darker.
   *
   * So this is kept because it is a real improvement over never running, and
   * recorded here as NOT the answer to a room looking flat. What remains missing
   * is bounced light: everything indoors is lit by a sun, a hemisphere and a
   * static probe, and none of it is lit by the light coming back off its own
   * floor. That is the difference this pass was being asked to paper over, and
   * it cannot.
   */
  renderStill(camera: THREE.PerspectiveCamera): void {
    this.drawn.still++;
    clearJitter(camera);

    if (!this.composer || !this.output) {
      // No post chain configured — nothing to add, so take the cheap path.
      this.renderMoving(camera);
      return;
    }

    this.drawn.composed++;
    this.output.enabled = true;
    this.composer.renderToScreen = true;
    this.composer.render();
    this.composer.renderToScreen = false;
    this.output.enabled = false;
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

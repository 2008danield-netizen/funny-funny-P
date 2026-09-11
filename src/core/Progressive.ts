/**
 * Progressive rendering: photoreal when still, responsive when moving.
 *
 * -----------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES.
 *
 * Everything that makes a render look real — soft shadows from a sun that is a
 * disc rather than a point, ambient occlusion in every corner, antialiasing
 * that does not crawl — costs more per frame than a modest laptop can pay sixty
 * times a second. The usual answer is to pick one: a smooth toy, or a beautiful
 * slideshow.
 *
 * There is a third answer, and it is what every serious architectural renderer
 * does. Notice that a person using this app is almost never moving the camera.
 * They orbit for a second, then stop and LOOK for thirty. So:
 *
 *   • WHILE MOVING — render cheaply. One sample, low resolution, no post. It
 *     only has to survive a fraction of a second of motion blur in the eye.
 *   • ONCE STILL — keep rendering the same frame over and over, each time with
 *     the camera and the sun nudged by a sub-pixel amount, and AVERAGE the
 *     results into an accumulation buffer.
 *
 * That averaging is the whole trick, and what falls out of it is remarkable:
 *
 *   • Jittering the CAMERA by a fraction of a pixel and averaging IS
 *     antialiasing — better than MSAA, because it antialiases shaders and
 *     alpha edges too, not just geometry.
 *   • Jittering the SUN'S POSITION across the disc of the sun and averaging IS
 *     a soft shadow — a real penumbra that grows with distance from the
 *     occluder, which no shadow-map blur reproduces correctly.
 *   • Every sample also re-runs ambient occlusion at a different rotation, so
 *     the AO noise averages out to a smooth result.
 *
 * The cost is spread over a second or two of wall-clock time that the user was
 * going to spend looking anyway. A laptop that can manage 30 cheap frames a
 * second converges a 64-sample image in about two seconds — and that image is
 * better than anything a single frame could produce on any hardware.
 *
 * -----------------------------------------------------------------------------
 * WHY THE ACCUMULATION IS DONE IN A FLOAT BUFFER.
 *
 * Averaging 64 samples in 8-bit precision quantises badly: each sample
 * contributes under half a unit of the 0–255 range, so most of them round away
 * to nothing and the image bands. The accumulation target is half-float, and
 * the tone mapping happens on the way OUT of it rather than into it — which is
 * also why the sky gradient does not posterise.
 */

import * as THREE from 'three';

/** How the renderer is behaving right now. */
export type RenderMode = 'moving' | 'converging' | 'converged';

export interface ProgressiveOptions {
  /** How many samples to accumulate before declaring the image finished. */
  maxSamples: number;
  /**
   * How wide the sun is, in radians.
   *
   * The real sun subtends about half a degree. Slightly wider reads better in a
   * small scene — a hard architectural model with a truly 0.5° sun looks
   * unnaturally crisp, because a real building is also lit by a sky this model
   * only approximates.
   */
  sunAngularRadius: number;
}

export const PROGRESSIVE_DEFAULTS: ProgressiveOptions = {
  maxSamples: 64,
  sunAngularRadius: THREE.MathUtils.degToRad(1.6),
};

/**
 * Averages many jittered renders into one converged image.
 *
 * Owns two render targets and a fullscreen quad. The caller drives it: call
 * `reset()` whenever anything changes, then `sample()` once per animation frame
 * until `isConverged()`.
 */
export class Progressive {
  private renderer: THREE.WebGLRenderer;
  private options: ProgressiveOptions;

  /** Where the running total lives. Half-float, so 64 samples do not band. */
  private accumulation: THREE.WebGLRenderTarget;
  /** Adds one sample into the accumulation buffer at the right weight. */
  private accumulateQuad: FullscreenQuad;
  /** Tone-maps the accumulated result onto the screen. */
  private presentQuad: FullscreenQuad;

  private samples = 0;
  private width = 1;
  private height = 1;

  constructor(renderer: THREE.WebGLRenderer, options = PROGRESSIVE_DEFAULTS) {
    this.renderer = renderer;
    this.options = options;

    const targetOptions: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      // No mips and linear filtering: this is read back pixel-for-pixel.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    };

    this.accumulation = new THREE.WebGLRenderTarget(1, 1, targetOptions);

    this.accumulateQuad = new FullscreenQuad(ACCUMULATE_SHADER);
    this.presentQuad = new FullscreenQuad(PRESENT_SHADER);
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;
    this.accumulation.setSize(w, h);
    this.reset();
  }

  /** Throws the accumulated image away. Call whenever anything changes. */
  reset(): void {
    this.samples = 0;
    this.stopped = false;
  }

  get sampleCount(): number {
    return this.samples;
  }

  isConverged(): boolean {
    return this.stopped || this.samples >= this.options.maxSamples;
  }

  /** Ends convergence early, keeping whatever has accumulated so far. */
  stop(): void {
    this.stopped = true;
  }

  private stopped = false;

  /**
   * The sub-pixel offset for this sample, in pixels.
   *
   * A HALTON SEQUENCE rather than random numbers. Random jitter clumps — with
   * 16 random samples you get two in one corner of the pixel and none in
   * another, and the average is biased. Halton is low-discrepancy: every new
   * sample lands in the largest remaining gap, so 16 Halton samples cover the
   * pixel far more evenly than 16 random ones and the image converges visibly
   * faster.
   */
  private jitter(index: number): { x: number; y: number } {
    return { x: halton(index + 1, 2) - 0.5, y: halton(index + 1, 3) - 0.5 };
  }

  /**
   * A point on the sun's disc for this sample, as an offset direction.
   *
   * Concentric mapping of the same Halton pair onto a disc, so the sun's
   * samples are as evenly spread as the pixel's. An uneven spread here shows up
   * as banding in the penumbra, which is far more visible than noise.
   */
  sunOffset(index: number): { x: number; y: number } {
    const u = halton(index + 1, 5);
    const v = halton(index + 1, 7);
    const radius = Math.sqrt(u) * this.options.sunAngularRadius;
    const angle = 2 * Math.PI * v;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }

  /**
   * Renders one jittered sample and folds it into the running average.
   *
   * `renderSample` is handed the sub-pixel jitter and returns the TEXTURE its
   * result ended up in. Returning a texture rather than rendering into one this
   * class supplies is what lets a post-processing chain sit in front of the
   * accumulator: the composer keeps its own buffers, and the last one it wrote
   * is simply handed over. The alternative — forcing the composer to write into
   * our target — meant reaching into its internals and cost an extra fullscreen
   * copy per sample.
   */
  sample(
    renderSample: (jitterX: number, jitterY: number) => THREE.Texture,
  ): void {
    const index = this.samples;
    const offset = this.jitter(index);

    const sampled = renderSample(offset.x, offset.y);

    /*
     * Fold it in: next = mix(previous, sample, 1/(n+1)).
     *
     * That weight makes the buffer a true running MEAN rather than a decaying
     * one — sample 64 counts exactly as much as sample 1. The usual
     * "mix by a fixed 0.1" never converges and keeps the first sample's noise
     * forever.
     *
     * WebGL forbids sampling a texture that is bound as the render target, so
     * the two buffers ping-pong: read `previous`, write `next`, swap.
     */
    const previous = this.accumulation;
    const next = this.scratch();

    const material = this.accumulateQuad.material;
    material.uniforms.tSample!.value = sampled;
    material.uniforms.tAccumulation!.value = previous.texture;
    material.uniforms.weight!.value = 1 / (index + 1);
    material.uniforms.reset!.value = index === 0 ? 1 : 0;

    this.renderer.setRenderTarget(next);
    this.accumulateQuad.render(this.renderer);
    this.renderer.setRenderTarget(null);

    this.accumulation = next;
    this.scratchTarget = previous;

    this.samples = index + 1;
  }

  /** The spare target, allocated lazily and swapped with the accumulation. */
  private scratchTarget: THREE.WebGLRenderTarget | null = null;

  private scratch(): THREE.WebGLRenderTarget {
    if (!this.scratchTarget) {
      this.scratchTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
    }
    if (this.scratchTarget.width !== this.width || this.scratchTarget.height !== this.height) {
      this.scratchTarget.setSize(this.width, this.height);
    }
    return this.scratchTarget;
  }

  /** Tone-maps the accumulated image onto the screen. */
  present(): void {
    this.renderer.setRenderTarget(null);
    const material = this.presentQuad.material;
    material.uniforms.tAccumulation!.value = this.accumulation.texture;
    material.uniforms.exposure!.value = this.renderer.toneMappingExposure;
    this.presentQuad.render(this.renderer);
  }

  dispose(): void {
    this.accumulation.dispose();
    this.scratchTarget?.dispose();
    this.accumulateQuad.dispose();
    this.presentQuad.dispose();
  }
}

/* ------------------------------- The shaders ------------------------------ */

const ACCUMULATE_SHADER: THREE.ShaderMaterialParameters = {
  uniforms: {
    tSample: { value: null },
    tAccumulation: { value: null },
    weight: { value: 1 },
    reset: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tSample;
    uniform sampler2D tAccumulation;
    uniform float weight;
    uniform float reset;
    varying vec2 vUv;

    void main() {
      vec4 sampled = texture2D(tSample, vUv);
      vec4 accumulated = texture2D(tAccumulation, vUv);

      // On the first sample there is nothing to blend with, and the buffer
      // holds whatever the last image was — so it is replaced outright rather
      // than averaged, which would ghost the previous camera position.
      vec4 result = mix(mix(accumulated, sampled, weight), sampled, reset);
      gl_FragColor = result;
    }
  `,
};

/**
 * Tone maps the accumulated linear image to the screen.
 *
 * ACES Filmic, matching what the renderer does for a single-pass render, so
 * switching between the moving and the still image does not shift the colours.
 * The curve is written out rather than imported because the accumulation buffer
 * is sampled directly here rather than going through Three's material system.
 */
const PRESENT_SHADER: THREE.ShaderMaterialParameters = {
  uniforms: {
    tAccumulation: { value: null },
    exposure: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tAccumulation;
    uniform float exposure;
    varying vec2 vUv;

    // ACES filmic tone mapping, Narkowicz's fit — the same curve Three uses.
    vec3 aces(vec3 x) {
      const float a = 2.51;
      const float b = 0.03;
      const float c = 2.43;
      const float d = 0.59;
      const float e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    void main() {
      vec3 colour = texture2D(tAccumulation, vUv).rgb * exposure;
      colour = aces(colour);
      // Linear to sRGB.
      colour = pow(colour, vec3(1.0 / 2.2));
      gl_FragColor = vec4(colour, 1.0);
    }
  `,
};

/** A fullscreen triangle-pair and the material drawn on it. */
class FullscreenQuad {
  readonly material: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mesh: THREE.Mesh;

  constructor(parameters: THREE.ShaderMaterialParameters) {
    this.material = new THREE.ShaderMaterial({
      ...parameters,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * The Halton low-discrepancy sequence.
 *
 * The radical inverse of `index` in `base`: write the index in that base and
 * mirror its digits about the point. Successive values land in the largest
 * remaining gap, which is exactly the property that makes 16 samples cover a
 * pixel better than 16 random ones.
 */
export function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * fraction;
    i = Math.floor(i / base);
    fraction /= base;
  }
  return result;
}

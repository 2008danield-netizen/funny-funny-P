/**
 * WebGL renderer setup and viewport sizing.
 *
 * Kept separate from the engine so that renderer-level concerns — colour
 * management, tone mapping, shadow configuration, device pixel ratio — live in
 * one place. When WebXR arrives it is configured here too (`xr.enabled`), not
 * scattered through the scene code.
 */

import * as THREE from 'three';

/**
 * Cap on device pixel ratio.
 *
 * Rendering at a phone's native 3× ratio means shading nine times as many
 * fragments as 1× for a difference almost nobody can see, and it is the single
 * most common cause of a 3D web app feeling slow on mobile.
 */
const MAX_PIXEL_RATIO = 2;

export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  private resizeObserver: ResizeObserver | null = null;
  private onResize: ((width: number, height: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    // Removes the 300 ms tap delay and stops the browser from scrolling the
    // page when the user drags to orbit on a touchscreen.
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);

    this.webgl = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      // Needed if we ever want to export a screenshot with `toDataURL`, which
      // otherwise reads back an empty buffer after the frame is presented.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });

    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));

    // Colour management: work in linear space, output sRGB. Without this,
    // textures are double-gamma-corrected and everything looks washed out.
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;

    // ACES Filmic maps high dynamic range down to the display gracefully —
    // it is what keeps a sunlit wall from clipping to flat white.
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.0;

    this.webgl.shadowMap.enabled = true;
    // PCF soft shadows: a reasonable quality floor without the cost of VSM.
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;

    this.observe(container);
  }

  /** Maximum anisotropy the GPU supports, for texture filtering. */
  get maxAnisotropy(): number {
    return this.webgl.capabilities.getMaxAnisotropy();
  }

  /** Registers a callback invoked whenever the container is resized. */
  setResizeHandler(handler: (width: number, height: number) => void): void {
    this.onResize = handler;
  }

  /**
   * Watches the container element rather than the window.
   *
   * A window `resize` listener misses the case that matters most here: the UI
   * panel collapsing or expanding changes the canvas size while the window
   * stays put.
   */
  private observe(container: HTMLElement): void {
    const applySize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;

      // `false` leaves the CSS size alone — it is already 100%/100%, and letting
      // Three write inline styles fights the stylesheet.
      this.webgl.setSize(width, height, false);
      this.webgl.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
      this.onResize?.(width, height);
    };

    this.resizeObserver = new ResizeObserver(applySize);
    this.resizeObserver.observe(container);
    applySize();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.webgl.dispose();
    this.canvas.remove();
  }
}

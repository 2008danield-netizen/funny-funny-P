/**
 * The 3D engine: owns the scene graph and the render loop.
 *
 * This class is the boundary between React and Three.js. React mounts it into a
 * DOM node and otherwise leaves it alone — the engine subscribes to the design
 * store directly and reacts to state changes on its own schedule. That
 * separation is deliberate: the render loop must not be coupled to React's
 * render cycle, or every colour tweak would cost a component tree reconciliation
 * and every frame would risk a React re-render.
 *
 * Data flow:
 *
 *     UI panel → designStore.edit() → store listener → Engine.applyDocument()
 *                                                   → Room / Lighting update
 *                                   → React re-render (panels only)
 */

import * as THREE from 'three';

import { Renderer } from './Renderer';
import { CameraController, type ViewpointId } from '@/controls/CameraController';
import { Lighting } from '@/scene/Lighting';
import { Room } from '@/scene/Room';
import { MaterialLibrary } from '@/scene/materials/MaterialLibrary';
import { designStore } from '@/state/store';
import type { DesignDocument } from '@/state/types';

/** Reported once per second to the UI's performance readout. */
export interface EngineStats {
  fps: number;
  /** Draw calls in the last frame — the number to watch as furniture is added. */
  drawCalls: number;
  triangles: number;
}

export class Engine {
  private renderer: Renderer;
  private scene: THREE.Scene;
  private cameraController: CameraController;
  private materials: MaterialLibrary;
  private room: Room;
  private lighting: Lighting;

  private clock = new THREE.Clock();
  private animationFrame: number | null = null;
  private unsubscribeStore: (() => void) | null = null;

  /** Accumulators for the once-per-second stats report. */
  private frameCount = 0;
  private statsTimer = 0;
  private onStats: ((stats: EngineStats) => void) | null = null;

  /** The document last applied, used to skip redundant scene updates. */
  private appliedDocument: DesignDocument | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);

    this.scene = new THREE.Scene();
    this.scene.name = 'havavamama';

    this.cameraController = new CameraController(this.renderer.canvas);
    this.renderer.setResizeHandler((width, height) => {
      this.cameraController.setViewportSize(width, height);
    });

    this.materials = new MaterialLibrary();
    this.materials.setMaxAnisotropy(this.renderer.maxAnisotropy);

    this.lighting = new Lighting(this.scene, this.renderer.webgl);
    this.scene.add(this.lighting.group);

    this.room = new Room(this.materials);
    this.scene.add(this.room.group);

    // Apply current state immediately, then track future changes.
    this.applyDocument(designStore.getState());
    this.unsubscribeStore = designStore.subscribe((doc) => this.applyDocument(doc));

    // Frame the room before the first frame is presented.
    this.cameraController.goTo('overview', designStore.getState().room);

    this.start();
  }

  /** Registers a callback for the once-per-second performance report. */
  setStatsHandler(handler: (stats: EngineStats) => void): void {
    this.onStats = handler;
  }

  /** Moves the camera to a named viewpoint. */
  goToViewpoint(viewpoint: ViewpointId): void {
    this.cameraController.goTo(viewpoint, designStore.getState().room);
  }

  /** Toggles automatic hiding of walls between the camera and the interior. */
  setAutoHideWalls(enabled: boolean): void {
    this.room.setAutoHideWalls(enabled);
  }

  /**
   * Captures the current frame as a PNG data URL.
   *
   * Renders once immediately beforehand because the drawing buffer may have
   * been presented and cleared since the last loop iteration.
   */
  captureScreenshot(): string {
    this.renderer.webgl.render(this.scene, this.cameraController.camera);
    return this.renderer.canvas.toDataURL('image/png');
  }

  /** Pushes a design document into the scene. */
  private applyDocument(doc: DesignDocument): void {
    const previous = this.appliedDocument;

    // Reference comparison is valid because the store treats documents as
    // immutable — an unchanged sub-object is guaranteed to be the same object.
    if (!previous || previous.room !== doc.room) {
      this.room.update(doc.room);
      this.cameraController.configureForRoom(doc.room);
    }

    if (!previous || previous.lighting !== doc.lighting || previous.room !== doc.room) {
      this.lighting.apply(doc.lighting, doc.room);
      this.renderer.webgl.shadowMap.enabled = doc.lighting.shadowsEnabled;
    }

    this.appliedDocument = doc;
  }

  private start(): void {
    const tick = () => {
      this.animationFrame = requestAnimationFrame(tick);

      const delta = this.clock.getDelta();

      this.cameraController.update(delta);
      this.room.updateForCamera(this.cameraController.camera);

      this.renderer.webgl.render(this.scene, this.cameraController.camera);

      this.reportStats(delta);
    };
    tick();
  }

  /** Aggregates frame timings and emits a stats report once per second. */
  private reportStats(delta: number): void {
    if (!this.onStats) return;

    this.frameCount += 1;
    this.statsTimer += delta;
    if (this.statsTimer < 1) return;

    const info = this.renderer.webgl.info;
    this.onStats({
      fps: Math.round(this.frameCount / this.statsTimer),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
    });

    this.frameCount = 0;
    this.statsTimer = 0;
  }

  /**
   * Tears everything down.
   *
   * Called when React unmounts the viewport. In development this runs on every
   * hot reload, so it has to be complete — a partial teardown leaks a render
   * loop and a WebGL context per edit, and the browser hard-caps live contexts.
   */
  dispose(): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;

    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.onStats = null;

    this.room.dispose();
    this.lighting.dispose();
    this.materials.dispose();
    this.cameraController.dispose();
    this.renderer.dispose();

    this.scene.clear();
  }
}

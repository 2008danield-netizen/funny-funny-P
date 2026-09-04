/**
 * The 3D engine: owns the scene graph, the render loop and the editing tools.
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
 *     UI panel  ─edit()─▶ designStore ─notify─▶ Engine ──▶ Building / Lighting
 *     Viewport  ────────▶ EditController ─edit()─▶ designStore  (same loop)
 *                                       └──────▶ editorStore ──▶ selection
 */

import * as THREE from 'three';

import { Renderer } from './Renderer';
import { CameraController, type ViewpointId } from '@/controls/CameraController';
import { EditController } from '@/interaction/EditController';
import { Lighting } from '@/scene/Lighting';
import { Building } from '@/scene/Building';
import { Furnishings } from '@/scene/Furnishings';
import { ClearanceOverlay } from '@/scene/ClearanceOverlay';
import { Staircases } from '@/scene/Staircases';
import { GhostLevel } from '@/scene/GhostLevel';
import { stairGeometry } from '@/building/stairs';
import { activeLevel, elevationOf, floorHoles, levelBelow } from '@/state/levels';
import { analyseClearance } from '@/clearance/analyze';
import { MaterialLibrary } from '@/scene/materials/MaterialLibrary';
import { designStore } from '@/state/store';
import { editorStore } from '@/state/selection';
import type { DesignDocument, Point2 } from '@/state/types';

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
  private building: Building;
  private furnishings: Furnishings;
  private clearanceOverlay: ClearanceOverlay;
  private staircases: Staircases;
  private ghost: GhostLevel;
  private lighting: Lighting;

  /**
   * Everything belonging to the storey being edited, parented together.
   *
   * One group carrying one elevation is what keeps "the floor is at y = 0"
   * true for every builder below this line. Walls, floors, furniture, stairs
   * and the clearance overlay all still work in their own level's coordinates;
   * this group is the single place that knows how high off the ground that
   * level actually is.
   */
  private levelGroup = new THREE.Group();
  private editController: EditController;

  private clock = new THREE.Clock();
  private animationFrame: number | null = null;
  private unsubscribeDesign: (() => void) | null = null;
  private unsubscribeEditor: (() => void) | null = null;

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

    this.building = new Building(this.materials);
    this.levelGroup.name = 'ActiveLevel';
    this.scene.add(this.levelGroup);
    this.levelGroup.add(this.building.group);

    this.furnishings = new Furnishings();
    this.levelGroup.add(this.furnishings.group);

    this.clearanceOverlay = new ClearanceOverlay();
    this.levelGroup.add(this.clearanceOverlay.group);
    this.staircases = new Staircases();
    this.levelGroup.add(this.staircases.group);
    this.ghost = new GhostLevel();
    this.levelGroup.add(this.ghost.group);

    // The edit controller drives OrbitControls' `enabled` flag directly so that
    // a drag on a wall does not also orbit the camera.
    this.editController = new EditController(
      this.renderer.canvas,
      this.cameraController.camera,
      this.building,
      this.furnishings,
      this.cameraController.controls,
    );

    // Apply current state immediately, then track future changes.
    this.applyDocument(designStore.getState());
    this.applyEditorState();
    this.unsubscribeDesign = designStore.subscribe((doc) => this.applyDocument(doc));
    this.unsubscribeEditor = editorStore.subscribe(() => this.applyEditorState());

    // Frame the plan before the first frame is presented.
    this.goToViewpoint('overview');

    this.start();
  }

  /** Registers a callback for the once-per-second performance report. */
  setStatsHandler(handler: (stats: EngineStats) => void): void {
    this.onStats = handler;
  }

  /** Moves the camera to a named viewpoint. */
  goToViewpoint(viewpoint: ViewpointId): void {
    const plan = activeLevel(designStore.getState()).plan;
    this.cameraController.goTo(viewpoint, plan, this.focusPoint());
  }

  /**
   * The point viewpoints should centre on: the middle of the biggest room.
   *
   * For a single-room plan this is the room's centre, same as before. For a
   * multi-room plan it keeps "Inside" from dropping the camera into a wall
   * between two rooms, which is where the plan's geometric centre often lands.
   */
  private focusPoint(): Point2 | undefined {
    const regions = this.building.getRegions();
    return regions.length > 0 ? regions[0]!.interiorPoint : undefined;
  }

  /** Toggles automatic hiding of walls between the camera and the interior. */
  setAutoHideWalls(enabled: boolean): void {
    this.building.setAutoHideWalls(enabled);
  }

  /** Inserts a corner at the middle of the selected wall. */
  splitSelectedWall(): void {
    this.editController.splitSelectedWall();
  }

  /** Turns the selected piece of furniture by one step. */
  rotateSelection(direction: number): void {
    this.editController.rotateSelection(direction);
  }

  /** Abandons a wall that is part-way through being drawn. */
  cancelDrawing(): void {
    this.editController.cancelDrawing();
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
    const level = activeLevel(doc);
    const previousLevel = previous ? activeLevel(previous) : null;

    // Switching storey changes everything on screen without changing a single
    // sub-object, so it has to be its own trigger rather than being inferred.
    const levelSwitched = previousLevel?.id !== level.id;

    // Reference comparison is valid because the store treats documents as
    // immutable — an unchanged sub-object is guaranteed to be the same object.
    const planChanged = levelSwitched || !previousLevel || previousLevel.plan !== level.plan;
    const ceilingsChanged = !previous || previous.showCeilings !== doc.showCeilings;

    // The whole storey rides at its own height above the ground.
    this.levelGroup.position.y = elevationOf(doc, level.id);

    const holes = floorHoles(doc, level.id, (stair) => stairGeometry(doc, stair).wellOpening);

    if (planChanged || ceilingsChanged || previous?.stairs !== doc.stairs) {
      this.building.update(level.plan, doc.showCeilings, holes);
    }
    if (levelSwitched || !previousLevel || previousLevel.furniture !== level.furniture) {
      this.furnishings.update(level.furniture);
    }
    if (levelSwitched || previous?.stairs !== doc.stairs || planChanged) {
      this.staircases.update(doc, level.id);
    }

    // The storey below, as an outline to line new walls up against.
    if (levelSwitched || planChanged || previous?.levels !== doc.levels) {
      this.ghost.update(levelBelow(doc, level.id)?.plan ?? null);
    }

    // Clearance depends on the plan, the furniture and the settings alike, so
    // it is refreshed whenever any of them moves. The overlay itself skips the
    // work while hidden.
    if (
      levelSwitched ||
      !previousLevel ||
      previousLevel.plan !== level.plan ||
      previousLevel.furniture !== level.furniture ||
      previous?.clearance !== doc.clearance
    ) {
      this.refreshClearance();
    }
    if (planChanged) {
      this.cameraController.configureForPlan(level.plan);
    }

    if (!previous || previous.lighting !== doc.lighting || planChanged) {
      this.lighting.apply(doc.lighting, level.plan);
      this.renderer.webgl.shadowMap.enabled = doc.lighting.shadowsEnabled;
    }

    this.appliedDocument = doc;
  }

  /** Recomputes the clearance report and pushes it to the overlay. */
  private refreshClearance(): void {
    if (!editorStore.getState().showClearance) return;
    const doc = designStore.getState();
    const report = analyseClearance(doc, activeLevel(doc));
    this.clearanceOverlay.update(report.zones, report.violatedZoneIds);
  }

  /** Mirrors editor state (tool, selection, hover) into the scene. */
  private applyEditorState(): void {
    const state = editorStore.getState();
    this.clearanceOverlay.setVisible(state.showClearance);
    if (state.showClearance) this.refreshClearance();
    // Corner handles and the grid belong to the plan tools; showing them while
    // arranging furniture is clutter the user cannot act on.
    const planTool = state.tool === 'move' || state.tool === 'draw';
    this.building.setEditMode(planTool);
    this.building.setSelection(state.selection);
    this.building.setHover(state.hover);

    this.furnishings.setSelection({
      selectedId: state.selection.kind === 'furniture' ? state.selection.id : null,
      hoveredId: state.hover.kind === 'furniture' ? state.hover.id : null,
      collidingIds: new Set(state.collidingIds),
    });
  }

  private start(): void {
    const tick = () => {
      this.animationFrame = requestAnimationFrame(tick);

      const delta = this.clock.getDelta();

      this.cameraController.update(delta);
      this.building.updateForCamera(this.cameraController.camera);

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

    this.unsubscribeDesign?.();
    this.unsubscribeEditor?.();
    this.unsubscribeDesign = null;
    this.unsubscribeEditor = null;
    this.onStats = null;

    this.editController.dispose();
    this.clearanceOverlay.dispose();
    this.staircases.dispose();
    this.ghost.dispose();
    this.furnishings.dispose();
    this.building.dispose();
    this.lighting.dispose();
    this.materials.dispose();
    this.cameraController.dispose();
    this.renderer.dispose();

    this.scene.clear();
  }
}

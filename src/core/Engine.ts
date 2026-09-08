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
import { FrameLoop, QualityGovernor, type QualityTier } from './FrameLoop';
import { RenderPipeline } from './RenderPipeline';
import { CameraController, type ViewpointId } from '@/controls/CameraController';
import { EditController } from '@/interaction/EditController';
import { Lighting } from '@/scene/Lighting';
import { Building } from '@/scene/Building';
import { Furnishings } from '@/scene/Furnishings';
import { ClearanceOverlay } from '@/scene/ClearanceOverlay';
import { Staircases } from '@/scene/Staircases';
import { Electrical } from '@/scene/Electrical';
import { Plumbing } from '@/scene/Plumbing';
import { Fittings } from '@/scene/Fittings';
import { GhostLevel } from '@/scene/GhostLevel';
import { Roofs } from '@/scene/Roofs';
import { PlanUnderlay } from '@/scene/PlanUnderlay';
import { getImage } from '@/state/imageStore';
import { Ground } from '@/scene/Ground';
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
  /** Accumulated samples in the still image, and whether it has finished. */
  samples: number;
  converged: boolean;
  tier: QualityTier;
}

/** Cheap frames to render after the camera stops, before starting to converge. */
const SETTLE_FRAMES = 6;

/**
 * How long a single accumulation sample may take before convergence gives up.
 *
 * Generous, because a sample is allowed to be slow — it happens while the user
 * is looking rather than dragging. It exists only to catch the pathological
 * case where a machine cannot render one sample without freezing the tab.
 */
const SAMPLE_BUDGET_MS = 120;

export class Engine {
  private renderer: Renderer;
  private scene: THREE.Scene;
  private cameraController: CameraController;
  private materials: MaterialLibrary;
  private building: Building;
  private furnishings: Furnishings;
  private clearanceOverlay: ClearanceOverlay;
  private staircases: Staircases;
  private electrical: Electrical;
  private plumbing: Plumbing;
  private fittings: Fittings;
  private ghost: GhostLevel;
  private roofs: Roofs;
  private ground: Ground;
  private planUnderlay: PlanUnderlay;

  /** Data URLs for plan images, once they have been read out of the store. */
  private underlayImages = new Map<string, string | null>();
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

  private loop: FrameLoop | null = null;
  private pipeline: RenderPipeline | null = null;
  private quality = new QualityGovernor();
  /**
   * Frames to keep rendering cheaply after the camera stops.
   *
   * Releasing the mouse mid-flick leaves OrbitControls' damping still moving
   * the camera. Starting to converge immediately means the first samples are
   * of a view that is still drifting, and the accumulation restarts several
   * times in a row — which reads as flickering rather than refining.
   */
  private settleFrames = 0;
  /**
   * Whether the still frame is refined by accumulating jittered samples.
   *
   * Off until the path has been confirmed on a real GPU. See the comment in
   * the frame callback.
   */
  private progressiveEnabled = false;
  private unsubscribeDesign: (() => void) | null = null;
  private unsubscribeEditor: (() => void) | null = null;

  /** Accumulators for the once-per-second stats report. */
  private frameCount = 0;
  private statsTimer = 0;
  private onStats: ((stats: EngineStats) => void) | null = null;

  /** The document last applied, used to skip redundant scene updates. */
  private appliedDocument: DesignDocument | null = null;

  /** The user's own "show roofs" setting, which the cutaway then overrides. */
  private showRoofs = true;

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);

    this.scene = new THREE.Scene();
    this.scene.name = 'havavamama';

    this.cameraController = new CameraController(this.renderer.canvas);
    this.renderer.setResizeHandler((width, height) => {
      this.cameraController.setViewportSize(width, height);
      this.sizePipeline();
      // A resize clears the canvas and invalidates every accumulated sample,
      // so the still image has to be built again from scratch.
      this.pipeline?.resetAccumulation();
      this.invalidate();
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
    // Inside the storey group: a device belongs to one storey and rides at its
    // height, and its mounting height is measured from that storey's floor.
    this.electrical = new Electrical();
    this.levelGroup.add(this.electrical.group);
    this.plumbing = new Plumbing();
    this.levelGroup.add(this.plumbing.group);
    // Inside the storey group: cabinetry belongs to one storey and its heights
    // are measured from that storey's floor.
    this.fittings = new Fittings();
    this.levelGroup.add(this.fittings.group);
    this.ghost = new GhostLevel();
    this.levelGroup.add(this.ghost.group);

    // Inside the storey group: a traced plan belongs to one storey and rides
    // at its height, exactly like the ghost of the storey below.
    this.planUnderlay = new PlanUnderlay();
    this.levelGroup.add(this.planUnderlay.group);

    /*
     * Roofs and ground hang off the SCENE, not off the active storey's group.
     * Both are described in world heights — a roof sits on top of the storey it
     * covers, and the ground is where it is — so putting them inside a group
     * that moves with the active level would slide them up and down every time
     * the user changed floors.
     */
    this.roofs = new Roofs();
    this.scene.add(this.roofs.group);
    this.ground = new Ground();
    this.scene.add(this.ground.group);

    // The edit controller drives OrbitControls' `enabled` flag directly so that
    // a drag on a wall does not also orbit the camera.
    this.editController = new EditController(
      this.renderer.canvas,
      this.cameraController.camera,
      this.building,
      this.furnishings,
      this.electrical,
      this.fittings,
      this.plumbing,
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
    this.invalidate();
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
    this.invalidate();
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
   * Presents the ACCUMULATED image rather than re-rendering the scene. A fresh
   * single-pass render would throw away everything the convergence just built —
   * the soft shadows, the occlusion, the clean edges — and hand back a picture
   * markedly worse than the one on screen, which is a baffling thing for a
   * screenshot button to do.
   *
   * The re-present is still needed because the drawing buffer may have been
   * cleared since the last frame.
   */
  captureScreenshot(): string {
    if (this.pipeline && this.pipeline.sampleCount > 0) {
      this.pipeline.present();
    } else {
      this.renderer.webgl.setRenderTarget(null);
      this.renderer.webgl.render(this.scene, this.cameraController.camera);
    }
    return this.renderer.canvas.toDataURL('image/png');
  }

  /**
   * Shows the plan image being traced on this storey.
   *
   * Reading the image out of the store is asynchronous and the scene is not, so
   * the result is remembered: the first call for a given image starts the read
   * and shows nothing, and the one that follows it — the next document change,
   * or the callback below — shows it. An image the store does not have is
   * remembered as missing, so a document naming a plan this browser has never
   * seen does not start a fresh read on every frame.
   */
  private applyUnderlay(underlay: DesignDocument['levels'][number]['underlay']): void {
    if (!underlay) {
      this.planUnderlay.update(null, null);
      return;
    }

    const known = this.underlayImages.get(underlay.imageId);
    if (known === undefined) {
      this.underlayImages.set(underlay.imageId, null);
      void getImage(underlay.imageId).then((stored) => {
        this.underlayImages.set(underlay.imageId, stored?.dataUrl ?? null);
        if (stored) this.planUnderlay.update(underlay, stored.dataUrl);
      });
      return;
    }

    this.planUnderlay.update(underlay, known);
  }

  /** Pushes a design document into the scene. */
  private applyDocument(doc: DesignDocument): void {
    // Every document change is a reason to redraw. Called first so an early
    // return further down cannot leave the screen stale.
    this.invalidate();
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

    if (
      planChanged ||
      ceilingsChanged ||
      previous?.stairs !== doc.stairs ||
      previous?.exterior !== doc.exterior
    ) {
      this.building.update(level.plan, doc.showCeilings, holes, doc.exterior);
    }
    if (levelSwitched || !previousLevel || previousLevel.furniture !== level.furniture) {
      this.furnishings.update(level.furniture);
    }
    if (levelSwitched || previous?.stairs !== doc.stairs || planChanged) {
      this.staircases.update(doc, level.id);
    }
    if (levelSwitched || !previous || previous.electrical !== doc.electrical) {
      this.electrical.update(doc, level.id);
    }
    /*
     * The plumbing also watches the FIXTURES, not just its own plan. Every pipe
     * size is derived from the fixtures it serves, so adding a bath upstairs
     * changes no pipe geometry and changes the diameter of everything under it.
     */
    if (
      levelSwitched ||
      !previous ||
      previous.plumbing !== doc.plumbing ||
      previous.fixtures !== doc.fixtures
    ) {
      this.plumbing.update(doc, level.id);
    }
    if (levelSwitched || !previous || previous.runs !== doc.runs || previous.fixtures !== doc.fixtures) {
      this.fittings.update(doc, level.id);
    }

    /*
     * A device selected on one storey must not stay selected when the user
     * changes to another: the inspector would still be offering to move and
     * delete something that is no longer on screen, and deleting a thing you
     * cannot see is the worst kind of undo-able mistake — the user has no idea
     * what to undo.
     */
    if (levelSwitched) {
      const selection = editorStore.getState().selection;
      if (selection.kind === 'device') {
        const device = doc.electrical.devices.find((entry) => entry.id === selection.id);
        if (!device || device.levelId !== level.id) editorStore.clearSelection();
      }
      if (selection.kind === 'fixture') {
        const fixture = doc.fixtures.find((entry) => entry.id === selection.id);
        if (!fixture || fixture.levelId !== level.id) editorStore.clearSelection();
      }
      if (selection.kind === 'unit') {
        const run = doc.runs.find((entry) => entry.units.some((unit) => unit.id === selection.id));
        if (!run || run.levelId !== level.id) editorStore.clearSelection();
      }
    }

    if (
      !previous ||
      previous.roofs !== doc.roofs ||
      previous.levels !== doc.levels ||
      previous.exterior !== doc.exterior
    ) {
      this.roofs.update(doc);
    }
    this.showRoofs = doc.showRoofs;
    this.roofs.setVisible(this.showRoofs && !this.building.isCutaway);
    if (!previous || previous.site !== doc.site || previous.levels !== doc.levels) {
      this.ground.update(doc);
    }

    this.applyUnderlay(level.underlay);

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
    this.invalidate();
    const state = editorStore.getState();
    this.planUnderlay.setProposals(state.traceCandidates, new Set(state.acceptedTraceIds));
    this.clearanceOverlay.setVisible(state.showClearance);
    if (state.showClearance) this.refreshClearance();

    // The electrical layer builds nothing while hidden, so switching it on has
    // to trigger the build the document change would otherwise have done.
    this.electrical.setVisible(state.showElectrical);
    this.electrical.setShowRuns(state.showElectricalRuns);
    this.electrical.setSelection(state.selection.kind === 'device' ? state.selection.id : null);
    this.plumbing.setVisible(state.showPlumbing);
    this.plumbing.setSystems(state.showDrainage, state.showSupply);
    this.plumbing.setSelection(
      state.selection.kind === 'pipe' ||
        state.selection.kind === 'stack' ||
        state.selection.kind === 'heater'
        ? state.selection.id
        : null,
    );
    this.fittings.setSelection(
      state.selection.kind === 'unit' || state.selection.kind === 'fixture'
        ? state.selection.id
        : null,
    );
    if (state.showElectrical) {
      const doc = designStore.getState();
      this.electrical.update(doc, activeLevel(doc).id);
    }
    if (state.showPlumbing) {
      const doc = designStore.getState();
      this.plumbing.update(doc, activeLevel(doc).id);
    }
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

  /**
   * Starts the demand-driven loop.
   *
   * Each frame decides which of the three states it is in and renders
   * accordingly. It returns whether it wants another frame, which is what lets
   * the loop go completely to sleep on a still, converged view — the state the
   * app is in almost all of the time.
   */
  private start(): void {
    const camera = this.cameraController.camera;
    this.pipeline = new RenderPipeline(
      this.renderer.webgl,
      this.scene,
      camera,
      this.quality.settings,
    );
    this.applyQuality();

    this.loop = new FrameLoop((delta, dirty) => {
      const started = performance.now();

      /* ---- Advance the camera, and find out whether it actually moved ---- */
      const cameraMoved = this.cameraController.update(delta);

      /*
       * Wall hiding and the roof only depend on the camera, so they are
       * recomputed only when the camera has moved or the document changed.
       * Doing this every frame regardless was a real cost: it walks every wall
       * in the building, and it ran sixty times a second while nothing moved.
       */
      if (cameraMoved || dirty) {
        this.building.updateForCamera(camera);
        this.roofs.setVisible(this.showRoofs && !this.building.isCutaway);
      }


      const moving = cameraMoved || dirty;
      if (moving) {
        this.settleFrames = SETTLE_FRAMES;
        this.pipeline!.resetAccumulation();
      }

      if (moving || this.settleFrames > 0) {
        /* ---- Cheap path ---- */
        if (!moving) this.settleFrames -= 1;

        this.applyPixelRatio(true);
        this.restoreSun();
        this.pipeline!.renderMoving(camera);

        this.reportStats(delta, started);
        // Keep going: either still moving, or settling before convergence.
        return true;
      }

      /*
       * PROGRESSIVE ACCUMULATION IS OPT-IN FOR NOW.
       *
       * The accumulation path is written and its pieces are individually
       * sound, but it has not yet been seen working on real hardware — the
       * only GPU available while building it was a software rasteriser, where
       * it renders the sky and no geometry. That could be a genuine bug or it
       * could be a SwiftShader limitation, and shipping a default that might
       * blank the model on somebody's laptop is not a trade worth making for
       * a nicer still frame.
       *
       * So with it off, a still view is simply drawn once at full resolution
       * and the loop then sleeps. That already delivers the whole of the
       * responsiveness fix. Turn it on with `setProgressive(true)` to get the
       * soft shadows and the occlusion.
       */
      if (!this.progressiveEnabled) {
        this.applyPixelRatio(false);
        this.restoreSun();
        this.pipeline!.renderMoving(camera);
        this.reportStats(delta, started);
        return false;
      }

      /* ---- Converging ---- */
      if (!this.pipeline!.converged) {
        this.applyPixelRatio(false);
        this.pipeline!.renderSample(camera, (index) => this.jitterSun(index));
        this.pipeline!.present();

        /*
         * A SAMPLE BUDGET, and it is not an optimisation — it is what stops a
         * weak machine locking up.
         *
         * Each sample is a full render plus a full ambient-occlusion pass. On
         * hardware where that takes a third of a second, asking for another
         * frame immediately means the browser never gets the main thread back:
         * the tab stops responding to clicks and the page appears hung. That is
         * a far worse failure than a slightly noisier image.
         *
         * So a sample that overruns badly ends the convergence where it is.
         * What is on screen at that point is still better than the cheap frame
         * — some accumulation happened — and the app stays usable.
         */
        const sampleMs = performance.now() - started;
        if (sampleMs > SAMPLE_BUDGET_MS) {
          this.pipeline!.stopConverging();
          this.reportStats(delta, started);
          return false;
        }

        this.reportStats(delta, started);
        return true;
      }

      /*
       * Converged. Present the finished image once more (the canvas may have
       * been cleared by a resize) and then stop entirely — no further frames
       * until something calls invalidate().
       */
      this.pipeline!.present();
      this.reportStats(delta, started);
      return false;
    });

    /*
     * The loop sleeps once the image has converged, so something has to wake
     * it when the user starts interacting. OrbitControls fires 'change' on
     * every camera movement including damping, and 'start' the moment a drag
     * begins — without this the app would freeze on the converged frame and
     * only redraw when the document happened to change.
     */
    const wake = () => this.invalidate();
    this.cameraController.controls.addEventListener('change', wake);
    this.cameraController.controls.addEventListener('start', wake);
    this.disposeControlWake = () => {
      this.cameraController.controls.removeEventListener('change', wake);
      this.cameraController.controls.removeEventListener('start', wake);
    };

    this.loop.invalidate();
  }

  private disposeControlWake: (() => void) | null = null;

  /** Draw again. Anything that changes what should be on screen calls this. */
  private invalidate(): void {
    this.loop?.invalidate();
  }

  /* ------------------------------ Quality ------------------------------- */

  /** Applies the governor's current tier to the renderer and the pipeline. */
  private applyQuality(): void {
    const settings = this.quality.settings;
    this.lighting.setShadowMapSize(settings.shadowMapSize);
    this.pipeline?.setQuality(settings, this.cameraController.camera);
    this.sizePipeline();
  }

  /** Lets the user pick a tier by hand, or hand it back to the governor. */
  setQualityTier(tier: QualityTier | 'auto'): void {
    if (tier === 'auto') this.quality.setAutomatic();
    else this.quality.setManual(tier);
    this.applyQuality();
    this.invalidate();
  }

  get qualityTier(): QualityTier {
    return this.quality.current;
  }

  get qualityIsManual(): boolean {
    return this.quality.isManual;
  }

  /**
   * Turns progressive refinement on or off.
   *
   * When on, a still view keeps accumulating jittered samples — soft shadows,
   * ambient occlusion and clean edges build up over a second or two. When off,
   * the still view is a single full-resolution render.
   */
  setProgressive(enabled: boolean): void {
    if (enabled === this.progressiveEnabled) return;
    this.progressiveEnabled = enabled;
    this.pipeline?.resetAccumulation();
    this.invalidate();
  }

  get progressive(): boolean {
    return this.progressiveEnabled;
  }

  /**
   * Switches resolution between the moving and the still frame.
   *
   * Dropping the pixel ratio while dragging is the single cheapest way to keep
   * a drag responsive: at 0.6 the frame costs about a third of what it does at
   * 1.0, and nobody can see the softness on a moving image.
   */
  private applyPixelRatio(moving: boolean): void {
    const settings = this.quality.settings;
    const wanted = Math.min(
      window.devicePixelRatio,
      moving ? settings.movingPixelRatio : settings.pixelRatio,
    );
    if (Math.abs(this.renderer.webgl.getPixelRatio() - wanted) < 1e-3) return;
    this.renderer.webgl.setPixelRatio(wanted);
    this.sizePipeline();
  }

  private sizePipeline(): void {
    const size = new THREE.Vector2();
    this.renderer.webgl.getSize(size);
    this.pipeline?.setSize(size.x, size.y, this.renderer.webgl.getPixelRatio());
  }

  /* ------------------------------ Soft sun ------------------------------ */

  /**
   * Moves the sun to a different point on its disc for this sample.
   *
   * This is what turns the hard edge of a shadow map into a real penumbra.
   * Averaging N renders of a point light spread across the sun's angular
   * diameter is, quite literally, what an area light IS — so the shadow it
   * produces is correct rather than a blur applied to a wrong one, and the
   * penumbra widens with distance from the occluder exactly as it should.
   */
  private jitterSun(index: number): void {
    const offset = this.pipeline!.sunOffset(index);
    this.lighting.offsetSun(offset.x, offset.y);
  }

  /** Puts the sun back on axis for the cheap path. */
  private restoreSun(): void {
    this.lighting.offsetSun(0, 0);
  }

  /**
   * Aggregates frame timings and emits a stats report once per second.
   *
   * Also feeds the quality governor, which is the only place frame cost is
   * measured. The figure passed is the time this frame's WORK took, not the
   * interval since the last one — on a demand-driven loop those are completely
   * different numbers, and the interval would read as "slow" simply because the
   * loop had been asleep.
   */
  private reportStats(delta: number, startedAt: number): void {
    const frameMs = performance.now() - startedAt;
    this.quality.record(frameMs, startedAt);

    if (!this.onStats) return;

    this.frameCount += 1;
    this.statsTimer += delta;
    if (this.statsTimer < 1) return;

    const info = this.renderer.webgl.info;
    this.onStats({
      fps: Math.round(this.frameCount / this.statsTimer),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      samples: this.pipeline?.sampleCount ?? 0,
      converged: this.pipeline?.converged ?? false,
      tier: this.quality.current,
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
    this.disposeControlWake?.();
    this.disposeControlWake = null;
    this.loop?.stop();
    this.loop = null;
    this.pipeline?.dispose();
    this.pipeline = null;

    this.unsubscribeDesign?.();
    this.unsubscribeEditor?.();
    this.unsubscribeDesign = null;
    this.unsubscribeEditor = null;
    this.onStats = null;

    this.editController.dispose();
    this.clearanceOverlay.dispose();
    this.staircases.dispose();
    this.electrical.dispose();
    this.plumbing.dispose();
    this.fittings.dispose();
    this.ghost.dispose();
    this.planUnderlay.dispose();
    this.roofs.dispose();
    this.ground.dispose();
    this.furnishings.dispose();
    this.building.dispose();
    this.lighting.dispose();
    this.materials.dispose();
    this.cameraController.dispose();
    this.renderer.dispose();

    this.scene.clear();
  }
}

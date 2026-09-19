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

import { interactablesOn } from '@/walk/interactables';
import { checkAcoustics } from '@/services/acousticCheck';

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
import { Hvac } from '@/scene/Hvac';
import { SectionClip } from '@/scene/SectionClip';
import { WalkMode } from './WalkMode';
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
import { bakeSkyVisibility, fillUnbaked, useBakedAmbient } from '@/scene/skyBake';
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
  private hvac: Hvac;
  private sectionClip: SectionClip;
  private walk: WalkMode | null = null;
  private onWalkChange: (() => void) | null = null;
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

  /**
   * Pending sky-visibility bake, and why it is debounced rather than immediate.
   *
   * The bake casts forty-eight rays from every vertex of every surface, which
   * for an ordinary room is around a hundred thousand casts. That is fine once
   * and ruinous sixty times a second, and dragging a wall corner rebuilds the
   * geometry on every mouse move. So the rebuild is cheap and unbaked, and the
   * bake lands shortly after the dragging stops.
   */
  private bakeTimer: number | null = null;
  /** Whether the sky bake runs at all. `__bakeProbe(false)` turns it off. */
  private bakeEnabled = true;

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
    this.hvac = new Hvac();
    this.levelGroup.add(this.hvac.group);

    this.sectionClip = new SectionClip();
    // Local clipping has to be switched on once, or every plane is ignored in
    // silence — which looks exactly like a plane in the wrong place.
    this.renderer.webgl.localClippingEnabled = true;
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
      this.hvac,
      this.cameraController.controls,
    );

    /*
     * Closures rather than a reference, because the walk mode that owns the
     * live state is not built until `start()` a few lines below. Looked up at
     * the moment of the click, which is long after that.
     */
    this.editController.setUseHandlers(
      (id) => this.useThing(id),
      (id) => this.describeThing(id),
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

  /* ------------------------------ Walkthrough ----------------------------- */

  /** Told whenever the mode, the pointer lock or the XR session changes. */
  setWalkHandler(handler: (() => void) | null): void {
    this.onWalkChange = handler;
  }

  /** Drops somebody into the building. False when there is no room to enter. */
  enterWalkthrough(): boolean {
    const entered = this.walk?.enter(designStore.getState()) ?? false;
    if (entered) {
      /*
       * The orbit controls have to be switched off, not merely ignored.
       *
       * They write the camera in their own `update()`, so leaving them enabled
       * means two things writing the same camera every frame and a view that
       * fights itself.
       */
      this.cameraController.controls.enabled = false;
      // The ceiling override only takes effect on a rebuild, and nothing about
      // the document changed — so ask for one.
      this.rebuildForMode();
      /*
       * Accumulation is switched off for the duration.
       *
       * It converges on a still camera, and a walker is never still. Left on it
       * would reset every frame and do nothing but cost — and in a headset it
       * would cost the frame budget the whole feature depends on.
       */
      this.building.updateForCamera(this.cameraController.camera);
      this.invalidate();
    }
    return entered;
  }

  exitWalkthrough(): void {
    /*
     * Every door back to fully open before the live state is thrown away —
     * which is how this app draws them, so the swing is visible. Doing it after
     * the reset would leave whatever was last pushed in sitting in the scene
     * with nothing owning it.
     */
    for (const openingId of this.building.movableOpenings()) {
      this.building.setOpeningOpenness(openingId, 1);
    }
    // And everything else back to shut and off, for the same reason.
    for (const unitId of this.fittings.movableUnits()) {
      this.fittings.setUnitOpenness(unitId, 0);
    }
    for (const fixtureId of this.fittings.tapFixtures()) {
      this.fittings.setTapRunning(fixtureId, false);
    }

    this.walk?.exit();
    this.rebuildForMode();
    // Put the orbit camera back in charge of its own framing.
    this.cameraController.controls.enabled = true;
    this.invalidate();
  }

  /** Rebuilds the storey because the MODE changed rather than the document. */
  private rebuildForMode(): void {
    const doc = designStore.getState();
    const level = activeLevel(doc);
    const holes = floorHoles(doc, level.id, (stair) => stairGeometry(doc, stair).wellOpening);

    const wantCeilings = doc.showCeilings || this.walkingThrough;
    this.lastCeilings = wantCeilings;
    this.building.update(level.plan, wantCeilings, holes, doc.exterior);

    /*
     * RE-BAKE, BECAUSE THE MODE CHANGED WHAT THE BUILDING IS.
     *
     * Entering the walkthrough switches the ceilings on. An invisible mesh
     * blocks no rays, so a bake taken in the orbit view describes a room open
     * to the sky — every wall brightly lit from above and no sense of being
     * indoors at all, which is the precise opposite of what the walkthrough is
     * for. Leaving again switches them off and the same argument runs backwards.
     *
     * Cheap to miss, because nothing about it looks wrong in isolation: the
     * bake ran, it reported a healthy spread, and it answered a question about
     * a different building from the one on screen.
     */
    this.scheduleSkyBake();
  }

  get walkingThrough(): boolean {
    return this.walk?.active ?? false;
  }

  get walkState() {
    return this.walk?.state ?? null;
  }

  get pointerLocked(): boolean {
    return this.walk?.pointerLocked ?? false;
  }

  resumeWalkPointer(): void {
    this.walk?.resumePointer();
  }

  /** What the crosshair should say: what is in reach and what using it does. */
  get walkPrompt(): { label: string; verb: string } | null {
    return this.walk?.prompt ?? null;
  }

  /** What is open and what is on, for the panel — null when there is nothing. */
  get liveSummary() {
    return this.walk?.liveSummary() ?? null;
  }

  get lightsInUse(): number {
    return this.walk?.lightsInUse ?? 0;
  }

  setLamp(lampId: string): void {
    this.walk?.setLamp(lampId);
  }

  /* ----------------------------------- Sound ------------------------------- */

  /**
   * Whether sound is actually coming out.
   *
   * Not "whether sound is switched on" — those are different, and the gap
   * between them is the whole autoplay problem. A browser leaves the context
   * suspended until a gesture and does it silently, so the panel has to be able
   * to say "click to allow sound" rather than leaving somebody turning the
   * volume up on a context that was never resumed.
   */
  get soundRunning(): boolean {
    return this.walk?.sound.engine.running ?? false;
  }

  get soundState(): string {
    return this.walk?.sound.engine.state ?? 'not started';
  }

  /** How many continuous sounds are open, for the panel to show honestly. */
  get soundBeds(): number {
    return this.walk?.sound.engine.bedCount ?? 0;
  }

  /** Starts the audio context. Must be called from a real user gesture. */
  async startAudio(): Promise<boolean> {
    return (await this.walk?.sound.start()) ?? false;
  }

  /** The level actually coming out of the master bus, as an RMS. */
  get soundLevel(): number {
    return this.walk?.sound.engine.level() ?? 0;
  }

  /* --------------------- Using things from the orbit view ----------------- */

  /**
   * Opens, closes, switches or runs whatever was clicked.
   *
   * Takes what the picker already found rather than doing its own ray: the
   * orbit view has a full mesh picker and it is better at this than a sphere
   * test would be, because up there you are looking at the door itself rather
   * than reaching for its handle.
   *
   * Returns what happened, for the toolbar to say, or null if that thing is
   * not something you can use.
   */
  useThing(id: string): string | null {
    if (!this.walk) return null;

    const doc = designStore.getState();
    const said = this.walk.useThing(doc, doc.activeLevelId, id);
    if (said) this.pushOpenness();
    return said;
  }

  /** What using it would do, for the hover readout. Nothing is changed. */
  describeThing(id: string): { label: string; verb: string } | null {
    if (!this.walk) return null;
    const doc = designStore.getState();
    return this.walk.describe(doc, doc.activeLevelId, id);
  }

  /**
   * Pushes how far each door stands open into the scene.
   *
   * The live state owns the fractions and the scene owns the geometry, and
   * this is the one line between them. Cheap: a handful of openings on one
   * storey, and setting a rotation that has not changed costs nothing.
   */
  private pushOpenness(): void {
    if (!this.walk) return;

    for (const [openingId, fraction] of this.walk.opennessByOpening()) {
      this.building.setOpeningOpenness(openingId, fraction);
    }
    for (const [unitId, fraction] of this.walk.opennessByUnit()) {
      this.fittings.setUnitOpenness(unitId, fraction);
    }

    const running = this.walk.runningTaps();
    for (const fixtureId of this.fittings.tapFixtures()) {
      this.fittings.setTapRunning(fixtureId, running.has(fixtureId));
    }
  }

  get frameSummary(): string {
    return this.walk?.budget.summary ?? 'no frames measured yet';
  }

  get frameStats() {
    return this.walk?.budget.stats ?? null;
  }

  applyComfort(comfort: Parameters<WalkMode['setComfort']>[0]): void {
    this.walk?.setComfort(comfort);
  }

  static xrAvailable(): Promise<boolean> {
    return WalkMode.xrAvailable();
  }

  get presenting(): boolean {
    return this.walk?.presenting ?? false;
  }

  /**
   * Enters a headset session and hands the frames over to the runtime.
   *
   * `requestAnimationFrame` does not drive an XR session — the headset does,
   * through `setAnimationLoop`, at its own rate. Leaving the ordinary loop
   * running gives a black headset with a perfectly healthy tab behind it.
   */
  async enterXr(): Promise<void> {
    if (!this.walk) return;
    await this.walk.enterXr(designStore.getState());

    this.loop?.stop();
    this.renderer.webgl.setAnimationLoop(() => this.renderXrFrame());
  }

  async exitXr(): Promise<void> {
    if (!this.walk) return;
    await this.walk.exitXr();

    this.renderer.webgl.setAnimationLoop(null);
    this.loop?.invalidate();
  }

  /**
   * One frame inside a session.
   *
   * Deliberately the plain path: no accumulation, no pixel-ratio games, no
   * post-processing. The runtime is rendering twice, once per eye, inside a
   * budget under ten milliseconds — and everything clever this app does for a
   * still desktop frame is worth nothing to somebody who is walking.
   */
  private renderXrFrame(): void {
    const now = performance.now();
    const delta = this.lastXrFrame > 0 ? (now - this.lastXrFrame) / 1000 : 1 / 90;
    this.lastXrFrame = now;

    const doc = designStore.getState();
    this.walk?.update(doc, delta);

    this.renderer.webgl.render(this.scene, this.cameraController.camera);
    this.walk?.budget.record(performance.now() - now);
  }

  private lastXrFrame = 0;
  /** What the ceilings were last built as, so the override can be noticed. */
  private lastCeilings: boolean | null = null;

  /**
   * Two hooks on `window` for automated checking, and why they are not
   * wrapped in a development-only flag.
   *
   * Pointer lock needs a real user gesture, which a headless browser cannot
   * produce — so without these the entire walkthrough can only ever be tested
   * by a person putting their hands on it, and a feature like that quietly
   * rots. Both are read-only or drive the same intent the real input produces,
   * neither exposes anything the console could not already reach through the
   * scene, and stripping them in a production build would mean the thing
   * shipped is not the thing tested.
   */
  private exposeProbe(): void {
    const scope = window as unknown as Record<string, unknown>;

    scope.__walkProbe = () => {
      const camera = this.cameraController.camera;
      const state = this.walkState;
      return {
        walking: this.walkingThrough,
        presenting: this.presenting,
        camera: {
          x: +camera.position.x.toFixed(3),
          y: +camera.position.y.toFixed(3),
          z: +camera.position.z.toFixed(3),
        },
        standing: state ? { y: +state.standing.y.toFixed(3), kind: state.standing.kind } : null,
        view: this.walk?.walkView ?? null,
        pose: this.walk?.figurePose ?? null,
        frames: this.frameSummary,
      };
    };

    scope.__walkDrive = (intent: Record<string, number>, seconds: number) =>
      this.walk?.drive(designStore.getState(), intent, seconds) ?? null;

    /*
     * Where each usable thing is on screen, for automated checking.
     *
     * Not a way to use things without clicking — the point is the opposite. A
     * headless browser can click a pixel perfectly well; what it cannot do is
     * work out WHICH pixel a door is at. So this answers only that, and the
     * check then goes through the real picker, the real ray and the real tool,
     * rather than through a shortcut that proves nothing about any of them.
     */
    scope.__usableProbe = () => {
      if (!this.walk) return [];

      const doc = designStore.getState();
      const camera = this.cameraController.camera;
      const canvas = this.renderer.canvas;
      const items = interactablesOn(doc, doc.activeLevelId);

      return items.map((item) => {
        const projected = new THREE.Vector3(item.at.x, item.at.y, item.at.z).project(camera);
        return {
          id: item.id,
          kind: item.kind,
          label: item.label,
          // Clipped points come back outside the canvas, which is the honest
          // answer: a door behind the camera has no pixel.
          x: Math.round(((projected.x + 1) / 2) * canvas.clientWidth),
          y: Math.round(((1 - projected.y) / 2) * canvas.clientHeight),
          onScreen: Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z < 1,
        };
      });
    };

    scope.__pickProbe = (x: number, y: number) => this.editController.pickAtClient(x, y);

    /*
     * What the sky bake did, for automated checking.
     *
     * The one number that separates a working bake from one that ran and
     * achieved nothing is the SPREAD: if every vertex came back seeing the same
     * amount of sky, the result is a uniform tint and the room is as flat as it
     * was. `mean` and `darkest` together say whether there is a gradient at all.
     */
    scope.__bakeProbe = (run?: boolean) => {
      if (run === false) {
        this.bakeEnabled = false;
        return this.lastBake;
      }
      if (run) {
        this.bakeEnabled = true;
        this.runSkyBake();
      }
      return this.lastBake;
    };

    /*
     * The baked field itself, point by point, and why a summary is not enough.
     *
     * `__bakeProbe` reports a mean and a darkest, which together say whether
     * there is a gradient — and say nothing at all about its SHAPE. The first
     * picture out of the finished bake had a hard diagonal line across two
     * walls, and no summary statistic could have distinguished that from the
     * soft corner darkening it was supposed to be. This hands back every baked
     * point with its world position so the pattern can be looked at directly.
     */
    scope.__bakeField = (name: string) => {
      const points: { x: number; y: number; z: number; a: number }[] = [];
      const seen = new Set<string>();

      this.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.name.startsWith(name)) return;
        const position = mesh.geometry.getAttribute('position');
        const baked = mesh.geometry.getAttribute('bakedAmbient');
        if (!position || !baked) return;

        mesh.updateMatrixWorld(true);
        const at = new THREE.Vector3();
        for (let v = 0; v < position.count; v++) {
          at.fromBufferAttribute(position, v).applyMatrix4(mesh.matrixWorld);
          const key = `${Math.round(at.x * 1000)},${Math.round(at.y * 1000)},${Math.round(at.z * 1000)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          points.push({
            x: Math.round(at.x * 1000) / 1000,
            y: Math.round(at.y * 1000) / 1000,
            z: Math.round(at.z * 1000) / 1000,
            a: Math.round(baked.getX(v) * 1000) / 1000,
          });
        }
      });

      return points;
    };

    /*
     * Ambient occlusion on or off, and a viewpoint to judge it from.
     *
     * A/B on the same frame is the only honest way to see what a post effect is
     * contributing. Session 18 nearly shipped an occlusion pass that did
     * nothing, on the strength of a screenshot that looked plausible.
     */
    scope.__aoProbe = (
      enabled: boolean,
      viewpoint?: string,
      mode?: 'default' | 'ao' | 'denoise' | 'normal' | 'depth',
      params?: Record<string, number | boolean>,
    ) => {
      if (viewpoint) this.goToViewpoint(viewpoint as ViewpointId);
      this.pipeline?.setAmbientOcclusion(enabled, this.cameraController.camera);
      if (mode) this.pipeline?.setAoOutput(mode);
      if (params) this.pipeline?.setAoParams(params);
      this.invalidate();
      return { enabled, mode: mode ?? 'default', params: this.pipeline?.aoParams ?? null };
    };

    /*
     * Enters the walkthrough in a given view, for automated checking.
     *
     * The panel's own buttons cannot be used from a headless browser: entering
     * the walkthrough asks for pointer lock, and pointer lock needs a real user
     * gesture that no automation can produce. This goes through `editorStore`,
     * which is the same path the buttons take — the engine reacts to the state
     * rather than to the click, so what this exercises is the real transition.
     */
    scope.__walkView = (view: 'first' | 'third') => {
      editorStore.patch({ walkthrough: true, walkView: view });
      return { walkthrough: true, view };
    };

    scope.__liveProbe = () => this.liveSummary;

    /*
     * What the sound is actually doing, for automated checking.
     *
     * `level` is the one that matters and the one nothing else can answer: a
     * suspended context, a muted master, a voice that rendered silence and a
     * panner pointing the wrong way all look identical from outside and all
     * come back as zero here. Measuring it is the difference between checking
     * that sound works and checking that it was switched on.
     */
    /*
     * Uses something by id, for automated checking.
     *
     * The orbit-view path takes a real click and the walkthrough path takes a
     * real crosshair, and neither is available to a headless browser: pointer
     * lock needs a gesture it cannot produce. This goes through the same
     * `useThing` both of those end in, so what it exercises is the real live
     * state rather than a stand-in.
     */
    scope.__useProbe = (id: string) => this.useThing(id);

    /*
     * Flips one sound setting, for automated checking.
     *
     * Through the editor store rather than around it, so what it exercises is
     * the real path: store → `applyEditorState` → `setSound` → the soundscape.
     * The panel's own checkbox drives exactly the same line.
     *
     * It exists because the browser check runs at a very small viewport — a
     * software rasteriser cannot render a walkthrough frame at full size
     * without blocking the main thread for longer than a footstep lasts — and
     * at that size the sidebar controls are overlapped and cannot be clicked.
     */
    scope.__soundSetting = (key: string, value: boolean | number) => {
      const current = editorStore.getState().sound;
      editorStore.patch({ sound: { ...current, [key]: value } });
      return editorStore.getState().sound;
    };

    scope.__soundDiagnose = () => {
      const sound = this.walk?.sound;
      if (!sound) return null;
      return { ...sound.engine.diagnose(), settings: sound.current };
    };

    scope.__soundProbe = () => {
      const sound = this.walk?.sound;
      if (!sound) return null;
      return {
        state: sound.engine.state,
        running: sound.engine.running,
        beds: sound.engine.bedCount,
        elapsed: +sound.engine.elapsed.toFixed(3),
        level: +sound.engine.level().toFixed(5),
        ...sound.engine.counters,
      };
    };

    /*
     * The acoustic report, so the browser run can check the numbers the panel
     * is showing rather than a second computation of them.
     */
    scope.__acousticProbe = () => {
      const doc = designStore.getState();
      const report = checkAcoustics(doc);
      return {
        rooms: report.rooms.map((room) => ({
          name: room.name,
          purpose: room.purpose,
          volume: +room.volume.toFixed(1),
          rt60: +room.midRt60.toFixed(2),
          bass: +room.bassRatio.toFixed(2),
          method: room.method,
          dominant: room.dominant?.label ?? null,
        })),
        findings: report.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          authority: finding.authority,
          section: finding.section,
          title: finding.title,
        })),
      };
    };

    /*
     * Why the room has the shadows it has, for automated checking.
     *
     * Same reasoning as the sound level meter in session 16: the states that
     * produce no shadow all look identical from outside. A light that is not
     * casting, a shadow map that was disposed and never reallocated, a frustum
     * that does not contain the building, a normal bias wider than the gap the
     * shadow was supposed to fall into, and geometry that simply never set
     * `castShadow` are five different bugs with one symptom, and no amount of
     * reading the code distinguishes them. So each is reported separately.
     */
    scope.__shadowProbe = () => {
      let casters = 0;
      let receivers = 0;
      let meshes = 0;
      this.scene.traverse((object) => {
        if (!(object as THREE.Mesh).isMesh) return;
        meshes++;
        if (object.castShadow) casters++;
        if (object.receiveShadow) receivers++;
      });
      return {
        renderer: {
          shadowMapEnabled: this.renderer.webgl.shadowMap.enabled,
          shadowMapType: this.renderer.webgl.shadowMap.type,
          toneMapping: this.renderer.webgl.toneMapping,
          exposure: this.renderer.webgl.toneMappingExposure,
        },
        sun: this.lighting.report(),
        shadowMap: this.lighting.sampleShadowMap(this.renderer.webgl),
        scene: {
          meshes,
          casters,
          receivers,
          // Named meshes, so a browser check can answer "was it built at all"
          // instead of inferring it from a picture.
          named: (() => {
            const names: Record<string, { count: number; size: string }> = {};
            this.scene.traverse((object) => {
              const mesh = object as THREE.Mesh;
              if (!mesh.isMesh) return;
              const kind = mesh.name.replace(/_.*$/, '') || 'unnamed';
              if (!names[kind]) {
                mesh.geometry.computeBoundingBox();
                const box = mesh.geometry.boundingBox;
                names[kind] = {
                  count: 0,
                  size: box
                    ? `${(box.max.x - box.min.x).toFixed(2)}x${(box.max.y - box.min.y).toFixed(3)}x${(box.max.z - box.min.z).toFixed(2)}`
                    : 'none',
                };
              }
              names[kind]!.count++;
            });
            return names;
          })(),
        },
        /*
         * Whether the compiled shaders can sample a shadow map at all.
         *
         * The last place a shadow can be lost. Three decides a material's
         * shader features when it first compiles it, and `USE_SHADOWMAP` is one
         * of them — so a material compiled at a moment when nothing was casting
         * has no `directionalShadowMap` uniform, samples nothing, and goes on
         * rendering a perfectly lit unshadowed surface forever. Nothing about
         * the light, the map or the mesh flags shows it.
         */
        programs: (this.renderer.webgl.info.programs ?? []).map((program) => {
          const uniforms = Object.keys(
            (program.getUniforms() as unknown as { map: Record<string, unknown> }).map,
          );
          return {
            name: program.name,
            usedTimes: program.usedTimes,
            canSampleShadows: uniforms.includes('directionalShadowMap'),
          };
        }),
      };
    };

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
    /*
     * CEILINGS GO ON WHILE WALKING, WHATEVER THE DOCUMENT SAYS.
     *
     * They are off by default so an orbit camera can look down into the plan,
     * which is exactly right from outside and exactly wrong from inside.
     * Standing in a room open to the sky, the enclosure disappears and with it
     * most of the sense of being anywhere — which the first browser run showed
     * plainly: a corner of two walls and blue sky where the ceiling should be.
     *
     * This is a view decision for one mode, not a change to the design, so it
     * overrides here rather than writing to the document.
     */
    const wantCeilings = doc.showCeilings || this.walkingThrough;
    const ceilingsChanged = this.lastCeilings !== wantCeilings;
    this.lastCeilings = wantCeilings;

    // The whole storey rides at its own height above the ground.
    this.levelGroup.position.y = elevationOf(doc, level.id);

    const holes = floorHoles(doc, level.id, (stair) => stairGeometry(doc, stair).wellOpening);

    if (
      planChanged ||
      ceilingsChanged ||
      previous?.stairs !== doc.stairs ||
      previous?.exterior !== doc.exterior
    ) {
      this.building.update(level.plan, wantCeilings, holes, doc.exterior);
      this.scheduleSkyBake();
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
    /*
     * The HVAC watches almost the whole document, because almost all of it is
     * derived: a duct's diameter comes from the airflow, which comes from the
     * equipment, which comes from the load, which comes from every wall,
     * window and room name in the building. Adding a window upstairs changes
     * no duct geometry at all and changes the size of the trunk under it.
     */
    if (
      levelSwitched ||
      !previous ||
      previous.hvac !== doc.hvac ||
      previous.levels !== doc.levels
    ) {
      this.hvac.update(doc, level.id);
    }
    if (levelSwitched || !previous || previous.runs !== doc.runs || previous.fixtures !== doc.fixtures) {
      this.fittings.update(doc, level.id);
    }

    /*
     * Re-walk the clip onto whatever was just rebuilt.
     *
     * Materials created after the cut was switched on have no planes on them,
     * so a wall added while a section is live would stand there uncut. Guarded
     * on the cut being active, because with none there is nothing to walk.
     */
    if (this.sectionClip.active) {
      this.sectionClip.apply(this.levelGroup);
      this.sectionClip.apply(this.roofs.group);
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

  /**
   * Works out how much sky each surface can see, shortly after things stop moving.
   *
   * See `skyBake.ts` for why this exists at all. The short version is that the
   * sun is occluded by the building and the ambient light never was, so every
   * interior surface was lit as though it stood in an open field — which is the
   * whole of "the rooms look flat".
   */
  private scheduleSkyBake(): void {
    /*
     * THIS WAS SWITCHED OFF FOR A WHOLE COMMIT, AND WHAT TURNED IT BACK ON.
     *
     * The bake was correct from the first version — the eight properties in
     * `skyBake.test.ts` held, gradient near an opening included — and it locked
     * the page so completely that the canvas never appeared.
     *
     * Three costs, found in order. Baking every vertex of non-indexed geometry
     * did eighteen times the necessary work, because a point where six
     * triangles meet is stored six times; that is deduplicated. Casting against
     * the SUBDIVIDED render meshes did four hundred times the necessary work,
     * because session 18's own subdivision turned each wall from twenty
     * triangles into several hundred; the coarse geometry is kept alongside and
     * is what gets cast against. Neither was enough, because neither touched
     * the shape of the cost: every ray against every triangle.
     *
     * `bvh.ts` is what changed it. A tree of boxes built once per edit turns
     * rays x triangles into rays x log(triangles), and asking only "did
     * anything block this" — rather than what, and how far — lets a ray pointed
     * at a nearby wall give up immediately, which indoors is most of them.
     */
    if (!this.bakeEnabled) return;
    if (this.bakeTimer !== null) window.clearTimeout(this.bakeTimer);
    this.bakeTimer = window.setTimeout(() => {
      this.bakeTimer = null;
      this.runSkyBake();
    }, 180);
  }

  private runSkyBake(): void {
    const surfaces: THREE.Mesh[] = [];
    const occluders: THREE.Object3D[] = [];

    /*
     * Which meshes get the bake, and which merely block rays.
     *
     * The building's shell carries it: walls, floors, ceilings and the trim,
     * because those are the large surfaces a gradient can be seen across. The
     * furniture only occludes — a sofa should darken the wall behind it without
     * needing per-vertex shading of its own, and giving every cushion a bake
     * would multiply the cost for detail too small to see.
     */
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;

      // Picking proxies are invisible to the eye and must stay invisible to a
      // ray, or every wall would report itself sealed by its own pick slab.
      if (mesh.name.includes('Pick')) return;

      occluders.push(mesh);

      const shell =
        mesh.name.startsWith('Wall') ||
        mesh.name.startsWith('Floor') ||
        mesh.name.startsWith('Ceiling') ||
        mesh.name.startsWith('Skirting') ||
        mesh.name.startsWith('Cornice');
      if (shell) surfaces.push(mesh);
    });

    if (surfaces.length === 0) return;

    const result = bakeSkyVisibility(surfaces, occluders);

    // Everything else keeps its full ambient rather than reading a missing
    // attribute as zero and rendering black.
    for (const object of occluders) {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) fillUnbaked(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material) useBakedAmbient(material);
      }
    }

    this.lastBake = result;
    this.invalidate();
  }

  /** What the last bake did, for the probe. */
  private lastBake: ReturnType<typeof bakeSkyVisibility> | null = null;

  /** Recomputes the clearance report and pushes it to the overlay. */
  private refreshClearance(): void {
    if (!editorStore.getState().showClearance) return;
    const doc = designStore.getState();
    const report = analyseClearance(doc, activeLevel(doc));
    this.clearanceOverlay.update(report.zones, report.violatedZoneIds);
  }

  /** Mirrors editor state (tool, selection, hover) into the scene. */
  /**
   * Switches the live section cut on, off, or onto a different cut.
   *
   * The clipping planes are handed to the RENDERER rather than to each
   * material, so one call covers every mesh in the scene — walls, roofs,
   * furniture, pipes and ducts alike — and nothing has to remember to opt in.
   * A material that opted in individually is a material that gets forgotten
   * the next time somebody adds a layer.
   */
  private applySectionCut(activeSectionId: string | null): void {
    const doc = designStore.getState();
    const cut = activeSectionId
      ? (doc.sections.find((section) => section.id === activeSectionId) ?? null)
      : null;

    this.sectionClip.set(cut);

    /*
     * The building and its roofs, and nothing else. The ground, the sky and
     * the site are not part of what a section cuts, and slicing them leaves
     * half the world missing with a void where it was.
     */
    this.sectionClip.apply(this.levelGroup);
    this.sectionClip.apply(this.roofs.group);
    this.invalidate();
  }

  private applyEditorState(): void {
    this.invalidate();
    const state = editorStore.getState();
    this.planUnderlay.setProposals(state.traceCandidates, new Set(state.acceptedTraceIds));
    this.clearanceOverlay.setVisible(state.showClearance);
    if (state.showClearance) this.refreshClearance();

    /*
     * The electrical layer builds nothing while hidden, so switching it on has
     * to trigger the build the document change would otherwise have done.
     *
     * The Use tool forces it on, because a switch you cannot see is a switch
     * you cannot press: the device meshes ARE the switches, and they are the
     * only thing on the wall at that position for a ray to hit. The wiring
     * runs stay off unless they were already asked for — what the tool needs
     * is the plates, not the circuit diagram.
     */
    const showingDevices = state.showElectrical || state.tool === 'use';
    this.electrical.setVisible(showingDevices);
    this.electrical.setShowRuns(state.showElectricalRuns && state.showElectrical);
    this.electrical.setSelection(state.selection.kind === 'device' ? state.selection.id : null);
    this.plumbing.setVisible(state.showPlumbing);
    this.plumbing.setSystems(state.showDrainage, state.showSupply);
    /*
     * Entering and leaving the walkthrough is driven from the editor state
     * rather than called directly, so the panel, a keyboard shortcut and
     * anything else all go through one path.
     */
    if (state.walkthrough && !this.walkingThrough) {
      if (!this.enterWalkthrough()) editorStore.patch({ walkthrough: false });
    } else if (!state.walkthrough && this.walkingThrough) {
      this.exitWalkthrough();
    }
    this.applyComfort(state.comfort);
    this.walk?.setView(state.walkView);
    this.walk?.setSound(state.sound);

    this.applySectionCut(state.activeSectionId);
    this.hvac.setVisible(state.showHvac);
    this.hvac.setSystems(state.showSupplyAir, state.showReturnAir);
    this.hvac.setSelection(
      state.selection.kind === 'duct' ||
        state.selection.kind === 'register' ||
        state.selection.kind === 'air-handler' ||
        state.selection.kind === 'emitter'
        ? state.selection.id
        : null,
    );
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
    if (showingDevices) {
      const doc = designStore.getState();
      this.electrical.update(doc, activeLevel(doc).id);
    }
    if (state.showPlumbing) {
      const doc = designStore.getState();
      this.plumbing.update(doc, activeLevel(doc).id);
    }
    if (state.showHvac) {
      const doc = designStore.getState();
      this.hvac.update(doc, activeLevel(doc).id);
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

    this.walk = new WalkMode(
      {
        renderer: this.renderer.webgl,
        scene: this.scene,
        camera,
        canvas: this.renderer.canvas,
        invalidate: () => this.invalidate(),
        onChange: () => {
          this.onWalkChange?.();
          this.invalidate();
        },
      },
      editorStore.getState().comfort,
      editorStore.getState().sound,
    );

    this.exposeProbe();

    this.loop = new FrameLoop((delta, dirty) => {
      const started = performance.now();

      /*
       * WALKTHROUGH TAKES THE FRAME OVER COMPLETELY.
       *
       * Not a variation on the orbit path: the camera is driven by a body
       * rather than by controls, and progressive accumulation is meaningless
       * because somebody walking is never still. So it is handled first and
       * returns, and it always asks for another frame — a walkthrough that
       * went to sleep would stop responding to a key being held.
       */
      if (this.walk?.active) {
        const doc = designStore.getState();
        this.walk.update(doc, delta);

        this.pushOpenness();

        this.building.updateForCamera(camera);
        this.roofs.setVisible(this.showRoofs && !this.building.isCutaway);

        this.applyPixelRatio(true);
        this.restoreSun();
        this.pipeline!.renderMoving(camera);

        this.walk.budget.record(performance.now() - started);
        this.reportStats(delta, started);
        return true;
      }

      /* ---- Advance the camera, and find out whether it actually moved ---- */
      const cameraMoved = this.cameraController.update(delta);

      /*
       * A door opened from up here is still swinging, and nothing else in the
       * orbit path would ask for the frames to show it. Returns true only
       * while something is actually moving, so a still view still sleeps.
       */
      let swinging = false;
      if (this.walk) {
        const doc = designStore.getState();
        if (this.walk.tickLive(doc, doc.activeLevelId, delta)) {
          this.pushOpenness();
          swinging = true;
        }
      }

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


      const moving = cameraMoved || dirty || swinging;
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
        /*
         * `renderStill`, not `renderMoving`. The difference is the ambient
         * occlusion, and it is the difference between a room and a diagram —
         * see the long note on that method. It was `renderMoving` here until
         * session 18, which meant the occlusion written in session 11 had never
         * once been drawn.
         */
        this.pipeline!.renderStill(camera);
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
    this.hvac.dispose();
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

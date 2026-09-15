/**
 * Walkthrough mode: the thing that owns a person moving through the building.
 *
 * -----------------------------------------------------------------------------
 * ONE MODE, TWO WAYS IN.
 *
 * Desktop and headset differ in exactly three places — where the intent comes
 * from, where the head pose comes from, and which loop drives the frames. Every
 * other rule is shared, which is what lets the desktop walkthrough act as the
 * test rig for the headset.
 *
 * -----------------------------------------------------------------------------
 * THE CAMERA IS DRIVEN DIFFERENTLY IN EACH, AND THAT IS NOT OPTIONAL.
 *
 * On desktop this writes the camera's position and rotation every frame.
 *
 * In an XR session it must not. The runtime owns the head pose absolutely: it
 * writes the camera from the real headset before every render, and anything
 * written here is discarded. So the player is moved by moving the RIG the
 * camera sits inside. Writing the camera anyway produces a view that judders
 * against real head movement, which is the fastest way to make somebody ill.
 *
 * -----------------------------------------------------------------------------
 * AND THE FRAME LOOP CHANGES HANDS.
 *
 * `requestAnimationFrame` does not drive an XR session; the runtime does,
 * through `setAnimationLoop`, at the headset's own rate. So entering a session
 * stops the ordinary loop and hands the frames over, and leaving it hands them
 * back. Getting that wrong gives a black headset with a perfectly healthy tab
 * behind it.
 */

import * as THREE from 'three';

import { DesktopWalk } from '@/interaction/DesktopWalk';
import { WalkOverlay } from '@/scene/WalkOverlay';
import { XrWalk } from '@/xr/XrWalk';
import { BUDGET, FrameBudget } from './FrameBudget';
import { BODY, NO_INTENT, Walker, startingPoint, type WalkIntent } from '@/walk/Walker';
import { standingAt } from '@/walk/ground';
import { aimTeleport, type TeleportAim } from '@/walk/teleport';
import { LiveState } from '@/walk/LiveState';
import { interactablesOn, reachFor, type Interactable } from '@/walk/interactables';
import { RoomLights } from '@/scene/RoomLights';
import type { ComfortSettings } from '@/state/selection';
import type { DesignDocument } from '@/state/types';

export interface WalkModeDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Ask for another frame. */
  invalidate: () => void;
  /** Called when the mode, the pointer lock or the session state changes. */
  onChange: () => void;
}

export class WalkMode {
  private deps: WalkModeDeps;
  private overlay = new WalkOverlay();
  private desktop: DesktopWalk;
  private xr: XrWalk;
  private walker: Walker | null = null;
  private comfort: ComfortSettings;
  readonly budget = new FrameBudget(120, BUDGET.desktop);

  private on = false;
  private aim: TeleportAim | null = null;
  private pitch = 0;

  /* ---- Interaction ---- */

  readonly live = new LiveState();
  readonly lights = new RoomLights();
  /**
   * What is touchable on the walker's storey, rebuilt only when the document
   * or the storey changes. A hand cannot reach through a floor, and deriving a
   * building's worth of openings ninety times a second would be a poor trade.
   */
  private reachable: Interactable[] = [];
  private reachableFor: DesignDocument | null = null;
  private reachableLevel = '';
  private focused: Interactable | null = null;
  /** What just happened, shown for a moment so an action is acknowledged. */
  private flash = '';
  private flashUntil = 0;
  /**
   * Whether anything has been used since the live state was last thrown away.
   *
   * Only so the panel can stay quiet rather than reporting "0 doors of 0" at
   * somebody who has not touched anything: outside the walkthrough nothing has
   * derived a storey's interactables yet, and an empty summary is not the same
   * answer as a real one.
   */
  private touched = false;

  /** Where the camera was before the walkthrough, to put it back afterwards. */
  private parked: { position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null;

  constructor(deps: WalkModeDeps, comfort: ComfortSettings) {
    this.deps = deps;
    this.comfort = comfort;

    this.desktop = new DesktopWalk(deps.canvas, () => deps.onChange());
    this.xr = new XrWalk(deps.renderer, () => {
      this.budget.setBudget(this.xr.presenting ? BUDGET.headset : BUDGET.desktop);
      deps.onChange();
    });

    deps.scene.add(this.overlay.world);
    deps.scene.add(this.lights.group);
    deps.scene.add(this.xr.rig);
    deps.camera.add(this.overlay.head);
    this.overlay.setVisible(false);
  }

  get active(): boolean {
    return this.on;
  }

  get presenting(): boolean {
    return this.xr.presenting;
  }

  get pointerLocked(): boolean {
    return this.desktop.pointerLocked;
  }

  /** Where the walker is, for the panel to say which room somebody is in. */
  get state() {
    return this.walker?.current ?? null;
  }

  setComfort(comfort: ComfortSettings): void {
    this.comfort = comfort;
  }

  /* --------------------------------- Entry -------------------------------- */

  /** Drops somebody into the building. Returns false if there is nowhere to go. */
  enter(doc: DesignDocument): boolean {
    if (this.on) return true;

    const start = startingPoint(doc);
    if (!start) return false;

    this.walker = new Walker(start.at, start.standing, start.heading);
    this.on = true;
    this.pitch = 0;

    const camera = this.deps.camera;
    this.parked = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };

    this.overlay.setVisible(true);
    this.lights.setVisible(true);
    this.budget.reset();

    this.desktop.resetPitch();
    this.desktop.start();
    this.deps.onChange();
    this.deps.invalidate();
    return true;
  }

  exit(): void {
    if (!this.on) return;
    this.on = false;

    this.desktop.stop();
    this.overlay.setVisible(false);
    this.lights.setVisible(false);
    this.aim = null;
    this.walker = null;
    this.focused = null;

    /*
     * Everything that was open or on goes back to how the document describes
     * it. That is what "transient" means, and the door fractions are pushed
     * back into the scene by the caller on the next rebuild.
     */
    this.live.reset();
    this.touched = false;

    // Put the camera back where the orbit controls left it, so leaving a
    // walkthrough returns to the view somebody was working from rather than
    // to wherever they happened to be standing.
    if (this.parked) {
      this.deps.camera.position.copy(this.parked.position);
      this.deps.camera.quaternion.copy(this.parked.quaternion);
      this.parked = null;
    }

    this.deps.onChange();
    this.deps.invalidate();
  }

  /** Re-asks for the pointer after the browser took it back. */
  resumePointer(): void {
    this.desktop.requestLock();
  }

  /* ---------------------------------- XR ---------------------------------- */

  static xrAvailable(): Promise<boolean> {
    return XrWalk.available();
  }

  /**
   * Enters a session, taking the camera with it.
   *
   * The camera is re-parented into the rig, because in a session the runtime
   * writes the head pose relative to whatever the camera's parent is. Leaving
   * it in the scene means the runtime's head pose is a world position and
   * moving the player does nothing at all.
   */
  async enterXr(doc: DesignDocument): Promise<void> {
    if (!this.on) this.enter(doc);
    if (!this.walker) return;

    this.xr.attach();
    this.xr.rig.add(this.deps.camera);

    const state = this.walker.current;
    this.xr.place(state.at.x, state.standing.y, state.at.z, state.heading);

    await this.xr.enter();

    // The runtime drives the frames now. The ordinary loop is stopped by the
    // Engine when it sees `presenting` go true.
    this.deps.onChange();
  }

  async exitXr(): Promise<void> {
    await this.xr.exit();
    this.deps.scene.add(this.deps.camera);
    this.deps.onChange();
  }

  /* -------------------------------- The frame ----------------------------- */

  /**
   * Advances the walker and puts the camera where it belongs.
   *
   * Returns whether anything moved, which the frame loop uses to decide whether
   * to keep drawing.
   */
  update(doc: DesignDocument, delta: number): boolean {
    if (!this.on || !this.walker) return false;

    const intent = this.presenting
      ? this.readHeadset(doc)
      : this.readDesktop(doc, delta);

    const before = this.walker.current;
    const state = this.walker.update(doc, intent, delta);

    this.overlay.updateComfort(state.speed, delta, this.comfort);

    /* ---- What is within reach, and what it is doing ---- */

    this.refreshReachable(doc, state.standing.levelId);
    const moving = this.live.update(delta);

    const eye = new THREE.Vector3(state.at.x, state.eyeY, state.at.z);
    this.lights.update(doc, new Set(this.live.litFittings), eye);

    if (this.flash && performance.now() > this.flashUntil) this.flash = '';

    if (this.presenting) {
      // Move the space, not the head. See the note at the top.
      this.xr.place(state.at.x, state.standing.y, state.at.z, state.heading);
    } else {
      const camera = this.deps.camera;
      camera.position.set(state.at.x, state.eyeY, state.at.z);
      // Yaw from the body, pitch from the mouse: a body does not tilt.
      camera.rotation.set(0, 0, 0);
      camera.rotateY(state.heading + Math.PI);
      camera.rotateX(this.pitch);
    }

    const moved =
      before.at.x !== state.at.x ||
      before.at.z !== state.at.z ||
      before.eyeY !== state.eyeY ||
      before.heading !== state.heading ||
      state.speed > 0;

    // The overlay animates on its own, and so does a door that is still
    // swinging — so a frame is wanted while either is going even if the walker
    // is standing perfectly still.
    return moved || moving || this.aim !== null || this.flash !== '';
  }

  /* ------------------------------ Interaction ----------------------------- */

  private refreshReachable(doc: DesignDocument, levelId: string): void {
    if (this.reachableFor === doc && this.reachableLevel === levelId) return;
    this.reachable = interactablesOn(doc, levelId);
    this.reachableFor = doc;
    this.reachableLevel = levelId;
  }

  /**
   * Points a ray at the world and highlights whatever is within reach.
   *
   * Shared by both input paths, which matters more than it looks: the desktop
   * ray comes from the eye and the headset ray from a hand, and if the two used
   * different reach rules somebody would learn one and be wrong in the other.
   */
  private lookFor(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
  ): void {
    this.focused = reachFor(this.reachable, origin, direction);
    this.overlay.setFocus(
      this.focused,
      new THREE.Vector3(origin.x, origin.y, origin.z),
    );
  }

  /** Uses whatever is focused. Returns what happened, or empty if nothing was. */
  private useFocused(): string {
    if (!this.focused) return '';

    const said = this.live.use(this.focused);
    this.touched = true;
    this.flash = said;
    // Long enough to read, short enough not to linger over the next thing.
    this.flashUntil = performance.now() + 1400;

    this.deps.invalidate();
    return said;
  }

  /** What the crosshair should say right now. */
  get prompt(): { label: string; verb: string } | null {
    if (this.flash) return { label: this.flash, verb: '' };
    if (!this.focused) return null;
    return { label: this.focused.label, verb: this.live.verbFor(this.focused) };
  }

  /** How far open each opening is, for the caller to push into the scene. */
  opennessByOpening(): Map<string, number> {
    const result = new Map<string, number>();
    for (const item of this.reachable) {
      if (item.kind !== 'door') continue;
      result.set(item.id, this.live.openness(item));
    }
    return result;
  }

  /** How far open each cabinet stands, for the caller to push into the scene. */
  opennessByUnit(): Map<string, number> {
    const result = new Map<string, number>();
    for (const item of this.reachable) {
      if (item.kind !== 'drawer' && item.kind !== 'cabinet-door') continue;
      result.set(item.id, this.live.openness(item));
    }
    return result;
  }

  /** Which taps are running, likewise. */
  runningTaps(): Set<string> {
    const result = new Set<string>();
    for (const item of this.reachable) {
      if (item.kind === 'tap' && this.live.isRunning(item.id)) result.add(item.id);
    }
    return result;
  }

  /**
   * What is open and on, for the panel — or null when there is nothing to say.
   *
   * Null rather than a row of zeros: outside the walkthrough nothing has
   * derived the storey's interactables until something is used, and "0 doors
   * open of 0" is not a true statement about a house with doors in it.
   */
  liveSummary() {
    if (!this.on && !this.touched) return null;
    return this.live.summary(this.reachable);
  }

  /* ------------------------ Using things from outside --------------------- */

  /*
   * A door can be opened from the orbit view as well as from inside, and the
   * reason is a practical one: checking that a swing clears the island, or that
   * a wall unit does not foul the one beside it, is something you do looking
   * down at the room rather than standing in it. Walking in to open a door and
   * walking back out to look at it is a chore nobody should have.
   *
   * It goes through the same LiveState as the walkthrough — the same easing,
   * the same reset on leaving, the same nothing-is-saved — so a door opened
   * from above is open when you walk in, and neither one is part of the design.
   */

  /**
   * Whatever the picker hit, if it is something that can be used.
   *
   * The ids match by construction: an interactable carries the id of the thing
   * in the document it came from, which is the same id the scene tags its pick
   * targets with. No second lookup table, and nothing to fall out of step.
   */
  find(doc: DesignDocument, levelId: string, id: string): Interactable | null {
    this.refreshReachable(doc, levelId);
    return this.reachable.find((item) => item.id === id) ?? null;
  }

  /** What using that thing would do, for a hover readout. */
  describe(doc: DesignDocument, levelId: string, id: string): { label: string; verb: string } | null {
    const item = this.find(doc, levelId, id);
    if (!item) return null;
    return { label: item.label, verb: this.live.verbFor(item) };
  }

  /** Uses it. Returns what happened, or null if it was not usable. */
  useThing(doc: DesignDocument, levelId: string, id: string): string | null {
    const item = this.find(doc, levelId, id);
    if (!item) return null;

    const said = this.live.use(item);
    this.touched = true;
    this.deps.invalidate();
    return said;
  }

  /**
   * Advances the easing while nobody is walking.
   *
   * The walkthrough's own update does this as part of its frame; the orbit view
   * has no such frame, so a door opened from above would jump to open without
   * this. Returns whether anything is still moving, which is what keeps the
   * on-demand renderer awake until the swing finishes.
   */
  tickLive(doc: DesignDocument, levelId: string, delta: number): boolean {
    if (this.on) return false;
    // Asked first, and cheap: deriving a storey's worth of interactables in
    // order to advance nothing is a cost paid by everybody who never opens a
    // door from up here.
    if (!this.live.busy) return false;

    this.refreshReachable(doc, levelId);
    return this.live.update(delta);
  }

  get lightsInUse(): number {
    return this.lights.inUse;
  }

  setLamp(lampId: string): void {
    this.lights.setLamp(lampId);
  }

  private readDesktop(doc: DesignDocument, delta: number): WalkIntent {
    const read = this.desktop.read(delta);
    this.pitch = read.pitch;

    if (!read.active || !this.walker) {
      this.overlay.setAim(null);
      this.overlay.setFocus(null, new THREE.Vector3());
      this.aim = null;
      this.focused = null;
      return { ...NO_INTENT };
    }

    const state = this.walker.current;

    /*
     * The look direction, used for both reaching and aiming. On desktop the
     * hand is the eye — a mouse has no other position to offer — which is why
     * the teleport arc starts there too.
     */
    const facing = new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(this.pitch, state.heading + Math.PI, 0, 'YXZ'),
    );

    this.lookFor(
      { x: state.at.x, y: state.eyeY, z: state.at.z },
      { x: facing.x, y: facing.y, z: facing.z },
    );

    if (read.use) this.useFocused();

    if (this.desktop.aiming) {
      /*
       * The aim starts at the eye and points where the view does, which is the
       * closest a mouse gets to pointing a hand. It is deliberately the same
       * arc the controller throws, so what somebody learns here transfers.
       */
      this.aim = aimTeleport(
        doc,
        { x: state.at.x, y: state.eyeY, z: state.at.z },
        { x: facing.x, y: facing.y, z: facing.z },
        state.standing,
      );
      this.overlay.setAim(this.aim);
    } else {
      this.overlay.setAim(null);
    }

    if (read.confirmTeleport && this.aim?.landing) {
      const landing = this.aim.landing;
      this.aim = null;
      this.overlay.setAim(null);
      return { ...read.intent, teleportTo: landing };
    }

    if (read.confirmTeleport) {
      this.aim = null;
      this.overlay.setAim(null);
    }

    return read.intent;
  }

  private readHeadset(doc: DesignDocument): WalkIntent {
    if (!this.walker) return { ...NO_INTENT };

    const read = this.xr.read(this.comfort);
    const state = this.walker.current;

    /*
     * In a headset the reaching ray comes from the HAND, not the eye. That is
     * the whole difference, and it is the right one: people reach for things
     * with their hands and find it uncanny when a gaze-driven cursor decides
     * what they meant.
     */
    if (read.hand) {
      this.lookFor(
        { x: read.hand.origin.x, y: read.hand.origin.y, z: read.hand.origin.z },
        { x: read.hand.direction.x, y: read.hand.direction.y, z: read.hand.direction.z },
      );
    } else {
      this.focused = null;
      this.overlay.setFocus(null, new THREE.Vector3());
    }

    if (read.use) this.useFocused();

    if (read.aim) {
      this.aim = aimTeleport(
        doc,
        { x: read.aim.origin.x, y: read.aim.origin.y, z: read.aim.origin.z },
        { x: read.aim.direction.x, y: read.aim.direction.y, z: read.aim.direction.z },
        state.standing,
      );
      this.overlay.setAim(this.aim);
    } else if (!read.confirmTeleport) {
      this.overlay.setAim(null);
    }

    if (read.confirmTeleport) {
      const landing = this.aim?.landing ?? null;
      this.aim = null;
      this.overlay.setAim(null);
      if (landing) return { ...read.intent, teleportTo: landing };
    }

    return read.intent;
  }

  /**
   * Puts the walker somewhere specific, for "walk from here".
   *
   * Refuses rather than placing somebody in a wall — the same `standingAt` the
   * walker uses, so a spot it accepts is a spot that can be walked out of.
   */
  moveTo(doc: DesignDocument, at: { x: number; z: number }): boolean {
    if (!this.walker) return false;
    const standing = standingAt(doc, at, this.walker.current.standing.y);
    if (!standing) return false;

    this.walker.placeAt(at, standing);
    this.deps.invalidate();
    return true;
  }

  /**
   * Drives the walker directly, for automated checks.
   *
   * Pointer lock cannot be granted without a real user gesture, so a headless
   * browser can never produce input through the ordinary path — and a
   * walkthrough that can only be tested by hand is one that quietly rots. This
   * feeds an intent straight in, which is exactly what the desktop and headset
   * paths do, so what it exercises is the real thing rather than a stand-in.
   *
   * Returns where the walker ended up.
   */
  drive(doc: DesignDocument, intent: Partial<WalkIntent>, seconds: number) {
    if (!this.walker) return null;

    const step = 1 / 60;
    for (let elapsed = 0; elapsed < seconds; elapsed += step) {
      this.walker.update(doc, { ...NO_INTENT, ...intent }, step);
    }

    this.update(doc, 0);
    this.deps.invalidate();
    return this.walker.current;
  }

  /** Eye height, for the panel to show what the view is measured from. */
  get eyeHeight(): number {
    return BODY.eyeHeight;
  }

  dispose(): void {
    this.desktop.stop();
    this.overlay.dispose();
    this.lights.dispose();
    this.xr.dispose();
    this.deps.scene.remove(this.overlay.world);
    this.deps.scene.remove(this.lights.group);
    this.deps.scene.remove(this.xr.rig);
    this.deps.camera.remove(this.overlay.head);
  }
}

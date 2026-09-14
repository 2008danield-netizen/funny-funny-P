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
    this.aim = null;
    this.walker = null;

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

    // The overlay animates on its own, so a frame is wanted while the vignette
    // is still easing even if nothing else changed.
    return moved || this.aim !== null;
  }

  private readDesktop(doc: DesignDocument, delta: number): WalkIntent {
    const read = this.desktop.read(delta);
    this.pitch = read.pitch;

    if (!read.active || !this.walker) {
      this.overlay.setAim(null);
      this.aim = null;
      return { ...NO_INTENT };
    }

    const state = this.walker.current;

    if (this.desktop.aiming) {
      /*
       * The aim starts at the eye and points where the view does, which is the
       * closest a mouse gets to pointing a hand. It is deliberately the same
       * arc the controller throws, so what somebody learns here transfers.
       */
      const direction = new THREE.Vector3(0, 0, -1)
        .applyEuler(new THREE.Euler(this.pitch, state.heading + Math.PI, 0, 'YXZ'));

      this.aim = aimTeleport(
        doc,
        { x: state.at.x, y: state.eyeY, z: state.at.z },
        { x: direction.x, y: direction.y, z: direction.z },
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
    this.xr.dispose();
    this.deps.scene.remove(this.overlay.world);
    this.deps.scene.remove(this.xr.rig);
    this.deps.camera.remove(this.overlay.head);
  }
}

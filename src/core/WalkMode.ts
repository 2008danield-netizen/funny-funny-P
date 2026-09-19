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
import { Stride } from '@/walk/stride';
import { BASE_FOV, easeFov, headBob } from '@/walk/feel';
import { Figure } from '@/scene/Figure';
import { ThirdPerson } from './ThirdPerson';
import { aimTeleport, type TeleportAim } from '@/walk/teleport';
import { LiveState } from '@/walk/LiveState';
import { interactablesOn, reachFor, type Interactable } from '@/walk/interactables';
import { RoomLights } from '@/scene/RoomLights';
import { Soundscape, type SoundEvent } from '@/audio/Soundscape';
import type { ComfortSettings, SoundSettings } from '@/state/selection';
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

  /**
   * How far through a step the walker is.
   *
   * Owned here rather than by either consumer, because both the footstep sounds
   * and the figure's legs need it and neither is always present — the sound only
   * runs once a browser has let an audio context start, and the figure is only
   * drawn in third person. Whichever of them is switched on has to see the same
   * step as the other, so the count lives above both.
   */
  private stride = new Stride();

  /**
   * The body you see in third person, and the camera that looks at it.
   *
   * Both exist whether or not third person is switched on. The figure is simply
   * hidden in first person — building and tearing it down on every toggle would
   * cost a stall at the exact moment somebody is looking for a smooth
   * transition, and an invisible group costs nothing per frame.
   */
  private figure = new Figure();
  private thirdPerson = new ThirdPerson();
  /** First person unless asked otherwise. See `setView`. */
  private view: 'first' | 'third' = 'first';

  /**
   * The field of view actually in use, which lags the one this speed wants.
   *
   * Held here rather than read off the camera each frame because the camera is
   * shared with the orbit view — leaving a widened field of view behind on the
   * way out would silently change every screenshot taken afterwards.
   */
  private fov = BASE_FOV;

  /* ---- Interaction ---- */

  readonly live = new LiveState();
  readonly lights = new RoomLights();
  readonly sound: Soundscape;
  /**
   * What happened this frame that wants a sound.
   *
   * Collected rather than played at the moment of the action, so that using
   * something has exactly one place where it becomes audible — and so that a
   * headless test can drive the interaction and inspect what it would have
   * sounded like without an AudioContext existing at all.
   */
  private soundEvents: SoundEvent[] = [];
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

  constructor(deps: WalkModeDeps, comfort: ComfortSettings, sound: SoundSettings) {
    this.deps = deps;
    this.comfort = comfort;
    this.sound = new Soundscape(sound);

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

  /**
   * First person or third.
   *
   * First person is the default and stays the default: it is the honest way to
   * judge a room, because it is the only one that puts your eye where a real eye
   * would be. Third person is for looking AT the space rather than from inside
   * it, and for the thing a figure is really for in an architectural view —
   * telling you how big the room is by standing in it.
   */
  setView(view: 'first' | 'third'): void {
    if (view === this.view) return;
    this.view = view;
    this.figure.setVisible(view === 'third');

    // Entering third person from wherever the body is facing, so the camera
    // arrives behind you rather than swinging round to find its default.
    if (view === 'third' && this.walker) this.thirdPerson.alignTo(this.walker.current.heading);
    this.deps.invalidate();
  }

  /** The figure's current joint angles, for automated checking. */
  get figurePose(): ReturnType<Figure['report']> {
    return this.figure.report();
  }

  get walkView(): 'first' | 'third' {
    return this.view;
  }

  setSound(settings: SoundSettings): void {
    this.sound.setSettings(settings);
  }

  /* --------------------------------- Entry -------------------------------- */

  /** Drops somebody into the building. Returns false if there is nowhere to go. */
  enter(doc: DesignDocument): boolean {
    if (this.on) return true;

    const start = startingPoint(doc);
    if (!start) return false;

    this.walker = new Walker(start.at, start.standing, start.heading);
    this.stride.reset();
    this.on = true;
    this.pitch = 0;

    this.deps.scene.add(this.figure.group);
    this.thirdPerson.ignoreObject(this.figure.group);
    this.figure.faceNow(start.heading);
    // Aligned on entry so that switching to third person does not swing the
    // camera round the building to find its default angle.
    this.thirdPerson.alignTo(start.heading);
    this.figure.setVisible(this.view === 'third');

    const camera = this.deps.camera;
    this.parked = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };

    this.overlay.setVisible(true);
    this.lights.setVisible(true);
    this.budget.reset();

    this.desktop.resetPitch();
    this.desktop.start();

    /*
     * The context is started here because this is the only place that is
     * reliably inside a user gesture: somebody clicked "Walk through it".
     * Browsers refuse to make noise otherwise, and they refuse by leaving the
     * context suspended rather than by throwing — so an app that starts audio
     * anywhere else is silently mute and looks like broken synthesis.
     */
    void this.sound.start().then(() => this.deps.onChange());

    this.deps.onChange();
    this.deps.invalidate();
    return true;
  }

  exit(): void {
    /*
     * Hand the camera back as it was found. It is shared with the orbit view,
     * and a walkthrough that ended mid-sprint would otherwise leave every
     * subsequent still six degrees wider than the one before it.
     */
    this.fov = BASE_FOV;
    this.deps.camera.fov = BASE_FOV;
    this.deps.camera.updateProjectionMatrix();
    this.deps.scene.remove(this.figure.group);
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
    this.sound.stop();
    this.soundEvents = [];

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

  /**
   * Turns a first-person intent into a free-orbit one.
   *
   * Three things happen, and the third is the one that makes it feel right:
   *
   *   the turn moves the CAMERA rather than the body;
   *   forward and strafe are rotated out of camera space into the world;
   *   the body is pointed at wherever that lands.
   *
   * The body is faced rather than turned because a heading is a fact, not a
   * rate. Feeding the walker a very large `turn` to land on the right angle this
   * frame would work and would silently depend on the frame time — press a key
   * on a slow frame and the body would overshoot.
   */
  private orbitIntent(intent: WalkIntent, delta: number): WalkIntent {
    this.thirdPerson.orbit(intent.turn, this.pitch, delta);

    const magnitude = Math.hypot(intent.forward, intent.strafe);
    if (magnitude < 1e-4) {
      // Standing still: no direction to face, so leave the body where it is
      // rather than snapping it to the camera every idle frame.
      return { ...intent, turn: 0, forward: 0, strafe: 0 };
    }

    /*
     * Camera space into world space.
     *
     * The walkthrough's convention is heading 0 looks towards +z, so forward is
     * (sin h, cos h) and the strafe axis is that turned a quarter turn. Written
     * out rather than done with a matrix because the sign conventions here have
     * bitten this project twice already — once in the audio listener, once in
     * the third-person boom — and an explicit pair of lines can be checked
     * against the walker's own maths by eye.
     */
    const heading = this.thirdPerson.heading;
    const x = Math.sin(heading) * intent.forward + Math.cos(heading) * intent.strafe;
    const z = Math.cos(heading) * intent.forward - Math.sin(heading) * intent.strafe;

    this.walker?.face(Math.atan2(x, z));

    // All of the movement is now "forward" along the new heading, so the strafe
    // has been fully consumed. Leaving it in would add the sideways component
    // twice.
    return { ...intent, turn: 0, forward: magnitude, strafe: 0 };
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

    /*
     * THIRD PERSON REDIRECTS THE INTENT BEFORE THE WALKER SEES IT.
     *
     * The mouse produced a `turn` and the keys produced a forward/strafe pair,
     * exactly as they always have — the input layer knows nothing about which
     * view is on, and should not. What changes is where those numbers go.
     *
     * The turn is spent on the camera instead of the body, and the movement is
     * rotated out of camera space into the world, so "forward" means away from
     * the camera. The body is then simply told to face wherever it is walking.
     */
    const driven = this.presenting || this.view === 'first'
      ? intent
      : this.orbitIntent(intent, delta);

    const state = this.walker.update(doc, driven, delta);

    this.overlay.updateComfort(state.speed, delta, this.comfort);

    /* ---- What is within reach, and what it is doing ---- */

    this.refreshReachable(doc, state.standing.levelId);
    const moving = this.live.update(delta);

    const eye = new THREE.Vector3(state.at.x, state.eyeY, state.at.z);
    this.lights.update(doc, new Set(this.live.litFittings), eye);

    /*
     * The step, advanced once and read twice.
     *
     * After the walker has moved, because a stride is measured from the distance
     * actually covered and that is not known until the collision solver has had
     * its say.
     */
    const stride = this.stride.advance(state.at, state.speed);

    /*
     * The sound, after the walker has moved and before the camera is written.
     *
     * After the move because footsteps are driven by distance travelled, and
     * the distance is not known until the move has happened. The events
     * collected this frame are handed over and cleared, so nothing can be
     * played twice.
     */
    this.sound.update(
      doc,
      {
        at: state.at,
        eyeY: state.eyeY,
        heading: state.heading,
        speed: state.speed,
        standing: state.standing,
        stride,
      },
      { runningTaps: this.live.runningSet, litFittings: this.live.litSet },
      this.soundEvents,
    );
    this.soundEvents.length = 0;

    if (this.flash && performance.now() > this.flashUntil) this.flash = '';

    if (this.presenting) {
      // Move the space, not the head. See the note at the top.
      this.xr.place(state.at.x, state.standing.y, state.at.z, state.heading);
    } else if (this.view === 'third') {
      /*
       * The figure first, the camera second.
       *
       * The camera casts a ray to find out how far back it can sit, and the
       * figure is one of the things in the scene. Posing it after the cast would
       * mean the boom was measured against last frame's body.
       */
      this.figure.place(state.at.x, state.standing.y, state.at.z, state.heading, delta);
      this.figure.setPose(stride, state.speed);
      this.thirdPerson.place(
        this.deps.camera,
        { x: state.at.x, y: state.standing.y, z: state.at.z },
        this.deps.scene,
        delta,
      );
    } else {
      const camera = this.deps.camera;

      /*
       * The bob, added to the eye rather than baked into it.
       *
       * `state.eyeY` is where the walkthrough says the eye IS — it is what the
       * sound listens from, what the reach ray starts at, and what the figure's
       * head is drawn at. The bob is a camera affectation on top of that, and
       * mixing the two would make a footstep's position wobble by a centimetre
       * with every step.
       */
      const bob = this.comfort.headBob
        ? headBob(stride, state.speed)
        : { rise: 0, sway: 0 };

      // Sideways, across the direction of travel rather than along it.
      const across = state.heading + Math.PI / 2;
      camera.position.set(
        state.at.x + Math.sin(across) * bob.sway,
        state.eyeY + bob.rise,
        state.at.z + Math.cos(across) * bob.sway,
      );
      // Yaw from the body, pitch from the mouse: a body does not tilt.
      camera.rotation.set(0, 0, 0);
      camera.rotateY(state.heading + Math.PI);
      camera.rotateX(this.pitch);
    }

    /*
     * The field of view, after whichever camera branch ran.
     *
     * Applied in one place for both views: a run should feel like a run whether
     * you are looking out of your own eyes or watching yourself do it.
     */
    if (!this.presenting) {
      const wanted = this.comfort.fovKick
        ? easeFov(this.fov, state.speed, intent.running, delta)
        : BASE_FOV;
      if (wanted !== this.fov) {
        this.fov = wanted;
        this.deps.camera.fov = wanted;
        this.deps.camera.updateProjectionMatrix();
      }
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

    /*
     * The sound of using it, queued rather than played.
     *
     * `kind` maps straight from the interactable, because the thing that knows
     * a drawer is a drawer is the thing that derived it — and a cabinet door
     * latches like a door rather than running like a drawer, which is the one
     * distinction that would be wrong if this were guessed from the verb.
     */
    this.soundEvents.push({
      kind:
        this.focused.kind === 'cabinet-door'
          ? 'door'
          : (this.focused.kind as SoundEvent['kind']),
      at: { ...this.focused.at },
    });

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

    const event: SoundEvent = {
      kind: item.kind === 'cabinet-door' ? 'door' : (item.kind as SoundEvent['kind']),
      at: { ...item.at },
    };

    if (this.on) {
      // The walkthrough's own frame will play it, positioned at the walker.
      this.soundEvents.push(event);
    } else {
      /*
       * Used from the orbit view, where there is no walk frame to play it in.
       * The click that got here is a genuine user gesture, so this is a legal
       * place to start the audio context.
       */
      const camera = this.deps.camera;
      void this.sound.playFromOrbit(
        {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          // The orbit camera's own yaw, so a door on the left of the screen is
          // heard on the left.
          heading: Math.atan2(-camera.matrixWorld.elements[8]!, -camera.matrixWorld.elements[10]!),
        },
        event,
      );
    }

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
    /*
     * In third person you reach where the CAMERA is looking, not where the body
     * happens to be facing — those are now two different directions, which is
     * the entire point of free orbit. The ray still STARTS at the figure's eye,
     * so you cannot reach through a wall the camera is looking over.
     *
     * One frame behind, because the camera's yaw is advanced further down in
     * `orbitIntent`. That is the right frame anyway: it is the view the person
     * was looking at when they clicked.
     */
    const viewHeading = this.view === 'third' ? this.thirdPerson.heading : state.heading;
    const facing = new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(this.pitch, viewHeading + Math.PI, 0, 'YXZ'),
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
    this.figure.dispose();
    this.desktop.stop();
    this.overlay.dispose();
    this.lights.dispose();
    this.sound.dispose();
    this.xr.dispose();
    this.deps.scene.remove(this.overlay.world);
    this.deps.scene.remove(this.lights.group);
    this.deps.scene.remove(this.xr.rig);
    this.deps.camera.remove(this.overlay.head);
  }
}

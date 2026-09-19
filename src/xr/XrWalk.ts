/**
 * The headset.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT OWN.
 *
 * It owns the session, the two controllers, and turning their sticks and
 * triggers into the same `WalkIntent` a keyboard produces. It owns nothing
 * about walls, stairs, teleport landings or comfort — those are shared with the
 * desktop walkthrough and are tested there.
 *
 * That line is drawn deliberately and it is the answer to a real constraint:
 * this code cannot be automated and I cannot put a headset on to check it. So
 * the amount of logic that exists only here is kept as small as it can be, and
 * what is left is plumbing that either works or fails loudly.
 *
 * -----------------------------------------------------------------------------
 * THE RIG, AND WHY THE CAMERA IS NOT MOVED DIRECTLY.
 *
 * In an XR session the runtime owns the camera absolutely: it writes the head
 * pose every frame from the real headset, and anything the app writes is
 * overwritten before the next render. Moving the player therefore means moving
 * the SPACE the camera sits in — a group the camera is a child of — and letting
 * the runtime position the head within it.
 *
 * Getting this wrong produces a very specific and very unpleasant symptom: the
 * view judders against the real head movement, which is the single fastest way
 * to make somebody ill.
 *
 * -----------------------------------------------------------------------------
 * FLOOR-LEVEL SPACE, SO THE BUILDING IS THE RIGHT SIZE.
 *
 * The session asks for `local-floor`, which puts the origin on the real floor
 * of the real room. The headset then reports the wearer's actual height, and a
 * 1.9 m person sees the building from 1.9 m. Using a fixed eye height instead
 * would put a tall person's eyes below their own — and since the entire value
 * of this is judging whether a room feels right, borrowing somebody else's
 * height would defeat the exercise.
 */

import * as THREE from 'three';

import { NO_INTENT, type WalkIntent } from '@/walk/Walker';

/** Below this, a stick is noise rather than an instruction. */
const STICK_DEADZONE = 0.18;

/** How far the stick must return towards centre before a snap turn re-arms. */
const SNAP_RELEASE = 0.35;

/** And how far it must go to trigger one. */
const SNAP_THRESHOLD = 0.7;

export interface XrFrameInput {
  intent: WalkIntent;
  /** Where the aiming hand is and which way it points, in world space. */
  aim: { origin: THREE.Vector3; direction: THREE.Vector3 } | null;
  /** True on the frame the teleport was released and should be taken. */
  confirmTeleport: boolean;
  /**
   * Where the reaching hand is, and which way it points.
   *
   * Always present while a controller is tracked, unlike `aim`, which only
   * exists while the teleport is being held. People reach for things with
   * their hands and find it uncanny when a gaze cursor decides what they meant,
   * so the highlight follows the hand at all times.
   */
  hand: { origin: THREE.Vector3; direction: THREE.Vector3 } | null;
  /** True on the frame the grip or A button was pressed. */
  use: boolean;
}

export class XrWalk {
  private renderer: THREE.WebGLRenderer;
  /**
   * The space the player stands in.
   *
   * The camera is added to this, and moving the player moves this rather than
   * the camera — see the note at the top about the runtime owning the head.
   */
  readonly rig = new THREE.Group();

  private left: THREE.XRTargetRaySpace | null = null;
  private right: THREE.XRTargetRaySpace | null = null;
  private snapArmed = true;
  private aimHeld = false;
  private useHeld = false;
  private confirm = false;
  private onChange: (presenting: boolean) => void;

  constructor(renderer: THREE.WebGLRenderer, onChange: (presenting: boolean) => void) {
    this.renderer = renderer;
    this.rig.name = 'XrRig';
    this.onChange = onChange;

    renderer.xr.addEventListener('sessionstart', () => this.onChange(true));
    renderer.xr.addEventListener('sessionend', () => this.onChange(false));
  }

  get presenting(): boolean {
    return this.renderer.xr.isPresenting;
  }

  /**
   * Whether this browser can offer an immersive session at all.
   *
   * Asked rather than assumed: `navigator.xr` exists in plenty of browsers that
   * will refuse the session, so the button has to be driven by the real answer
   * or it is a button that does nothing.
   */
  static async available(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr?.isSessionSupported) return false;
    try {
      return await xr.isSessionSupported('immersive-vr');
    } catch {
      return false;
    }
  }

  /** Attaches the controllers. Safe to call before any session exists. */
  attach(): void {
    this.left = this.renderer.xr.getController(0);
    this.right = this.renderer.xr.getController(1);
    this.rig.add(this.left, this.right);
  }

  /**
   * Opens a session.
   *
   * `local-floor` is required rather than optional: without it the origin is
   * wherever the headset happened to be when the session began, and the whole
   * building would sit at chest height.
   */
  async enter(): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error('This browser has no WebXR.');

    const session = await xr.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking'],
    });

    this.renderer.xr.setReferenceSpaceType('local-floor');
    await this.renderer.xr.setSession(session as XRSession);
  }

  async exit(): Promise<void> {
    const session = this.renderer.xr.getSession();
    if (session) await session.end();
  }

  /** Puts the rig somewhere, in world metres. The camera follows it. */
  place(x: number, y: number, z: number, heading: number): void {
    this.rig.position.set(x, y, z);
    this.rig.rotation.y = heading;
  }

  /**
   * Reads both controllers into an intent.
   *
   * Left stick moves, right stick turns — the layout nearly every VR
   * application uses, and the one people arrive already knowing.
   */
  read(comfort: { locomotion: 'smooth' | 'teleport'; snapTurn: boolean }): XrFrameInput {
    const session = this.renderer.xr.getSession();
    if (!session) {
      return { intent: { ...NO_INTENT }, aim: null, hand: null, confirmTeleport: false, use: false };
    }

    let forward = 0;
    let strafe = 0;
    let turn = 0;
    let snap = 0;
    let running = false;
    let aiming = false;
    let using = false;

    for (const source of session.inputSources) {
      const pad = source.gamepad;
      if (!pad) continue;

      // Axes 2 and 3 are the thumbstick on every mainstream controller; 0 and 1
      // are the trackpad that older hardware has instead. Falling back covers
      // both without a device table.
      const x = pad.axes[2] ?? pad.axes[0] ?? 0;
      const y = pad.axes[3] ?? pad.axes[1] ?? 0;
      const dead = (value: number) => (Math.abs(value) < STICK_DEADZONE ? 0 : value);

      if (source.handedness === 'left') {
        if (comfort.locomotion === 'smooth') {
          strafe = dead(x);
          // Pushing the stick away from you walks forwards, so the axis is
          // inverted — the runtime reports "away" as negative.
          forward = -dead(y);
        }
        running = pad.buttons[1]?.pressed === true;
      }

      if (source.handedness === 'right') {
        const sideways = dead(x);

        if (comfort.snapTurn) {
          /*
           * One turn per push, re-armed only when the stick comes back.
           *
           * Without the re-arm, holding the stick over snaps every frame and
           * becomes a very fast continuous turn — which is the exact thing snap
           * turning exists to avoid.
           */
          if (this.snapArmed && Math.abs(sideways) > SNAP_THRESHOLD) {
            snap = Math.sign(sideways);
            this.snapArmed = false;
          } else if (Math.abs(sideways) < SNAP_RELEASE) {
            this.snapArmed = true;
          }
        } else {
          turn = sideways;
        }

        // The trigger aims the teleport; releasing it takes the jump.
        const trigger = pad.buttons[0]?.pressed === true;
        aiming = trigger;

        /*
         * The grip uses whatever the hand is pointing at. Grip rather than
         * trigger because the trigger is already the teleport, and because
         * closing your hand around something is what taking hold of a door
         * handle feels like.
         */
        using = pad.buttons[1]?.pressed === true;
      }
    }

    // Teleport is always available, whichever locomotion is chosen: somebody on
    // smooth movement still wants to cross a room they can see into.
    const confirmTeleport = this.aimHeld && !aiming;
    this.aimHeld = aiming;
    this.confirm = confirmTeleport;

    const controller = this.right;
    let hand: XrFrameInput['hand'] = null;

    if (controller) {
      const origin = new THREE.Vector3();
      const direction = new THREE.Vector3(0, 0, -1);
      controller.getWorldPosition(origin);
      direction.applyQuaternion(controller.getWorldQuaternion(new THREE.Quaternion()));
      hand = { origin, direction };
    }

    // A press, not a hold: using something is an event, and a held grip should
    // not open and shut a door sixty times a second.
    const use = using && !this.useHeld;
    this.useHeld = using;

    return {
      intent: { forward, strafe, turn, snap, running, crouching: false, teleportTo: null },
      aim: aiming ? hand : null,
      hand,
      confirmTeleport,
      use,
    };
  }

  /** Where the aim ended, so the caller can take the teleport on release. */
  get confirmed(): boolean {
    return this.confirm;
  }

  dispose(): void {
    if (this.left) this.rig.remove(this.left);
    if (this.right) this.rig.remove(this.right);
    this.left = null;
    this.right = null;
  }
}

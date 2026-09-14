/**
 * Walking about with a keyboard and mouse.
 *
 * -----------------------------------------------------------------------------
 * THIS IS NOT A CONSOLATION PRIZE FOR NOT OWNING A HEADSET.
 *
 * It is a real feature — most people assessing a design will never put a
 * headset on — and it is also the thing that makes the headset version
 * possible to build. Everything below the input layer is shared, so every rule
 * about walls, doorways, stairs and teleport landings is exercised here, on a
 * machine that can be automated, rather than only inside a device that cannot.
 *
 * -----------------------------------------------------------------------------
 * POINTER LOCK, AND WHAT HAPPENS WHEN IT GOES AWAY.
 *
 * Mouse-look needs the pointer locked, and the browser can take that lock back
 * at any moment — Escape, switching tabs, a permission prompt. Every one of
 * those has to leave the app in a sane state rather than in a walkthrough with
 * a cursor stuck somewhere. So the lock is the source of truth: losing it
 * pauses the walk rather than being treated as an error.
 */

import { NO_INTENT, type WalkIntent } from '@/walk/Walker';

/** How far the view turns per pixel of mouse movement. */
const LOOK_SENSITIVITY = 0.0022;

/** How far up and down the view may tilt. Just short of straight up or down. */
const MAX_PITCH = Math.PI / 2 - 0.05;

export interface DesktopWalkState {
  intent: WalkIntent;
  /** Up and down, which the walker does not own — the body does not tilt. */
  pitch: number;
  /** Whether the pointer is locked and input is being read. */
  active: boolean;
  /** True on the frame a teleport was confirmed. */
  confirmTeleport: boolean;
}

export class DesktopWalk {
  private canvas: HTMLCanvasElement;
  private held = new Set<string>();
  private pitch = 0;
  private yawDelta = 0;
  private snapQueued = 0;
  private confirm = false;
  private teleportHeld = false;
  private locked = false;
  private onLockChange: (locked: boolean) => void;
  private detach: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement, onLockChange: (locked: boolean) => void) {
    this.canvas = canvas;
    this.onLockChange = onLockChange;
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  get currentPitch(): number {
    return this.pitch;
  }

  /** Whether the teleport aim is being held down this frame. */
  get aiming(): boolean {
    return this.teleportHeld;
  }

  /** Starts listening and asks for the pointer. */
  start(): void {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!this.locked) return;
      this.held.add(event.code);

      // Snap turn is a discrete event, not a held state: holding Q should turn
      // once, not spin, or it is no longer a comfort feature.
      if (event.repeat) return;
      if (event.code === 'KeyQ') this.snapQueued -= 1;
      if (event.code === 'KeyE') this.snapQueued += 1;
    };

    const onKeyUp = (event: KeyboardEvent) => {
      this.held.delete(event.code);
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!this.locked) return;
      this.yawDelta += event.movementX * LOOK_SENSITIVITY;
      this.pitch = Math.max(
        -MAX_PITCH,
        Math.min(MAX_PITCH, this.pitch - event.movementY * LOOK_SENSITIVITY),
      );
    };

    const onMouseDown = (event: MouseEvent) => {
      if (!this.locked) return;
      // Right button aims the teleport, the way a controller's grip does.
      if (event.button === 2) this.teleportHeld = true;
    };

    const onMouseUp = (event: MouseEvent) => {
      if (!this.locked) return;
      if (event.button === 2 && this.teleportHeld) {
        this.teleportHeld = false;
        this.confirm = true;
      }
    };

    const onContextMenu = (event: Event) => {
      // Right-drag is the teleport; a context menu in the middle of it is not
      // what anybody wanted.
      if (this.locked) event.preventDefault();
    };

    const onLockChanged = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.held.clear();
        this.teleportHeld = false;
      }
      this.onLockChange(this.locked);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    this.canvas.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerlockchange', onLockChanged);

    this.detach = [
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => window.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => this.canvas.removeEventListener('contextmenu', onContextMenu),
      () => document.removeEventListener('pointerlockchange', onLockChanged),
    ];

    void this.canvas.requestPointerLock();
  }

  /** Asks for the pointer again, after the user clicked to resume. */
  requestLock(): void {
    void this.canvas.requestPointerLock();
  }

  stop(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.held.clear();
    this.teleportHeld = false;
    this.confirm = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /**
   * The intent for this frame, and the accumulated look.
   *
   * Reading clears the one-shot parts — the snap turn and the teleport
   * confirmation — because they are events rather than states, and a frame that
   * dropped would otherwise replay them.
   */
  read(delta: number): DesktopWalkState {
    if (!this.locked) {
      return { intent: { ...NO_INTENT }, pitch: this.pitch, active: false, confirmTeleport: false };
    }

    const down = (code: string) => (this.held.has(code) ? 1 : 0);

    const forward = down('KeyW') + down('ArrowUp') - down('KeyS') - down('ArrowDown');
    const strafe = down('KeyD') - down('KeyA');

    // The mouse has already moved the view this frame; the walker takes a rate,
    // so it is converted back. Dividing by delta keeps a fast flick and a slow
    // drag turning by the same amount for the same pixels.
    const turn = delta > 0 ? this.yawDelta / delta : 0;
    this.yawDelta = 0;

    const snap = this.snapQueued;
    this.snapQueued = 0;

    const confirmTeleport = this.confirm;
    this.confirm = false;

    return {
      intent: {
        forward: Math.max(-1, Math.min(1, forward)),
        strafe: Math.max(-1, Math.min(1, strafe)),
        // The walker multiplies by its own turn speed, and the mouse has
        // already produced radians — so this is handed over pre-scaled.
        turn: turn / 2.2,
        snap,
        running: this.held.has('ShiftLeft') || this.held.has('ShiftRight'),
        teleportTo: null,
      },
      pitch: this.pitch,
      active: true,
      confirmTeleport,
    };
  }

  /** Puts the view level again, for entering the mode. */
  resetPitch(): void {
    this.pitch = 0;
    this.yawDelta = 0;
  }
}

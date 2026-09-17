/**
 * The camera, when you are looking at yourself.
 *
 * -----------------------------------------------------------------------------
 * FREE ORBIT, WHICH IS A DIFFERENT CONTRACT FROM FIRST PERSON.
 *
 * In first person the mouse turns the BODY: where you look and where you face
 * are the same fact, and the walkthrough has always modelled them as one number.
 * Free orbit breaks them apart. The mouse moves the CAMERA around the figure,
 * the figure stays where it was facing, and it only turns when you actually walk
 * — to face wherever you are walking.
 *
 * That is the better choice for looking at a room, which is what this app is
 * for: you can walk to the middle of a kitchen and then circle it without
 * spinning on the spot. It costs one thing, and it is worth being honest about
 * it — forward now means "away from the camera" rather than "the way I am
 * facing", so steering takes a moment more thought.
 *
 * -----------------------------------------------------------------------------
 * THE BOOM SHORTENS FAST AND LENGTHENS SLOWLY.
 *
 * A camera three metres behind a person is three metres into the wall behind
 * them, most of the time, in a house. So it is cast against the building every
 * frame and pulled in to whatever it hits.
 *
 * The asymmetry matters more than the raycast. Easing the shortening means the
 * camera spends those frames inside the wall, which is the one failure mode that
 * is genuinely unusable — you see the room from outside through a hole. Easing
 * the lengthening is what stops the camera snapping outwards every time you
 * clear a doorway. So: in at once, out gently.
 */

import * as THREE from 'three';

/** How far behind the figure the camera sits when nothing is in the way. */
const BOOM = 3.1;

/**
 * How high above the feet the camera aims.
 *
 * Chest height rather than eye height. Aiming at the eye puts the head in the
 * exact centre of the screen, which hides the thing you are trying to look at;
 * aiming a little lower leaves the head high in frame and the room visible
 * around it, which is what every third-person camera does and why.
 */
const FOCUS_HEIGHT = 1.25;

/** Keeps the camera off the surface it hit, so it never clips through. */
const SKIN = 0.22;

/** Metres per second the boom extends back out once it is clear. */
const EXTEND_SPEED = 4;

/**
 * How quickly the camera's aim catches up with the body, per second.
 *
 * A camera welded rigidly to a moving body transfers every one of that body's
 * accelerations straight into the frame, and the result reads as stiff — it is
 * the difference between a camera operator following somebody and a camera
 * bolted to their back. Letting the aim trail and catch up costs a few
 * centimetres of lag and is most of what separates a third-person view that
 * feels expensive from one that does not.
 *
 * Too low and the body outruns its own frame, which is worse than being stiff.
 * Ten per second lands around a tenth of a second behind, which is about a
 * step's worth of lean and reads as weight rather than delay.
 */
const FOLLOW_RATE = 10;

/** Limits, so the camera cannot go under the floor or straight overhead. */
const MIN_PITCH = -0.95;
const MAX_PITCH = 1.15;

/**
 * How far above level the camera sits when the mouse has not been moved.
 *
 * Third person needs this and first person does not. Looking dead level from
 * behind somebody puts their head over everything you are trying to see, and in
 * a room — where the boom is usually shortened by the wall behind you anyway —
 * a little height buys back most of the view that the shortened boom lost.
 *
 * Added to the mouse's pitch rather than used as a starting value. The first
 * version set it once in the field initialiser, where it survived exactly until
 * the first frame: the mouse reports an absolute pitch, not a delta, so it was
 * overwritten by zero before anybody saw it.
 */
const BASE_PITCH = 0.2;

export class ThirdPerson {
  /** Where the camera sits around the figure, radians. */
  private yaw = 0;
  /** How far above or below the focus it looks from. */
  private pitch = BASE_PITCH;
  /** The boom length actually in use, which lags the ideal one outwards only. */
  private reach = BOOM;
  /** Where the camera is actually aimed, which trails the body. See FOLLOW_RATE. */
  private aim: THREE.Vector3 | null = null;

  private raycaster = new THREE.Raycaster();

  /** Objects the camera is allowed to pass through — chiefly the figure itself. */
  private ignore = new Set<THREE.Object3D>();

  ignoreObject(object: THREE.Object3D): void {
    this.ignore.add(object);
  }

  /**
   * Takes the mouse.
   *
   * `turn` arrives as the walker's turn intent — the same accumulated mouse
   * movement first person would have given the body — and is spent on the camera
   * instead. That is the whole difference between the two modes, and doing it
   * here rather than in the input layer means the mouse code stays one thing.
   */
  orbit(turn: number, pitch: number, delta: number): void {
    this.yaw += turn * 2.2 * delta;
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch + BASE_PITCH));
  }

  /** Where "forward" points, for turning movement keys into a world direction. */
  get heading(): number {
    return this.yaw;
  }

  /** Aligns the orbit with a heading, for entering third person without a jump. */
  alignTo(heading: number): void {
    this.yaw = heading;
    this.reach = BOOM;
    // Forget where it was trailing, so entering third person does not sweep the
    // camera across the building from wherever the body last stood.
    this.aim = null;
  }

  /**
   * Places the camera, and returns where it is looking from.
   *
   * `feet` is the walker's position on the floor; the focus is computed from it
   * rather than passed in, so there is one definition of what the camera looks
   * at.
   */
  place(
    camera: THREE.PerspectiveCamera,
    feet: { x: number; y: number; z: number },
    scene: THREE.Scene,
    delta: number,
  ): void {
    const onBody = new THREE.Vector3(feet.x, feet.y + FOCUS_HEIGHT, feet.z);

    /*
     * The aim trails the body rather than sitting on it.
     *
     * Exponential catch-up, framed so it is frame-rate independent: a fixed
     * fraction per frame would follow twice as fast at 120 fps as at 60, which
     * is the most common way smoothing like this is written and quietly wrong.
     */
    if (!this.aim) this.aim = onBody.clone();
    else this.aim.lerp(onBody, 1 - Math.exp(-FOLLOW_RATE * delta));

    const focus = this.aim;

    /*
     * The direction from the focus out to the camera.
     *
     * Note the sign on yaw: the walkthrough's heading convention is that a
     * heading of zero looks towards +z, which is not Three's default. Getting
     * this backwards puts the camera in front of the figure, which looks almost
     * right — you are still orbiting a person — and is maddening to diagnose,
     * because the only symptom is that the controls feel inverted.
     */
    const horizontal = Math.cos(this.pitch);
    const back = new THREE.Vector3(
      -Math.sin(this.yaw) * horizontal,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * horizontal,
    );

    const wanted = this.clearDistance(focus, back, scene);

    // In at once, out gently. See the header.
    if (wanted < this.reach) this.reach = wanted;
    else this.reach = Math.min(wanted, this.reach + EXTEND_SPEED * delta);

    camera.position.copy(focus).addScaledVector(back, this.reach);
    camera.lookAt(focus);
  }

  /**
   * How far the boom can extend before it hits something.
   *
   * Cast from the focus outwards rather than from the camera inwards, because
   * the focus is always inside the room and the camera may already be inside a
   * wall — a ray that starts inside geometry hits nothing on the way out, which
   * would report the wall as clear at exactly the moment it matters.
   */
  private clearDistance(focus: THREE.Vector3, back: THREE.Vector3, scene: THREE.Scene): number {
    this.raycaster.set(focus, back);
    this.raycaster.far = BOOM;

    for (const hit of this.raycaster.intersectObject(scene, true)) {
      if (this.isIgnored(hit.object)) continue;
      const mesh = hit.object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) continue;
      return Math.max(0.35, hit.distance - SKIN);
    }
    return BOOM;
  }

  private isIgnored(object: THREE.Object3D): boolean {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      if (this.ignore.has(node)) return true;
      // An escape hatch for anything that should never block the view — the
      // comfort vignette, the reach highlight, the teleport arc.
      if (node.userData.noCameraCollide) return true;
    }
    return false;
  }
}

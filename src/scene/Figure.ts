/**
 * The person you are, when you look at yourself.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS BUILT RATHER THAN DOWNLOADED.
 *
 * Every other object in havavamama is generated from real dimensions, for a
 * reason that matters commercially: a sofa in the catalogue is 2.28 m wide
 * because the real one is, and the shopping list is only honest while that stays
 * true. A downloaded human would be the one thing on screen whose size nobody
 * could account for — and the size is the entire value of putting a person in an
 * architectural view. So this is built, from a table of proportions, like
 * everything else.
 *
 * -----------------------------------------------------------------------------
 * THE PROPORTIONS ARE REAL, AND THE ARTISTIC ONES WOULD BE WRONG.
 *
 * Figure drawing teaches an eight-head canon: a heroic, idealised body used
 * because it composes well. Real adults are about seven and a half heads, and
 * fashion illustration goes to nine. Using either of those here would quietly
 * break the thing this figure is for — a person who is the wrong number of heads
 * tall makes every room they stand in look the wrong size, which is worse than
 * having no figure at all.
 *
 * So the numbers below come from anthropometric survey proportions for a median
 * adult, expressed as fractions of stature, and the default stature is 1.75 m.
 * The eye lands at 1.62 m, which is not a coincidence: it is `BODY.eyeHeight`,
 * the height the walkthrough camera has always used. The camera is in this
 * figure's head rather than hovering near it.
 *
 * -----------------------------------------------------------------------------
 * ON THE UNCANNY VALLEY, WHICH IS A REAL RISK HERE.
 *
 * A figure detailed enough to read as a person invites the eye to judge it as
 * one, and a slightly wrong human looks far worse than an obviously abstract
 * one. Three decisions hedge against that, and each of them is a deliberate
 * refusal to add detail:
 *
 *   NO FACE. A face is where the valley is deepest, and a smooth head reads as
 *   "a figure in an architectural render" — a convention people already know —
 *   rather than as a person with something wrong with their features.
 *
 *   ONE MATERIAL. No skin tone, no clothing colour. Partly because this figure
 *   stands in a tool for judging paint colours and must not compete with them,
 *   and partly because a neutral grey is read as a representation while a flesh
 *   tone is read as an attempt at a person.
 *
 *   MOTION BEFORE DETAIL. A static human standing bolt upright and sliding
 *   across the floor looks worse than no human at all, however well modelled. So
 *   the walk cycle came first and the geometry is only as detailed as the motion
 *   can carry.
 */

import * as THREE from 'three';

import { cornerSegments, radialSegments, sphereSegments } from './tessellation';

import type { StrideSample } from '@/walk/stride';

/* ------------------------------- Proportions ------------------------------ */

/**
 * A median adult, as fractions of stature.
 *
 * Kept as fractions rather than metres so the figure can be resized — a 1.6 m
 * person and a 1.9 m one are not the same shape scaled, but they are much closer
 * to that than to each other in absolute terms, and for a scale reference this
 * is the right approximation.
 */
const P = {
  /** Head height. About 1/7.5 of stature for a real adult. */
  head: 0.133,
  /** Eye above the floor, as a fraction. 1.62 / 1.75. */
  eye: 0.926,
  /** Top of the shoulders. */
  shoulder: 0.818,
  /** Width across the shoulders. */
  shoulderSpan: 0.259,
  /** Hip joint height — the top of the leg, and where the thigh pivots. */
  hip: 0.53,
  /** Width between the hip joints. */
  hipSpan: 0.115,
  /** Knee joint height. */
  knee: 0.285,
  /** Ankle joint height. */
  ankle: 0.039,
  /** Elbow height when the arm hangs. */
  elbow: 0.63,
  /** Wrist height when the arm hangs. */
  wrist: 0.485,
  /** Foot length. */
  foot: 0.152,
} as const;

/** Radii, also as fractions of stature. A person is not a stick. */
const R = {
  neck: 0.032,
  chest: 0.098,
  waist: 0.072,
  pelvis: 0.086,
  upperArm: 0.032,
  forearm: 0.026,
  wristR: 0.019,
  thigh: 0.056,
  calf: 0.042,
  ankleR: 0.026,
} as const;

/** Default stature, in metres. A median adult, and the scale reference. */
export const FIGURE_HEIGHT = 1.75;

/**
 * One neutral grey.
 *
 * Mid-grey at a roughness that reads as matte fabric rather than skin or
 * plastic. It has to sit quietly behind the paint colours a person is here to
 * judge, which rules out anything warm.
 */
const SKIN = 0x9a9ba0;

/* -------------------------------- The rig --------------------------------- */

/**
 * A limb segment: a tapered shaft with a ball at the joint.
 *
 * The ball is what makes a jointed figure read as a body rather than as a
 * collection of sticks. Without one, every bend opens a visible gap at the
 * elbow and knee; with one, the silhouette stays continuous through the whole
 * range of the walk cycle, which is the only range that matters here.
 */
function segment(
  material: THREE.Material,
  length: number,
  topRadius: number,
  bottomRadius: number,
): THREE.Group {
  const group = new THREE.Group();

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(
      topRadius,
      bottomRadius,
      length,
      radialSegments(Math.max(topRadius, bottomRadius)),
      1,
    ),
    material,
  );
  // Hung from the joint at its top, so rotating the group swings the limb from
  // the shoulder or the hip rather than about its own middle.
  shaft.position.y = -length / 2;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  group.add(shaft);

  const ball = new THREE.Mesh(new THREE.SphereGeometry(
      topRadius,
      sphereSegments(topRadius).width,
      sphereSegments(topRadius).height,
    ),
    material,
  );
  ball.castShadow = true;
  group.add(ball);

  return group;
}

/** The joints the walk cycle drives, in the order a leg bends. */
interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
  end: THREE.Group;
}

export class Figure {
  readonly group = new THREE.Group();

  private material: THREE.MeshStandardMaterial;
  private height: number;

  private leftLeg: Limb;
  private rightLeg: Limb;
  private leftArm: Limb;
  private rightArm: Limb;
  private torso = new THREE.Group();
  private head: THREE.Mesh;

  /** Body facing, eased towards the direction of travel rather than snapped. */
  private facing = 0;

  constructor(height = FIGURE_HEIGHT) {
    this.height = height;
    this.group.name = 'Figure';

    this.material = new THREE.MeshStandardMaterial({
      color: SKIN,
      roughness: 0.78,
      metalness: 0,
    });

    const h = height;
    const m = this.material;

    /* ---------------------------- Trunk ---------------------------- */

    this.torso.position.y = P.hip * h;
    this.group.add(this.torso);

    // Pelvis to shoulders as one tapered mass. A real trunk narrows at the waist
    // and widens again at the chest, which a single cone cannot do — so it is two
    // stacked, meeting at the waist.
    const trunkLower = new THREE.Mesh(
      new THREE.CylinderGeometry(
        R.waist * h,
        R.pelvis * h,
        (0.66 - P.hip) * h,
        radialSegments(Math.max(R.waist, R.pelvis) * h),
        1,
      ),
      m,
    );
    trunkLower.position.y = ((0.66 - P.hip) / 2) * h;
    trunkLower.castShadow = true;
    trunkLower.receiveShadow = true;
    this.torso.add(trunkLower);

    const trunkUpper = new THREE.Mesh(
      new THREE.CylinderGeometry(
        R.chest * h,
        R.waist * h,
        (P.shoulder - 0.66) * h,
        radialSegments(Math.max(R.chest, R.waist) * h),
        1,
      ),
      m,
    );
    trunkUpper.position.y = (0.66 - P.hip) * h + ((P.shoulder - 0.66) / 2) * h;
    trunkUpper.castShadow = true;
    trunkUpper.receiveShadow = true;
    this.torso.add(trunkUpper);

    /*
     * Shoulders, as a bar across the top of the chest. Without it the arms hang
     * off the sides of a cylinder and the figure reads as a bottle.
     *
     * Sat so its TOP meets the shoulder line rather than its centre, and slimmer
     * than the first attempt. Centred on the line, a bar of this radius stood ten
     * centimetres proud of the shoulders and swallowed the neck whole — from
     * behind the figure had no neck at all and read as hunched, which is a long
     * way into the uncanny valley for the sake of one misplaced origin.
     */
    const shoulderRadius = R.chest * h * 0.46;
    const shoulders = new THREE.Mesh(
      new THREE.CapsuleGeometry(
        shoulderRadius,
        P.shoulderSpan * h * 0.74,
        cornerSegments(shoulderRadius) * 2,
        radialSegments(shoulderRadius),
      ),
      m,
    );
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.y = (P.shoulder - P.hip) * h - shoulderRadius * 0.55;
    shoulders.castShadow = true;
    this.torso.add(shoulders);

    /* ----------------------------- Head ----------------------------- */

    /*
     * Neck and head, stacked from the shoulder line rather than placed by eye.
     *
     * Each sits on top of the one below, so a change to any proportion keeps the
     * head clear of the shoulders instead of sinking into them. Working out the
     * three heights independently is how the first version ended up with the
     * head's underside six centimetres BELOW the top of its own neck.
     */
    const shoulderLine = (P.shoulder - P.hip) * h;
    const neckLength = 0.055 * h;
    const headRadius = P.head * h * 0.5;

    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(
        R.neck * h,
        R.neck * h * 1.2,
        neckLength,
        radialSegments(R.neck * h * 1.2),
        1,
      ),
      m,
    );
    neck.position.y = shoulderLine + neckLength * 0.5;
    neck.castShadow = true;
    this.torso.add(neck);

    // Slightly taller than wide, like a real skull, and set a little forward of
    // the spine where a head actually sits.
    this.head = new THREE.Mesh(new THREE.SphereGeometry(
        headRadius,
        sphereSegments(headRadius).width,
        sphereSegments(headRadius).height,
      ),
      m,
    );
    this.head.scale.set(0.86, 1, 0.94);
    this.head.position.set(0, shoulderLine + neckLength + headRadius * 0.82, 0.008 * h);
    this.head.castShadow = true;
    this.head.receiveShadow = true;
    this.torso.add(this.head);

    /* ----------------------------- Limbs ---------------------------- */

    this.leftArm = this.buildArm(-1);
    this.rightArm = this.buildArm(1);
    this.leftLeg = this.buildLeg(-1);
    this.rightLeg = this.buildLeg(1);

    this.setPose({ phase: 0, planted: null, leading: 'right', moving: false }, 0);
  }

  /** `side` is -1 for the figure's left, +1 for its right. */
  private buildArm(side: number): Limb {
    const h = this.height;
    const m = this.material;

    const upper = segment(m, (P.shoulder - P.elbow) * h, R.upperArm * h, R.forearm * h * 1.1);
    upper.position.set(side * P.shoulderSpan * h * 0.44, (P.shoulder - P.hip) * h, 0);
    /*
     * Hung slightly inwards, so the arm rests against the ribs.
     *
     * Arms dropped straight down from the shoulder joints stand a few
     * centimetres clear of the torso all the way to the wrist, and the daylight
     * between arm and body is the single thing that most makes a jointed figure
     * read as a mannequin rather than a person. A real arm at rest touches.
     */
    upper.rotation.z = -side * 0.07;
    this.torso.add(upper);

    const lower = segment(m, (P.elbow - P.wrist) * h, R.forearm * h, R.wristR * h);
    lower.position.y = -(P.shoulder - P.elbow) * h;
    upper.add(lower);

    // A hand, as a flattened blob. Fingers at this scale are a few pixels and
    // modelling them buys nothing but polygons and a chance to look wrong.
    const hand = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.SphereGeometry(
        R.wristR * h * 1.5,
        sphereSegments(R.wristR * h * 1.5).width,
        sphereSegments(R.wristR * h * 1.5).height,
      ),
      m,
    );
    palm.scale.set(0.75, 1.5, 0.45);
    palm.position.y = -R.wristR * h * 1.5;
    palm.castShadow = true;
    hand.add(palm);
    hand.position.y = -(P.elbow - P.wrist) * h;
    lower.add(hand);

    return { upper, lower, end: hand };
  }

  private buildLeg(side: number): Limb {
    const h = this.height;
    const m = this.material;

    const upper = segment(m, (P.hip - P.knee) * h, R.thigh * h, R.calf * h * 1.15);
    upper.position.set(side * P.hipSpan * h * 0.5, 0, 0);
    this.torso.add(upper);

    const lower = segment(m, (P.knee - P.ankle) * h, R.calf * h, R.ankleR * h);
    lower.position.y = -(P.hip - P.knee) * h;
    upper.add(lower);

    // The foot, which is the one place a little length matters: it is what stops
    // the figure looking like it is standing on stumps, and it is what the eye
    // uses to tell whether a step has actually landed.
    const foot = new THREE.Group();
    const shoe = new THREE.Mesh(
      new THREE.BoxGeometry(R.ankleR * h * 2.1, P.ankle * h * 1.5, P.foot * h),
      m,
    );
    shoe.position.set(0, -P.ankle * h * 0.5, P.foot * h * 0.28);
    shoe.castShadow = true;
    shoe.receiveShadow = true;
    foot.add(shoe);
    foot.position.y = -(P.knee - P.ankle) * h;
    lower.add(foot);

    return { upper, lower, end: foot };
  }

  /* -------------------------------- Motion ------------------------------- */

  /**
   * Poses the figure for a point in the stride.
   *
   * The cycle is written as plain trigonometry rather than as keyframes, because
   * a walk IS periodic and because a keyframed cycle has to be re-authored for
   * every speed while this one just takes a longer step.
   *
   * `phase` counts ONE step, not a full two-step cycle, so the legs are driven
   * at half its rate and half a period apart. That is what keeps this in step
   * with the footstep sounds, which fire once per step for alternating feet.
   */
  setPose(stride: StrideSample, speed: number): void {
    // How much of the cycle to express. Standing still should not freeze
    // mid-stride with one leg in the air, so the whole thing fades out.
    const effort = stride.moving ? Math.min(1, 0.35 + speed / 1.4) : 0;

    /*
     * The leading foot decides the phase offset.
     *
     * `phase` restarts at every heel strike and does not know which foot it
     * was, so on its own it would drive both legs identically. Offsetting by
     * half a cycle on alternate steps is what turns a bounce into a walk.
     */
    const half = stride.leading === 'right' ? 0 : Math.PI;
    const angle = stride.phase * Math.PI + half;

    this.poseLeg(this.rightLeg, angle, effort);
    this.poseLeg(this.leftLeg, angle + Math.PI, effort);

    // Arms swing opposite the leg on the same side — the counter-rotation that
    // keeps a walking person from spinning about their own axis. Shorter throw
    // than the legs, because they are passengers rather than drivers.
    this.poseArm(this.rightArm, angle + Math.PI, effort);
    this.poseArm(this.leftArm, angle, effort);

    /*
     * The bob.
     *
     * A walking body rises and falls about 25 mm, twice per stride — at each
     * mid-stance, when the supporting leg is straight underneath. Leaving it out
     * is the single biggest reason an otherwise correct walk cycle reads as
     * gliding, and it costs one sine.
     */
    this.torso.position.y = P.hip * this.height - Math.abs(Math.cos(angle)) * 0.025 * effort;
    // And a slight forward lean when moving, which is how people accelerate.
    this.torso.rotation.x = 0.05 * effort;
  }

  private poseLeg(leg: Limb, angle: number, effort: number): void {
    const swing = Math.sin(angle);

    // Hip: forward at the start of the step, trailing at the end.
    leg.upper.rotation.x = swing * 0.55 * effort;

    /*
     * Knee: bends on the way through, straight on the way down.
     *
     * A knee is a hinge that only goes one way, and a walk cycle that lets it
     * bend backwards is the single most obviously wrong thing a figure can do.
     * `Math.max(0, ...)` is the hinge, and it is why this is not just a second
     * sine wave.
     */
    const lift = Math.max(0, -Math.cos(angle));
    leg.lower.rotation.x = -lift * 0.95 * effort;

    // Ankle keeps the foot roughly level with the floor through the step.
    leg.end.rotation.x = (lift * 0.5 - swing * 0.25) * effort;
  }

  private poseArm(arm: Limb, angle: number, effort: number): void {
    const swing = Math.sin(angle);
    arm.upper.rotation.x = swing * 0.38 * effort;
    // The elbow is always a little bent, and bends more on the forward swing.
    arm.lower.rotation.x = -(0.12 + Math.max(0, swing) * 0.4) * effort - 0.08;
  }

  /* ------------------------------- Placement ------------------------------ */

  /**
   * Puts the figure where the walker is.
   *
   * `heading` is where the body should face. It is eased rather than set,
   * because in the free-orbit camera the walking direction can change instantly
   * — press A while walking forward and the intent turns ninety degrees in one
   * frame — and a body that snaps round in a single frame reads as a glitch
   * rather than as a turn.
   */
  place(x: number, y: number, z: number, heading: number, delta: number): void {
    this.group.position.set(x, y, z);

    // Shortest way round, so turning from +179° to -179° is two degrees rather
    // than three hundred and fifty-eight.
    let difference = heading - this.facing;
    while (difference > Math.PI) difference -= Math.PI * 2;
    while (difference < -Math.PI) difference += Math.PI * 2;

    this.facing += difference * Math.min(1, delta * 10);
    this.group.rotation.y = this.facing;
  }

  /** Snaps the facing, for when the walker is put somewhere new. */
  faceNow(heading: number): void {
    this.facing = heading;
    this.group.rotation.y = heading;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * The current pose, for automated checking.
   *
   * The walk cycle is covered by unit tests, but those exercise the maths in
   * isolation. This answers the different question of whether the figure in the
   * running app is actually being driven — a rig that is correct and never
   * posed looks exactly like a rig that is broken, and a headless browser cannot
   * tell them apart from a screenshot.
   */
  report(): { hipLeft: number; hipRight: number; kneeLeft: number; kneeRight: number; bob: number } {
    return {
      hipLeft: +this.leftLeg.upper.rotation.x.toFixed(4),
      hipRight: +this.rightLeg.upper.rotation.x.toFixed(4),
      kneeLeft: +this.leftLeg.lower.rotation.x.toFixed(4),
      kneeRight: +this.rightLeg.lower.rotation.x.toFixed(4),
      bob: +this.torso.position.y.toFixed(4),
    };
  }

  /** Eye height above the feet, which is what the camera sits at. */
  get eyeHeight(): number {
    return P.eye * this.height;
  }

  dispose(): void {
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.material.dispose();
  }
}

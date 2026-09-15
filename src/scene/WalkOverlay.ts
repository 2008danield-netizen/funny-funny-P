/**
 * What a walker sees that is not the building: the teleport arc, its landing
 * marker, and the comfort vignette.
 *
 * -----------------------------------------------------------------------------
 * THE VIGNETTE IS THE MOST IMPORTANT THING IN THIS FILE.
 *
 * It looks like a cosmetic darkening at the edges and it is the difference
 * between a headset somebody keeps on and one they take off after ninety
 * seconds. Moving smoothly through a virtual space while standing still is a
 * direct disagreement between the eyes and the inner ear, and the periphery is
 * where that disagreement is felt. Covering the periphery while moving removes
 * most of it for most people, at almost no cost to what they can actually see —
 * because the thing they are looking at is in the middle.
 *
 * It fades in as movement starts and out as it stops, over about a fifth of a
 * second. A vignette that snaps on is its own jolt.
 *
 * -----------------------------------------------------------------------------
 * DRAWN ON A CAMERA-ATTACHED QUAD, NOT AS A POST-PROCESS.
 *
 * The app has a post-processing chain, and putting the vignette in it would be
 * the obvious choice on desktop and wrong in a headset: post-processing in
 * WebXR has to run per eye, and the accumulation pass this app uses for its
 * photoreal stills is skipped in VR anyway. A small quad parented to the camera
 * costs one draw call, works identically in both eyes, and cannot interact with
 * anything else.
 */

import * as THREE from 'three';

import type { TeleportAim } from '@/walk/teleport';
import type { Interactable } from '@/walk/interactables';

const ARC_GOOD = 0x6fc27a;
const ARC_REFUSED = 0xc2706f;
const FOCUS_COLOUR = 0xf2d16b;

export class WalkOverlay {
  /** Goes in the scene: the arc and its marker live in world space. */
  readonly world = new THREE.Group();
  /** Goes on the camera: the vignette travels with the head. */
  readonly head = new THREE.Group();

  private arc: THREE.Line;
  private arcGeometry: THREE.BufferGeometry;
  private arcMaterial: THREE.LineBasicMaterial;
  private marker: THREE.Mesh;
  private markerMaterial: THREE.MeshBasicMaterial;

  /**
   * A ring drawn around whatever is within reach.
   *
   * In world space rather than on the crosshair, because in a headset there is
   * no crosshair to put it on — and a highlight that travels with the object
   * reads as "this thing", while one fixed to the middle of the view reads as
   * "something".
   */
  private focus: THREE.Mesh;
  private focusMaterial: THREE.MeshBasicMaterial;

  private vignette: THREE.Mesh;
  private vignetteMaterial: THREE.ShaderMaterial;
  private vignetteAmount = 0;

  constructor() {
    this.world.name = 'WalkOverlay';
    this.head.name = 'WalkComfort';

    /* ---- The arc ---- */

    this.arcGeometry = new THREE.BufferGeometry();
    this.arcGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(3 * 64), 3),
    );
    this.arcMaterial = new THREE.LineBasicMaterial({ color: ARC_GOOD, transparent: true });
    this.arc = new THREE.Line(this.arcGeometry, this.arcMaterial);
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    this.world.add(this.arc);

    /* ---- The landing marker ---- */

    // A ring rather than a disc: a disc hides the floor finish you are about to
    // stand on, which is often the thing being assessed.
    this.markerMaterial = new THREE.MeshBasicMaterial({
      color: ARC_GOOD,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 32), this.markerMaterial);
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    this.world.add(this.marker);

    /* ---- The focus ring ---- */

    this.focusMaterial = new THREE.MeshBasicMaterial({
      color: FOCUS_COLOUR,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      // Drawn over whatever it is on: a highlight hidden inside the door it is
      // highlighting is not a highlight.
      depthTest: false,
    });
    this.focus = new THREE.Mesh(new THREE.RingGeometry(0.075, 0.1, 24), this.focusMaterial);
    this.focus.renderOrder = 11;
    this.focus.visible = false;
    this.world.add(this.focus);

    /* ---- The comfort vignette ---- */

    this.vignetteMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { amount: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      /*
       * A soft ring closing in from the edges.
       *
       * `amount` is how much of the view it takes. The inner edge is feathered
       * over a wide band on purpose — a hard-edged hole reads as a mask being
       * held in front of your face, which is its own kind of unpleasant, while
       * a soft one is barely noticed even at full strength.
       */
      fragmentShader: `
        uniform float amount;
        varying vec2 vUv;
        void main() {
          if (amount <= 0.001) discard;
          vec2 centred = (vUv - 0.5) * 2.0;
          float radius = length(centred);
          float inner = mix(1.6, 0.25, amount);
          float outer = inner + 0.55;
          float darkness = smoothstep(inner, outer, radius);
          if (darkness <= 0.002) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, darkness);
        }
      `,
    });

    this.vignette = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.vignetteMaterial);
    this.vignette.frustumCulled = false;
    this.vignette.renderOrder = 1000;
    this.vignette.visible = false;
    this.head.add(this.vignette);
  }

  /**
   * Puts the focus ring on something, or takes it off.
   *
   * The ring always faces the viewer, so it reads as a target rather than as a
   * decal lying on a surface at a glancing angle.
   */
  setFocus(item: Interactable | null, viewer: THREE.Vector3): void {
    if (!item) {
      this.focus.visible = false;
      return;
    }

    this.focus.position.set(item.at.x, item.at.y, item.at.z);
    this.focus.lookAt(viewer);
    this.focus.visible = true;
  }

  /** Shows the arc and marker, or hides them. */
  setAim(aim: TeleportAim | null): void {
    if (!aim || aim.points.length < 2) {
      this.arc.visible = false;
      this.marker.visible = false;
      return;
    }

    const colour = aim.landing ? ARC_GOOD : ARC_REFUSED;
    this.arcMaterial.color.setHex(colour);
    this.markerMaterial.color.setHex(colour);

    const positions = this.arcGeometry.getAttribute('position') as THREE.BufferAttribute;
    const count = Math.min(aim.points.length, positions.count);
    for (let i = 0; i < count; i += 1) {
      const point = aim.points[i]!;
      positions.setXYZ(i, point.x, point.y, point.z);
    }
    // The remaining vertices are parked on the last real one, so the unused
    // tail of a fixed-size buffer draws as nothing rather than as a line back
    // to the origin.
    const last = aim.points[count - 1]!;
    for (let i = count; i < positions.count; i += 1) {
      positions.setXYZ(i, last.x, last.y, last.z);
    }
    positions.needsUpdate = true;

    this.arc.visible = true;

    if (aim.landing && aim.standing) {
      this.marker.position.set(aim.landing.x, aim.standing.y + 0.02, aim.landing.z);
      this.marker.visible = true;
    } else {
      this.marker.visible = false;
    }
  }

  /**
   * Eases the vignette towards where the current speed says it should be.
   *
   * Called every frame with the walker's speed, so it opens and closes with
   * movement rather than being switched.
   */
  updateComfort(
    speed: number,
    delta: number,
    settings: { vignette: boolean; vignetteStrength: number },
  ): void {
    // Full strength at a brisk walk; nothing at all when still.
    const target = settings.vignette ? Math.min(1, speed / 1.4) * settings.vignetteStrength : 0;

    // About a fifth of a second either way. A vignette that snaps on is its
    // own jolt, which rather defeats the purpose.
    const rate = 5 * Math.min(delta, 0.1);
    const gap = target - this.vignetteAmount;
    this.vignetteAmount += Math.abs(gap) <= rate ? gap : Math.sign(gap) * rate;

    this.vignetteMaterial.uniforms.amount!.value = this.vignetteAmount;
    this.vignette.visible = this.vignetteAmount > 0.001;
  }

  setVisible(visible: boolean): void {
    this.world.visible = visible;
    this.head.visible = visible;
    if (!visible) {
      this.arc.visible = false;
      this.marker.visible = false;
      this.focus.visible = false;
      this.vignette.visible = false;
      this.vignetteAmount = 0;
      this.vignetteMaterial.uniforms.amount!.value = 0;
    }
  }

  dispose(): void {
    this.arcGeometry.dispose();
    this.arcMaterial.dispose();
    this.marker.geometry.dispose();
    this.markerMaterial.dispose();
    this.focus.geometry.dispose();
    this.focusMaterial.dispose();
    this.vignette.geometry.dispose();
    this.vignetteMaterial.dispose();
    this.world.clear();
    this.head.clear();
  }
}

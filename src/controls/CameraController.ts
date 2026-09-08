/**
 * Camera and navigation.
 *
 * Wraps Three's OrbitControls with the behaviours an interior viewer needs:
 *
 *   • Limits that keep the camera above the site plane, so the user can never
 *     end up underneath the building looking at the underside of the floor.
 *   • Distance limits derived from the room size, so a 2 m closet and a 12 m
 *     open-plan space both feel right without manual tuning.
 *   • Named viewpoints (overview / plan / interior) with an eased fly-to, which
 *     is far less disorienting than snapping the camera.
 *
 * FOR SESSION 4 (WebXR): keep this class as the desktop navigation model. VR
 * gets its own rig — an XR session drives the camera from the headset pose and
 * OrbitControls must be disabled while it is active, or the two will fight over
 * the camera matrix.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { PlanModel, Point2 } from '@/state/types';
import { planBounds } from '@/scene/planGraph';

export type ViewpointId = 'overview' | 'plan' | 'interior' | 'corner';

export const VIEWPOINTS: Array<{ id: ViewpointId; label: string; hint: string }> = [
  { id: 'overview', label: 'Overview', hint: 'Three-quarter view from outside' },
  { id: 'corner', label: 'Corner', hint: 'Low angle from a room corner' },
  { id: 'interior', label: 'Inside', hint: 'Standing in the room at eye height' },
  { id: 'plan', label: 'Plan', hint: 'Straight down, like a floor plan' },
];

/** Average adult eye height, in metres — used by the interior viewpoint. */
const EYE_HEIGHT = 1.62;

/** Duration of a viewpoint transition, in seconds. */
const FLY_DURATION = 0.9;

/** Ease-in-out cubic. Starts and ends at rest, which reads as intentional. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  /** Active fly-to animation, or null when the camera is user-controlled. */
  private flight: {
    fromPosition: THREE.Vector3;
    toPosition: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    elapsed: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    // A 50° vertical FOV is close to a 35 mm lens — wide enough to take a room
    // in, narrow enough to avoid the barrel-distorted look of typical 75° defaults.
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    this.camera.position.set(6, 4.5, 6);

    this.controls = new OrbitControls(this.camera, canvas);
    // Damping makes dragging feel weighted rather than twitchy. It requires
    // controls.update() every frame, which the engine's loop does.
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.screenSpacePanning = false;
    this.controls.rotateSpeed = 0.75;
    this.controls.panSpeed = 0.8;
    this.controls.zoomSpeed = 0.9;
    // Stop just shy of horizontal so the camera never dips below the ground.
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 1.2, 0);
  }

  /** Adapts distance limits and target height to the plan's size. */
  configureForPlan(plan: PlanModel): void {
    const bounds = planBounds(plan);
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = bounds.radius * 8;
    // Keep the orbit pivot near seated eye level rather than on the floor -
    // orbiting around the floor centre makes the room appear to swing.
    this.controls.target.y = Math.min(this.controls.target.y, bounds.height * 0.55);
  }

  /**
   * Starts an eased transition to a named viewpoint.
   *
   * `focus` is the point the viewpoint should centre on - normally the centroid
   * of the largest room, so that "Inside" puts the camera in the main space of a
   * multi-room plan rather than at the geometric centre of the whole building,
   * which may well be inside a wall.
   */
  goTo(viewpoint: ViewpointId, plan: PlanModel, focus?: Point2): void {
    const { position, target } = this.resolveViewpoint(viewpoint, plan, focus);
    this.flight = {
      fromPosition: this.camera.position.clone(),
      toPosition: position,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      elapsed: 0,
    };
    // OrbitControls would otherwise apply damping to a camera we are animating.
    this.controls.enabled = false;
  }

  /** Computes the camera pose for a viewpoint, scaled to the plan. */
  private resolveViewpoint(
    viewpoint: ViewpointId,
    plan: PlanModel,
    focus?: Point2,
  ): { position: THREE.Vector3; target: THREE.Vector3 } {
    const bounds = planBounds(plan);
    const radius = bounds.radius;
    const centre = focus ?? bounds.center;
    const height = bounds.height;

    switch (viewpoint) {
      case 'plan':
        return {
          // Straight down. A tiny Z offset keeps the view direction from being
          // exactly parallel to the up vector, which makes the orbit basis
          // degenerate and causes the camera to spin unpredictably.
          position: new THREE.Vector3(bounds.center.x, radius * 3.2, bounds.center.z + 0.001),
          target: new THREE.Vector3(bounds.center.x, 0, bounds.center.z),
        };

      case 'interior': {
        // Stand off-centre in the focus room and look across it, which shows
        // several walls and the floor at once rather than staring at one wall.
        const offset = Math.min(radius * 0.35, 1.6);
        return {
          position: new THREE.Vector3(centre.x + offset, EYE_HEIGHT, centre.z + offset),
          target: new THREE.Vector3(
            centre.x - offset * 1.6,
            EYE_HEIGHT * 0.85,
            centre.z - offset * 1.6,
          ),
        };
      }

      case 'corner':
        return {
          position: new THREE.Vector3(
            bounds.center.x + radius * 1.5,
            height * 0.75,
            bounds.center.z + radius * 1.5,
          ),
          target: new THREE.Vector3(bounds.center.x, height * 0.4, bounds.center.z),
        };

      case 'overview':
      default:
        return {
          position: new THREE.Vector3(
            bounds.center.x + radius * 1.5,
            radius * 1.5,
            bounds.center.z + radius * 2,
          ),
          target: new THREE.Vector3(bounds.center.x, height * 0.4, bounds.center.z),
        };
    }
  }

  /**
   * Advances any in-flight transition and the damping simulation.
   *
   * Returns whether the camera actually moved. That return value is what lets
   * the frame loop stop drawing: OrbitControls' damping keeps the camera
   * drifting for a few tenths of a second after the pointer is released, and
   * a loop that stopped on mouse-up would freeze mid-glide.
   */
  update(delta: number): boolean {
    if (this.flight) {
      this.flight.elapsed += delta;
      const t = Math.min(1, this.flight.elapsed / FLY_DURATION);
      const eased = easeInOutCubic(t);

      this.camera.position.lerpVectors(this.flight.fromPosition, this.flight.toPosition, eased);
      this.controls.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, eased);

      if (t >= 1) {
        this.flight = null;
        this.controls.enabled = true;
      }
    }

    /*
     * `OrbitControls.update()` returns whether it changed the camera, which
     * covers damping, inertia and user input in one flag. A flight is always a
     * change, and it is checked separately because the flight moves the camera
     * directly rather than through the controls.
     */
    const orbited = this.controls.update();
    return orbited || this.flight !== null;
  }

  /** Keeps the projection matrix in step with the viewport aspect ratio. */
  setViewportSize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.controls.dispose();
  }
}

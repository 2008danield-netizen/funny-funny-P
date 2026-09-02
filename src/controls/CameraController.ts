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

import type { RoomModel } from '@/state/types';
import { boundingRadius } from '@/scene/roomGeometry';

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

  /** Adapts distance limits and target height to a room's size. */
  configureForRoom(room: RoomModel): void {
    const radius = boundingRadius(room);
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = radius * 8;
    // Keep the orbit pivot near seated eye level rather than on the floor —
    // orbiting around the floor centre makes the room appear to swing.
    this.controls.target.y = Math.min(this.controls.target.y, room.height * 0.55);
  }

  /** Starts an eased transition to a named viewpoint. */
  goTo(viewpoint: ViewpointId, room: RoomModel): void {
    const { position, target } = this.resolveViewpoint(viewpoint, room);
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

  /** Computes the camera pose for a viewpoint, scaled to the room. */
  private resolveViewpoint(
    viewpoint: ViewpointId,
    room: RoomModel,
  ): { position: THREE.Vector3; target: THREE.Vector3 } {
    const radius = boundingRadius(room);

    switch (viewpoint) {
      case 'plan':
        return {
          // Straight down. A tiny Z offset keeps the view direction from being
          // exactly parallel to the up vector, which makes the orbit basis
          // degenerate and causes the camera to spin unpredictably.
          position: new THREE.Vector3(0, radius * 3.2, 0.001),
          target: new THREE.Vector3(0, 0, 0),
        };

      case 'interior':
        return {
          // Stand near the south-east quarter looking across the room, which
          // shows three walls and the floor at once.
          position: new THREE.Vector3(room.width * 0.3, EYE_HEIGHT, room.depth * 0.3),
          target: new THREE.Vector3(-room.width * 0.35, EYE_HEIGHT * 0.85, -room.depth * 0.35),
        };

      case 'corner':
        return {
          position: new THREE.Vector3(radius * 1.5, room.height * 0.75, radius * 1.5),
          target: new THREE.Vector3(0, room.height * 0.4, 0),
        };

      case 'overview':
      default:
        return {
          position: new THREE.Vector3(radius * 1.5, radius * 1.5, radius * 2),
          target: new THREE.Vector3(0, room.height * 0.4, 0),
        };
    }
  }

  /** Advances any in-flight transition and the damping simulation. */
  update(delta: number): void {
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

    this.controls.update();
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

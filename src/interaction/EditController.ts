/**
 * Direct 3D editing: picking, dragging, drawing and placing openings.
 *
 * -----------------------------------------------------------------------------
 * THE CENTRAL TECHNIQUE — why dragging in 3D is precise here.
 *
 * The naive approach drags a wall by following the pointer across the mesh
 * itself, which makes the amount a wall moves depend on how far away it is and
 * what angle it is seen from. Instead, every drag projects the pointer's ray
 * onto the FLOOR PLANE (y = 0) and works in plan coordinates. The wall then
 * tracks the point on the floor under the cursor, exactly, at any camera angle.
 *
 * Combined with snapping, that makes editing from the top-down "Plan" viewpoint
 * as precise as a dedicated 2D plan editor would be, while still allowing edits
 * from any other angle.
 * -----------------------------------------------------------------------------
 *
 * Camera control has to be surrendered during a drag or OrbitControls and this
 * controller both consume the same pointer events and fight over the frame.
 */

import * as THREE from 'three';

import { Building, type PickResult } from '@/scene/Building';
import type { Furnishings } from '@/scene/Furnishings';
import type { Electrical } from '@/scene/Electrical';
import type { Plumbing } from '@/scene/Plumbing';
import type { Hvac } from '@/scene/Hvac';
import type { Fittings } from '@/scene/Fittings';
import { nearestSnapCandidates, snapPoint } from './snapping';
import { distance, indexVertices, resolveWall } from '@/scene/planGraph';
import { getOpeningPreset } from '@/scene/openings/presets';
import { designStore } from '@/state/store';
import { activeLevel } from '@/state/levels';
import { addStair } from '@/state/buildingOps';
import {
  addOpening,
  deleteVertex,
  deleteWall,
  drawWall,
  moveVertex,
  normalizePlan,
  nearestWall,
  removeOpening,
  splitWall,
  updateOpening,
} from '@/state/planOps';
import { editorStore, isOpeningTool } from '@/state/selection';
import {
  duplicateFurniture,
  moveFurniture,
  placeFurniture,
  removeFurniture,
  reseatFurniture,
  rotateFurniture,
} from '@/state/furnitureOps';
import { itemDimensions } from '@/physics/colliders';
import { isReceptacle } from '@/services/layout';
import { addFixture, addRun, moveFixture } from '@/state/fittingOps';
import { snapRunToWall } from '@/state/fittingOps';
import { normalizeAngle } from '@/state/defaults';
import type { Point2 } from '@/state/types';
import { formatLength } from '@/state/units';

/** How close the pointer must come to a wall to place an opening on it. */
const OPENING_PICK_RADIUS = 0.6;

/** Degrees the keyboard shortcut turns furniture by. */
const FURNITURE_ROTATION_STEP = 15;

interface DragState {
  kind: 'vertex' | 'wall' | 'opening' | 'furniture' | 'device' | 'fixture';
  id: string;
  /** Where on the floor the drag started. */
  origin: Point2;
  /** Positions at drag start, so each frame computes an absolute result. */
  startVertices: Map<string, Point2>;
  startOffset: number;
  /** True once the pointer has moved far enough to count as a drag. */
  moved: boolean;
}

export class EditController {
  private camera: THREE.Camera;
  private canvas: HTMLCanvasElement;
  private building: Building;
  private furnishings: Furnishings;
  private electrical: Electrical;
  private plumbing: Plumbing;
  private hvac: Hvac;
  private fittings: Fittings;
  private orbit: { enabled: boolean };

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private drag: DragState | null = null;
  /** First point of a wall being drawn, or null when not drawing. */
  private drawAnchor: Point2 | null = null;
  /** First point of a cabinet run being drawn. */
  private cabinetAnchor: Point2 | null = null;

  private disposers: Array<() => void> = [];

  constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    building: Building,
    furnishings: Furnishings,
    electrical: Electrical,
    fittings: Fittings,
    plumbing: Plumbing,
    hvac: Hvac,
    orbit: { enabled: boolean },
  ) {
    this.canvas = canvas;
    this.camera = camera;
    this.building = building;
    this.furnishings = furnishings;
    this.electrical = electrical;
    this.fittings = fittings;
    this.plumbing = plumbing;
    this.hvac = hvac;
    this.orbit = orbit;

    const onPointerDown = (event: PointerEvent) => this.handlePointerDown(event);
    const onPointerMove = (event: PointerEvent) => this.handlePointerMove(event);
    const onPointerUp = (event: PointerEvent) => this.handlePointerUp(event);
    const onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);

    canvas.addEventListener('pointerdown', onPointerDown);
    // Move and up are bound to the window so a drag survives the pointer
    // leaving the canvas, which it routinely does when dragging a far wall.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);

    this.disposers.push(
      () => canvas.removeEventListener('pointerdown', onPointerDown),
      () => window.removeEventListener('pointermove', onPointerMove),
      () => window.removeEventListener('pointerup', onPointerUp),
      () => window.removeEventListener('keydown', onKeyDown),
    );
  }

  /** Keeps the controller pointed at the live camera after a rebuild. */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /* --------------------------- Ray utilities ------------------------- */

  /** Converts a pointer event into normalised device coordinates. */
  private updatePointer(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /**
   * Where the pointer ray meets the floor plane.
   *
   * Returns null when the ray is parallel to the floor or points at the sky,
   * which happens whenever the camera is near eye level and the user aims above
   * the horizon.
   */
  private floorPoint(): Point2 | null {
    const hit = new THREE.Vector3();
    const found = this.raycaster.ray.intersectPlane(this.floorPlane, hit);
    if (!found) return null;
    return { x: hit.x, z: hit.z };
  }

  /**
   * The nearest pickable thing under the pointer.
   *
   * Furniture is tested first and wins outright. Its pick volume is a bounding
   * box that necessarily overlaps the floor beneath it, so testing everything
   * together and taking the nearest hit would let a floor poking through the gap
   * under a chair steal the click.
   */
  private pick(): PickResult | null {
    /*
     * Devices first, for the same reason furniture beats the floor: a
     * receptacle is a plate two centimetres deep sitting on a wall, so the wall
     * behind it is always also under the pointer and would take every click.
     * They are only pickable while the electrical layer is shown, so this costs
     * nothing when it is off.
     */
    const devices = this.raycaster.intersectObjects(this.electrical.pickTargets(), false);
    for (const intersection of devices) {
      const result = Building.interpret(intersection);
      if (result) return result;
    }

    /*
     * Pipework next, and for a slightly different reason: a waste pipe lives in
     * the floor void, so the floor above it is always between the pointer and
     * the pipe. Testing it before the building is what makes a run under a
     * bathroom clickable at all. Like the devices, it is only pickable while
     * the layer is shown.
     */
    const pipes = this.raycaster.intersectObjects(this.plumbing.pickTargets(), false);
    for (const intersection of pipes) {
      const result = Building.interpret(intersection);
      if (result) return result;
    }

    /*
     * Ductwork, for exactly the same reason and immediately after it: a supply
     * trunk is in the same floor void as the waste pipe, with the same floor
     * between it and the pointer.
     */
    const ducts = this.raycaster.intersectObjects(this.hvac.pickTargets(), false);
    for (const intersection of ducts) {
      const result = Building.interpret(intersection);
      if (result) return result;
    }

    const furniture = this.raycaster.intersectObjects(this.furnishings.pickTargets(), false);
    for (const intersection of furniture) {
      const result = Building.interpret(intersection);
      if (result) return result;
    }

    // Cabinetry and fixtures beat the walls behind them for the same reason.
    const fittings = this.raycaster.intersectObjects(this.fittings.pickTargets(), false);
    for (const intersection of fittings) {
      const result = Building.interpret(intersection);
      if (result) return result;
    }

    const building = this.raycaster.intersectObjects(this.building.pickTargets(), false);
    for (const intersection of building) {
      const result = Building.interpret(intersection);
      if (result) return result;
    }
    return null;
  }

  /* ------------------------------ Pointer ---------------------------- */

  private handlePointerDown(event: PointerEvent): void {
    // Left button only: right-drag is OrbitControls' pan, and middle is dolly.
    if (event.button !== 0) return;

    this.updatePointer(event);
    const state = editorStore.getState();
    const floor = this.floorPoint();
    const pick = this.pick();

    /* ---- Drawing a wall ---- */
    if (state.tool === 'draw') {
      if (!floor) return;
      const snapped = this.snap(floor, this.drawAnchor);
      if (!this.drawAnchor) {
        this.drawAnchor = snapped;
        editorStore.patch({ readout: 'Click again to finish the wall' });
      } else {
        const from = this.drawAnchor;
        designStore.edit((draft) => {
          drawWall(activeLevel(draft).plan, from, snapped);
        });
        // Chain from the point just placed, so a room can be drawn in one go.
        this.drawAnchor = snapped;
      }
      this.suppressOrbit();
      return;
    }

    /* ---- Dropping a catalogue item ---- */
    if (state.tool === 'furnish') {
      if (!floor || !state.pendingCatalogId) return;
      const catalogId = state.pendingCatalogId;
      let placedId: string | null = null;
      let reason: string | undefined;

      designStore.edit((draft) => {
        const result = placeFurniture(draft, activeLevel(draft), catalogId, floor);
        placedId = result.id;
        reason = result.reason;
      });

      if (placedId) {
        editorStore.select('furniture', placedId);
        // Stay armed so a row of dining chairs is a row of clicks. Escape or
        // another tool disarms.
        editorStore.patch({ readout: 'Placed. Click again for another.' });
      } else {
        editorStore.patch({ readout: reason ?? 'It does not fit there' });
      }
      this.suppressOrbit();
      return;
    }


    /* ---- Drawing a run of cabinets ---- */
    if (state.tool === 'cabinet') {
      if (!floor) return;

      /*
       * Two clicks, like the wall tool: the first sets the start, the second
       * finishes. The path is then snapped ONTO the wall it was drawn against,
       * because a run is a thing fitted to a wall — drawing one 40 mm off it
       * and leaving the gap would be a drawing of a kitchen rather than a
       * kitchen.
       */
      if (!this.cabinetAnchor) {
        this.cabinetAnchor = floor;
        editorStore.patch({ readout: 'Click again to finish the run' });
      } else {
        const from = this.cabinetAnchor;
        this.cabinetAnchor = null;

        const placed: Array<string | null> = [];
        designStore.edit((draft) => {
          const level = activeLevel(draft);
          const path = snapRunToWall(level.plan, from, floor);
          placed.push(path ? addRun(draft, level.id, path, 'base') : null);
        });

        const id = placed[0];
        if (id) {
          editorStore.select('unit', null);
          editorStore.patch({ readout: 'Run drawn. Click a cabinet to swap it.' });
        } else {
          editorStore.patch({
            readout: 'A run has to be drawn along a wall, and long enough for a cupboard.',
          });
        }
      }
      this.suppressOrbit();
      return;
    }

    /* ---- Dropping a fixture ---- */
    if (state.tool === 'fixture') {
      if (!floor || !state.pendingFixtureId) return;

      const placed: Array<string | null> = [];
      designStore.edit((draft) => {
        placed.push(addFixture(draft, activeLevel(draft).id, state.pendingFixtureId!, floor));
      });

      const id = placed[0];
      if (id) {
        editorStore.select('fixture', id);
        editorStore.patch({ readout: 'Placed. Drag it where you want it.' });
      } else {
        editorStore.patch({ readout: 'That fixture could not be placed there.' });
      }
      this.suppressOrbit();
      return;
    }

    /* ---- Setting the foot of a staircase ---- */
    if (state.tool === 'stair') {
      if (!floor) return;
      let placedId: string | null = null;
      let reason: string | undefined;

      designStore.edit((draft) => {
        const result = addStair(draft, floor);
        placedId = result.id;
        reason = result.reason;
      });

      if (placedId) {
        editorStore.select('stair', placedId);
        // Unlike furniture, a stair is a one-off: drop back to Select so the
        // next click inspects what was just made rather than adding a second.
        editorStore.patch({ tool: 'select', readout: 'Stair placed.' });
      } else {
        editorStore.patch({ readout: reason ?? 'A stair needs a storey above it' });
      }
      this.suppressOrbit();
      return;
    }

    /* ---- Placing an opening ---- */
    if (isOpeningTool(state.tool)) {
      this.placeOpening(pick, floor, state.tool === 'door');
      this.suppressOrbit();
      return;
    }

    /* ---- Selecting ---- */
    if (!pick) {
      editorStore.clearSelection();
      return;
    }
    editorStore.select(pick.kind, pick.id);

    /* ---- Starting a drag ---- */
    if (!floor) return;
    // Furniture drags with the Select tool too. Arranging a room is the common
    // case, and making people switch tools first would be needless friction —
    // whereas dragging a WALL by accident would wreck the plan, so that stays
    // behind the Move tool.
    if (pick.kind === 'furniture') {
      this.beginFurnitureDrag(pick.id, floor);
      return;
    }

    // A device drags with the ordinary select tool, like furniture: switching
    // to the move tool to nudge a socket would be a step nobody expects.
    if (pick.kind === 'device') {
      this.beginDeviceDrag(pick.id, floor);
      return;
    }

    // A fixture drags like furniture. A cabinet does not: a unit's position is
    // decided by the run it is in, so clicking one selects it to be swapped or
    // to take a sink, and moving it means moving the run.
    if (pick.kind === 'fixture') {
      this.beginFixtureDrag(pick.id, floor);
      return;
    }
    if (pick.kind === 'unit') return;

    if (state.tool !== 'move') return;
    if (pick.kind === 'vertex') this.beginVertexDrag(pick.id, floor);
    else if (pick.kind === 'wall') this.beginWallDrag(pick.id, floor);
    else if (pick.kind === 'opening') this.beginOpeningDrag(pick.id, floor);
  }

  private handlePointerMove(event: PointerEvent): void {
    this.updatePointer(event);
    const state = editorStore.getState();

    if (this.drag) {
      this.continueDrag();
      return;
    }

    /* ---- Preview line while drawing ---- */
    if (state.tool === 'draw' && this.drawAnchor) {
      const floor = this.floorPoint();
      if (floor) {
        const snapped = this.snap(floor, this.drawAnchor);
        const units = designStore.getState().units;
        editorStore.patch({
          readout: `${formatLength(distance(this.drawAnchor, snapped), units)}`,
        });
      }
      return;
    }

    /* ---- Hover highlighting ---- */
    const pick = this.pick();
    editorStore.setHover(pick?.kind ?? null, pick?.id ?? null);
    this.canvas.style.cursor = pick ? (state.tool === 'move' ? 'move' : 'pointer') : '';
  }

  private handlePointerUp(event: PointerEvent): void {
    if (event.button !== 0) return;

    if (this.drag) {
      // Normalise once at the end of the drag rather than on every frame: a
      // mid-drag merge would delete the vertex being dragged out from under the
      // pointer, and repeated topology edits would flood the undo history.
      if (this.drag.moved) {
        const wasPlanEdit = this.drag.kind !== 'furniture' && this.drag.kind !== 'opening';
        designStore.edit(
          (draft) => {
            normalizePlan(activeLevel(draft).plan);
            // Moving a wall can leave furniture buried in it. Rather than
            // blocking the wall edit, the furniture is pushed clear afterwards.
            if (wasPlanEdit) reseatFurniture(draft, activeLevel(draft));
          },
          { history: 'coalesce', coalesceKey: this.dragCoalesceKey() },
        );
      }
      this.drag = null;
      editorStore.patch({ readout: null, collidingIds: [] });
    }

    this.orbit.enabled = true;
  }

  /** Stops OrbitControls acting on the same gesture the tool just consumed. */
  private suppressOrbit(): void {
    this.orbit.enabled = false;
    // Restored on pointer-up; a tool click is a single event, not a drag.
    window.setTimeout(() => {
      this.orbit.enabled = true;
    }, 0);
  }

  /* ------------------------------ Dragging --------------------------- */

  private dragCoalesceKey(): string {
    return `plan.drag.${this.drag?.kind ?? 'none'}.${this.drag?.id ?? ''}`;
  }

  private beginVertexDrag(vertexId: string, origin: Point2): void {
    const plan = activeLevel(designStore.getState()).plan;
    const vertex = plan.vertices.find((candidate) => candidate.id === vertexId);
    if (!vertex) return;

    this.drag = {
      kind: 'vertex',
      id: vertexId,
      origin,
      startVertices: new Map([[vertexId, { x: vertex.x, z: vertex.z }]]),
      startOffset: 0,
      moved: false,
    };
    this.orbit.enabled = false;
  }

  private beginWallDrag(wallId: string, origin: Point2): void {
    const plan = activeLevel(designStore.getState()).plan;
    const wall = plan.walls.find((candidate) => candidate.id === wallId);
    if (!wall) return;

    const startVertices = new Map<string, Point2>();
    for (const id of [wall.start, wall.end]) {
      const vertex = plan.vertices.find((candidate) => candidate.id === id);
      if (vertex) startVertices.set(id, { x: vertex.x, z: vertex.z });
    }

    this.drag = {
      kind: 'wall',
      id: wallId,
      origin,
      startVertices,
      startOffset: 0,
      moved: false,
    };
    this.orbit.enabled = false;
  }

  private beginFurnitureDrag(itemId: string, origin: Point2): void {
    const item = activeLevel(designStore.getState()).furniture.find(
      (candidate) => candidate.id === itemId,
    );
    if (!item) return;

    this.drag = {
      kind: 'furniture',
      id: itemId,
      origin,
      // Reused to hold the piece's starting position, so each frame computes an
      // absolute target rather than accumulating deltas through the solver.
      startVertices: new Map([[itemId, { x: item.x, z: item.z }]]),
      startOffset: 0,
      moved: false,
    };
    this.orbit.enabled = false;
  }

  private beginOpeningDrag(openingId: string, origin: Point2): void {
    const plan = activeLevel(designStore.getState()).plan;
    const wall = plan.walls.find((candidate) =>
      candidate.openings.some((opening) => opening.id === openingId),
    );
    const opening = wall?.openings.find((candidate) => candidate.id === openingId);
    if (!opening) return;

    this.drag = {
      kind: 'opening',
      id: openingId,
      origin,
      startVertices: new Map(),
      startOffset: opening.offset,
      moved: false,
    };
    this.orbit.enabled = false;
  }

  /**
   * Picks a device up.
   *
   * Same shape as the furniture drag — the start position is remembered so that
   * every frame computes an absolute target rather than accumulating deltas,
   * which is what keeps a long drag from creeping.
   */
  private beginDeviceDrag(deviceId: string, origin: Point2): void {
    const device = designStore
      .getState()
      .electrical.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return;

    this.drag = {
      kind: 'device',
      id: deviceId,
      origin,
      startVertices: new Map([[deviceId, { x: device.at.x, z: device.at.z }]]),
      startOffset: 0,
      moved: false,
    };
    this.orbit.enabled = false;
  }

  /** Picks a fixture up. Same shape as the furniture and device drags. */
  private beginFixtureDrag(fixtureId: string, origin: Point2): void {
    const fixture = designStore.getState().fixtures.find((entry) => entry.id === fixtureId);
    if (!fixture) return;

    this.drag = {
      kind: 'fixture',
      id: fixtureId,
      origin,
      startVertices: new Map([[fixtureId, { x: fixture.at.x, z: fixture.at.z }]]),
      startOffset: 0,
      moved: false,
    };
    this.orbit.enabled = false;
  }

  private continueDrag(): void {
    const drag = this.drag;
    if (!drag) return;

    const floor = this.floorPoint();
    if (!floor) return;

    const delta = { x: floor.x - drag.origin.x, z: floor.z - drag.origin.z };
    // A few millimetres of jitter between press and release is a click, not a
    // drag; without this threshold every selection nudges the plan.
    if (!drag.moved && Math.hypot(delta.x, delta.z) < 0.01) return;
    drag.moved = true;

    const units = designStore.getState().units;

    if (drag.kind === 'fixture') {
      const start = drag.startVertices.get(drag.id);
      if (!start) return;
      const target = { x: start.x + delta.x, z: start.z + delta.z };

      designStore.edit(
        (draft) => {
          // Seated against the nearest wall as it goes: a bath floating in the
          // middle of a bathroom is never what somebody meant, and making them
          // line it up by eye is work the app can do.
          moveFixture(draft, drag.id, target);
        },
        { history: 'coalesce', coalesceKey: this.dragCoalesceKey() },
      );

      editorStore.patch({ readout: `${target.x.toFixed(2)}, ${target.z.toFixed(2)}` });
      return;
    }

    if (drag.kind === 'device') {
      const start = drag.startVertices.get(drag.id);
      if (!start) return;
      const target = { x: start.x + delta.x, z: start.z + delta.z };

      designStore.edit(
        (draft) => {
          const device = draft.electrical.devices.find((entry) => entry.id === drag.id);
          if (!device) return;

          /*
           * A wall-mounted device is put back ON the wall rather than left
           * where the pointer is. A socket floating in the middle of a room is
           * not a socket, and making the user place it to the millimetre is a
           * worse experience than snapping — so the drag chooses the wall and
           * the position along it, and the app keeps the device flush.
           */
          const wallMounted = isReceptacle(device.kind) || device.kind.startsWith('switch');
          const near = wallMounted ? nearestWall(activeLevel(draft).plan, target, 1.2) : null;

          if (near) {
            const plan = activeLevel(draft).plan;
            const segment = resolveWall(near.wall, indexVertices(plan));
            if (segment) {
              const along = Math.max(0.1, Math.min(segment.length - 0.1, near.t * segment.length));
              // Which side of the wall the pointer is on decides which face the
              // device ends up on, so dragging a socket round a corner works.
              const toPointer = {
                x: target.x - segment.center.x,
                z: target.z - segment.center.z,
              };
              const side =
                toPointer.x * segment.normal.x + toPointer.z * segment.normal.z >= 0 ? 1 : -1;
              const offset = near.wall.thickness / 2 + 0.02;

              device.at = {
                x: segment.start.x + segment.direction.x * along + segment.normal.x * offset * side,
                z: segment.start.z + segment.direction.z * along + segment.normal.z * offset * side,
              };
              device.wallId = near.wall.id;
              device.rotation = Math.atan2(segment.normal.x * side, segment.normal.z * side);
              return;
            }
          }

          device.at = target;
          device.wallId = null;
        },
        { history: 'coalesce', coalesceKey: this.dragCoalesceKey() },
      );

      editorStore.patch({ readout: `${target.x.toFixed(2)}, ${target.z.toFixed(2)}` });
      return;
    }

    if (drag.kind === 'vertex') {
      const start = drag.startVertices.get(drag.id);
      if (!start) return;
      const target = this.snap({ x: start.x + delta.x, z: start.z + delta.z }, null, drag.id);

      designStore.edit(
        (draft) => moveVertex(activeLevel(draft).plan, drag.id, target),
        { history: 'coalesce', coalesceKey: this.dragCoalesceKey() },
      );
      editorStore.patch({
        readout: `${target.x.toFixed(2)}, ${target.z.toFixed(2)}`,
      });
      return;
    }

    if (drag.kind === 'wall') {
      // Absolute rather than incremental: each frame recomputes the wall's
      // position from where it started, so rounding never accumulates.
      const [firstId] = [...drag.startVertices.keys()];
      const firstStart = firstId ? drag.startVertices.get(firstId) : undefined;
      if (!firstId || !firstStart) return;

      const snappedFirst = this.snap(
        { x: firstStart.x + delta.x, z: firstStart.z + delta.z },
        null,
        firstId,
      );
      const applied = { x: snappedFirst.x - firstStart.x, z: snappedFirst.z - firstStart.z };

      designStore.edit(
        (draft) => {
          for (const [id, start] of drag.startVertices) {
            moveVertex(activeLevel(draft).plan, id, { x: start.x + applied.x, z: start.z + applied.z });
          }
        },
        { history: 'coalesce', coalesceKey: this.dragCoalesceKey() },
      );
      editorStore.patch({
        readout: `moved ${formatLength(Math.hypot(applied.x, applied.z), units)}`,
      });
      return;
    }

    if (drag.kind === 'furniture') {
      const start = drag.startVertices.get(drag.id);
      if (!start) return;

      const target = { x: start.x + delta.x, z: start.z + delta.z };
      let blocked: string[] = [];

      designStore.edit(
        (draft) => {
          // Wall-snapping is applied on every frame, not just on release, so
          // the piece visibly clicks into place against a wall as it passes.
          const result = moveFurniture(draft, activeLevel(draft), drag.id, target, { snapWalls: true });
          blocked = result.blockedBy;
        },
        { history: 'coalesce', coalesceKey: this.dragCoalesceKey() },
      );

      editorStore.patch({
        collidingIds: blocked.filter((id) => id !== drag.id),
        readout: blocked.length > 0 ? 'Blocked' : null,
      });
      return;
    }

    if (drag.kind === 'opening') {
      // Slide along the wall: project the pointer's travel onto the wall axis.
      const segment = this.building
        .getSegments()
        .find((candidate) =>
          candidate.wall.openings.some((opening) => opening.id === drag.id),
        );
      if (!segment) return;

      const along = delta.x * segment.direction.x + delta.z * segment.direction.z;
      const offset = drag.startOffset + along;
      const snapped = editorStore.getState().snapEnabled
        ? Math.round(offset / 0.05) * 0.05
        : offset;

      designStore.edit(
        (draft) => updateOpening(activeLevel(draft).plan, drag.id, { offset: snapped }),
        { history: 'coalesce', coalesceKey: this.dragCoalesceKey() },
      );
      editorStore.patch({ readout: `${formatLength(snapped, units)} along wall` });
    }
  }

  /* ------------------------------ Snapping --------------------------- */

  /**
   * Snaps a plan-space point.
   *
   * `anchor` is the other end of a wall being drawn, which enables angle
   * snapping; `excludeVertexId` keeps a dragged corner from snapping to itself.
   */
  private snap(point: Point2, anchor: Point2 | null, excludeVertexId?: string): Point2 {
    const state = editorStore.getState();
    if (!state.snapEnabled) return point;

    const plan = activeLevel(designStore.getState()).plan;
    return snapPoint(point, {
      gridSize: state.gridSize,
      anchor,
      candidates: nearestSnapCandidates(plan, point, excludeVertexId),
    });
  }

  /* ------------------------------ Openings --------------------------- */

  /** Places a door or window on whichever wall the user clicked. */
  private placeOpening(pick: PickResult | null, floor: Point2 | null, isDoor: boolean): void {
    const state = editorStore.getState();
    const preset = getOpeningPreset(isDoor ? state.doorPresetId : state.windowPresetId);

    // Prefer the wall actually struck by the ray; fall back to the nearest wall
    // to the floor point, so clicking just beside a wall still works.
    let wallId: string | null = pick?.kind === 'wall' ? pick.id : null;
    let offset: number | null = null;

    const segments = this.building.getSegments();

    if (wallId && pick) {
      const segment = segments.find((candidate) => candidate.wall.id === wallId);
      if (segment) {
        const along =
          (pick.point.x - segment.start.x) * segment.direction.x +
          (pick.point.z - segment.start.z) * segment.direction.z;
        offset = along;
      }
    }

    if ((wallId === null || offset === null) && floor) {
      let best: { id: string; offset: number; distance: number } | null = null;
      for (const segment of segments) {
        const toPoint = { x: floor.x - segment.start.x, z: floor.z - segment.start.z };
        const along = toPoint.x * segment.direction.x + toPoint.z * segment.direction.z;
        if (along < 0 || along > segment.length) continue;
        const perpendicular = Math.abs(
          toPoint.x * segment.normal.x + toPoint.z * segment.normal.z,
        );
        if (perpendicular > OPENING_PICK_RADIUS) continue;
        if (!best || perpendicular < best.distance) {
          best = { id: segment.wall.id, offset: along, distance: perpendicular };
        }
      }
      if (best) {
        wallId = best.id;
        offset = best.offset;
      }
    }

    if (!wallId || offset === null) {
      editorStore.patch({ readout: 'Click on a wall to place it' });
      return;
    }

    const targetWall = wallId;
    const targetOffset = offset;
    let createdId: string | null = null;

    designStore.edit((draft) => {
      createdId = addOpening(
        activeLevel(draft).plan,
        targetWall,
        preset.kind,
        preset.id,
        { width: preset.width, height: preset.height, sillHeight: preset.sillHeight },
        targetOffset,
      );
    });

    if (createdId) {
      editorStore.patch({ readout: null });
      editorStore.select('opening', createdId);
    } else {
      editorStore.patch({ readout: 'Not enough room on that wall' });
    }
  }

  /* ------------------------------ Keyboard --------------------------- */

  private handleKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && target.type === 'text') ||
      target?.isContentEditable === true
    ) {
      return;
    }

    const state = editorStore.getState();

    // Escape backs out of whatever is in progress, in the order a user expects:
    // the half-drawn wall first, then the selection.
    if (event.key === 'Escape') {
      if (this.drawAnchor) {
        this.drawAnchor = null;
        editorStore.patch({ readout: null });
      } else if (state.pendingCatalogId) {
        editorStore.armCatalogItem(null);
      } else if (state.tool !== 'select') {
        editorStore.setTool('select');
      } else {
        editorStore.clearSelection();
      }
      return;
    }

    const { kind, id } = state.selection;
    if (!kind || !id) return;

    // Rotate the selected piece in 15-degree steps; Shift reverses.
    if (event.key.toLowerCase() === 'r' && kind === 'furniture') {
      event.preventDefault();
      this.rotateSelection(event.shiftKey ? -1 : 1);
      return;
    }

    // Duplicate, for building a row of chairs.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      if (kind !== 'furniture') return;
      event.preventDefault();
      let created: string | null = null;
      designStore.edit((draft) => {
        created = duplicateFurniture(draft, activeLevel(draft), id);
      });
      if (created) editorStore.select('furniture', created);
      else editorStore.patch({ readout: 'No space for a copy' });
      return;
    }

    if (event.key !== 'Delete' && event.key !== 'Backspace') return;

    event.preventDefault();
    designStore.edit((draft) => {
      if (kind === 'wall') {
        deleteWall(activeLevel(draft).plan, id);
        reseatFurniture(draft, activeLevel(draft));
      } else if (kind === 'vertex') {
        deleteVertex(activeLevel(draft).plan, id);
        reseatFurniture(draft, activeLevel(draft));
      } else if (kind === 'opening') removeOpening(activeLevel(draft).plan, id);
      else if (kind === 'furniture') removeFurniture(activeLevel(draft), id);
    });
    editorStore.clearSelection();
  }

  /* ------------------------------ Commands --------------------------- */

  /** Inserts a corner at the middle of the selected wall and selects it. */
  splitSelectedWall(): void {
    const { kind, id } = editorStore.getState().selection;
    if (kind !== 'wall' || !id) return;

    let created: string | null = null;
    designStore.edit((draft) => {
      created = splitWall(activeLevel(draft).plan, id, 0.5);
    });
    if (created) editorStore.select('vertex', created);
  }

  /**
   * Rotates the selected piece by one step.
   *
   * The rotation goes through the solver, so turning a long sofa in a tight
   * alcove is refused rather than silently burying it in the wall.
   */
  rotateSelection(direction: number): void {
    const { kind, id } = editorStore.getState().selection;
    if (kind !== 'furniture' || !id) return;

    const item = activeLevel(designStore.getState()).furniture.find((candidate) => candidate.id === id);
    if (!item) return;

    const step = (FURNITURE_ROTATION_STEP * Math.PI) / 180;
    const target = normalizeAngle(item.rotation + step * direction);

    let ok = false;
    designStore.edit((draft) => {
      ok = rotateFurniture(draft, activeLevel(draft), id, target);
    });
    if (!ok) editorStore.patch({ readout: 'Not enough space to turn it' });
  }

  /** The footprint of the selected piece, for the inspector's readout. */
  selectedFootprint(): { width: number; depth: number } | null {
    const { kind, id } = editorStore.getState().selection;
    if (kind !== 'furniture' || !id) return null;
    const item = activeLevel(designStore.getState()).furniture.find((candidate) => candidate.id === id);
    return item ? itemDimensions(item) : null;
  }

  /** Cancels an in-progress wall being drawn. */
  cancelDrawing(): void {
    this.cabinetAnchor = null;
    this.drawAnchor = null;
    editorStore.patch({ readout: null });
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.drag = null;
    this.drawAnchor = null;
  }
}

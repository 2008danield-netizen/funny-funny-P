/**
 * What you can reach out and touch.
 *
 * -----------------------------------------------------------------------------
 * ALL OF THIS ALREADY EXISTED.
 *
 * Nothing here adds an object to the document. Every door, switch, light
 * fitting, drawer and tap in this list was already modelled, with real
 * dimensions and, in the case of the switches, a real circuit — fourteen
 * sessions of drawing a building properly turn out to be fourteen sessions of
 * making a building you can touch. This file only says which of those things a
 * hand can reach and what happens when it does.
 *
 * So the list is DERIVED, every time, exactly like the pipe sizes and the duct
 * sizes. A stored list of interactables is a list that is wrong the moment
 * somebody moves a door.
 *
 * -----------------------------------------------------------------------------
 * WHICH LIGHTS DOES A SWITCH CONTROL?
 *
 * The electrical model does not record it, and inventing a field for it would
 * be inventing a decision nobody has made. What it does record is where every
 * switch and every fitting is, and the layout that placed them put the switch
 * by the door of the room whose lights it works.
 *
 * So the rule is: a switch controls the lights in the room it is in. That is
 * what a person assumes walking up to it, it is what the layout actually built,
 * and it is derivable rather than guessed. Where a room has no switch, its
 * lights answer to nothing and the panel says so rather than pretending.
 */

import { findRegions, resolveWalls } from '@/scene/planGraph';
import { pointInPolygon } from '@/physics/collision';
import { resolveRoomSpec } from '@/state/planOps';
import { elevationOf } from '@/state/levels';
import { getOpeningPreset } from '@/scene/openings/presets';
import { runGeometry } from '@/building/cabinetRun';
import { getFixture } from '@/fittings/fixtures';
import { isLighting } from '@/services/layout';
import type { DesignDocument, Point2 } from '@/state/types';

/** What kind of thing this is, which decides what using it means. */
export type InteractableKind = 'door' | 'switch' | 'drawer' | 'cabinet-door' | 'tap';

export interface Interactable {
  /** Stable across rebuilds: the id of the thing in the document. */
  id: string;
  kind: InteractableKind;
  levelId: string;
  /** Where a hand reaches for it, in world metres. */
  at: { x: number; y: number; z: number };
  /** How big a target it is, in metres — a door is easier to hit than a tap. */
  radius: number;
  /** What the crosshair says. */
  label: string;
  /** What using it does, for the prompt: "Open", "Close", "Turn on". */
  verb: string;
  /**
   * For a switch, the fittings it controls. Empty for everything else.
   *
   * Carried on the interactable rather than looked up at the moment of use, so
   * the rule that decides it lives in one place and the panel can show what a
   * switch actually reaches.
   */
  controls: string[];
  /** The room it is in, for the prompt and for the lighting. */
  roomKey: string;
  roomName: string;
}

/* ------------------------------ The derivation ---------------------------- */

/**
 * Everything touchable on one storey.
 *
 * One storey rather than the whole building: a hand cannot reach through a
 * floor, and walking a building's worth of openings every frame to find the
 * three within arm's length would be a poor trade.
 */
export function interactablesOn(doc: DesignDocument, levelId: string): Interactable[] {
  const level = doc.levels.find((entry) => entry.id === levelId);
  if (!level) return [];

  const base = elevationOf(doc, levelId);
  const regions = findRegions(level.plan);

  const roomAt = (point: Point2): { key: string; name: string } => {
    const region = regions.find((entry) => pointInPolygon(point, entry.polygon));
    if (!region) return { key: '', name: 'Outside' };
    return { key: region.key, name: resolveRoomSpec(level.plan, region.key).name };
  };

  const found: Interactable[] = [];

  /* ------------------------------- Doors -------------------------------- */

  for (const segment of resolveWalls(level.plan)) {
    for (const opening of segment.wall.openings) {
      if (opening.kind !== 'door') continue;

      const preset = getOpeningPreset(opening.presetId);
      // A cased opening has no leaf, so there is nothing to open.
      if (!preset || preset.leaf === 'none') continue;

      const centre = {
        x: segment.start.x + segment.direction.x * opening.offset,
        z: segment.start.z + segment.direction.z * opening.offset,
      };
      const room = roomAt({
        x: centre.x + segment.normal.x * 0.4,
        z: centre.z + segment.normal.z * 0.4,
      });

      found.push({
        id: opening.id,
        kind: 'door',
        levelId,
        // Handle height, which is where a hand actually goes.
        at: { x: centre.x, y: base + 1.05, z: centre.z },
        // Generous: a door is a big thing and nobody should have to aim at it.
        radius: Math.max(0.5, opening.width / 2),
        label: preset.label,
        verb: 'Open',
        controls: [],
        roomKey: room.key,
        roomName: room.name,
      });
    }
  }

  /* ------------------------------ Switches ------------------------------ */

  const devices = doc.electrical.devices.filter((device) => device.levelId === levelId);
  /*
   * `isLighting` rather than a list of kinds written out again here. It already
   * decides this for the NEC checks, and it knows the thing a second copy would
   * have got wrong: a ceiling fan is a lighting outlet, which is what a living
   * room gets instead of a pendant.
   */
  const lights = devices.filter((device) => isLighting(device.kind));

  for (const device of devices) {
    const isSwitch =
      device.kind === 'switch' || device.kind === 'switch-3way' || device.kind === 'switch-dimmer';
    if (!isSwitch) continue;

    const room = roomAt(device.at);

    /*
     * The lights in the same room. See the note at the top: the model records
     * no switch-to-fitting link, and the room is both what the layout built
     * and what anybody walking up to the switch would assume.
     */
    const controls = lights
      .filter((light) => roomAt(light.at).key === room.key)
      .map((light) => light.id);

    found.push({
      id: device.id,
      kind: 'switch',
      levelId,
      at: { x: device.at.x, y: base + device.height, z: device.at.z },
      // Small, because a switch is small — but not so small it cannot be hit.
      radius: 0.2,
      label: device.label || 'Light switch',
      verb: 'Turn on',
      controls,
      roomKey: room.key,
      roomName: room.name,
    });
  }

  /* --------------------------- Cabinets and taps ------------------------- */

  for (const run of doc.runs) {
    if (run.levelId !== levelId) continue;

    /*
     * `runGeometry` rather than walking the path again here.
     *
     * The first version of this did re-derive it, and it put the handles of
     * half the kitchen INSIDE the wall: the outward normal of a leg depends on
     * which way the run was drawn, and a second derivation got the sign right
     * for one run and wrong for the next. `runGeometry` is what the scene
     * builds the carcasses from, so taking the position and the facing from it
     * means the handle is on the side the doors are on, by construction.
     */
    for (const placed of runGeometry(run).units) {
      const module = placed.module;
      if (module.kind !== 'base' && module.kind !== 'tall' && module.kind !== 'wall') continue;

      const unit = placed.unit;
      // Where somebody stands to open it: just off the front face.
      const facing = { x: Math.sin(placed.rotation), z: Math.cos(placed.rotation) };
      const spot = {
        at: {
          x: placed.at.x + facing.x * (placed.depth / 2 + 0.06),
          z: placed.at.z + facing.z * (placed.depth / 2 + 0.06),
        },
      };

      const room = roomAt(spot.at);

      /*
       * `module.front` rather than the label, because the label is prose and
       * the front is the thing the scene actually builds from. A unit whose
       * front is `open`, `appliance` or `filler` has nothing to open — open
       * shelving is open, and an appliance gap gets the appliance's own door,
       * which is not modelled. Offering to open one of those would be offering
       * an action that does nothing, which is worse than offering none.
       */
      const drawers = module.front.startsWith('drawers');
      if (!drawers && module.front !== 'door' && module.front !== 'double-door' &&
          module.front !== 'corner' && module.front !== 'sink') {
        continue;
      }

      found.push({
        id: unit.id,
        kind: drawers ? 'drawer' : 'cabinet-door',
        levelId,
        at: {
          x: spot.at.x,
          // The handle, which is on the edge of the front nearest the person:
          // near the top of a base unit and near the bottom of a wall one.
          y: base + placed.lift + placed.height * (module.kind === 'wall' ? 0.15 : 0.85),
          z: spot.at.z,
        },
        radius: 0.28,
        label: module.label,
        verb: 'Open',
        controls: [],
        roomKey: room.key,
        roomName: room.name,
      });
    }
  }

  for (const fixture of doc.fixtures) {
    if (fixture.levelId !== levelId) continue;

    const spec = getFixture(fixture.fixtureId);
    if (!spec) continue;
    if (!hasTap(spec)) continue;

    const room = roomAt(fixture.at);

    found.push({
      id: fixture.id,
      kind: 'tap',
      levelId,
      at: { x: fixture.at.x, y: base + fixture.y + tapHeightAbove(spec), z: fixture.at.z },
      radius: 0.24,
      label: `${spec.name} tap`,
      verb: 'Turn on',
      controls: [],
      roomKey: room.key,
      roomName: room.name,
    });
  }

  return found;
}

/**
 * Whether a fixture has a tap on it. A bath has one; a toilet does not.
 *
 * Exported because the scene needs the same answer to decide where to hang a
 * stream of water, and two copies of this would be two copies that disagree
 * the first time a fixture is added.
 */
export function hasTap(spec: { id: string; name: string }): boolean {
  return /sink|basin|bath|shower/i.test(spec.id) || /sink|basin|bath|shower/i.test(spec.name);
}

/**
 * How far above a fixture's own base its tap is, in metres.
 *
 * Measured from the fixture rather than from the floor, because a sink sits on
 * a worktop and a bath sits on the floor: a fixed height above the floor puts
 * a kitchen tap either inside the cupboard or up by the wall units. A shower
 * is the exception in the other direction — its "tap" is a head overhead.
 *
 * Exported because the scene hangs the water from the same point. Two numbers
 * would mean a stream that starts somewhere the hand does not reach.
 */
export function tapHeightAbove(spec: { kind: string; height: number }): number {
  if (spec.kind === 'shower') return 1.9;
  // A spout stands a little proud of the bowl it fills.
  return spec.height + 0.22;
}

/* -------------------------------- Reaching -------------------------------- */

/** How far a hand reaches. Beyond this, nothing is offered. */
export const REACH = 1.9;

/**
 * The thing a ray is pointing at, within reach.
 *
 * A ray-versus-sphere test rather than picking against the real meshes, and
 * that is deliberate. The meshes for a door leaf move as it opens, a switch is
 * a few centimetres across, and a drawer front is inside a merged carcass — so
 * picking geometry would make some of these nearly impossible to hit and others
 * impossible to hit once used. A sphere at the handle is what a person is
 * actually aiming at.
 */
export function reachFor(
  items: readonly Interactable[],
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
): Interactable | null {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const ray = {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };

  let best: Interactable | null = null;
  let bestDistance = Infinity;

  for (const item of items) {
    const dx = item.at.x - origin.x;
    const dy = item.at.y - origin.y;
    const dz = item.at.z - origin.z;

    // How far along the ray the item's centre projects.
    const along = dx * ray.x + dy * ray.y + dz * ray.z;
    if (along < 0 || along > REACH) continue;

    // And how far off the ray it sits at that point.
    const offX = dx - ray.x * along;
    const offY = dy - ray.y * along;
    const offZ = dz - ray.z * along;
    const miss = Math.hypot(offX, offY, offZ);

    if (miss > item.radius) continue;

    /*
     * Nearest along the ray wins, not nearest to the centre of the crosshair.
     * Standing at a worktop the wall switch behind it is often closer to the
     * middle of the view than the drawer in front of you, and reaching past
     * the thing under your hand is not what anybody meant.
     */
    if (along < bestDistance) {
      bestDistance = along;
      best = item;
    }
  }

  return best;
}

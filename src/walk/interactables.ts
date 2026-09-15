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
import { getModule } from '@/fittings/modules';
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

    for (const unit of run.units) {
      const module = getModule(unit.moduleId);
      if (!module) continue;
      if (module.kind !== 'base' && module.kind !== 'tall' && module.kind !== 'wall') continue;

      const spot = unitFront(run, unit.offset + unit.width / 2);
      if (!spot) continue;

      const room = roomAt(spot.at);
      // A drawer unit opens as drawers; everything else opens as a door.
      const drawers = /drawer/i.test(module.id) || /drawer/i.test(module.label);

      found.push({
        id: unit.id,
        kind: drawers ? 'drawer' : 'cabinet-door',
        levelId,
        at: {
          x: spot.at.x,
          // Base units get a handle near the top, wall units near the bottom:
          // in both cases the edge nearest the person standing at them.
          y: base + (module.kind === 'wall' ? 1.5 : 0.8),
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
    // Only the things with a tap on them. A bath has one; a toilet does not.
    if (!/sink|basin|bath|shower/i.test(spec.id) && !/sink|basin|bath|shower/i.test(spec.name)) {
      continue;
    }

    const room = roomAt(fixture.at);

    found.push({
      id: fixture.id,
      kind: 'tap',
      levelId,
      at: { x: fixture.at.x, y: base + fixture.y + 0.95, z: fixture.at.z },
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
 * A point just in front of a cabinet unit, at a distance along its run.
 *
 * The run's path is a polyline, so this walks it to find which leg the offset
 * falls on and steps out perpendicular to that leg — which is where somebody
 * stands to open the unit, and therefore where the handle faces.
 */
function unitFront(
  run: { path: Point2[]; depth?: number },
  along: number,
): { at: Point2 } | null {
  const path = run.path;
  if (path.length < 2) return null;

  let travelled = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-6) continue;

    if (travelled + length >= along) {
      const t = (along - travelled) / length;
      const on = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      // The outward normal of this leg, which is the side you stand on.
      const outward = { x: (b.z - a.z) / length, z: -(b.x - a.x) / length };
      const reach = (run.depth ?? 0.6) / 2;
      return { at: { x: on.x + outward.x * reach, z: on.z + outward.z * reach } };
    }

    travelled += length;
  }

  return null;
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

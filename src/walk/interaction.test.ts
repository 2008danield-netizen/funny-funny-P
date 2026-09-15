/**
 * Tests for what you can touch and what happens when you do.
 *
 * Same reasoning as the walker's tests: a headset cannot be automated, so the
 * rules have to be established here. `interactablesOn` and `LiveState` are both
 * pure functions of the document and of what has been pressed, which is what
 * makes that possible.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, drawWall, normalizePlan, splitWall } from '@/state/planOps';
import { layOutElectrical } from '@/state/buildingOps';
import { addFixture, addRun } from '@/state/fittingOps';
import { findRegions } from '@/scene/planGraph';
import { REACH, hasTap, interactablesOn, reachFor, type Interactable } from './interactables';
import { LiveState } from './LiveState';
import { isLighting } from '@/services/layout';
import type { DesignDocument } from '@/state/types';

/** A 12 × 8 house split into two rooms by a partition with a door in it. */
function house(): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  addRectangle(level.plan, { x: 6, z: 4 }, 12, 8);
  normalizePlan(level.plan);

  const north = level.plan.walls.find((wall) => {
    const a = level.plan.vertices.find((v) => v.id === wall.start)!;
    const b = level.plan.vertices.find((v) => v.id === wall.end)!;
    return Math.abs(a.z) < 0.01 && Math.abs(b.z) < 0.01;
  })!;
  const south = level.plan.walls.find((wall) => {
    const a = level.plan.vertices.find((v) => v.id === wall.start)!;
    const b = level.plan.vertices.find((v) => v.id === wall.end)!;
    return Math.abs(a.z - 8) < 0.01 && Math.abs(b.z - 8) < 0.01;
  })!;

  const top = splitWall(level.plan, north.id, 0.5)!;
  const bottom = splitWall(level.plan, south.id, 0.5)!;
  const va = level.plan.vertices.find((v) => v.id === top)!;
  const vb = level.plan.vertices.find((v) => v.id === bottom)!;

  const partition = drawWall(level.plan, { x: va.x, z: va.z }, { x: vb.x, z: vb.z })!;
  addOpening(level.plan, partition, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 4);
  normalizePlan(level.plan);

  const names = ['Living Room', 'Bedroom 1'];
  findRegions(level.plan).forEach((region, index) => {
    level.plan.rooms[region.key] = {
      name: names[index] ?? 'Room',
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  });

  return doc;
}

const doorsIn = (items: Interactable[]) => items.filter((item) => item.kind === 'door');
const switchesIn = (items: Interactable[]) => items.filter((item) => item.kind === 'switch');

/* ------------------------------ What is there ----------------------------- */

describe('what you can touch', () => {
  it('finds the doors', () => {
    const doc = house();
    const items = interactablesOn(doc, doc.levels[0]!.id);

    expect(doorsIn(items)).toHaveLength(1);
    expect(doorsIn(items)[0]!.label).toMatch(/door/i);
  });

  it('puts the handle at handle height, not at the floor', () => {
    const doc = house();
    const door = doorsIn(interactablesOn(doc, doc.levels[0]!.id))[0]!;
    expect(door.at.y).toBeGreaterThan(0.9);
    expect(door.at.y).toBeLessThan(1.3);
  });

  it('offers nothing to open on a cased opening', () => {
    // A doorway with no leaf in it. There is nothing there to take hold of,
    // and offering "Open" on an empty hole would be a lie.
    const doc = house();
    const plan = doc.levels[0]!.plan;
    const partition = plan.walls.find((wall) => wall.openings.length > 0)!;
    partition.openings[0]!.presetId = 'door-opening';

    expect(doorsIn(interactablesOn(doc, doc.levels[0]!.id))).toHaveLength(0);
  });

  it('finds the switches once the electrical is laid out', () => {
    const doc = house();
    layOutElectrical(doc);

    const items = interactablesOn(doc, doc.levels[0]!.id);
    expect(switchesIn(items).length).toBeGreaterThan(0);
  });

  it('wires a switch to the lights in its own room and no others', () => {
    /*
     * The model records no switch-to-fitting link, so the rule is derived: a
     * switch works the lights in the room it is in. That is what the layout
     * built and what anybody walking up to it assumes — but it must not reach
     * into the next room.
     */
    const doc = house();
    layOutElectrical(doc);

    const items = interactablesOn(doc, doc.levels[0]!.id);
    // `isLighting`, not a hand-written list — a living room gets a ceiling fan
    // rather than a pendant, and it is a lighting outlet.
    const lights = doc.electrical.devices.filter((device) => isLighting(device.kind));
    expect(lights.length).toBeGreaterThan(1);

    for (const control of switchesIn(items)) {
      expect(control.controls.length).toBeGreaterThan(0);
      for (const id of control.controls) {
        const light = lights.find((entry) => entry.id === id)!;
        expect(light).toBeDefined();
      }
      // No switch claims every light in a two-room house.
      expect(control.controls.length).toBeLessThan(lights.length);
    }
  });

  it('says which room each thing is in', () => {
    const doc = house();
    layOutElectrical(doc);

    for (const item of interactablesOn(doc, doc.levels[0]!.id)) {
      expect(item.roomName.length).toBeGreaterThan(0);
    }
  });

  it('finds nothing on a storey that does not exist', () => {
    expect(interactablesOn(house(), 'no-such-level')).toEqual([]);
  });
});

/* -------------------------------- Reaching -------------------------------- */

describe('reaching for things', () => {
  const door = (): Interactable =>
    doorsIn(interactablesOn(house(), house().levels[0]!.id))[0] ?? {
      id: 'x',
      kind: 'door',
      levelId: 'lv1',
      at: { x: 6, y: 1.05, z: 4 },
      radius: 0.5,
      label: 'Door',
      verb: 'Open',
      controls: [],
      roomKey: '',
      roomName: '',
    };

  it('finds what the ray points at', () => {
    const target = door();
    const found = reachFor(
      [target],
      { x: target.at.x, y: target.at.y, z: target.at.z - 1 },
      { x: 0, y: 0, z: 1 },
    );
    expect(found?.id).toBe(target.id);
  });

  it('finds nothing beyond arm’s length', () => {
    const target = door();
    const found = reachFor(
      [target],
      { x: target.at.x, y: target.at.y, z: target.at.z - (REACH + 1) },
      { x: 0, y: 0, z: 1 },
    );
    expect(found).toBeNull();
  });

  it('finds nothing behind you', () => {
    const target = door();
    const found = reachFor(
      [target],
      { x: target.at.x, y: target.at.y, z: target.at.z - 1 },
      { x: 0, y: 0, z: -1 },
    );
    expect(found).toBeNull();
  });

  it('takes the nearest along the ray, not the nearest to the crosshair', () => {
    /*
     * Standing at a worktop, a wall switch behind it is often closer to the
     * middle of the view than the drawer under your hand. Reaching past the
     * thing in front of you is never what anybody meant.
     */
    const near: Interactable = {
      id: 'near',
      kind: 'drawer',
      levelId: 'lv1',
      at: { x: 0.12, y: 1, z: 0.6 },
      radius: 0.3,
      label: 'Drawer',
      verb: 'Open',
      controls: [],
      roomKey: '',
      roomName: '',
    };
    const far: Interactable = { ...near, id: 'far', at: { x: 0, y: 1, z: 1.5 }, radius: 0.3 };

    const found = reachFor([far, near], { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(found?.id).toBe('near');
  });

  it('misses something the ray passes wide of', () => {
    const target = door();
    const found = reachFor(
      [target],
      { x: target.at.x + 3, y: target.at.y, z: target.at.z - 1 },
      { x: 0, y: 0, z: 1 },
    );
    expect(found).toBeNull();
  });
});

/* ------------------------------- Live state ------------------------------- */

describe('what is open and what is on', () => {
  let live: LiveState;
  beforeEach(() => {
    live = new LiveState();
  });

  const doorItem = (): Interactable => {
    const doc = house();
    return doorsIn(interactablesOn(doc, doc.levels[0]!.id))[0]!;
  };

  it('starts doors open, the way this app has always drawn them', () => {
    // Deliberately unchanged. Doors are drawn standing open so the floor area
    // their swing needs is visible, and the drawings rely on that.
    expect(live.openness(doorItem())).toBe(1);
  });

  it('starts drawers shut', () => {
    const drawer: Interactable = { ...doorItem(), id: 'd1', kind: 'drawer' };
    expect(live.openness(drawer)).toBe(0);
  });

  it('closes a door and opens it again', () => {
    const door = doorItem();

    expect(live.use(door)).toBe('Closed');
    live.update(10);
    expect(live.openness(door)).toBe(0);

    expect(live.use(door)).toBe('Opened');
    live.update(10);
    expect(live.openness(door)).toBe(1);
  });

  it('reverses a door caught half way rather than stalling it', () => {
    /*
     * Aiming at the opposite of where it is HEADED, not of where it is. Hitting
     * a door twice quickly should shut it again; aiming off its current value
     * leaves it stuck half open, which reads as broken.
     */
    const door = doorItem();

    live.use(door);
    live.update(0.2);
    const midway = live.openness(door);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(1);

    live.use(door);
    live.update(10);
    expect(live.openness(door)).toBe(1);
  });

  it('eases rather than snapping', () => {
    // A door that jumps from shut to open is a jump cut, and in a headset the
    // thing you are holding teleports.
    const door = doorItem();
    live.use(door);

    live.update(1 / 60);
    expect(live.openness(door)).toBeGreaterThan(0);
    expect(live.openness(door)).toBeLessThan(1);
  });

  it('asks for frames while something is moving, and stops when it arrives', () => {
    const door = doorItem();
    live.use(door);

    expect(live.update(0.1)).toBe(true);
    expect(live.update(10)).toBe(true);
    // Arrived: nothing left to draw.
    expect(live.update(0.1)).toBe(false);
  });

  it('turns on the lights a switch controls', () => {
    const doc = house();
    layOutElectrical(doc);
    const control = switchesIn(interactablesOn(doc, doc.levels[0]!.id))[0]!;

    expect(live.verbFor(control)).toBe('Turn on');
    expect(live.use(control)).toBe('Turned on');

    for (const id of control.controls) expect(live.isLit(id)).toBe(true);
    expect(live.verbFor(control)).toBe('Turn off');
  });

  it('lets either of two switches turn the same light off', () => {
    // Which is how a room with two doors works, and the reason a switch acts
    // on its fittings rather than on itself.
    const doc = house();
    layOutElectrical(doc);
    const items = switchesIn(interactablesOn(doc, doc.levels[0]!.id));

    const first = items[0]!;
    const second: Interactable = { ...first, id: 'other-switch' };

    live.use(first);
    expect(first.controls.every((id) => live.isLit(id))).toBe(true);

    live.use(second);
    expect(first.controls.some((id) => live.isLit(id))).toBe(false);
  });

  it('says so when a switch is wired to nothing', () => {
    const orphan: Interactable = { ...doorItem(), id: 's1', kind: 'switch', controls: [] };
    expect(live.verbFor(orphan)).toMatch(/not wired/i);
    expect(live.use(orphan)).toMatch(/nothing wired/i);
  });

  it('runs a tap and stops it', () => {
    const tap: Interactable = { ...doorItem(), id: 't1', kind: 'tap' };

    expect(live.use(tap)).toBe('Turned on');
    expect(live.isRunning('t1')).toBe(true);
    expect(live.use(tap)).toBe('Turned off');
    expect(live.isRunning('t1')).toBe(false);
  });

  it('throws everything away on reset', () => {
    // Leaving the walkthrough leaves the design exactly as it was.
    const doc = house();
    layOutElectrical(doc);
    const items = interactablesOn(doc, doc.levels[0]!.id);

    live.use(doorsIn(items)[0]!);
    live.use(switchesIn(items)[0]!);
    live.update(10);

    live.reset();

    expect(live.openness(doorsIn(items)[0]!)).toBe(1);
    expect(live.litFittings).toEqual([]);
  });

  it('counts what is open and on', () => {
    const doc = house();
    layOutElectrical(doc);
    const items = interactablesOn(doc, doc.levels[0]!.id);

    const before = live.summary(items);
    expect(before.doorsOpen).toBe(1);
    expect(before.lightsOn).toBe(0);

    live.use(doorsIn(items)[0]!);
    live.use(switchesIn(items)[0]!);
    live.update(10);

    const after = live.summary(items);
    expect(after.doorsOpen).toBe(0);
    expect(after.doorsClosed).toBe(1);
    expect(after.lightsOn).toBeGreaterThan(0);
  });
});

/* ---------------------------- Cabinets and taps --------------------------- */

/**
 * The same house with a run of kitchen units and a sink in it.
 *
 * The modules are asked for by name rather than left to the filler. What is
 * under test is how a unit's front decides what it does, so the run has to
 * contain one of each kind — and the filler, left alone, fills four metres
 * with four identical 1000 double-door bases.
 */
function kitchen(required: readonly string[] = ['base-600-drawers', 'base-600-door']): DesignDocument {
  const doc = house();
  const levelId = doc.levels[0]!.id;

  // Along the inside of the north wall of the left-hand room, clear of the
  // partition at x = 6.
  addRun(doc, levelId, [{ x: 0.5, z: 0.4 }, { x: 4.5, z: 0.4 }], 'base', { required });
  addFixture(doc, levelId, 'sink-1.5-bowl', { x: 2, z: 1 });

  return doc;
}

/** The id of the unit built from a named module. */
function unitOf(doc: DesignDocument, moduleId: string): string {
  const unit = doc.runs[0]!.units.find((entry) => entry.moduleId === moduleId);
  expect(unit, `the run should contain a ${moduleId}`).toBeDefined();
  return unit!.id;
}

const kindsIn = (items: Interactable[], kind: Interactable['kind']) =>
  items.filter((item) => item.kind === kind);

describe('cabinets and taps', () => {
  it('offers the units of a run', () => {
    const doc = kitchen();
    const items = interactablesOn(doc, doc.levels[0]!.id);

    const cabinets = [
      ...kindsIn(items, 'drawer'),
      ...kindsIn(items, 'cabinet-door'),
    ];
    expect(cabinets.length).toBeGreaterThan(0);
  });

  it('calls a drawer unit a drawer and a door unit a door', () => {
    const doc = kitchen();
    const drawers = unitOf(doc, 'base-600-drawers');
    const door = unitOf(doc, 'base-600-door');

    const items = interactablesOn(doc, doc.levels[0]!.id);
    expect(items.find((item) => item.id === drawers)!.kind).toBe('drawer');
    expect(items.find((item) => item.id === door)!.kind).toBe('cabinet-door');
  });

  it('offers nothing on a unit with no front to open', () => {
    /*
     * Open shelving is already open and an appliance gap is filled by the
     * appliance's own door, which is not modelled. Offering "Open" on either
     * would be offering an action that visibly does nothing.
     */
    const doc = kitchen(['base-200-open', 'base-600-appliance']);
    const shelf = unitOf(doc, 'base-200-open');
    const gap = unitOf(doc, 'base-600-appliance');

    const items = interactablesOn(doc, doc.levels[0]!.id);
    expect(items.find((item) => item.id === shelf)).toBeUndefined();
    expect(items.find((item) => item.id === gap)).toBeUndefined();
  });

  it('opens a sink base, which has a door under the bowl', () => {
    // A `sink` front is a door in everything but name, and a kitchen without
    // an openable cupboard under the sink would be a strange kitchen.
    const doc = kitchen(['base-600-sink']);
    const sinkBase = unitOf(doc, 'base-600-sink');

    const items = interactablesOn(doc, doc.levels[0]!.id);
    expect(items.find((item) => item.id === sinkBase)!.kind).toBe('cabinet-door');
  });

  it('puts a tap on a sink and not on a WC', () => {
    const doc = kitchen();
    const levelId = doc.levels[0]!.id;
    addFixture(doc, levelId, 'wc-close-coupled', { x: 9, z: 6 });

    const taps = kindsIn(interactablesOn(doc, levelId), 'tap');
    expect(taps).toHaveLength(1);
    expect(taps[0]!.label).toMatch(/tap/i);
  });

  it('agrees with the scene about which fixtures have a tap', () => {
    // One predicate, used by both the reach test and the water geometry. Two
    // copies would disagree the first time a fixture was added.
    expect(hasTap({ id: 'sink-1.5-bowl', name: 'Kitchen sink' })).toBe(true);
    expect(hasTap({ id: 'wc-close-coupled', name: 'Close-coupled WC' })).toBe(false);
  });

  it('runs a tap and turns it off again', () => {
    const doc = kitchen();
    const live = new LiveState();
    const tap = kindsIn(interactablesOn(doc, doc.levels[0]!.id), 'tap')[0]!;

    expect(live.isRunning(tap.id)).toBe(false);
    expect(live.use(tap)).toBe('Turned on');
    expect(live.isRunning(tap.id)).toBe(true);
    expect(live.summary([tap]).tapsRunning).toBe(1);

    expect(live.use(tap)).toBe('Turned off');
    expect(live.isRunning(tap.id)).toBe(false);
  });

  it('slides a drawer and counts it as open', () => {
    const doc = kitchen();
    const live = new LiveState();
    const unitId = unitOf(doc, 'base-600-drawers');

    const drawer = interactablesOn(doc, doc.levels[0]!.id).find(
      (item) => item.id === unitId,
    )!;

    expect(live.use(drawer)).toBe('Opened');
    live.update(10);
    expect(live.openness(drawer)).toBe(1);
    expect(live.summary([drawer]).drawersOpen).toBe(1);
  });
});

/* ------------------------------- Still moving ----------------------------- */

describe('knowing when to keep drawing', () => {
  it('is not busy until something is used', () => {
    // Asked every frame by the orbit view, so it has to be both correct and
    // free when nothing has happened.
    const live = new LiveState();
    expect(live.busy).toBe(false);
  });

  it('is busy while a door swings and still once it arrives', () => {
    const doc = house();
    const live = new LiveState();
    const door = doorsIn(interactablesOn(doc, doc.levels[0]!.id))[0]!;

    live.use(door);
    expect(live.busy).toBe(true);

    live.update(0.1);
    expect(live.busy).toBe(true);

    live.update(10);
    expect(live.busy).toBe(false);
  });
});

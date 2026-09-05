/**
 * Tests for the electrical.
 *
 * The spacing rule is the one that decides whether a house is wired properly,
 * and it is checked the way an inspector would: walk every wall and find the
 * furthest point from an outlet. Everything else follows from what the code
 * requires by room, so most of these build a house of named rooms and ask what
 * came out.
 */

import { describe, expect, it } from 'vitest';

import { NEC_OUTLETS, conductorFor, breakerFor } from '@/code/nec';
import { createDefaultDocument } from '@/state/defaults';
import { addRectangle, normalizePlan, addOpening } from '@/state/planOps';
import { addDevice, layOutElectrical, removeDevice, updateDevice, wireElectrical } from '@/state/buildingOps';
import { findRegions } from '@/scene/planGraph';
import type { DesignDocument } from '@/state/types';

import { calculateLoad, groupByRoom, panelSchedule } from './circuits';
import { spacingAlong } from './layout';
import { checkElectrical } from './necCheck';
import { isHabitable, needsAfci, needsGfci, roomPurpose } from './rooms';

/* -------------------------------- Fixtures -------------------------------- */

/** A house of named rooms, drawn as rectangles side by side. */
function house(rooms: Array<{ name: string; x: number; z: number; w: number; d: number }>): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  level.plan.defaultWallThickness = 0.12;

  for (const room of rooms) {
    addRectangle(level.plan, { x: room.x, z: room.z }, room.w, room.d);
  }
  normalizePlan(level.plan);

  // Name each detected region after the rectangle whose centre it contains.
  for (const region of findRegions(level.plan)) {
    const match = rooms.find(
      (room) =>
        Math.abs(region.interiorPoint.x - room.x) < room.w / 2 &&
        Math.abs(region.interiorPoint.z - room.z) < room.d / 2,
    );
    if (match) {
      level.plan.rooms[region.key] = {
        name: match.name,
        floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
        wall: { color: '#ece7df', roughness: 0.88 },
        ceilingColor: '#f7f5f2',
      };
    }
  }

  return doc;
}

const oneRoom = (name: string, w = 5, d = 4) => house([{ name, x: 0, z: 0, w, d }]);

/* --------------------------------- Rooms ---------------------------------- */

describe('what a room is for', () => {
  it('reads the name the user typed', () => {
    expect(roomPurpose('Master Bedroom')).toBe('bedroom');
    expect(roomPurpose('En-suite')).toBe('bathroom');
    expect(roomPurpose('Kitchen / Diner')).toBe('kitchen');
    expect(roomPurpose('Upstairs Hall')).toBe('hall');
    expect(roomPurpose('Snug')).toBe('other');
  });

  it('knows which rooms the code protects, and how', () => {
    // GFCI protects people, where water is; AFCI protects the building, where
    // people sleep and sit. Bathrooms get the first and not the second.
    expect(needsGfci('bathroom')).toBe(true);
    expect(needsAfci('bathroom')).toBe(false);
    expect(needsGfci('bedroom')).toBe(false);
    expect(needsAfci('bedroom')).toBe(true);
    expect(isHabitable('bedroom')).toBe(true);
    expect(isHabitable('hall')).toBe(false);
  });
});

/* -------------------------------- Spacing --------------------------------- */

describe('the six-foot rule', () => {
  it('leaves a short return beside a door alone', () => {
    // NEC 210.52(A)(2): wall space is 2 ft or more. A 450 mm return is not
    // somewhere anybody plugs a lamp in.
    expect(spacingAlong(0.45)).toEqual([]);
  });

  it('puts one outlet in the middle of a wall up to twelve feet', () => {
    const positions = spacingAlong(3.6);
    expect(positions).toHaveLength(1);
    expect(positions[0]!).toBeCloseTo(1.8, 6);
  });

  it('adds a second the moment twelve feet is exceeded', () => {
    // A 13 ft wall cannot be served by one outlet: an end would be 6.5 ft away.
    expect(spacingAlong(3.97)).toHaveLength(2);
  });

  it('never leaves any point further than the code allows', () => {
    const limit = NEC_OUTLETS.maxDistanceAlongWall.metres;
    for (const length of [2, 3.6, 4, 7.2, 9, 12.5]) {
      const positions = spacingAlong(length);
      for (let at = 0; at <= length; at += 0.05) {
        const nearest = Math.min(...positions.map((p) => Math.abs(p - at)));
        expect(nearest).toBeLessThanOrEqual(limit + 1e-9);
      }
    }
  });
});

/* -------------------------------- Layout ---------------------------------- */

describe('laying a house out', () => {
  it('gives a bedroom outlets, a light and a switch', () => {
    const doc = oneRoom('Bedroom');
    const result = layOutElectrical(doc);

    expect(result.devices).toBeGreaterThan(4);
    const kinds = doc.electrical.devices.map((device) => device.kind);
    expect(kinds.filter((kind) => kind.startsWith('receptacle')).length).toBeGreaterThanOrEqual(3);
    expect(kinds.some((kind) => kind.startsWith('switch'))).toBe(true);
    expect(kinds.some((kind) => kind === 'light-ceiling' || kind === 'fan')).toBe(true);
    // IRC R314 wants one in every bedroom.
    expect(kinds).toContain('smoke-alarm');
  });

  it('satisfies its own spacing rule', () => {
    // The layout and the check are written separately and must agree: if they
    // ever disagree, one of them has the code wrong.
    const doc = house([
      { name: 'Living Room', x: 0, z: 0, w: 6, d: 5 },
      { name: 'Bedroom', x: 8, z: 0, w: 4.5, d: 4 },
    ]);
    layOutElectrical(doc);

    const spacing = checkElectrical(doc).findings.find((finding) => finding.id === 'nec-spacing');
    expect(spacing?.severity).toBe('pass');
  });

  it('makes the bathroom and kitchen outlets GFCI', () => {
    const doc = house([
      { name: 'Bathroom', x: 0, z: 0, w: 2.4, d: 3 },
      { name: 'Kitchen', x: 6, z: 0, w: 4, d: 4 },
    ]);
    layOutElectrical(doc);

    const wet = doc.electrical.devices.filter((device) => device.kind.startsWith('receptacle'));
    expect(wet.length).toBeGreaterThan(0);
    for (const device of wet) {
      expect(device.kind === 'receptacle-gfci' || device.kind === 'receptacle-counter').toBe(true);
    }
  });

  it('says what it had to assume', () => {
    const doc = oneRoom('Kitchen');
    const result = layOutElectrical(doc);
    // The app has no model of cabinets, and says so rather than reporting a
    // compliant counter layout it cannot know is right.
    expect(result.assumptions.join(' ')).toMatch(/counter/i);
  });

  it('puts a switch beside the door rather than in a corner', () => {
    const doc = oneRoom('Living Room', 6, 5);
    const wall = doc.levels[0]!.plan.walls[0]!;
    addOpening(doc.levels[0]!.plan, wall.id, 'door', 'door-single', { width: 0.9, height: 2.03, sillHeight: 0 }, 3);
    layOutElectrical(doc);

    const switches = doc.electrical.devices.filter((device) => device.kind.startsWith('switch'));
    expect(switches).toHaveLength(1);
    // Within a metre and a half of the doorway, not out in the middle of a
    // different wall.
    const vertices = doc.levels[0]!.plan.vertices;
    const start = vertices.find((v) => v.id === wall.start)!;
    const end = vertices.find((v) => v.id === wall.end)!;
    const doorAt = { x: start.x + ((end.x - start.x) * 3) / 6, z: start.z + ((end.z - start.z) * 3) / 6 };
    expect(Math.hypot(switches[0]!.at.x - doorAt.x, switches[0]!.at.z - doorAt.z)).toBeLessThan(1.6);
  });

  it('does nothing, and says so, for a plan with no rooms', () => {
    const doc = createDefaultDocument();
    doc.levels[0]!.plan.walls = [];
    doc.levels[0]!.plan.vertices = [];

    const result = layOutElectrical(doc);
    expect(result.devices).toBe(0);
    expect(result.assumptions.join(' ')).toMatch(/no enclosed rooms/i);
  });
});

/* -------------------------------- Circuits -------------------------------- */

describe('circuits', () => {
  it('gives the kitchen two small-appliance circuits, as the code demands', () => {
    const doc = house([
      { name: 'Kitchen', x: 0, z: 0, w: 4, d: 4 },
      { name: 'Dining Room', x: 6, z: 0, w: 4, d: 4 },
    ]);
    layOutElectrical(doc);

    const small = doc.electrical.circuits.filter((circuit) => circuit.kind === 'small-appliance');
    expect(small).toHaveLength(2);
    for (const circuit of small) expect(circuit.amps).toBe(20);
  });

  it('gives the bathroom and the laundry their own', () => {
    const doc = house([
      { name: 'Bathroom', x: 0, z: 0, w: 2.4, d: 3 },
      { name: 'Laundry', x: 5, z: 0, w: 2.4, d: 3 },
    ]);
    layOutElectrical(doc);

    expect(doc.electrical.circuits.some((circuit) => circuit.kind === 'bathroom')).toBe(true);
    expect(doc.electrical.circuits.some((circuit) => circuit.kind === 'laundry')).toBe(true);
  });

  it('puts every device on a circuit', () => {
    const doc = house([
      { name: 'Living Room', x: 0, z: 0, w: 6, d: 5 },
      { name: 'Bedroom', x: 8, z: 0, w: 4, d: 4 },
      { name: 'Bathroom', x: 8, z: 6, w: 2.4, d: 3 },
    ]);
    layOutElectrical(doc);

    const loose = doc.electrical.devices.filter((device) => !device.circuitId);
    expect(loose).toEqual([]);
  });

  it('sizes the conductor to the breaker, never the other way round', () => {
    expect(conductorFor(15).size).toBe('14 AWG');
    expect(conductorFor(20).size).toBe('12 AWG');
    expect(conductorFor(30).size).toBe('10 AWG');
    expect(breakerFor(17)).toBe(20);
    // Past 100 A the table has to keep going, because the same function sizes
    // the service: a house asking for 134 A gets a 150 A service, not a 100 A
    // one that quietly reads as compliant.
    expect(breakerFor(101)).toBe(110);
    expect(breakerFor(134)).toBe(150);

    const doc = oneRoom('Kitchen');
    layOutElectrical(doc);
    for (const circuit of doc.electrical.circuits) {
      expect(conductorFor(circuit.amps).size).toBe(circuit.conductor);
    }
  });

  it('groups devices by the room they stand in', () => {
    const doc = house([
      { name: 'Bedroom', x: 0, z: 0, w: 4, d: 4 },
      { name: 'Kitchen', x: 7, z: 0, w: 4, d: 4 },
    ]);
    layOutElectrical(doc);

    const rooms = groupByRoom(doc);
    expect(rooms.map((room) => room.name).sort()).toContain('Kitchen');
    for (const room of rooms) expect(room.devices.length).toBeGreaterThan(0);
  });

  it('reports how hard each circuit is worked', () => {
    const doc = oneRoom('Living Room', 6, 5);
    layOutElectrical(doc);

    const schedule = panelSchedule(doc);
    expect(schedule.length).toBe(doc.electrical.circuits.length);
    for (const row of schedule) {
      expect(row.utilisation).toBeGreaterThanOrEqual(0);
      // Nothing the layout produces should come anywhere near a full breaker.
      expect(row.utilisation).toBeLessThan(1);
    }
  });
});

/* ------------------------------ The load ---------------------------------- */

describe('the load calculation', () => {
  it('takes 3 VA a square foot, and says where that comes from', () => {
    const doc = oneRoom('Living Room', 6, 5); // about 30 m², 320 sq ft
    layOutElectrical(doc);

    const load = calculateLoad(doc);
    const general = load.lines.find((line) => line.section === '220.12')!;
    expect(general.va).toBeGreaterThan(800);
    expect(general.va).toBeLessThan(1100);
    expect(general.working).toMatch(/sq ft/);
  });

  it('applies the demand factor, which is the whole point of the method', () => {
    // Big enough to pass the 10 kVA threshold, which a 200 m² house does: at
    // 3 VA a square foot that alone is 6.6 kVA, and the small-appliance and
    // laundry circuits add 4.5 kVA more.
    const doc = house([
      { name: 'Living Room', x: 0, z: 0, w: 12, d: 9 },
      { name: 'Kitchen', x: 15, z: 0, w: 8, d: 6 },
      { name: 'Bedroom', x: 15, z: 8, w: 8, d: 6 },
    ]);
    layOutElectrical(doc);

    const load = calculateLoad(doc);
    expect(load.connectedVa).toBeGreaterThan(10000);
    // Everything over the first 10 kVA counts at 40 percent. Without that a
    // perfectly ordinary house asks for a 400 A service.
    expect(load.demandVa).toBeLessThan(load.connectedVa);
    expect(load.serviceAmps).toBeGreaterThanOrEqual(100);
    expect(load.serviceAmps).toBeLessThanOrEqual(200);
  });

  it('never goes below the 100 A floor', () => {
    const doc = oneRoom('Bedroom', 3, 3);
    layOutElectrical(doc);
    expect(calculateLoad(doc).serviceAmps).toBe(100);
  });

  it('says when the heating and cooling are missing', () => {
    const doc = oneRoom('Living Room');
    layOutElectrical(doc);
    expect(calculateLoad(doc).gaps.join(' ')).toMatch(/heating or cooling/i);

    doc.electrical.heatingVa = 9000;
    expect(calculateLoad(doc).gaps).toEqual([]);
    expect(calculateLoad(doc).demandVa).toBeGreaterThan(9000);
  });
});

/* -------------------------------- The checks ------------------------------ */

describe('checking against the NEC', () => {
  it('says nothing at all about a house with no electrical in it', () => {
    expect(checkElectrical(oneRoom('Bedroom')).findings).toEqual([]);
  });

  it('passes a house it laid out itself', () => {
    const doc = house([
      { name: 'Living Room', x: 0, z: 0, w: 6, d: 5 },
      { name: 'Kitchen', x: 8, z: 0, w: 4, d: 4 },
      { name: 'Bedroom', x: 0, z: 7, w: 4.5, d: 4 },
      { name: 'Bathroom', x: 8, z: 6, w: 2.4, d: 3 },
    ]);
    layOutElectrical(doc);

    const report = checkElectrical(doc);
    const violations = report.findings.filter((finding) => finding.severity === 'violation');
    expect(violations.map((finding) => `${finding.section}: ${finding.title}`)).toEqual([]);
    expect(report.compliant).toBe(true);
  });

  it('catches a wall left too far from an outlet', () => {
    const doc = oneRoom('Living Room', 8, 6);
    layOutElectrical(doc);

    // Strip the receptacles off one wall.
    doc.electrical.devices = doc.electrical.devices.filter(
      (device) => !device.kind.startsWith('receptacle') || device.at.z > -2,
    );

    const finding = checkElectrical(doc).findings.find((entry) => entry.id === 'nec-spacing')!;
    expect(finding.severity).toBe('violation');
    expect(finding.section).toBe('210.52(A)(1)');
    expect(finding.detail).toMatch(/6 ft/);
  });

  it('catches a kitchen with one small-appliance circuit', () => {
    const doc = oneRoom('Kitchen');
    layOutElectrical(doc);
    doc.electrical.circuits = doc.electrical.circuits.filter(
      (circuit, index) => circuit.kind !== 'small-appliance' || index === 0,
    );

    const finding = checkElectrical(doc).findings.find((entry) => entry.id === 'nec-small-appliance')!;
    expect(finding.severity).toBe('violation');
    expect(finding.section).toBe('210.11(C)(1)');
  });

  it('catches a bathroom receptacle with no ground-fault protection', () => {
    const doc = oneRoom('Bathroom', 2.4, 3);
    layOutElectrical(doc);

    for (const device of doc.electrical.devices) {
      if (device.kind === 'receptacle-gfci') device.kind = 'receptacle';
    }
    for (const circuit of doc.electrical.circuits) circuit.gfci = false;

    const finding = checkElectrical(doc).findings.find((entry) => entry.id === 'nec-gfci')!;
    expect(finding.severity).toBe('violation');
    expect(finding.section).toBe('210.8(A)');
  });

  it('catches a 20 A breaker on 14 AWG', () => {
    const doc = oneRoom('Bedroom');
    layOutElectrical(doc);
    doc.electrical.circuits[0]!.amps = 20;
    doc.electrical.circuits[0]!.conductor = '14 AWG';

    const finding = checkElectrical(doc).findings.find((entry) => entry.id === 'nec-conductors')!;
    expect(finding.severity).toBe('violation');
    expect(finding.detail).toMatch(/14 AWG/);
    expect(finding.remedy).toMatch(/12 AWG|15 A/);
  });

  it('catches a service too small for the load', () => {
    const doc = house([
      { name: 'Living Room', x: 0, z: 0, w: 9, d: 8 },
      { name: 'Kitchen', x: 11, z: 0, w: 6, d: 5 },
    ]);
    layOutElectrical(doc);
    doc.electrical.heatingVa = 24000;
    doc.electrical.panel!.mainAmps = 100;

    const finding = checkElectrical(doc).findings.find((entry) => entry.id === 'nec-service')!;
    expect(finding.severity).toBe('violation');
    expect(finding.section).toBe('220.82');
  });

  it('never states a limit without an article, or an article without a limit', () => {
    const doc = house([
      { name: 'Living Room', x: 0, z: 0, w: 6, d: 5 },
      { name: 'Kitchen', x: 8, z: 0, w: 4, d: 4 },
    ]);
    layOutElectrical(doc);

    for (const finding of checkElectrical(doc).findings) {
      if (!finding.section) continue;
      // A well-formed NEC reference: 210.52(A)(1), 240.4(D)(3), 220.12.
      expect(finding.section).toMatch(/^\d{3}\.\d+([.(][A-Za-z0-9)(.]*)?$/);
      expect(finding.detail).toContain(finding.section);
    }
  });

  it('reports devices left off a circuit as unfinished work, not a violation', () => {
    const doc = oneRoom('Bedroom');
    layOutElectrical(doc);
    doc.electrical.devices[0]!.circuitId = null;

    const finding = checkElectrical(doc).findings.find((entry) => entry.id === 'nec-unassigned')!;
    expect(finding.severity).toBe('caution');
    expect(finding.detail).toMatch(/not a code violation/i);
  });

  it('re-wiring picks up a device added by hand', () => {
    const doc = oneRoom('Bedroom');
    layOutElectrical(doc);

    doc.electrical.devices.push({
      ...doc.electrical.devices[0]!,
      id: 'added-by-hand',
      circuitId: null,
    });
    wireElectrical(doc);

    expect(doc.electrical.devices.find((device) => device.id === 'added-by-hand')?.circuitId)
      .not.toBeNull();
  });
});

/* ------------------------------ Adjusting it ------------------------------ */

/*
 * The other half of the bargain the app makes: it lays a house out to satisfy
 * the code, and then everything it placed is the user's to change. These check
 * that changing it does not quietly break anything else.
 */
describe('adjusting what was laid out', () => {
  it('adds a device in the biggest room, at the height the code puts it', () => {
    const doc = house([
      { name: 'Living Room', x: 0, z: 0, w: 6, d: 5 },
      { name: 'Bathroom', x: 8, z: 0, w: 2.4, d: 3 },
    ]);
    const levelId = doc.levels[0]!.id;

    const id = addDevice(doc, levelId, 'receptacle');
    expect(id).not.toBeNull();

    const device = doc.electrical.devices.find((entry) => entry.id === id)!;
    // 15 in above the floor: NEC has no rule, but every electrician does.
    expect(device.height).toBeCloseTo(0.381, 3);
    // In the living room, which is the bigger of the two.
    expect(Math.hypot(device.at.x, device.at.z)).toBeLessThan(3);
    // And on no circuit, because assigning circuits renumbers the whole panel.
    expect(device.circuitId).toBeNull();
  });

  it('puts a switch at switch height and a light at the ceiling', () => {
    const doc = oneRoom('Living Room', 6, 5);
    const levelId = doc.levels[0]!.id;

    const switchId = addDevice(doc, levelId, 'switch');
    const lightId = addDevice(doc, levelId, 'light-ceiling');

    const find = (id: string | null) => doc.electrical.devices.find((entry) => entry.id === id)!;
    expect(find(switchId).height).toBeCloseTo(1.1684, 3);
    expect(find(lightId).height).toBeCloseTo(doc.levels[0]!.wallHeight, 6);
  });

  it('refuses to add anything to a storey with no rooms, rather than guessing', () => {
    const doc = createDefaultDocument();
    doc.levels[0]!.plan.walls = [];
    doc.levels[0]!.plan.vertices = [];
    expect(addDevice(doc, doc.levels[0]!.id, 'receptacle')).toBeNull();
  });

  it('takes a device out of the schedule when it is deleted', () => {
    const doc = oneRoom('Living Room', 6, 5);
    layOutElectrical(doc);

    const victim = doc.electrical.devices.find((device) => isReceptacleKind(device.kind))!;
    const before = panelSchedule(doc).reduce((total, row) => total + row.va, 0);

    removeDevice(doc, victim.id);
    const after = panelSchedule(doc).reduce((total, row) => total + row.va, 0);

    expect(doc.electrical.devices.some((device) => device.id === victim.id)).toBe(false);
    expect(after).toBeLessThan(before);
  });

  it('notices when a change to a device breaks the spacing rule', () => {
    // The whole point of keeping the checks and the layout apart: an outlet the
    // user retypes as a switch stops counting towards the six-foot rule.
    const doc = oneRoom('Living Room', 8, 6);
    layOutElectrical(doc);
    expect(checkElectrical(doc).findings.find((f) => f.id === 'nec-spacing')?.severity).toBe('pass');

    for (const device of doc.electrical.devices) {
      if (isReceptacleKind(device.kind) && device.at.z < -2) {
        updateDevice(doc, device.id, { kind: 'switch' });
      }
    }

    expect(checkElectrical(doc).findings.find((f) => f.id === 'nec-spacing')?.severity).toBe(
      'violation',
    );
  });
});

function isReceptacleKind(kind: string): boolean {
  return kind.startsWith('receptacle');
}

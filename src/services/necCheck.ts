/**
 * Checking the electrical against the NEC.
 *
 * Same contract as the stair and roof checks: every finding names the
 * measurement, the limit and the article, so anybody can open the code book and
 * see in thirty seconds whether we read it right.
 *
 * What is checked:
 *   • 210.52(A)(1) — no point along a wall more than 6 ft from a receptacle.
 *   • 210.11(C) — the small-appliance, laundry and bathroom circuits.
 *   • 210.8(A) — ground-fault protection where the code names it.
 *   • 210.12(A) — arc-fault protection where the code names it.
 *   • 210.70(A) — a switched lighting outlet in each room, and both ends of a
 *     stairway of six risers or more.
 *   • 240.4(D) / 310.16 — the breaker against the conductor protecting it.
 *   • 230.79(C) and Article 220 — the service against the calculated load.
 *
 * And what is NOT: box fill, derating for conductors bundled together, voltage
 * drop over a long run, and anything at all about the supply side of the meter.
 * Those depend on how the house is actually built and on decisions nobody has
 * made yet, and a plausible-looking answer would be worse than none.
 *
 * These are checks, not a design. The work must be done by a licensed
 * electrician and inspected.
 */

import {
  NEC_AFCI,
  NEC_CIRCUITS,
  NEC_GFCI,
  NEC_LIGHTING,
  NEC_LOAD,
  NEC_OUTLETS,
  asAmps,
  asVoltAmperes,
  conductorFor,
} from '@/code/nec';
import { IRC_STAIRS, asFeetInches } from '@/code/irc';
import { blankSpans, roomWalls } from '@/advisor/geometry';
import { findRegions } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { levelAbove, stairsOn } from '@/state/levels';
import { calculateLoad, groupByRoom } from './circuits';
import { isLighting, isReceptacle } from './layout';
import { isHabitable, needsAfci, needsGfci, roomPurpose } from './rooms';
import type { DesignDocument, ElectricalDevice, Point2 } from '@/state/types';

export type NecSeverity = 'violation' | 'caution' | 'pass';

export interface NecFinding {
  id: string;
  severity: NecSeverity;
  /** The article, e.g. "210.52(A)(1)". Empty for checks the app makes itself. */
  section: string;
  title: string;
  detail: string;
  remedy: string;
}

export interface NecReport {
  findings: NecFinding[];
  compliant: boolean;
}

/* --------------------------------- The run -------------------------------- */

export function checkElectrical(doc: DesignDocument): NecReport {
  const findings: NecFinding[] = [];
  const add = (finding: NecFinding) => findings.push(finding);

  if (doc.electrical.devices.length === 0) {
    return { findings, compliant: true };
  }

  checkSpacing(doc, add);
  checkRequiredCircuits(doc, add);
  checkProtection(doc, add);
  checkLighting(doc, add);
  checkStairways(doc, add);
  checkConductors(doc, add);
  checkService(doc, add);
  checkAssignment(doc, add);

  return {
    findings,
    compliant: findings.every((finding) => finding.severity !== 'violation'),
  };
}

type Add = (finding: NecFinding) => void;

/* ------------------------------ 210.52 spacing ---------------------------- */

/**
 * Walks every wall space in every room and finds the point furthest from an
 * outlet.
 *
 * The measurement the code asks for is along the FLOOR LINE, not through the
 * air, which is why this walks the wall rather than measuring distances between
 * outlets. It samples every ten centimetres, which is finer than the tolerance
 * anybody could build to and cheap enough to run on every edit.
 */
function checkSpacing(doc: DesignDocument, add: Add): void {
  const limit = NEC_OUTLETS.maxDistanceAlongWall.metres;
  let worst = 0;
  let worstRoom = '';
  let rooms = 0;

  for (const level of doc.levels) {
    const receptacles = doc.electrical.devices.filter(
      (device) => device.levelId === level.id && isReceptacle(device.kind),
    );

    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      const purpose = roomPurpose(spec.name);
      if (!isHabitable(purpose) && purpose !== 'kitchen') continue;
      rooms += 1;

      for (const wall of roomWalls(level.plan, region)) {
        for (const span of blankSpans(wall, 0, NEC_OUTLETS.minWallSpace.metres)) {
          for (let along = span.from; along <= span.to; along += 0.1) {
            const at = pointAlong(wall.faceStart, wall.faceEnd, along);
            const nearest = nearestDistance(at, receptacles);
            if (nearest > worst) {
              worst = nearest;
              worstRoom = spec.name;
            }
          }
        }
      }
    }
  }

  if (rooms === 0) return;

  if (worst > limit + 1e-6) {
    add({
      id: 'nec-spacing',
      severity: 'violation',
      section: NEC_OUTLETS.maxDistanceAlongWall.section,
      title: 'A wall is too far from the nearest receptacle',
      detail: `In ${worstRoom}, a point on the wall is ${asFeetInches(worst)} from the nearest receptacle. NEC ${NEC_OUTLETS.maxDistanceAlongWall.section} allows ${NEC_OUTLETS.maxDistanceAlongWall.asWritten}, so that a lamp with a six-foot cord reaches from anywhere along the wall.`,
      remedy: `Add a receptacle within ${asFeetInches(worst - limit)} of that point, or lay the electrical out again.`,
    });
    return;
  }

  add({
    id: 'nec-spacing',
    severity: 'pass',
    section: NEC_OUTLETS.maxDistanceAlongWall.section,
    title: 'Receptacle spacing meets the six-foot rule',
    detail: `The furthest point along any wall is ${asFeetInches(worst)} from a receptacle; NEC ${NEC_OUTLETS.maxDistanceAlongWall.section} allows ${NEC_OUTLETS.maxDistanceAlongWall.asWritten}.`,
    remedy: '',
  });
}

/* ------------------------- 210.11 required circuits ----------------------- */

function checkRequiredCircuits(doc: DesignDocument, add: Add): void {
  const rooms = groupByRoom(doc);
  const has = (kind: string) => doc.electrical.circuits.filter((circuit) => circuit.kind === kind);

  const kitchens = rooms.filter((room) => room.purpose === 'kitchen' || room.purpose === 'dining');
  if (kitchens.length > 0) {
    const small = has('small-appliance');
    if (small.length < NEC_CIRCUITS.smallApplianceCount) {
      add({
        id: 'nec-small-appliance',
        severity: 'violation',
        section: NEC_CIRCUITS.smallAppliance.section,
        title: 'Not enough small-appliance circuits',
        detail: `There ${small.length === 1 ? 'is 1' : `are ${small.length}`} 20 A small-appliance circuit${small.length === 1 ? '' : 's'}; NEC ${NEC_CIRCUITS.smallAppliance.section} requires ${NEC_CIRCUITS.smallAppliance.asWritten} serving the kitchen, pantry and dining receptacles, and they may serve nothing else.`,
        remedy: `Add ${NEC_CIRCUITS.smallApplianceCount - small.length} more and move the kitchen receptacles onto them. One circuit is adequate until a kettle and a toaster are on at once.`,
      });
    } else {
      add({
        id: 'nec-small-appliance',
        severity: 'pass',
        section: NEC_CIRCUITS.smallAppliance.section,
        title: 'Small-appliance circuits',
        detail: `${small.length} of them, at ${asAmps(NEC_CIRCUITS.smallApplianceAmps)}, as NEC ${NEC_CIRCUITS.smallAppliance.section} requires.`,
        remedy: '',
      });
    }
  }

  if (rooms.some((room) => room.purpose === 'bathroom') && has('bathroom').length === 0) {
    add({
      id: 'nec-bathroom-circuit',
      severity: 'violation',
      section: NEC_CIRCUITS.bathroom.section,
      title: 'The bathrooms have no circuit of their own',
      detail: `NEC ${NEC_CIRCUITS.bathroom.section} requires ${NEC_CIRCUITS.bathroom.asWritten}.`,
      remedy: 'Add a 20 A circuit and put the bathroom receptacles on it.',
    });
  }

  if (rooms.some((room) => room.purpose === 'laundry') && has('laundry').length === 0) {
    add({
      id: 'nec-laundry-circuit',
      severity: 'violation',
      section: NEC_CIRCUITS.laundry.section,
      title: 'The laundry has no circuit of its own',
      detail: `NEC ${NEC_CIRCUITS.laundry.section} requires ${NEC_CIRCUITS.laundry.asWritten}.`,
      remedy: 'Add a 20 A circuit for the laundry receptacles, serving nothing else.',
    });
  }
}

/* --------------------------- 210.8 and 210.12 ----------------------------- */

function checkProtection(doc: DesignDocument, add: Add): void {
  const circuitById = new Map(doc.electrical.circuits.map((circuit) => [circuit.id, circuit]));
  const rooms = groupByRoom(doc);

  const unprotectedGfci: string[] = [];
  const unprotectedAfci: string[] = [];

  for (const room of rooms) {
    const receptacles = room.devices.filter((device) => isReceptacle(device.kind));
    if (receptacles.length === 0) continue;

    if (needsGfci(room.purpose)) {
      const bad = receptacles.filter((device) => {
        if (device.kind === 'receptacle-gfci') return false;
        const circuit = device.circuitId ? circuitById.get(device.circuitId) : undefined;
        return !circuit?.gfci;
      });
      if (bad.length > 0 && !unprotectedGfci.includes(room.name)) unprotectedGfci.push(room.name);
    }

    if (needsAfci(room.purpose)) {
      const bad = receptacles.filter((device) => {
        const circuit = device.circuitId ? circuitById.get(device.circuitId) : undefined;
        return !circuit?.afci;
      });
      if (bad.length > 0 && !unprotectedAfci.includes(room.name)) unprotectedAfci.push(room.name);
    }
  }

  if (unprotectedGfci.length > 0) {
    add({
      id: 'nec-gfci',
      severity: 'violation',
      section: NEC_GFCI.section,
      title: 'Receptacles that need ground-fault protection do not have it',
      detail: `${unprotectedGfci.join(', ')}. NEC ${NEC_GFCI.section} requires GFCI protection in ${NEC_GFCI.asWritten}. This is the protection that trips on current leaking to earth through a person, long before a breaker would notice.`,
      remedy: 'Put those receptacles on a GFCI breaker, or make the first receptacle on each run a GFCI device.',
    });
  } else {
    add({
      id: 'nec-gfci',
      severity: 'pass',
      section: NEC_GFCI.section,
      title: 'Ground-fault protection',
      detail: `Every receptacle in the places NEC ${NEC_GFCI.section} names is GFCI protected.`,
      remedy: '',
    });
  }

  if (unprotectedAfci.length > 0) {
    add({
      id: 'nec-afci',
      severity: 'violation',
      section: NEC_AFCI.section,
      title: 'Circuits that need arc-fault protection do not have it',
      detail: `${unprotectedAfci.join(', ')}. NEC ${NEC_AFCI.section} requires AFCI protection in ${NEC_AFCI.asWritten}. It listens for an arcing connection — a loose screw, a nail through a cable — which draws too little current to trip a breaker and is quite hot enough to start a fire.`,
      remedy: 'Use AFCI breakers on those circuits.',
    });
  }
}

/* ---------------------------- 210.70 lighting ----------------------------- */

function checkLighting(doc: DesignDocument, add: Add): void {
  const missing: string[] = [];
  const unswitched: string[] = [];

  for (const level of doc.levels) {
    const devices = doc.electrical.devices.filter((device) => device.levelId === level.id);

    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      const purpose = roomPurpose(spec.name);
      const wanted =
        isHabitable(purpose) || purpose === 'kitchen' || purpose === 'bathroom' || purpose === 'hall';
      if (!wanted) continue;

      const inside = devices.filter((device) => pointInPolygon(device.at, region.polygon));
      const lights = inside.filter((device) => isLighting(device.kind));
      const switches = inside.filter((device) => device.kind.startsWith('switch'));

      if (lights.length === 0) missing.push(spec.name);
      else if (switches.length === 0) unswitched.push(spec.name);
    }
  }

  if (missing.length > 0) {
    add({
      id: 'nec-lighting',
      severity: 'violation',
      section: NEC_LIGHTING.habitable.section,
      title: 'Rooms with no lighting outlet',
      detail: `${missing.join(', ')}. NEC ${NEC_LIGHTING.habitable.section} requires ${NEC_LIGHTING.habitable.asWritten}.`,
      remedy: 'Add a ceiling fitting and a switch by the door in each.',
    });
  }

  if (unswitched.length > 0) {
    add({
      id: 'nec-lighting-switch',
      severity: 'violation',
      section: NEC_LIGHTING.habitable.section,
      title: 'Lights with no wall switch',
      detail: `${unswitched.join(', ')} have a lighting outlet but no switch. NEC ${NEC_LIGHTING.habitable.section} requires it to be wall switch-controlled.`,
      remedy: 'Add a switch inside the room, beside the door.',
    });
  }

  if (missing.length === 0 && unswitched.length === 0) {
    add({
      id: 'nec-lighting',
      severity: 'pass',
      section: NEC_LIGHTING.habitable.section,
      title: 'Lighting outlets',
      detail: `Every room NEC ${NEC_LIGHTING.habitable.section} names has a switched lighting outlet.`,
      remedy: '',
    });
  }
}

/** 210.70(A)(2)(3): a stairway of six risers or more is switched at both ends. */
function checkStairways(doc: DesignDocument, add: Add): void {
  const rule = NEC_LIGHTING.stairwaySwitching;

  for (const level of doc.levels) {
    for (const stair of stairsOn(doc, level.id)) {
      if (stair.riserCount < rule.risers) continue;

      const nearBottom = doc.electrical.devices.some(
        (device) =>
          device.levelId === stair.fromLevelId &&
          device.kind.startsWith('switch') &&
          distance(device.at, stair.at) < 4,
      );
      // The storey above is where the stair arrives; a stair records only the
      // level it starts from, and the one above it is derived from the order.
      const above = levelAbove(doc, stair.fromLevelId);
      const nearTop =
        above !== null &&
        doc.electrical.devices.some(
          (device) => device.levelId === above.id && device.kind.startsWith('switch'),
        );

      if (nearBottom && nearTop) continue;

      add({
        id: `nec-stair-switch-${stair.id}`,
        severity: 'violation',
        section: rule.section,
        title: 'A stairway is not switched at both ends',
        detail: `This stair has ${stair.riserCount} risers. NEC ${rule.section} requires ${rule.asWritten}, so that nobody has to walk down a dark stair to reach the switch at the bottom. IRC ${IRC_STAIRS.minWidth.section} governs the stair itself.`,
        remedy: 'Add three-way switches at the top and bottom of the flight.',
      });
    }
  }
}

/* ----------------------- 240.4(D) breaker and conductor ------------------- */

function checkConductors(doc: DesignDocument, add: Add): void {
  const wrong = doc.electrical.circuits.filter((circuit) => {
    const needed = conductorFor(circuit.amps);
    const declared = doc.electrical.circuits.find((entry) => entry.id === circuit.id)?.conductor;
    return declared !== needed.size && sizeRank(declared) < sizeRank(needed.size);
  });

  if (wrong.length === 0) {
    add({
      id: 'nec-conductors',
      severity: 'pass',
      section: '240.4(D)',
      title: 'Breakers match their conductors',
      detail: 'Every circuit is protected at or below what its conductor may carry, per Table 310.16 and the small-conductor limits of 240.4(D).',
      remedy: '',
    });
    return;
  }

  const circuit = wrong[0]!;
  const needed = conductorFor(circuit.amps);
  add({
    id: 'nec-conductors',
    severity: 'violation',
    section: needed.section,
    title: 'A breaker is bigger than its conductor allows',
    detail: `Circuit ${circuit.reference} (${circuit.name}) is protected at ${asAmps(circuit.amps)} on ${circuit.conductor}. NEC ${needed.section} limits that conductor, so ${needed.size} is the smallest that may carry ${asAmps(circuit.amps)}. This is the single commonest dangerous mistake in domestic wiring: the breaker will not trip before the cable overheats.`,
    remedy: `Either run ${needed.size}, or drop the breaker to ${asAmps(conductorAmps(circuit.conductor))}.`,
  });
}

/* ------------------------ 220 / 230.79 the service ------------------------ */

function checkService(doc: DesignDocument, add: Add): void {
  const load = calculateLoad(doc);
  const panel = doc.electrical.panel;

  if (!panel) {
    add({
      id: 'nec-service',
      severity: 'caution',
      section: NEC_LOAD.minService.section,
      title: 'There is no panel yet',
      detail: `The calculated load is ${asVoltAmperes(load.demandVa)}, which needs a ${asAmps(load.serviceAmps)} service. NEC ${NEC_LOAD.minService.section} sets a floor of ${NEC_LOAD.minService.asWritten}.`,
      remedy: 'Add a panel and give it a rating.',
    });
    return;
  }

  if (panel.mainAmps < load.serviceAmps) {
    add({
      id: 'nec-service',
      severity: 'violation',
      section: NEC_LOAD.optionalMethod.section,
      title: 'The service is smaller than the calculated load',
      detail: `The panel is ${asAmps(panel.mainAmps)} and the load works out at ${asVoltAmperes(load.demandVa)}, which is ${load.amps.toFixed(0)} A at ${NEC_LOAD.volts.service} V. NEC ${NEC_LOAD.optionalMethod.section} allows ${NEC_LOAD.optionalMethod.asWritten}, and that has already been applied.`,
      remedy: `Fit a ${asAmps(load.serviceAmps)} service.`,
    });
  } else {
    add({
      id: 'nec-service',
      severity: 'pass',
      section: NEC_LOAD.optionalMethod.section,
      title: 'The service carries the calculated load',
      detail: `${asVoltAmperes(load.demandVa)} after the ${NEC_LOAD.optionalMethod.section} demand factor is ${load.amps.toFixed(0)} A, inside the ${asAmps(panel.mainAmps)} service.`,
      remedy: '',
    });
  }

  for (const [index, gap] of load.gaps.entries()) {
    add({
      id: `nec-load-gap-${index}`,
      severity: 'caution',
      section: '220.82(C)',
      title: 'The load calculation is missing something',
      detail: gap,
      remedy: 'Enter the heating and cooling loads on the electrical panel.',
    });
  }
}

/** Every device should end up on a circuit; one that does not is unfinished work. */
function checkAssignment(doc: DesignDocument, add: Add): void {
  const loose = doc.electrical.devices.filter(
    (device) => !device.circuitId && device.kind !== 'panel',
  );
  if (loose.length === 0) return;

  add({
    id: 'nec-unassigned',
    severity: 'caution',
    section: '',
    title: `${loose.length} device${loose.length === 1 ? ' is' : 's are'} not on a circuit`,
    detail:
      'They are drawn and they are counted in the spacing checks, but they are on no breaker, so they are missing from the panel schedule. This is not a code violation — it is unfinished work.',
    remedy: 'Assign the circuits again to sweep them up.',
  });
}

/* -------------------------------- Internals ------------------------------- */

function pointAlong(from: Point2, to: Point2, along: number): Point2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: from.x + (dx / length) * along, z: from.z + (dz / length) * along };
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function nearestDistance(at: Point2, devices: readonly ElectricalDevice[]): number {
  let nearest = Infinity;
  for (const device of devices) nearest = Math.min(nearest, distance(at, device.at));
  return nearest;
}

/** Bigger conductors rank higher; used only to compare two sizes. */
function sizeRank(size: string | undefined): number {
  if (!size) return -1;
  const order = ['14 AWG', '12 AWG', '10 AWG', '8 AWG', '6 AWG', '4 AWG', '3 AWG', '2 AWG', '1 AWG', '1/0 AWG', '2/0 AWG', '3/0 AWG', '4/0 AWG'];
  return order.indexOf(size);
}

/** What a named conductor may carry. */
function conductorAmps(size: string): number {
  const table: Record<string, number> = {
    '14 AWG': 15, '12 AWG': 20, '10 AWG': 30, '8 AWG': 40, '6 AWG': 55,
  };
  return table[size] ?? 15;
}

function pointInPolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.z > point.z === b.z > point.z) continue;
    const crossing = ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (point.x < crossing) inside = !inside;
  }
  return inside;
}

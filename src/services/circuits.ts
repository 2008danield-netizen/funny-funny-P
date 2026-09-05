/**
 * Circuits, the panel schedule, and the load the service has to carry.
 *
 * Two jobs that look separate and are not. Grouping devices onto breakers
 * decides what the panel schedule says; the Article 220 calculation decides how
 * big the service is; and the same rules — two small-appliance circuits, a
 * laundry circuit, a bathroom circuit — drive both.
 *
 * -----------------------------------------------------------------------------
 * THE ONE THING WORTH UNDERSTANDING ABOUT THE LOAD CALCULATION.
 *
 * It is not a sum of what is plugged in. The NEC does not care how many lamps
 * you own: Article 220 says to take 3 VA for every square foot of floor, add
 * 1500 VA for each small-appliance and laundry circuit, add the fixed
 * appliances, and then apply a DEMAND FACTOR — the first 10 kVA at full and the
 * rest at 40 percent — because nothing in a house is ever all switched on at
 * once. That factor is the difference between a 100 A service and a 400 A one,
 * and leaving it out is the commonest way an amateur calculation comes out
 * absurd.
 *
 * The heating and cooling figures are the user's to enter, and the calculation
 * says so when they have not, rather than quietly assuming zero — a house with
 * no heat in the load is a house with an undersized service.
 * -----------------------------------------------------------------------------
 */

import {
  NEC_CIRCUITS,
  NEC_LOAD,
  breakerFor,
  conductorFor,
} from '@/code/nec';
import { findRegions } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { needsAfci, needsGfci, roomPurpose, type RoomPurpose } from './rooms';
import { isLighting, isReceptacle } from './layout';
import type { Circuit, DesignDocument, ElectricalDevice, Level } from '@/state/types';

/* --------------------------- Grouping onto breakers ----------------------- */

/**
 * What a receptacle outlet is counted at on the panel schedule.
 *
 * 220.14(I) says 180 VA per outlet. In a DWELLING that figure does not go into
 * the service calculation — 220.14(J) folds receptacles into the 3 VA per
 * square foot instead, and Article 220 is where the service is sized. But the
 * panel schedule is a different question: it asks how hard one breaker is
 * worked, and 180 VA an outlet is the number every electrician uses to answer
 * it. So it is used here, and nowhere near the load calculation.
 */
export const RECEPTACLE_VA = 180;

/** General-purpose receptacle circuits, in amps. */
const GENERAL_CIRCUIT_AMPS = 20;

/**
 * How many general-purpose outlets share one circuit.
 *
 * The NEC sets no limit for a dwelling, so this is a convention — but not an
 * arbitrary one. It is derived: as many outlets at {@link RECEPTACLE_VA} as
 * fit inside the breaker's continuous rating (80 percent of it, 210.19(A)(1)),
 * which on a 20 A circuit is ten. Deriving it rather than writing "10" means
 * the panel schedule can never report a circuit the layout itself built as
 * being over its breaker, which is what a hard-coded number quietly allowed.
 */
const OUTLETS_PER_CIRCUIT = Math.max(
  1,
  Math.ceil(
    (GENERAL_CIRCUIT_AMPS * NEC_LOAD.volts.branch * NEC_CIRCUITS.continuousFactor) / RECEPTACLE_VA,
  ) - 1,
);

/** How many lighting outlets share one circuit. Same reasoning, more headroom. */
const LIGHTS_PER_CIRCUIT = 12;

interface Grouping {
  circuits: Circuit[];
  /** Device id to circuit id. */
  assignment: Map<string, string>;
}

function makeCircuit(
  index: number,
  name: string,
  kind: Circuit['kind'],
  amps: number,
  gfci: boolean,
  afci: boolean,
  volts = 120,
): Circuit {
  return {
    id: `ckt${index}`,
    // Odd numbers down the left of a panel, even down the right, which is how
    // every panel schedule in the country is numbered.
    reference: String(index),
    name,
    kind,
    amps,
    volts,
    conductor: conductorFor(amps).size,
    gfci,
    afci,
  };
}

/**
 * Puts every device on a circuit.
 *
 * Room by room, because that is how a house is actually wired and how a panel
 * schedule is read — "Bedroom 2 receptacles" tells somebody standing at the
 * panel what they are turning off, and "Circuit 14" does not.
 *
 * The circuits the code demands come first and take their devices exclusively:
 * a small-appliance circuit may serve nothing but the kitchen and dining
 * receptacles (210.11(C)(1)), and a bathroom circuit nothing but bathroom
 * receptacles (210.11(C)(3)). Everything else is grouped by room and split when
 * it gets long.
 */
export function assignCircuits(doc: DesignDocument): Grouping {
  const circuits: Circuit[] = [];
  const assignment = new Map<string, string>();
  let index = 0;

  const add = (
    name: string,
    kind: Circuit['kind'],
    amps: number,
    gfci: boolean,
    afci: boolean,
    devices: readonly ElectricalDevice[],
    volts = 120,
  ) => {
    if (devices.length === 0) return;
    index += 1;
    const circuit = makeCircuit(index, name, kind, amps, gfci, afci, volts);
    circuits.push(circuit);
    for (const device of devices) assignment.set(device.id, circuit.id);
  };

  /** Devices grouped by the room they stand in, per storey. */
  const byRoom = groupByRoom(doc);

  /* ---- The circuits the code names ---- */

  const smallAppliance = byRoom
    .filter((room) => room.purpose === 'kitchen' || room.purpose === 'dining')
    .flatMap((room) => room.devices.filter((device) => isReceptacle(device.kind)));

  if (smallAppliance.length > 0) {
    // Two of them, minimum, and split evenly: 210.11(C)(1).
    const half = Math.ceil(smallAppliance.length / NEC_CIRCUITS.smallApplianceCount);
    for (let i = 0; i < NEC_CIRCUITS.smallApplianceCount; i++) {
      add(
        `Small appliance ${i + 1}`,
        'small-appliance',
        NEC_CIRCUITS.smallApplianceAmps,
        true,
        true,
        smallAppliance.slice(i * half, (i + 1) * half),
      );
    }
  }

  const bathroomReceptacles = byRoom
    .filter((room) => room.purpose === 'bathroom')
    .flatMap((room) => room.devices.filter((device) => isReceptacle(device.kind)));
  add('Bathroom receptacles', 'bathroom', 20, true, false, bathroomReceptacles);

  const laundry = byRoom
    .filter((room) => room.purpose === 'laundry')
    .flatMap((room) => room.devices.filter((device) => isReceptacle(device.kind)));
  add('Laundry', 'laundry', 20, true, true, laundry);

  /* ---- Everything else, by room ---- */

  const takenIds = new Set(assignment.keys());

  for (const room of byRoom) {
    const remaining = room.devices.filter((device) => !takenIds.has(device.id));
    const receptacles = remaining.filter((device) => isReceptacle(device.kind));
    const lights = remaining.filter(
      (device) => isLighting(device.kind) || device.kind.startsWith('switch'),
    );

    for (let i = 0; i < receptacles.length; i += OUTLETS_PER_CIRCUIT) {
      const slice = receptacles.slice(i, i + OUTLETS_PER_CIRCUIT);
      const part = receptacles.length > OUTLETS_PER_CIRCUIT ? ` ${Math.floor(i / OUTLETS_PER_CIRCUIT) + 1}` : '';
      add(
        `${room.name} receptacles${part}`,
        'general',
        GENERAL_CIRCUIT_AMPS,
        needsGfci(room.purpose),
        needsAfci(room.purpose),
        slice,
      );
    }

    for (let i = 0; i < lights.length; i += LIGHTS_PER_CIRCUIT) {
      add(
        `${room.name} lighting`,
        'lighting',
        15,
        needsGfci(room.purpose) && room.purpose !== 'bathroom',
        needsAfci(room.purpose),
        lights.slice(i, i + LIGHTS_PER_CIRCUIT),
      );
    }
  }

  /* ---- Whatever is left: smoke alarms and strays ---- */
  const strays = doc.electrical.devices.filter(
    (device) => !assignment.has(device.id) && device.kind !== 'panel',
  );
  add('Smoke alarms and sundries', 'general', 15, false, true, strays);

  return { circuits, assignment };
}

interface RoomDevices {
  name: string;
  purpose: RoomPurpose;
  devices: ElectricalDevice[];
}

/**
 * Which room each device stands in.
 *
 * By point-in-polygon rather than by anything stored, so moving a wall moves
 * the device into whichever room it now belongs to — the same derived-not-stored
 * rule the rest of the app follows. A device in no room at all (in a wall, or
 * outside the building) is gathered under the storey's name so that it still
 * reaches a circuit instead of silently disappearing from the schedule.
 */
export function groupByRoom(doc: DesignDocument): RoomDevices[] {
  const rooms: RoomDevices[] = [];

  for (const level of doc.levels) {
    const devices = doc.electrical.devices.filter((device) => device.levelId === level.id);
    if (devices.length === 0) continue;

    const regions = findRegions(level.plan);
    const claimed = new Set<string>();

    for (const region of regions) {
      const spec = resolveRoomSpec(level.plan, region.key);
      const inside = devices.filter(
        (device) => !claimed.has(device.id) && pointInPolygon(device.at, region.polygon),
      );
      for (const device of inside) claimed.add(device.id);
      if (inside.length === 0) continue;

      rooms.push({ name: spec.name, purpose: roomPurpose(spec.name), devices: inside });
    }

    const orphans = devices.filter((device) => !claimed.has(device.id));
    if (orphans.length > 0) {
      rooms.push({ name: level.name, purpose: 'other', devices: orphans });
    }
  }

  return rooms;
}

/* ---------------------------- The load calculation ------------------------ */

export interface LoadLine {
  label: string;
  /** The article this line comes from. */
  section: string;
  va: number;
  /** How the figure was arrived at, in words. */
  working: string;
}

export interface LoadResult {
  lines: LoadLine[];
  /** Everything before the demand factor. */
  connectedVa: number;
  /** After the 220.82 demand factor, plus heating or cooling. */
  demandVa: number;
  amps: number;
  /** The service size this needs, rounded up to a real one. */
  serviceAmps: number;
  /** What the app could not know, in words. */
  gaps: string[];
}

/** Floor area of a storey, in square metres. */
export function floorAreaOf(level: Level): number {
  return findRegions(level.plan).reduce((total, region) => total + region.area, 0);
}

/**
 * The dwelling load, by the optional method of NEC 220.82.
 *
 * The optional method rather than the standard one because it is the method
 * every residential job in the country is calculated by, it is simpler, and it
 * gives the same answer within a few amps for an ordinary house.
 */
export function calculateLoad(doc: DesignDocument): LoadResult {
  const lines: LoadLine[] = [];
  const gaps: string[] = [];

  const squareMetres = doc.levels.reduce((total, level) => total + floorAreaOf(level), 0);
  const squareFeet = squareMetres / (0.3048 * 0.3048);

  const general = squareFeet * NEC_LOAD.generalLighting.vaPerSquareFoot;
  lines.push({
    label: 'General lighting and receptacles',
    section: NEC_LOAD.generalLighting.section,
    va: general,
    working: `${Math.round(squareFeet).toLocaleString('en-US')} sq ft at ${NEC_LOAD.generalLighting.vaPerSquareFoot} VA per sq ft`,
  });

  const smallApplianceCircuits = Math.max(
    NEC_CIRCUITS.smallApplianceCount,
    doc.electrical.circuits.filter((circuit) => circuit.kind === 'small-appliance').length,
  );
  lines.push({
    label: 'Small-appliance circuits',
    section: NEC_LOAD.smallApplianceVa.section,
    va: smallApplianceCircuits * NEC_LOAD.smallApplianceVa.va,
    working: `${smallApplianceCircuits} circuits at ${NEC_LOAD.smallApplianceVa.va} VA`,
  });

  const laundryCircuits = Math.max(
    1,
    doc.electrical.circuits.filter((circuit) => circuit.kind === 'laundry').length,
  );
  lines.push({
    label: 'Laundry circuit',
    section: NEC_LOAD.laundryVa.section,
    va: laundryCircuits * NEC_LOAD.laundryVa.va,
    working: `${laundryCircuits} circuit at ${NEC_LOAD.laundryVa.va} VA`,
  });

  // Fixed appliances and fittings that named their own load.
  const fixed = doc.electrical.devices.reduce(
    (total, device) => total + (isReceptacle(device.kind) ? 0 : (device.va ?? 0)),
    0,
  );
  if (fixed > 0) {
    lines.push({
      label: 'Fixed appliances and fittings',
      section: '220.53',
      va: fixed,
      working: 'the connected load of everything placed that names one',
    });
  }

  const connectedVa = lines.reduce((total, line) => total + line.va, 0);

  const { firstVa, remainderFactor } = NEC_LOAD.optionalMethod;
  const afterDemand =
    connectedVa <= firstVa ? connectedVa : firstVa + (connectedVa - firstVa) * remainderFactor;

  const climate = Math.max(doc.electrical.heatingVa, doc.electrical.coolingVa);
  if (climate === 0) {
    gaps.push(
      'No heating or cooling load has been entered, so this figure is low. NEC 220.82(C) adds the larger of the two at full value, and it is usually the biggest single item in the calculation.',
    );
  }

  const demandVa = afterDemand + climate;
  const amps = demandVa / NEC_LOAD.volts.service;
  const serviceAmps = Math.max(NEC_LOAD.minService.amps, breakerFor(amps));

  return { lines, connectedVa, demandVa, amps, serviceAmps, gaps };
}

/* ------------------------------ Panel schedule ---------------------------- */

export interface ScheduleRow {
  circuit: Circuit;
  deviceCount: number;
  /** Connected load on this circuit, in VA. */
  va: number;
  /** How loaded it is, 0-1, against the breaker at 80 percent. */
  utilisation: number;
}

/**
 * The panel schedule: every circuit, what is on it, and how hard it is worked.
 *
 * The load per circuit is NOT what Article 220 calculates — that is a
 * whole-house figure and deliberately not per-circuit. This is the connected
 * load of the things actually on the breaker, which is what tells somebody
 * whether a circuit is sensible, and general-purpose receptacles are counted at
 * {@link RECEPTACLE_VA} each for exactly that purpose.
 */
export function panelSchedule(doc: DesignDocument): ScheduleRow[] {
  const byCircuit = new Map<string, ElectricalDevice[]>();
  for (const device of doc.electrical.devices) {
    if (!device.circuitId) continue;
    const list = byCircuit.get(device.circuitId) ?? [];
    list.push(device);
    byCircuit.set(device.circuitId, list);
  }

  return doc.electrical.circuits.map((circuit) => {
    const devices = byCircuit.get(circuit.id) ?? [];
    const va = devices.reduce(
      (total, device) => total + (device.va ?? (isReceptacle(device.kind) ? RECEPTACLE_VA : 0)),
      0,
    );
    const capacity = circuit.amps * circuit.volts * NEC_CIRCUITS.continuousFactor;
    return { circuit, deviceCount: devices.length, va, utilisation: capacity > 0 ? va / capacity : 0 };
  });
}

/* -------------------------------- Internals ------------------------------- */

function pointInPolygon(point: { x: number; z: number }, polygon: readonly { x: number; z: number }[]): boolean {
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

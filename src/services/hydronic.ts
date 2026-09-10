/**
 * Hydronic heating: radiators and underfloor, sized from the same load.
 *
 * -----------------------------------------------------------------------------
 * THE SAME LOAD, A COMPLETELY DIFFERENT MACHINE.
 *
 * Manual J produces watts per room. A ducted system turns those watts into
 * airflow; a hydronic system turns them into surface area. Nothing about the
 * load changes — which is the point of keeping the load calculation free of
 * any assumption about how the heat gets delivered.
 *
 * -----------------------------------------------------------------------------
 * WHY THE FLOW TEMPERATURE DECIDES EVERYTHING.
 *
 * A radiator's published output is quoted at a "delta T" — the difference
 * between the average water temperature in it and the room. Almost every
 * catalogue quotes ΔT 50: water in at 75°C, out at 65°C, room at 20°C.
 *
 * A condensing boiler does not want to run at 75°C. It only condenses — which
 * is where its efficiency comes from — when the water coming back to it is
 * below about 55°C, so it wants to run a flow temperature of 55°C or lower.
 * That is ΔT 30, not 50, and a radiator at ΔT 30 puts out roughly HALF what its
 * catalogue says.
 *
 * So a house fitted with radiators sized off the catalogue figure and then
 * given a condensing boiler is a house that is cold, and the owner turns the
 * flow temperature up to fix it, and the boiler stops condensing and stops
 * being efficient. This is an extremely common real outcome, and the whole
 * reason this file makes the design flow temperature an explicit input rather
 * than burying 75°C in a constant.
 *
 * -----------------------------------------------------------------------------
 * UNDERFLOOR IS LIMITED BY YOUR FEET, NOT BY THE PIPE.
 *
 * An underfloor loop could deliver far more heat than it does. What stops it is
 * that the floor is a surface people stand on: above about 29°C it is
 * uncomfortable, and there is a real limit on how much heat a surface at 29°C
 * can give a room at 20°C. That works out to roughly 100 W/m² of floor, and no
 * amount of extra pipe changes it.
 *
 * Which means underfloor simply CANNOT heat a room whose load per square metre
 * exceeds that — a poorly insulated room with a lot of glass. The honest answer
 * there is a radiator, or better insulation, and this file says which.
 */

import { HVAC_LIMITS, type DesignDocument, type Emitter, type Level, type Point2 } from '@/state/types';
import { findRegions, pointInPolygon, type Region } from '@/scene/planGraph';
import { roomWalls } from '@/advisor/geometry';
import { resolveRoomSpec } from '@/state/planOps';
import { roomPurpose } from './rooms';
import { isExteriorWall, type BuildingLoad } from './manualJ';

/* ------------------------------- Emitter data ----------------------------- */

/**
 * Typical published outputs. Manufacturer data, not a code requirement — so
 * these carry no section number, and the UI prints them as guidance.
 */
export const EMITTERS = {
  /**
   * A double-panel, double-convector radiator 600 mm high, at ΔT 50.
   *
   * The workhorse of a wet system and the size that fits under a window. Watts
   * per metre of length.
   */
  radiatorWattsPerMetreAtDeltaT50: 1250,
  /** The height these figures are for. */
  radiatorHeight: HVAC_LIMITS.radiatorHeight,
  /** Shortest and longest radiator anybody makes in one piece. */
  minLength: 0.4,
  maxLength: 2.4,

  /**
   * Most heat an underfloor slab will give up, watts per square metre.
   *
   * Set by the surface temperature people will tolerate, not by the pipe. The
   * bathroom figure is higher because a bathroom floor is expected to be warm
   * underfoot and it is walked on barefoot briefly rather than stood on all
   * day, so a higher surface temperature is acceptable there.
   */
  underfloorWattsPerSquareMetre: 100,
  underfloorBathroomWattsPerSquareMetre: 130,
  /** How much of a room's floor a loop can actually cover, allowing for units. */
  underfloorUsableFraction: 0.85,
} as const;

/**
 * How a radiator's output scales away from its catalogue ΔT 50.
 *
 * The exponent is 1.3 rather than 1, because a radiator does most of its work
 * by convection and convection is not linear in temperature difference. Using
 * a straight ratio overstates a low-temperature system by about 10%, which is
 * the wrong direction to be wrong in.
 */
export function radiatorOutputFactor(flowC: number, returnC: number, roomC = 20): number {
  const meanWater = (flowC + returnC) / 2;
  const deltaT = meanWater - roomC;
  if (deltaT <= 0) return 0;
  return Math.pow(deltaT / 50, 1.3);
}

/** Common flow regimes, so the panel can offer them by name. */
export const FLOW_REGIMES = [
  {
    id: 'condensing-45',
    name: '45 / 35 °C — underfloor, fully condensing',
    flowC: 45,
    returnC: 35,
    note: 'The efficient end. Radiators sized for this are large.',
  },
  {
    id: 'condensing-55',
    name: '55 / 45 °C — low temperature, condensing',
    flowC: 55,
    returnC: 45,
    note: 'What a condensing boiler is designed around. Radiators roughly double the catalogue size.',
  },
  {
    id: 'traditional-75',
    name: '75 / 65 °C — traditional',
    flowC: 75,
    returnC: 65,
    note: 'The catalogue condition. Smallest radiators, and the boiler never condenses.',
  },
] as const;

export type FlowRegimeId = (typeof FLOW_REGIMES)[number]['id'];

export function flowRegime(id: string): (typeof FLOW_REGIMES)[number] {
  return FLOW_REGIMES.find((regime) => regime.id === id) ?? FLOW_REGIMES[1];
}

/* -------------------------------- The result ------------------------------ */

/** One room's emitter, and whether it can actually do the job. */
export interface SizedEmitter {
  emitter: Emitter;
  roomName: string;
  /** What the room needs, watts. */
  requiredWatts: number;
  /** What this emitter gives at the chosen flow temperature, watts. */
  providedWatts: number;
  /**
   * The radiator length the room actually needs, metres, before it was clamped
   * to the wall it has to go on.
   *
   * Kept separately from the length that was placed, because "needs 3.4 m and
   * there is 1.7 m of clear wall" is a completely different problem from "needs
   * 3.4 m and nobody makes one that long", and the panel has to be able to say
   * which. Zero for underfloor.
   */
  wantedLength: number;
  adequate: boolean;
  /** Why this kind was chosen here. */
  reason: string;
}

export interface HydronicLayout {
  emitters: Emitter[];
  sized: SizedEmitter[];
  assumptions: string[];
}

export const emptyHydronic = (): HydronicLayout => ({
  emitters: [],
  sized: [],
  assumptions: [],
});

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}${counter}`;
};

export function resetEmitterIds(): void {
  counter = 0;
}

/* -------------------------------- Placement ------------------------------- */

/**
 * Where a radiator goes: under a window, on the longest clear exterior wall.
 *
 * Same physics as the supply register, and the convention is older — the
 * radiator was put under the window a century before anybody was calculating
 * anything, because that is where the cold comes in. Returns the midpoint of
 * the chosen span and how much clear wall it has.
 */
function radiatorSpot(
  level: Level,
  region: Region,
): { at: Point2; rotation: number; clear: number } | null {
  const found: Array<{ at: Point2; rotation: number; clear: number; score: number }> = [];

  for (const wall of roomWalls(level.plan, region)) {
    const exterior = isExteriorWall(level, wall.wallId);
    const planWall = level.plan.walls.find((candidate) => candidate.id === wall.wallId);

    /*
     * Clear spans on this wall: everything between the openings. A radiator
     * cannot go across a door, but it very much CAN go under a window, so a
     * window span is a preferred position rather than an obstruction.
     */
    const openings = planWall?.openings ?? [];
    /*
     * Taken from the wall's own openings rather than from `openingSpans`.
     * That array is sorted by position while `openings` is in insertion order,
     * so pairing them by index silently mislabels a door as a window the
     * moment somebody adds an opening to the left of an existing one.
     */
    const doors = openings
      .filter((opening) => opening.kind !== 'window')
      .map((opening) => ({ from: opening.offset - opening.width / 2, to: opening.offset + opening.width / 2 }));

    const windows = openings.filter((opening) => opening.kind === 'window');

    const at = (along: number): Point2 => {
      const t = wall.length > 0 ? along / wall.length : 0.5;
      return {
        x:
          wall.faceStart.x +
          (wall.faceEnd.x - wall.faceStart.x) * t +
          wall.inward.x * HVAC_LIMITS.radiatorDepth,
        z:
          wall.faceStart.z +
          (wall.faceEnd.z - wall.faceStart.z) * t +
          wall.inward.z * HVAC_LIMITS.radiatorDepth,
      };
    };

    const consider = (along: number, clear: number, bonus: number): void => {
      const point = at(along);
      if (!pointInPolygon(point, region.polygon)) return;
      found.push({ at: point, rotation: wall.seatRotation, clear, score: clear + bonus });
    };

    // Under each window first, with a bonus so a short window wall beats a
    // long internal one.
    for (const window of windows) {
      const blocked = doors.some(
        (span) => window.offset > span.from - 0.1 && window.offset < span.to + 0.1,
      );
      if (blocked) continue;
      consider(window.offset, Math.min(window.width + 0.4, wall.length), exterior ? 100 : 20);
    }

    // Then the longest gap between doors.
    let cursor = 0;
    const sorted = [...doors].sort((a, b) => a.from - b.from);
    for (const span of [...sorted, { from: wall.length, to: wall.length }]) {
      const gap = span.from - cursor;
      if (gap > EMITTERS.minLength) {
        consider(cursor + gap / 2, gap, exterior ? 10 : 0);
      }
      cursor = Math.max(cursor, span.to);
    }
  }

  const best = found.sort((a, b) => b.score - a.score)[0];
  return best ? { at: best.at, rotation: best.rotation, clear: best.clear } : null;
}

/* ------------------------------ The whole pass ---------------------------- */

/**
 * Lay out the emitters for the whole building.
 *
 * Underfloor where the load per square metre allows it, radiators where it does
 * not — decided per room rather than for the house, because a well-insulated
 * bedroom and a glazed living room genuinely want different things and forcing
 * one answer on both is how underfloor gets a reputation for not working.
 */
export function layoutHydronic(
  doc: DesignDocument,
  load: BuildingLoad,
  options: { regimeId?: string; preferUnderfloor?: boolean } = {},
): HydronicLayout {
  const layout = emptyHydronic();

  const regime = flowRegime(options.regimeId ?? 'condensing-55');
  const factor = radiatorOutputFactor(regime.flowC, regime.returnC);
  const preferUnderfloor = options.preferUnderfloor ?? false;

  if (!load.conditions) {
    layout.assumptions.push('No design location chosen, so there is no load to size against.');
    return layout;
  }

  const loadByRoom = new Map(load.rooms.map((room) => [room.roomKey, room]));

  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const room = loadByRoom.get(region.key);
      if (!room || room.heatingTotal <= 1) continue;

      const spec = resolveRoomSpec(level.plan, region.key);
      const purpose = roomPurpose(spec.name);
      if (purpose === 'garage' || purpose === 'outdoor') continue;

      const bathroom = purpose === 'bathroom';
      const underfloorCeiling =
        (bathroom
          ? EMITTERS.underfloorBathroomWattsPerSquareMetre
          : EMITTERS.underfloorWattsPerSquareMetre) * EMITTERS.underfloorUsableFraction;

      const intensity = region.area > 0 ? room.heatingTotal / region.area : Infinity;
      const underfloorWorks = intensity <= underfloorCeiling;

      if (preferUnderfloor && underfloorWorks) {
        const provided = region.area * underfloorCeiling;
        const emitter: Emitter = {
          id: nextId('emit'),
          levelId: level.id,
          at: region.interiorPoint,
          kind: 'underfloor',
          roomKey: region.key,
          outputWatts: room.heatingTotal,
          length: 0,
        };
        layout.emitters.push(emitter);
        layout.sized.push({
          emitter,
          roomName: room.roomName,
          requiredWatts: room.heatingTotal,
          providedWatts: provided,
          wantedLength: 0,
          adequate: true,
          reason: `${Math.round(intensity)} W/m² is inside what a floor at a comfortable surface temperature can give.`,
        });
        continue;
      }

      /* ---- A radiator, then ---- */

      const wattsPerMetre = EMITTERS.radiatorWattsPerMetreAtDeltaT50 * factor;
      const wanted = wattsPerMetre > 0 ? room.heatingTotal / wattsPerMetre : Infinity;

      const spot = radiatorSpot(level, region);
      const available = spot ? Math.max(0, spot.clear - 0.2) : 0;
      const length = Math.max(
        EMITTERS.minLength,
        Math.min(EMITTERS.maxLength, available > 0 ? Math.min(wanted, available) : wanted),
      );
      const provided = length * wattsPerMetre;

      const emitter: Emitter = {
        id: nextId('emit'),
        levelId: level.id,
        at: spot ? spot.at : region.interiorPoint,
        kind: 'radiator',
        roomKey: region.key,
        outputWatts: provided,
        length,
      };
      layout.emitters.push(emitter);

      const reason = preferUnderfloor
        ? `${Math.round(intensity)} W/m² is more than a floor can give at a comfortable surface temperature, so this room gets a radiator instead.`
        : spot
          ? 'On the clearest exterior wall, under a window where there is one.'
          : 'No clear wall found; placed in the middle of the room for you to move.';

      layout.sized.push({
        emitter,
        roomName: room.roomName,
        requiredWatts: room.heatingTotal,
        providedWatts: provided,
        wantedLength: Number.isFinite(wanted) ? wanted : 0,
        adequate: provided >= room.heatingTotal * 0.98,
        reason,
      });
    }
  }

  /* ---- The caveats that travel with all of it ---- */

  layout.assumptions.push(
    `Sized at ${regime.name}. ${regime.note}`,
  );

  const short = layout.sized.filter((sized) => !sized.adequate);
  if (short.length > 0) {
    layout.assumptions.push(
      `${short.length} room${short.length === 1 ? '' : 's'} cannot fit a radiator big enough at this flow temperature. Either raise the flow temperature, use two radiators, or insulate the room better.`,
    );
  }

  if (layout.emitters.length === 0) {
    layout.assumptions.push('No room came out with a heating load, so nothing was placed.');
  }

  layout.assumptions.push(
    'Pipe sizes, pump duty and the balancing of the circuit are not designed here. Neither is cooling: a wet system does not cool, and adding cooling to one means condensation on cold pipework, which is its own design problem.',
  );

  return layout;
}

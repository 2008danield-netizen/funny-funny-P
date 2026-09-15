/**
 * Manual J: how much heat this building loses, and gains, room by room.
 *
 * -----------------------------------------------------------------------------
 * EVERYTHING ELSE DEPENDS ON THIS NUMBER.
 *
 * The equipment is chosen from it, the ducts are sized from it, the electrical
 * service calculation asks for it. Get it wrong and every one of those is wrong
 * in the same direction, which is why this file is written to be arguable with:
 * every component of the load is kept separately and reported separately, so a
 * figure that looks wrong can be traced to the surface that produced it.
 *
 * -----------------------------------------------------------------------------
 * HEATING AND COOLING ARE NOT THE SAME CALCULATION.
 *
 * This trips people up constantly, and the two halves of this file look
 * different for real reasons.
 *
 * HEATING is simple and pessimistic. It is the coldest hour of the year, at
 * night, in the dark. No sun, nobody home, nothing switched on — because the
 * heating has to work on the night nobody is cooking. So it is conduction
 * through the surfaces plus the cold air leaking in, and nothing else.
 *
 * COOLING is complicated and has to be optimistic in places. It is a summer
 * afternoon, so the sun is pouring through the windows, the people and the
 * appliances are adding heat, and the humidity has to be removed as well as
 * the heat. And crucially the peak does not happen at the same moment for every
 * surface: a west window peaks at five, a roof peaks at two. Manual J handles
 * this with equivalent temperature differences rather than by simulating hour
 * by hour, and so does this.
 *
 * -----------------------------------------------------------------------------
 * SENSIBLE AND LATENT.
 *
 * Sensible heat changes the temperature. Latent heat changes the humidity —
 * the energy it takes to condense the moisture out of the air. A cooling system
 * has to do both, and they are sized separately, because a coil that has the
 * capacity but the wrong split leaves a house cold and clammy.
 *
 * Heating has no latent component here. Humidification is a separate machine
 * and a separate decision.
 */

import {
  INDOOR_DESIGN,
  INFILTRATION,
  INTERNAL_GAINS,
  LATENT_AIR_FACTOR,
  SENSIBLE_AIR_FACTOR,
  SOLAR_GAIN,
  altitudeFactor,
  btuToWatts,
  findConditions,
  orientationOf,
  type DesignConditions,
} from '@/code/acca';
import {
  DOOR_TYPES,
  FLOOR_ASSEMBLIES,
  GLAZING,
  ROOF_ASSEMBLIES,
  WALL_ASSEMBLIES,
  getAssembly,
  getGlazing,
  rToU,
  type Assembly,
  type GlazingType,
} from '@/code/iecc';
import { findRegions, resolveWall, indexVertices, type Region } from '@/scene/planGraph';
import { roomWalls } from '@/advisor/geometry';
import { resolveRoomSpec } from '@/state/planOps';
import { roomPurpose } from './rooms';
import type { DesignDocument, Level } from '@/state/types';

/* ------------------------------- The result ------------------------------- */

/** Where one room's load comes from. Every term kept, so it can be argued with. */
export interface RoomLoad {
  levelId: string;
  levelName: string;
  roomKey: string;
  roomName: string;
  /** Floor area, m². */
  area: number;
  /** Volume, m³ — what the infiltration acts on. */
  volume: number;

  /* ---- Heating, all in watts ---- */
  heatingWalls: number;
  heatingWindows: number;
  heatingDoors: number;
  heatingRoof: number;
  heatingFloor: number;
  heatingInfiltration: number;
  /** The total the heating has to cover. */
  heatingTotal: number;

  /* ---- Cooling, watts ---- */
  coolingWalls: number;
  coolingWindows: number;
  /** Sun through the glass, which is usually the biggest single term. */
  coolingSolar: number;
  coolingRoof: number;
  coolingInfiltration: number;
  coolingInternal: number;
  /** Everything that changes the temperature. */
  coolingSensible: number;
  /** Everything that changes the humidity. */
  coolingLatent: number;
  coolingTotal: number;

  /*
   * There is deliberately no airflow figure here.
   *
   * Airflow is not a property of the load — it is the load divided by what the
   * chosen blower moves, so it cannot be known until the equipment is chosen,
   * and a room's share of the air changes the moment a different machine is
   * selected. It lives in `ductSize.ts`, where the equipment is in scope.
   */
}

export interface BuildingLoad {
  /** Null when no design location has been chosen; nothing can be computed. */
  conditions: DesignConditions | null;
  rooms: RoomLoad[];

  heatingTotal: number;
  coolingSensible: number;
  coolingLatent: number;
  coolingTotal: number;

  /** Conditioned floor area, m². */
  floorArea: number;
  /** Bedrooms, which drives occupancy and ventilation. */
  bedrooms: number;

  /**
   * What had to be assumed to get here.
   *
   * Never empty in practice. The envelope starts as five defaults and the load
   * is only as good as they are, so this list is the honest caveat that travels
   * with the number wherever it is shown.
   */
  assumptions: string[];
}

/* ------------------------------ The envelope ------------------------------ */

/** The assemblies the document names, resolved, with fallbacks. */
interface ResolvedEnvelope {
  wall: Assembly;
  roof: Assembly;
  floor: Assembly;
  glazing: GlazingType;
  door: GlazingType;
  winterAch: number;
  summerAch: number;
}

function resolveEnvelope(doc: DesignDocument): ResolvedEnvelope {
  const spec = doc.hvac.envelope;
  const infiltration =
    INFILTRATION.find((entry) => entry.id === spec.infiltrationId) ?? INFILTRATION[1]!;

  return {
    wall: getAssembly(WALL_ASSEMBLIES, spec.wallAssemblyId) ?? WALL_ASSEMBLIES[2]!,
    roof: getAssembly(ROOF_ASSEMBLIES, spec.roofAssemblyId) ?? ROOF_ASSEMBLIES[2]!,
    floor: getAssembly(FLOOR_ASSEMBLIES, spec.floorAssemblyId) ?? FLOOR_ASSEMBLIES[0]!,
    glazing: getGlazing(spec.glazingId) ?? GLAZING[2]!,
    door: getGlazing(spec.doorId) ?? DOOR_TYPES[1]!,
    winterAch: infiltration.winterAch,
    summerAch: infiltration.summerAch,
  };
}

/* -------------------------- Equivalent differences ------------------------ */

/**
 * The temperature difference a surface behaves as if it had, in cooling.
 *
 * Not the same as the actual indoor-to-outdoor difference, and this is the part
 * of Manual J that most surprises people. A roof in full sun reaches far above
 * the air temperature, so it conducts heat inward as though it were much hotter
 * outside than it is. A shaded north wall behaves as though it were cooler.
 *
 * These are Manual J's Table 4 CLTD values, condensed. Using the plain air
 * temperature difference instead would underestimate the roof by a factor of
 * two and produce an air conditioner that cannot hold the house on a sunny day.
 */
function coolingEquivalentDifference(
  surface: 'wall' | 'roof' | 'glass',
  conditions: DesignConditions,
): number {
  const airDifference = conditions.summerDryBulb - INDOOR_DESIGN.coolingF;

  /*
   * The daily range correction. A place that swings 35°F overnight has cooled
   * its own building fabric down by morning, so the fabric absorbs part of the
   * afternoon's heat instead of passing it inside.
   */
  const rangeAdjust =
    conditions.dailyRange === 'high' ? -3 : conditions.dailyRange === 'low' ? 3 : 0;

  switch (surface) {
    case 'roof':
      // A sunlit roof runs far hotter than the air around it.
      return airDifference + 30 + rangeAdjust;
    case 'wall':
      return airDifference + 8 + rangeAdjust;
    case 'glass':
      // Glass has no mass to speak of, so it tracks the air.
      return airDifference + rangeAdjust;
  }
}

/* --------------------------------- The walk ------------------------------- */

/**
 * Computes the load for the whole building.
 *
 * Walks every room of every storey, and for each one measures its exterior
 * walls, the glazing in them, the roof above it if it is on the top floor, and
 * the floor below it if it is on the bottom. An interior wall between two
 * heated rooms conducts nothing on balance and is skipped — which is why the
 * walls are taken from the ROOM rather than from the plan.
 */
export function calculateLoad(doc: DesignDocument): BuildingLoad {
  const conditions = findConditions(doc.hvac.locationKey);
  const assumptions: string[] = [];

  if (!conditions) {
    return {
      conditions: null,
      rooms: [],
      heatingTotal: 0,
      coolingSensible: 0,
      coolingLatent: 0,
      coolingTotal: 0,
      floorArea: 0,
      bedrooms: 0,
      assumptions: [
        'No design location has been chosen, so no load can be computed. Pick the nearest city — the outdoor design temperature is the single number the whole calculation rests on, and there is no sensible default for it.',
      ],
    };
  }

  const envelope = resolveEnvelope(doc);
  const rooms: RoomLoad[] = [];

  const heatingDelta = INDOOR_DESIGN.heatingF - conditions.winterDryBulb;
  const bedrooms = countBedrooms(doc);
  const topLevelId = doc.levels[doc.levels.length - 1]?.id;
  const bottomLevelId = doc.levels[0]?.id;

  // Air is thinner high up and carries less heat; Denver needs more of it.
  const altitude = altitudeFactor(doc.site.terrain.datum);

  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      const load = roomLoad(
        doc,
        level,
        region,
        spec.name,
        envelope,
        conditions,
        heatingDelta,
        level.id === topLevelId,
        level.id === bottomLevelId,
        altitude,
      );
      rooms.push(load);
    }
  }

  const total = <K extends keyof RoomLoad>(key: K): number =>
    rooms.reduce((sum, room) => sum + (room[key] as number), 0);

  const floorArea = total('area');
  const heatingTotal = total('heatingTotal');
  const coolingSensible = total('coolingSensible');
  const coolingLatent = total('coolingLatent');

  /* ---- What the user needs to know they are trusting ---- */

  if (!doc.hvac.envelope.confirmed) {
    assumptions.push(
      `The envelope is still the app’s defaults — ${envelope.wall.label.toLowerCase()}, ${envelope.roof.label.toLowerCase()}, ${envelope.glazing.label.toLowerCase()}. The load is only as good as those. Confirm what the house is actually built of before anybody orders equipment.`,
    );
  }

  assumptions.push(
    `Design conditions for ${conditions.city}, ${conditions.state}: ${conditions.winterDryBulb}°F winter, ${conditions.summerDryBulb}°F summer. Those are the 99% and 1% values, not record extremes — sizing to the coldest night ever recorded would oversize the system for every other hour of the year.`,
  );

  if (rooms.length === 0) {
    assumptions.push('No enclosed rooms were found, so there was nothing to compute a load for.');
  }

  return {
    conditions,
    rooms,
    heatingTotal,
    coolingSensible,
    coolingLatent,
    coolingTotal: coolingSensible + coolingLatent,
    floorArea,
    bedrooms,
    assumptions,
  };
}

/* ------------------------------- One room --------------------------------- */

function roomLoad(
  doc: DesignDocument,
  level: Level,
  region: Region,
  roomName: string,
  envelope: ResolvedEnvelope,
  conditions: DesignConditions,
  heatingDelta: number,
  isTopFloor: boolean,
  isBottomFloor: boolean,
  altitude: number,
): RoomLoad {
  const area = areaOf(region.polygon);
  const volume = area * level.wallHeight;

  const wallU = rToU(envelope.wall.effectiveR);
  const roofU = rToU(envelope.roof.effectiveR);
  const floorU = rToU(envelope.floor.effectiveR);

  let heatingWalls = 0;
  let heatingWindows = 0;
  let heatingDoors = 0;
  let coolingWalls = 0;
  let coolingWindows = 0;
  let coolingSolar = 0;

  const wallCltd = coolingEquivalentDifference('wall', conditions);
  const glassCltd = coolingEquivalentDifference('glass', conditions);

  const vertices = indexVertices(level.plan);

  for (const wall of roomWalls(level.plan, region)) {
    /*
     * Only EXTERIOR walls count. A wall between two heated rooms has the same
     * temperature on both sides and conducts nothing on balance; including it
     * would roughly double the load of an interior room and produce a system
     * far too big.
     */
    if (!isExteriorWall(level, wall.wallId)) continue;

    const grossArea = wall.length * level.wallHeight;

    // Openings come out of the wall and are counted at their own U-factor.
    let glazedArea = 0;
    let doorArea = 0;

    const planWall = level.plan.walls.find((candidate) => candidate.id === wall.wallId);
    const segment = planWall ? resolveWall(planWall, vertices) : null;

    for (const opening of planWall?.openings ?? []) {
      const openingArea = opening.width * opening.height;
      if (opening.kind === 'window') glazedArea += openingArea;
      else doorArea += openingArea;
    }

    const opaqueArea = Math.max(0, grossArea - glazedArea - doorArea);

    /* ---- Heating: conduction, in watts ---- */
    heatingWalls += conduction(opaqueArea, wallU, heatingDelta);
    heatingWindows += conduction(glazedArea, envelope.glazing.uFactor, heatingDelta);
    heatingDoors += conduction(doorArea, envelope.door.uFactor, heatingDelta);

    /* ---- Cooling: conduction at the equivalent difference ---- */
    coolingWalls += conduction(opaqueArea, wallU, wallCltd);
    coolingWindows += conduction(glazedArea, envelope.glazing.uFactor, glassCltd);

    /* ---- Cooling: sun through the glass ---- */
    if (glazedArea > 0 && segment) {
      /*
       * Which way the glass faces decides everything here. West is the worst
       * by a wide margin: not because more sun falls on it, but because it
       * arrives at five in the afternoon when the air is already at its
       * hottest and the building has been warming all day.
       */
      const outward = { x: -wall.inward.x, z: -wall.inward.z };
      const facing = orientationOf(outward.x, outward.z, doc.site.northAngle);
      const gainPerSqFt = SOLAR_GAIN[facing] ?? SOLAR_GAIN.south!;

      /*
       * The table is on an SHGC = 1.0 basis, so multiplying by the glazing's
       * own coefficient here is the whole of the correction — no second
       * discount for the glass type, which is what made this half the right
       * answer the first time.
       */
      const glazedSqFt = glazedArea / 0.092903;
      coolingSolar += btuToWatts(glazedSqFt * gainPerSqFt * envelope.glazing.solarHeatGain);
    }
  }

  /* ---- Roof and floor ---- */
  const roofCltd = coolingEquivalentDifference('roof', conditions);
  const heatingRoof = isTopFloor ? conduction(area, roofU, heatingDelta) : 0;
  const coolingRoof = isTopFloor ? conduction(area, roofU, roofCltd) : 0;

  /*
   * A slab loses heat round its PERIMETER rather than through its area — the
   * ground under the middle of a slab sits at close to room temperature after
   * a season, while the edge is a few inches from outdoor air. Treating a slab
   * as an area with a U-factor is the classic way to get a wildly wrong figure.
   */
  const heatingFloor = isBottomFloor
    ? envelope.floor.id.startsWith('floor-slab')
      ? slabPerimeterLoss(region, envelope.floor, heatingDelta)
      : conduction(area, floorU, heatingDelta)
    : 0;

  /* ---- Infiltration ---- */
  const volumeCubicFeet = volume / 0.0283168;
  const heatingCfm = (volumeCubicFeet * envelope.winterAch) / 60;
  const coolingInfiltrationCfm = (volumeCubicFeet * envelope.summerAch) / 60;

  const heatingInfiltration = btuToWatts(
    heatingCfm * SENSIBLE_AIR_FACTOR * heatingDelta * altitude,
  );
  const coolingInfiltration = btuToWatts(
    coolingInfiltrationCfm *
      SENSIBLE_AIR_FACTOR *
      (conditions.summerDryBulb - INDOOR_DESIGN.coolingF) *
      altitude,
  );

  /* ---- Internal gains: summer only ---- */
  const purpose = roomPurpose(roomName);
  const areaSqFt = area / 0.092903;
  let internalSensible = btuToWatts(areaSqFt * INTERNAL_GAINS.perSquareFoot);
  let internalLatent = 0;

  if (purpose === 'kitchen') {
    internalSensible += btuToWatts(INTERNAL_GAINS.kitchenSensible);
    internalLatent += btuToWatts(INTERNAL_GAINS.kitchenLatent);
  }

  /*
   * Occupants. Manual J puts them where they actually are rather than spreading
   * them evenly: two in each bedroom, the rest in the living space. A bedroom
   * at three in the afternoon is empty, but the load is sized for the peak the
   * ROOM sees, and a bedroom's peak is at night.
   */
  const people = purpose === 'bedroom' ? 2 : purpose === 'living' ? 2 : 0;
  internalSensible += btuToWatts(people * INTERNAL_GAINS.perPersonSensible);
  internalLatent += btuToWatts(people * INTERNAL_GAINS.perPersonLatent);

  /* ---- Latent from the air coming in ---- */
  const grainsDifference = humidityDifference(conditions);
  const coolingLatent =
    btuToWatts(coolingInfiltrationCfm * LATENT_AIR_FACTOR * grainsDifference * altitude) +
    internalLatent;

  const heatingTotal =
    heatingWalls + heatingWindows + heatingDoors + heatingRoof + heatingFloor + heatingInfiltration;

  const coolingSensible =
    coolingWalls + coolingWindows + coolingSolar + coolingRoof + coolingInfiltration + internalSensible;

  return {
    levelId: level.id,
    levelName: level.name,
    roomKey: region.key,
    roomName,
    area,
    volume,
    heatingWalls,
    heatingWindows,
    heatingDoors,
    heatingRoof,
    heatingFloor,
    heatingInfiltration,
    heatingTotal,
    coolingWalls,
    coolingWindows,
    coolingSolar,
    coolingRoof,
    coolingInfiltration,
    coolingInternal: internalSensible,
    coolingSensible,
    coolingLatent,
    coolingTotal: coolingSensible + coolingLatent,
  };
}

/* -------------------------------- Helpers --------------------------------- */

/** Conduction through an area, in watts. U is in BTU/h·ft²·°F, area in m². */
function conduction(areaM2: number, u: number, deltaF: number): number {
  const areaSqFt = areaM2 / 0.092903;
  return btuToWatts(areaSqFt * u * deltaF);
}

/**
 * A slab's heat loss, which is per metre of exposed edge, not per square metre.
 *
 * The ground under the middle of a slab reaches close to room temperature after
 * a season and stops taking heat. The edge never does — it is inches from
 * outdoor air. So the loss scales with perimeter, and F-factors (BTU/h per foot
 * of perimeter per °F) are what the industry uses.
 */
function slabPerimeterLoss(region: Region, floor: Assembly, deltaF: number): number {
  let perimeter = 0;
  const polygon = region.polygon;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    perimeter += Math.hypot(b.x - a.x, b.z - a.z);
  }

  // F-factor: 0.73 uninsulated, about 0.54 with R-10 edge insulation.
  const fFactor = floor.effectiveR > 5 ? 0.54 : 0.73;
  const perimeterFeet = perimeter / 0.3048;
  return btuToWatts(perimeterFeet * fFactor * deltaF);
}

/**
 * How much more moisture is in the outdoor air than we want indoors, in grains
 * per pound.
 *
 * A rough psychrometric estimate from the wet-bulb depression rather than a
 * full chart lookup. It is the term that decides how much of the cooling duty
 * is dehumidification, and in a humid climate that is a third of the total —
 * which is exactly why an oversized air conditioner leaves a house clammy.
 */
function humidityDifference(conditions: DesignConditions): number {
  const depression = conditions.summerDryBulb - conditions.summerWetBulb;
  // Outdoor humidity ratio rises as the wet bulb approaches the dry bulb.
  const outdoorGrains = Math.max(30, 130 - depression * 4.5);
  // Indoors at 75°F and 50% RH is about 65 grains per pound.
  const indoorGrains = 65;
  return Math.max(0, outdoorGrains - indoorGrains);
}

/**
 * Whether a wall separates this room from outdoors.
 *
 * A wall with a room on both sides is interior. `findRegions` gives every
 * enclosed space, so a wall shared by two of them is internal by definition —
 * which is more reliable than trying to trace the building outline, and it
 * handles a garage or a porch correctly without special-casing them.
 */
export function isExteriorWall(level: Level, wallId: string): boolean {
  let count = 0;
  for (const region of findRegions(level.plan)) {
    if (region.wallIds.includes(wallId)) count += 1;
    if (count > 1) return false;
  }
  return true;
}

function areaOf(polygon: readonly { x: number; z: number }[]): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    total += a.x * b.z - b.x * a.z;
  }
  return Math.abs(total) / 2;
}

/** Bedrooms in the building, for occupancy and the ventilation rate. */
export function countBedrooms(doc: DesignDocument): number {
  let count = 0;
  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      if (roomPurpose(spec.name) === 'bedroom') count += 1;
    }
  }
  return count;
}

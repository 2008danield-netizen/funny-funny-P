/**
 * Manual S: which machine to buy, given the load Manual J produced.
 *
 * -----------------------------------------------------------------------------
 * THE ONE THING THIS FILE EXISTS TO PREVENT.
 *
 * Equipment gets oversized. Almost always, and almost always deliberately —
 * the installer would rather be called out for a house that is too cold than
 * one that is too warm, and a bigger unit is a bigger invoice. The result is
 * the single most common defect in residential HVAC, and it is worth being
 * precise about why it is a defect rather than merely wasteful:
 *
 *   A furnace that is too big short-cycles. It fires, satisfies the
 *   thermostat in four minutes, and stops — never reaching steady state, so
 *   it spends its life in the least efficient part of its own operation, and
 *   the rooms furthest from it never get their share before it shuts off.
 *
 *   An air conditioner that is too big is worse, because cooling has a second
 *   job. Removing humidity happens at the coil, and only once the coil has
 *   been cold and wet for a while. A unit that satisfies the thermostat in
 *   six minutes never gets there. The house ends up at 74°F and 65% relative
 *   humidity, which feels clammy and unpleasant, and the owner's instinct is
 *   to turn the thermostat DOWN — making it worse. This is why a house with
 *   an oversized air conditioner feels bad in a way the owner usually cannot
 *   name.
 *
 * So the sizing windows here are narrow on purpose and the app says when it
 * cannot hit them, rather than rounding up quietly.
 *
 * -----------------------------------------------------------------------------
 * WHY HEATING AND COOLING GET DIFFERENT WINDOWS.
 *
 * Heating may go to 140% of the load. Cooling may go to 115% and no further,
 * and may not go below 90%. The asymmetry is entirely about that second job:
 * an oversized furnace is inefficient, an oversized coil is uncomfortable.
 *
 * -----------------------------------------------------------------------------
 * THE BALANCE POINT.
 *
 * A heat pump pulls heat out of the outdoor air, so the colder it gets the
 * less it can pull — exactly as the building needs more. Capacity falls with
 * temperature and the load rises with it, and the two lines cross. Above the
 * crossing the heat pump carries the house alone; below it, something else
 * has to make up the difference.
 *
 * That crossing is the balance point, and it is computable rather than
 * guessable, because both lines are straight over this range. This file
 * computes it, and sizes the backup from what is missing at the coldest hour.
 * A heat pump specified without knowing its balance point is a house that
 * runs on emergency resistance heat all winter and produces an electricity
 * bill nobody was warned about.
 */

import {
  AIRFLOW,
  EQUIPMENT,
  INDOOR_DESIGN,
  SIZING_LIMITS,
  TON_BTU,
  equipmentOfKind,
  getEquipment,
  heatPumpCapacity,
  ventilationCfm,
  wattsToBtu,
  type DesignConditions,
  type EquipmentKind,
  type EquipmentModel,
} from '@/code/acca';
import type { BuildingLoad } from './manualJ';
import type { HvacSystemKind } from '@/state/types';

/* --------------------------------- Results -------------------------------- */

/** One piece of equipment, and how it measures against the load. */
export interface EquipmentChoice {
  model: EquipmentModel;
  /** What the building asked for, BTU/h. */
  requiredBtu: number;
  /** What this machine delivers at design conditions, BTU/h. */
  providedBtu: number;
  /** Provided divided by required. The number Manual S constrains. */
  fraction: number;
  /** Whether that fraction sits inside the Manual S window. */
  withinLimits: boolean;
  /** The window it was measured against. */
  section: string;
  asWritten: string;
  /** Why this one, in a sentence, for the panel and the schedule. */
  reason: string;
}

/**
 * Where a heat pump stops being able to do the job on its own.
 *
 * `outdoorF` at or below the winter design temperature means the pump covers
 * the whole winter unaided and no backup is needed — rare outside a mild
 * climate, and worth saying explicitly when it happens.
 */
export interface BalancePoint {
  /** Outdoor temperature, °F, where capacity and load are equal. */
  outdoorF: number;
  /** What the pump is short by at the winter design temperature, BTU/h. */
  supplementalBtu: number;
  /** That shortfall as electric resistance heat, kW. */
  supplementalKw: number;
  /** True when the pump alone covers the design condition. */
  coversDesignDay: boolean;
}

/** How the cooling capacity splits, which is a separate Manual S check. */
export interface LatentCheck {
  sensibleRequiredBtu: number;
  sensibleProvidedBtu: number;
  latentRequiredBtu: number;
  latentProvidedBtu: number;
  sensibleAdequate: boolean;
  latentAdequate: boolean;
}

export interface SystemSelection {
  system: HvacSystemKind;
  heating: EquipmentChoice | null;
  cooling: EquipmentChoice | null;
  balancePoint: BalancePoint | null;
  latent: LatentCheck | null;

  /** Design airflow the ducts have to carry, cfm. Manual D starts here. */
  supplyCfm: number;
  /** Outdoor air the house needs continuously, cfm. */
  ventilationCfm: number;

  /** Connected load, watts, for the electrical service calculation. */
  heatingWatts: number;
  coolingWatts: number;

  /** Everything the reader should know before ordering anything. */
  notes: string[];
}

/* ------------------------------- Selection -------------------------------- */

/**
 * The smallest unit that covers the heating load without exceeding the window.
 *
 * "Smallest that covers it" rather than "closest to it", because undersizing
 * heating means the house does not reach temperature on the coldest night,
 * which is a failure rather than a compromise. Equipment comes in steps, so
 * the answer is usually somewhat above the load; the window is what stops
 * "somewhat" becoming "double".
 */
function selectHeating(
  kind: EquipmentKind,
  requiredBtu: number,
): { model: EquipmentModel; withinLimits: boolean } | null {
  const catalogue = equipmentOfKind(kind);
  if (catalogue.length === 0) return null;

  const ceiling = requiredBtu * SIZING_LIMITS.heating.maxFraction;

  const inWindow = catalogue.find(
    (model) => model.heatingBtu >= requiredBtu && model.heatingBtu <= ceiling,
  );
  if (inWindow) return { model: inWindow, withinLimits: true };

  /*
   * Nothing fits. Two ways that happens, and they want opposite answers.
   *
   * A very small load falls below the smallest machine made — a well-insulated
   * flat can want 12,000 BTU/h when the smallest furnace is 38,000. Take the
   * smallest and flag it; there is nothing else to take.
   *
   * A very large load exceeds the biggest machine. Take the biggest and flag
   * it, because the real answer is two units and this app does not zone.
   */
  const covering = catalogue.find((model) => model.heatingBtu >= requiredBtu);
  if (covering) return { model: covering, withinLimits: false };
  return { model: catalogue[catalogue.length - 1]!, withinLimits: false };
}

/**
 * Cooling, which is chosen against a two-sided window and a split.
 *
 * Manual S wants three things at once: total capacity between 90% and 115% of
 * the total load, sensible capacity at least the sensible load, and latent
 * capacity at least the latent load. They can conflict — a dry climate has
 * almost no latent load and a humid one has a great deal — so the search is
 * ordered rather than filtered: prefer a unit that satisfies all three, fall
 * back to one that satisfies the window, and flag whatever is left.
 */
function selectCooling(
  kind: EquipmentKind,
  totalBtu: number,
  sensibleBtu: number,
  latentBtu: number,
): { model: EquipmentModel; withinLimits: boolean } | null {
  const catalogue = equipmentOfKind(kind).filter((model) => model.coolingBtu > 0);
  if (catalogue.length === 0) return null;

  const floor = totalBtu * SIZING_LIMITS.cooling.minFraction;
  const ceiling = totalBtu * SIZING_LIMITS.cooling.maxFraction;

  const inWindow = catalogue.filter(
    (model) => model.coolingBtu >= floor && model.coolingBtu <= ceiling,
  );

  const complete = inWindow.find(
    (model) =>
      model.coolingBtu * model.sensibleHeatRatio >= sensibleBtu &&
      model.coolingBtu * (1 - model.sensibleHeatRatio) >= latentBtu,
  );
  if (complete) return { model: complete, withinLimits: true };

  // In the window but with the wrong split. Still a legal selection; the
  // latent check reports the shortfall rather than hiding it in the choice.
  const windowed = inWindow[0];
  if (windowed) return { model: windowed, withinLimits: true };

  const covering = catalogue.find((model) => model.coolingBtu >= floor);
  if (covering) return { model: covering, withinLimits: false };
  return { model: catalogue[catalogue.length - 1]!, withinLimits: false };
}

/**
 * Where the heat pump's capacity line crosses the building's load line.
 *
 * Both are straight over this range, so this is algebra rather than a search.
 *
 *   capacity(T) = c17 + (T - 17) · slope,  slope = (c47 − c17) / 30
 *   load(T)     = Q · (indoor − T) / (indoor − designT)
 *
 * The load line is the honest part: the design load Q is the load at ONE
 * temperature, and heat flows in proportion to the difference, so the load at
 * any other temperature is a straight line through the indoor temperature —
 * where, by definition, there is no load at all.
 */
export function balancePointOf(
  model: EquipmentModel,
  designHeatingBtu: number,
  conditions: DesignConditions,
): BalancePoint {
  const indoor = INDOOR_DESIGN.heatingF;
  const designT = conditions.winterDryBulb;

  const slope =
    model.capacityAt17F === undefined ? 0 : (model.heatingBtu - model.capacityAt17F) / (47 - 17);
  const c17 = model.capacityAt17F ?? model.heatingBtu;

  // Watts of load per degree of temperature difference.
  const perDegree = indoor > designT ? designHeatingBtu / (indoor - designT) : 0;

  const outdoorF =
    slope + perDegree === 0
      ? designT
      : (indoor * perDegree - c17 + 17 * slope) / (slope + perDegree);

  const atDesign = heatPumpCapacity(model, designT);
  const supplementalBtu = Math.max(0, designHeatingBtu - atDesign);

  return {
    outdoorF,
    supplementalBtu,
    // 3412 BTU/h per kW is the definition of electric resistance heat: all of
    // the electricity becomes heat, which is why backup strips are simple and
    // expensive to run.
    supplementalKw: supplementalBtu / 3412,
    coversDesignDay: supplementalBtu <= 1,
  };
}

/* --------------------------------- Driver --------------------------------- */

/**
 * Choose the equipment for this building.
 *
 * Derived, not stored — called fresh every time anything is asked of it, so
 * that adding a window re-sizes the furnace. The document only remembers a
 * selection when the user has overridden it by hand.
 */
export function selectSystem(
  load: BuildingLoad,
  system: HvacSystemKind,
  override?: { heatingEquipmentId: string | null; coolingEquipmentId: string | null },
): SystemSelection {
  const notes: string[] = [];
  const floorSqFt = load.floorArea / 0.092903;

  const empty: SystemSelection = {
    system,
    heating: null,
    cooling: null,
    balancePoint: null,
    latent: null,
    supplyCfm: 0,
    ventilationCfm: floorSqFt > 0 ? ventilationCfm(floorSqFt, load.bedrooms) : 0,
    heatingWatts: 0,
    coolingWatts: 0,
    notes,
  };

  if (!load.conditions) {
    notes.push('No design location chosen, so there is no load to select against.');
    return empty;
  }
  if (system === 'load-only') {
    notes.push('Load calculation only — no equipment has been selected.');
    return empty;
  }
  if (load.rooms.length === 0) {
    notes.push('No enclosed rooms found, so there is nothing to heat or cool.');
    return empty;
  }

  const heatingBtu = wattsToBtu(load.heatingTotal);
  const sensibleBtu = wattsToBtu(load.coolingSensible);
  const latentBtu = wattsToBtu(load.coolingLatent);
  const coolingBtu = wattsToBtu(load.coolingTotal);

  /*
   * Which catalogue each system draws from.
   *
   * A heat pump and a mini-split are one machine doing both jobs, so the same
   * model appears as both the heating and the cooling selection — which is
   * exactly why they are sized on the COOLING load and topped up in winter,
   * rather than sized on heating and left oversized all summer.
   */
  const heatingKind: EquipmentKind | null =
    system === 'forced-air' ? 'furnace'
    : system === 'heat-pump' ? 'heat-pump'
    : system === 'mini-split' ? 'mini-split'
    : 'boiler';

  const coolingKind: EquipmentKind | null =
    system === 'forced-air' ? 'air-conditioner'
    : system === 'heat-pump' ? 'heat-pump'
    : system === 'mini-split' ? 'mini-split'
    : null;

  let heating: EquipmentChoice | null = null;
  let cooling: EquipmentChoice | null = null;

  const manualHeating = override?.heatingEquipmentId
    ? getEquipment(override.heatingEquipmentId)
    : null;
  const manualCooling = override?.coolingEquipmentId
    ? getEquipment(override.coolingEquipmentId)
    : null;

  if (coolingKind) {
    const picked = manualCooling
      ? { model: manualCooling, withinLimits: false }
      : selectCooling(coolingKind, coolingBtu, sensibleBtu, latentBtu);

    if (picked) {
      const fraction = coolingBtu > 0 ? picked.model.coolingBtu / coolingBtu : 0;
      const within =
        fraction >= SIZING_LIMITS.cooling.minFraction &&
        fraction <= SIZING_LIMITS.cooling.maxFraction;

      cooling = {
        model: picked.model,
        requiredBtu: coolingBtu,
        providedBtu: picked.model.coolingBtu,
        fraction,
        withinLimits: within,
        section: SIZING_LIMITS.cooling.section,
        asWritten: SIZING_LIMITS.cooling.asWritten,
        reason: manualCooling
          ? 'Chosen by hand, so the automatic selection is not being applied.'
          : within
            ? `${Math.round(fraction * 100)}% of the cooling load, inside the 90–115% window.`
            : `${Math.round(fraction * 100)}% of the cooling load — nothing in the catalogue lands inside 90–115%.`,
      };
    }
  }

  if (heatingKind) {
    /*
     * A heat pump is chosen by its cooling selection, not sized again on
     * heating. Sizing it on the heating load in a cold climate gives a unit
     * that is enormously oversized for the summer, and summer is where the
     * comfort penalty lives.
     */
    const shared =
      (system === 'heat-pump' || system === 'mini-split') && cooling ? cooling.model : null;

    const picked = manualHeating
      ? { model: manualHeating, withinLimits: false }
      : shared
        ? { model: shared, withinLimits: true }
        : selectHeating(heatingKind, heatingBtu);

    if (picked) {
      const provided = picked.model.heatingBtu;
      const fraction = heatingBtu > 0 ? provided / heatingBtu : 0;

      const limit = shared ? SIZING_LIMITS.heatPumpHeating : SIZING_LIMITS.heating;
      const within = shared
        ? true // A heat pump under its load is expected; the backup covers it.
        : fraction >= 1 && fraction <= SIZING_LIMITS.heating.maxFraction;

      heating = {
        model: picked.model,
        requiredBtu: heatingBtu,
        providedBtu: provided,
        fraction,
        withinLimits: within,
        section: limit.section,
        asWritten: limit.asWritten,
        reason: manualHeating
          ? 'Chosen by hand, so the automatic selection is not being applied.'
          : shared
            ? 'Sized on the cooling load, with backup heat below the balance point.'
            : within
              ? `${Math.round(fraction * 100)}% of the heating load, inside the 140% ceiling.`
              : fraction < 1
                ? `${Math.round(fraction * 100)}% of the heating load — the smallest unit made is still short.`
                : `${Math.round(fraction * 100)}% of the heating load, above the 140% ceiling.`,
      };
    }
  }

  /* ---- The balance point, for anything that gets its heat from the air ---- */

  let balancePoint: BalancePoint | null = null;
  if (heating && heating.model.capacityAt17F !== undefined) {
    balancePoint = balancePointOf(heating.model, heatingBtu, load.conditions);

    if (balancePoint.coversDesignDay) {
      notes.push(
        `The heat pump carries the house unaided down to ${Math.round(load.conditions.winterDryBulb)}°F, so no backup heat is needed for the design condition.`,
      );
    } else {
      notes.push(
        `Below ${Math.round(balancePoint.outdoorF)}°F the heat pump cannot keep up on its own. At the winter design temperature it is short by ${Math.round(balancePoint.supplementalBtu).toLocaleString()} BTU/h — about ${balancePoint.supplementalKw.toFixed(1)} kW of backup heat.`,
      );
    }
  }

  /* ---- The split, which is where a dry climate and a wet one differ ---- */

  let latent: LatentCheck | null = null;
  if (cooling) {
    const sensibleProvided = cooling.model.coolingBtu * cooling.model.sensibleHeatRatio;
    const latentProvided = cooling.model.coolingBtu * (1 - cooling.model.sensibleHeatRatio);

    latent = {
      sensibleRequiredBtu: sensibleBtu,
      sensibleProvidedBtu: sensibleProvided,
      latentRequiredBtu: latentBtu,
      latentProvidedBtu: latentProvided,
      sensibleAdequate: sensibleProvided >= sensibleBtu,
      latentAdequate: latentProvided >= latentBtu,
    };

    if (!latent.latentAdequate) {
      notes.push(
        'This unit cannot remove as much moisture as the climate puts in. The house will hold temperature but feel humid; a variable-speed unit or a separate dehumidifier is the usual answer.',
      );
    }
    if (!latent.sensibleAdequate) {
      notes.push(
        'Sensible capacity is below the sensible load, so the house will not hold temperature on the hottest afternoon even though total capacity looks adequate.',
      );
    }
  }

  /* ---- Airflow, which is what the ducts are then sized from ---- */

  let supplyCfm = 0;
  if (cooling) {
    supplyCfm = (cooling.model.coolingBtu / TON_BTU) * AIRFLOW.cfmPerTon;
  } else if (heating && system !== 'hydronic') {
    // Heating-only forced air: airflow comes from the furnace's temperature
    // rise instead, since there is no coil to keep wet.
    supplyCfm = heating.model.heatingBtu / (1.1 * AIRFLOW.typicalTemperatureRise);
  }

  if (system === 'hydronic') {
    supplyCfm = 0;
    notes.push(
      'A hydronic system moves water, not air, so it has no ducts and provides no cooling. Ventilation still has to come from somewhere.',
    );
  }

  const ventilation = floorSqFt > 0 ? ventilationCfm(floorSqFt, load.bedrooms) : 0;

  if (!load.rooms.some((room) => room.heatingTotal > 0)) {
    notes.push('Every room came out at zero load, which usually means the envelope is unset.');
  }

  return {
    system,
    heating,
    cooling,
    balancePoint,
    latent,
    supplyCfm,
    ventilationCfm: ventilation,
    heatingWatts: heating ? heating.model.watts : 0,
    /*
     * When one machine does both, its watts are counted once. Counting them
     * twice would inflate the electrical service by a whole condenser — and
     * the two loads are never simultaneous anyway, which is exactly the
     * assumption NEC 220.60 makes.
     */
    coolingWatts: cooling && cooling.model.id !== heating?.model.id ? cooling.model.watts : 0,
    notes,
  };
}

/** Every model this system kind could use, for the manual-override picker. */
export function alternativesFor(system: HvacSystemKind): EquipmentModel[] {
  switch (system) {
    case 'forced-air':
      return EQUIPMENT.filter(
        (model) => model.kind === 'furnace' || model.kind === 'air-conditioner',
      );
    case 'heat-pump':
      return EQUIPMENT.filter((model) => model.kind === 'heat-pump');
    case 'mini-split':
      return EQUIPMENT.filter((model) => model.kind === 'mini-split');
    case 'hydronic':
      return EQUIPMENT.filter((model) => model.kind === 'boiler');
    case 'load-only':
      return [];
  }
}

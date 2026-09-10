/**
 * ACCA Manual J, S and D — the numbers, with their sources.
 *
 * -----------------------------------------------------------------------------
 * WHAT THESE ARE.
 *
 * Three manuals from the Air Conditioning Contractors of America, and they are
 * a sequence rather than three separate things:
 *
 *   MANUAL J — how much heat the building loses in winter and gains in summer,
 *              room by room. Everything else depends on this number.
 *   MANUAL S — which piece of equipment to buy, given that load.
 *   MANUAL D — how big the ducts have to be to deliver it.
 *
 * They are referenced by the IRC (M1401.3) and by the IECC, so "sized to
 * Manual J" is not best practice, it is what the code asks for. The figures
 * below are from Manual J 8th edition abridged, Manual S 2nd edition and
 * Manual D 3rd edition.
 *
 * -----------------------------------------------------------------------------
 * THE MISTAKE THIS WHOLE MODULE EXISTS TO PREVENT: OVERSIZING.
 *
 * Nearly every system in a house is too big, because the usual method is a
 * rule of thumb — "500 square feet per ton" — and rules of thumb are written
 * conservatively so nobody gets a callback in a cold snap.
 *
 * An oversized system is not a safe choice. It short-cycles: it blasts, hits
 * the thermostat in four minutes, and shuts off. In heating that means
 * temperature swings and a furnace that wears out early. In cooling it is
 * worse, because a coil only removes humidity once it has run long enough to
 * get properly cold — so an oversized air conditioner leaves the house cold
 * and clammy, which is the exact complaint that makes people turn it down and
 * feel colder still.
 *
 * That is why Manual S caps how far above the load you may go, and why this
 * module treats oversizing as a finding rather than a safety margin.
 *
 * -----------------------------------------------------------------------------
 * UNITS.
 *
 * The manuals are in BTU per hour, °F, and cubic feet per minute, and those
 * are what a contractor's equipment is labelled in. The app stores metric
 * everywhere else, so conversions live here and every limit carries its
 * `asWritten` figure in the manual's own units.
 */

/* ------------------------------ Conversions ------------------------------- */

/** BTU/h to watts. */
export const btuToWatts = (btu: number): number => btu * 0.29307107;
/** Watts to BTU/h. */
export const wattsToBtu = (watts: number): number => watts / 0.29307107;

/** A temperature difference in °F to one in °C (a delta, not a reading). */
export const deltaFtoC = (fahrenheit: number): number => fahrenheit * (5 / 9);
export const deltaCtoF = (celsius: number): number => celsius * (9 / 5);

/** An absolute temperature. */
export const fahrenheitToCelsius = (f: number): number => ((f - 32) * 5) / 9;
export const celsiusToFahrenheit = (c: number): number => (c * 9) / 5 + 32;

/** Cubic feet per minute to litres per second. */
export const cfmToLitresPerSecond = (cfm: number): number => cfm * 0.4719474;
export const litresPerSecondToCfm = (lps: number): number => lps / 0.4719474;

/**
 * An R-value in the American unit to a U-value in W/m²K.
 *
 * R is written in h·ft²·°F/BTU and is the resistance; U is its reciprocal in
 * W/m²K. The two are used interchangeably in conversation and are not the same
 * quantity, which is a reliable source of errors — so the conversion is named
 * rather than inlined anywhere.
 */
export const rValueToU = (r: number): number => (r > 0 ? 1 / (r * 0.1761102) : 0);
export const uToRValue = (u: number): number => (u > 0 ? 1 / (u * 0.1761102) : 0);

/** One ton of cooling, the unit air conditioners are sold in. */
export const TON_BTU = 12000;

/* ------------------------- Outdoor design conditions ---------------------- */

/**
 * What the weather is assumed to do, for one place.
 *
 * These are not record extremes. Manual J sizes to the 99% winter and 1%
 * summer conditions — the temperature exceeded 99% and 1% of hours in a year.
 * Sizing to the actual record low would produce a system enormously oversized
 * for the other 8,750 hours, and that is the oversizing problem again.
 */
export interface DesignConditions {
  /** City name as ACCA lists it. */
  city: string;
  state: string;
  /** 99% winter dry bulb, °F. The temperature heating is sized to. */
  winterDryBulb: number;
  /** 1% summer dry bulb, °F. */
  summerDryBulb: number;
  /** 1% summer wet bulb, °F — how much moisture is in that hot air. */
  summerWetBulb: number;
  /**
   * Daily temperature range in summer: low, medium or high.
   *
   * Not decoration. A desert swings 35°F between night and day, so the building
   * coasts through the afternoon on the coolness stored in its mass; a humid
   * coast barely swings at all and the peak load is the whole day. Manual J
   * corrects the gain calculation by this.
   */
  dailyRange: 'low' | 'medium' | 'high';
  /** Degrees north, for the solar gain calculation. */
  latitude: number;
  /** IECC climate zone, which decides the envelope minimums. */
  climateZone: string;
}

/**
 * Design conditions for a spread of American cities.
 *
 * Not every city — a complete set is thousands of rows and a licensing
 * question. This is a spread wide enough that almost anybody can find somewhere
 * with the same climate within a hundred miles, and the UI says plainly that
 * the figures are for the city chosen and not for the user's own address.
 */
export const DESIGN_CONDITIONS: readonly DesignConditions[] = [
  { city: 'Anchorage', state: 'AK', winterDryBulb: -6, summerDryBulb: 71, summerWetBulb: 60, dailyRange: 'medium', latitude: 61.2, climateZone: '7' },
  { city: 'Phoenix', state: 'AZ', winterDryBulb: 37, summerDryBulb: 109, summerWetBulb: 71, dailyRange: 'high', latitude: 33.4, climateZone: '2B' },
  { city: 'Tucson', state: 'AZ', winterDryBulb: 33, summerDryBulb: 104, summerWetBulb: 66, dailyRange: 'high', latitude: 32.2, climateZone: '2B' },
  { city: 'Los Angeles', state: 'CA', winterDryBulb: 45, summerDryBulb: 83, summerWetBulb: 67, dailyRange: 'medium', latitude: 34.1, climateZone: '3B' },
  { city: 'San Francisco', state: 'CA', winterDryBulb: 42, summerDryBulb: 78, summerWetBulb: 62, dailyRange: 'medium', latitude: 37.8, climateZone: '3C' },
  { city: 'Sacramento', state: 'CA', winterDryBulb: 32, summerDryBulb: 98, summerWetBulb: 69, dailyRange: 'high', latitude: 38.6, climateZone: '3B' },
  { city: 'Denver', state: 'CO', winterDryBulb: 3, summerDryBulb: 91, summerWetBulb: 60, dailyRange: 'high', latitude: 39.7, climateZone: '5B' },
  { city: 'Hartford', state: 'CT', winterDryBulb: 7, summerDryBulb: 88, summerWetBulb: 73, dailyRange: 'medium', latitude: 41.8, climateZone: '5A' },
  { city: 'Miami', state: 'FL', winterDryBulb: 50, summerDryBulb: 91, summerWetBulb: 77, dailyRange: 'low', latitude: 25.8, climateZone: '1A' },
  { city: 'Orlando', state: 'FL', winterDryBulb: 42, summerDryBulb: 93, summerWetBulb: 76, dailyRange: 'medium', latitude: 28.5, climateZone: '2A' },
  { city: 'Atlanta', state: 'GA', winterDryBulb: 23, summerDryBulb: 92, summerWetBulb: 74, dailyRange: 'medium', latitude: 33.6, climateZone: '3A' },
  { city: 'Boise', state: 'ID', winterDryBulb: 10, summerDryBulb: 96, summerWetBulb: 63, dailyRange: 'high', latitude: 43.6, climateZone: '5B' },
  { city: 'Chicago', state: 'IL', winterDryBulb: 0, summerDryBulb: 91, summerWetBulb: 74, dailyRange: 'medium', latitude: 41.8, climateZone: '5A' },
  { city: 'Indianapolis', state: 'IN', winterDryBulb: 2, summerDryBulb: 90, summerWetBulb: 74, dailyRange: 'medium', latitude: 39.7, climateZone: '5A' },
  { city: 'Des Moines', state: 'IA', winterDryBulb: -4, summerDryBulb: 91, summerWetBulb: 75, dailyRange: 'medium', latitude: 41.5, climateZone: '5A' },
  { city: 'Wichita', state: 'KS', winterDryBulb: 5, summerDryBulb: 99, summerWetBulb: 73, dailyRange: 'high', latitude: 37.7, climateZone: '4A' },
  { city: 'New Orleans', state: 'LA', winterDryBulb: 33, summerDryBulb: 93, summerWetBulb: 78, dailyRange: 'low', latitude: 30.0, climateZone: '2A' },
  { city: 'Portland', state: 'ME', winterDryBulb: -1, summerDryBulb: 84, summerWetBulb: 70, dailyRange: 'medium', latitude: 43.7, climateZone: '6A' },
  { city: 'Baltimore', state: 'MD', winterDryBulb: 13, summerDryBulb: 92, summerWetBulb: 75, dailyRange: 'medium', latitude: 39.2, climateZone: '4A' },
  { city: 'Boston', state: 'MA', winterDryBulb: 9, summerDryBulb: 88, summerWetBulb: 72, dailyRange: 'medium', latitude: 42.4, climateZone: '5A' },
  { city: 'Detroit', state: 'MI', winterDryBulb: 4, summerDryBulb: 88, summerWetBulb: 72, dailyRange: 'medium', latitude: 42.3, climateZone: '5A' },
  { city: 'Minneapolis', state: 'MN', winterDryBulb: -11, summerDryBulb: 89, summerWetBulb: 73, dailyRange: 'medium', latitude: 45.0, climateZone: '6A' },
  { city: 'Kansas City', state: 'MO', winterDryBulb: 4, summerDryBulb: 94, summerWetBulb: 75, dailyRange: 'medium', latitude: 39.1, climateZone: '4A' },
  { city: 'St Louis', state: 'MO', winterDryBulb: 6, summerDryBulb: 95, summerWetBulb: 76, dailyRange: 'medium', latitude: 38.6, climateZone: '4A' },
  { city: 'Billings', state: 'MT', winterDryBulb: -10, summerDryBulb: 91, summerWetBulb: 63, dailyRange: 'high', latitude: 45.8, climateZone: '6B' },
  { city: 'Omaha', state: 'NE', winterDryBulb: -3, summerDryBulb: 92, summerWetBulb: 75, dailyRange: 'medium', latitude: 41.3, climateZone: '5A' },
  { city: 'Las Vegas', state: 'NV', winterDryBulb: 31, summerDryBulb: 108, summerWetBulb: 67, dailyRange: 'high', latitude: 36.2, climateZone: '3B' },
  { city: 'Newark', state: 'NJ', winterDryBulb: 12, summerDryBulb: 91, summerWetBulb: 74, dailyRange: 'medium', latitude: 40.7, climateZone: '4A' },
  { city: 'Albuquerque', state: 'NM', winterDryBulb: 17, summerDryBulb: 95, summerWetBulb: 61, dailyRange: 'high', latitude: 35.1, climateZone: '4B' },
  { city: 'New York', state: 'NY', winterDryBulb: 14, summerDryBulb: 90, summerWetBulb: 74, dailyRange: 'medium', latitude: 40.7, climateZone: '4A' },
  { city: 'Buffalo', state: 'NY', winterDryBulb: 3, summerDryBulb: 85, summerWetBulb: 71, dailyRange: 'medium', latitude: 42.9, climateZone: '5A' },
  { city: 'Charlotte', state: 'NC', winterDryBulb: 23, summerDryBulb: 93, summerWetBulb: 75, dailyRange: 'medium', latitude: 35.2, climateZone: '3A' },
  { city: 'Fargo', state: 'ND', winterDryBulb: -17, summerDryBulb: 88, summerWetBulb: 72, dailyRange: 'medium', latitude: 46.9, climateZone: '7' },
  { city: 'Cleveland', state: 'OH', winterDryBulb: 5, summerDryBulb: 88, summerWetBulb: 73, dailyRange: 'medium', latitude: 41.5, climateZone: '5A' },
  { city: 'Columbus', state: 'OH', winterDryBulb: 5, summerDryBulb: 90, summerWetBulb: 74, dailyRange: 'medium', latitude: 40.0, climateZone: '5A' },
  { city: 'Oklahoma City', state: 'OK', winterDryBulb: 11, summerDryBulb: 98, summerWetBulb: 74, dailyRange: 'high', latitude: 35.5, climateZone: '3A' },
  { city: 'Portland', state: 'OR', winterDryBulb: 26, summerDryBulb: 89, summerWetBulb: 67, dailyRange: 'medium', latitude: 45.5, climateZone: '4C' },
  { city: 'Philadelphia', state: 'PA', winterDryBulb: 14, summerDryBulb: 92, summerWetBulb: 75, dailyRange: 'medium', latitude: 39.9, climateZone: '4A' },
  { city: 'Pittsburgh', state: 'PA', winterDryBulb: 5, summerDryBulb: 88, summerWetBulb: 72, dailyRange: 'medium', latitude: 40.4, climateZone: '5A' },
  { city: 'Charleston', state: 'SC', winterDryBulb: 27, summerDryBulb: 92, summerWetBulb: 78, dailyRange: 'low', latitude: 32.8, climateZone: '3A' },
  { city: 'Nashville', state: 'TN', winterDryBulb: 16, summerDryBulb: 94, summerWetBulb: 75, dailyRange: 'medium', latitude: 36.2, climateZone: '4A' },
  { city: 'Dallas', state: 'TX', winterDryBulb: 24, summerDryBulb: 100, summerWetBulb: 75, dailyRange: 'medium', latitude: 32.8, climateZone: '3A' },
  { city: 'Houston', state: 'TX', winterDryBulb: 31, summerDryBulb: 95, summerWetBulb: 77, dailyRange: 'medium', latitude: 29.8, climateZone: '2A' },
  { city: 'San Antonio', state: 'TX', winterDryBulb: 30, summerDryBulb: 98, summerWetBulb: 74, dailyRange: 'medium', latitude: 29.4, climateZone: '2A' },
  { city: 'Salt Lake City', state: 'UT', winterDryBulb: 10, summerDryBulb: 96, summerWetBulb: 62, dailyRange: 'high', latitude: 40.8, climateZone: '5B' },
  { city: 'Burlington', state: 'VT', winterDryBulb: -7, summerDryBulb: 85, summerWetBulb: 71, dailyRange: 'medium', latitude: 44.5, climateZone: '6A' },
  { city: 'Richmond', state: 'VA', winterDryBulb: 19, summerDryBulb: 93, summerWetBulb: 76, dailyRange: 'medium', latitude: 37.5, climateZone: '4A' },
  { city: 'Seattle', state: 'WA', winterDryBulb: 28, summerDryBulb: 83, summerWetBulb: 64, dailyRange: 'medium', latitude: 47.6, climateZone: '4C' },
  { city: 'Milwaukee', state: 'WI', winterDryBulb: -4, summerDryBulb: 87, summerWetBulb: 73, dailyRange: 'medium', latitude: 43.0, climateZone: '6A' },
  { city: 'Cheyenne', state: 'WY', winterDryBulb: -3, summerDryBulb: 86, summerWetBulb: 58, dailyRange: 'high', latitude: 41.1, climateZone: '6B' },
];

/** Looks a place up by "City, ST". */
export function findConditions(key: string): DesignConditions | null {
  return (
    DESIGN_CONDITIONS.find(
      (entry) => `${entry.city}, ${entry.state}`.toLowerCase() === key.toLowerCase(),
    ) ?? null
  );
}

/** How a place is named in the UI and stored in the document. */
export const conditionsKey = (entry: DesignConditions): string =>
  `${entry.city}, ${entry.state}`;

/* ------------------------- Indoor design conditions ----------------------- */

/**
 * What the house is kept at.
 *
 * Manual J's defaults, and they are lower in winter and higher in summer than
 * most people actually set their thermostat. That is deliberate: sizing to a
 * heroic indoor temperature inflates the load and oversizes the equipment.
 */
export const INDOOR_DESIGN = {
  heatingF: 70,
  coolingF: 75,
  /** Relative humidity the cooling coil is sized to hold, as a percentage. */
  coolingRelativeHumidity: 50,
  section: 'Manual J Table 1',
} as const;

/* ------------------------------ Infiltration ------------------------------ */

/**
 * How leaky the house is, in air changes per hour at natural conditions.
 *
 * The largest single uncertainty in the whole calculation and the one people
 * fight about. A 1950s house leaks three or four times an hour; a new house
 * built to code leaks well under one; a passive house is almost sealed and has
 * to be ventilated mechanically or it goes stale.
 *
 * Manual J's own table is by construction quality, and that is what this is.
 */
export interface InfiltrationClass {
  id: 'tight' | 'average' | 'leaky' | 'very-leaky';
  label: string;
  description: string;
  /** Air changes per hour, winter. */
  winterAch: number;
  /** Summer is lower: less wind, less stack effect. */
  summerAch: number;
}

export const INFILTRATION: readonly InfiltrationClass[] = [
  {
    id: 'tight',
    label: 'Tight — new, sealed and tested',
    description: 'Built to current energy code with a blower-door test. Needs mechanical ventilation.',
    winterAch: 0.25,
    summerAch: 0.15,
  },
  {
    id: 'average',
    label: 'Average — ordinary modern construction',
    description: 'Housewrap, sealed penetrations, reasonable workmanship. The sensible default.',
    winterAch: 0.5,
    summerAch: 0.3,
  },
  {
    id: 'leaky',
    label: 'Leaky — older house, some draughtproofing',
    description: 'Retrofitted windows, unsealed penetrations, an unconditioned loft hatch.',
    winterAch: 0.9,
    summerAch: 0.5,
  },
  {
    id: 'very-leaky',
    label: 'Very leaky — untouched older house',
    description: 'Original windows, open chimney, no housewrap. You can feel the draught.',
    winterAch: 1.5,
    summerAch: 0.9,
  },
];

export const INFILTRATION_SECTION = 'Manual J Table 5';

/**
 * Heat carried by air, per unit of flow and temperature difference.
 *
 * 1.1 is the familiar Manual J constant for BTU/h per cfm per °F. It is not a
 * fundamental constant — it is the density and specific heat of air at sea
 * level rolled together, and it drops with altitude, which is why a system in
 * Denver moves more air for the same duty.
 */
export const SENSIBLE_AIR_FACTOR = 1.1;
/** The same for moisture: BTU/h per cfm per grain of humidity difference. */
export const LATENT_AIR_FACTOR = 0.68;

/** Air is thinner high up, so it carries less heat. */
export function altitudeFactor(metresAboveSeaLevel: number): number {
  const feet = metresAboveSeaLevel / 0.3048;
  // Roughly 4% less per 1,000 ft, which is the usual correction.
  return Math.max(0.6, 1 - (feet / 1000) * 0.04);
}

/* ------------------------------ Internal gains ---------------------------- */

/**
 * Heat produced inside the house, which only matters in summer.
 *
 * In winter it helps and Manual J ignores it — deliberately, because sizing
 * heating on the assumption that the oven is on would leave the house cold on
 * the day nobody cooks.
 */
export const INTERNAL_GAINS = {
  /** Per person, sensible and latent, BTU/h. Manual J Table 6. */
  perPersonSensible: 230,
  perPersonLatent: 200,
  /**
   * Occupants assumed: bedrooms plus one, which is Manual J's rule and is
   * about household size rather than how many could physically fit.
   */
  occupantsRule: 'Number of bedrooms plus one',
  /** A kitchen's appliances, BTU/h, Manual J Table 6. */
  kitchenSensible: 1200,
  kitchenLatent: 300,
  /** Everything else — lighting, electronics — per square foot. */
  perSquareFoot: 0.5,
  section: 'Manual J Table 6',
} as const;

/* ------------------------------- Solar gain ------------------------------- */

/**
 * How much sun falls on a window, by the way it faces.
 *
 * -----------------------------------------------------------------------------
 * THESE ARE ON AN SHGC = 1.0 BASIS. READ THAT AGAIN BEFORE CHANGING THEM.
 *
 * Peak solar heat gain in BTU/h per square foot of opening, for glass that
 * transmits EVERYTHING. The caller multiplies by the actual glazing's solar
 * heat gain coefficient.
 *
 * The basis matters enormously and getting it wrong is silent. The first
 * version of this table held values "for clear double glazing" — which already
 * has an SHGC of about 0.6 folded in — and the caller then multiplied by the
 * real SHGC as well. Solar was discounted twice and the whole cooling load came
 * out around half of what Manual J gives, which is the kind of error that
 * produces an air conditioner one size too small and a house that cannot be
 * held on a sunny afternoon.
 *
 * -----------------------------------------------------------------------------
 * WHY WEST IS THE WORST.
 *
 * East and west receive the same peak irradiance — the sun is equally low in
 * the sky morning and evening. But the east peak lands at nine in the morning
 * when the outdoor air is still cool and the building is cold from the night,
 * and the west peak lands at five in the afternoon when the air is at its
 * hottest and the fabric has been soaking up heat all day. The two loads add
 * to the rest of the building completely differently, and a west-facing living
 * room is the single most common cause of a house that cannot be cooled.
 *
 * A skylight is worse than any wall, which surprises people: it faces the sun
 * at midday when the sun is nearest overhead and its intensity is highest.
 */
export const SOLAR_GAIN: Record<string, number> = {
  north: 45,
  northeast: 90,
  east: 160,
  southeast: 130,
  south: 95,
  southwest: 130,
  west: 160,
  northwest: 90,
  /** A skylight, facing straight up. */
  horizontal: 250,
};

export const SOLAR_SECTION = 'Manual J Table 3D-1';

/**
 * The compass point a wall faces, from its outward normal.
 *
 * `northAngle` is the site's rotation, so this works in real compass terms
 * rather than in the model's arbitrary axes — a west-facing window is west
 * whatever way round the plan was drawn.
 */
export function orientationOf(normalX: number, normalZ: number, northAngle: number): string {
  // The model's -Z is north when northAngle is zero.
  const bearing =
    (((Math.atan2(normalX, -normalZ) - northAngle) * 180) / Math.PI + 360 + 360) % 360;
  const points = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return points[Math.round(bearing / 45) % 8]!;
}

/* ------------------------------- Manual S --------------------------------- */

/**
 * How far above the calculated load equipment is allowed to be.
 *
 * The asymmetry is the interesting part. Heating may be oversized generously,
 * because a furnace that is too big is merely inefficient. Cooling may barely
 * be oversized at all, because an oversized coil never runs long enough to
 * remove humidity — the house ends up cold and damp, which feels worse than
 * warm and dry and is the classic symptom of a system sized by rule of thumb.
 */
export const SIZING_LIMITS = {
  heating: {
    /** Manual S 3-2: up to 140% of the heating load. */
    maxFraction: 1.4,
    section: 'Manual S 3-2',
    asWritten: 'not more than 140% of the design heating load',
  },
  cooling: {
    /** Manual S 3-3: 90% to 115% for a fixed-capacity air conditioner. */
    minFraction: 0.9,
    maxFraction: 1.15,
    section: 'Manual S 3-3',
    asWritten: '90% to 115% of the design cooling load',
  },
  heatPumpHeating: {
    /** A heat pump may be sized on cooling and topped up by backup heat. */
    maxFraction: 1.25,
    section: 'Manual S 4-2',
    asWritten: 'sized on the cooling load, with supplemental heat below the balance point',
  },
} as const;

/** Equipment this app knows how to select. */
export type EquipmentKind =
  | 'furnace'
  | 'air-conditioner'
  | 'heat-pump'
  | 'boiler'
  | 'mini-split';

export interface EquipmentModel {
  id: string;
  kind: EquipmentKind;
  name: string;
  /** Heating output at design conditions, BTU/h. Zero for cooling-only. */
  heatingBtu: number;
  /** Cooling capacity, BTU/h. Zero for heating-only. */
  coolingBtu: number;
  /** Sensible fraction of that cooling capacity — the rest removes moisture. */
  sensibleHeatRatio: number;
  /** Efficiency, in the units each kind is rated in. */
  efficiency: string;
  /** Electrical load, in watts, for the NEC service calculation. */
  watts: number;
  /**
   * How capacity falls as it gets colder outside, for a heat pump.
   *
   * A heat pump gets its heat FROM the outside air, so the colder it is the
   * less there is to get — exactly when you need more. That is the whole
   * reason a balance point exists and why backup heat is not optional in a
   * cold climate. Expressed as capacity at 47°F and at 17°F.
   */
  capacityAt17F?: number;
}

/**
 * A catalogue of representative equipment.
 *
 * Generic rather than branded, and the sizes are the ones the industry
 * actually sells — equipment comes in steps, so a 34,000 BTU/h load buys a
 * 36,000 BTU/h unit and there is nothing in between. Selecting a "34,000 BTU/h
 * furnace" would be a calculation, not a specification.
 */
export const EQUIPMENT: readonly EquipmentModel[] = [
  // Gas furnaces, 95% AFUE condensing.
  { id: 'furnace-40', kind: 'furnace', name: '40,000 BTU/h condensing furnace', heatingBtu: 38000, coolingBtu: 0, sensibleHeatRatio: 1, efficiency: '95% AFUE', watts: 400 },
  { id: 'furnace-60', kind: 'furnace', name: '60,000 BTU/h condensing furnace', heatingBtu: 57000, coolingBtu: 0, sensibleHeatRatio: 1, efficiency: '95% AFUE', watts: 500 },
  { id: 'furnace-80', kind: 'furnace', name: '80,000 BTU/h condensing furnace', heatingBtu: 76000, coolingBtu: 0, sensibleHeatRatio: 1, efficiency: '95% AFUE', watts: 600 },
  { id: 'furnace-100', kind: 'furnace', name: '100,000 BTU/h condensing furnace', heatingBtu: 95000, coolingBtu: 0, sensibleHeatRatio: 1, efficiency: '95% AFUE', watts: 750 },
  { id: 'furnace-120', kind: 'furnace', name: '120,000 BTU/h condensing furnace', heatingBtu: 114000, coolingBtu: 0, sensibleHeatRatio: 1, efficiency: '95% AFUE', watts: 900 },

  // Air conditioners, by ton.
  { id: 'ac-1.5', kind: 'air-conditioner', name: '1.5 ton air conditioner', heatingBtu: 0, coolingBtu: 18000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2', watts: 1900 },
  { id: 'ac-2', kind: 'air-conditioner', name: '2 ton air conditioner', heatingBtu: 0, coolingBtu: 24000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2', watts: 2500 },
  { id: 'ac-2.5', kind: 'air-conditioner', name: '2.5 ton air conditioner', heatingBtu: 0, coolingBtu: 30000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2', watts: 3100 },
  { id: 'ac-3', kind: 'air-conditioner', name: '3 ton air conditioner', heatingBtu: 0, coolingBtu: 36000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2', watts: 3700 },
  { id: 'ac-3.5', kind: 'air-conditioner', name: '3.5 ton air conditioner', heatingBtu: 0, coolingBtu: 42000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2', watts: 4300 },
  { id: 'ac-4', kind: 'air-conditioner', name: '4 ton air conditioner', heatingBtu: 0, coolingBtu: 48000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2', watts: 4900 },
  { id: 'ac-5', kind: 'air-conditioner', name: '5 ton air conditioner', heatingBtu: 0, coolingBtu: 60000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2', watts: 6100 },

  // Heat pumps: both, and capacity falls with outdoor temperature.
  { id: 'hp-2', kind: 'heat-pump', name: '2 ton heat pump', heatingBtu: 23000, coolingBtu: 24000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2 / 8.5 HSPF2', watts: 2600, capacityAt17F: 14000 },
  { id: 'hp-2.5', kind: 'heat-pump', name: '2.5 ton heat pump', heatingBtu: 29000, coolingBtu: 30000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2 / 8.5 HSPF2', watts: 3200, capacityAt17F: 17500 },
  { id: 'hp-3', kind: 'heat-pump', name: '3 ton heat pump', heatingBtu: 35000, coolingBtu: 36000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2 / 8.5 HSPF2', watts: 3800, capacityAt17F: 21000 },
  { id: 'hp-4', kind: 'heat-pump', name: '4 ton heat pump', heatingBtu: 46000, coolingBtu: 48000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2 / 8.5 HSPF2', watts: 5000, capacityAt17F: 28000 },
  { id: 'hp-5', kind: 'heat-pump', name: '5 ton heat pump', heatingBtu: 58000, coolingBtu: 60000, sensibleHeatRatio: 0.75, efficiency: '15 SEER2 / 8.5 HSPF2', watts: 6200, capacityAt17F: 35000 },

  // Cold-climate mini-splits, which hold capacity far better when it is cold.
  { id: 'mini-1', kind: 'mini-split', name: '12,000 BTU/h cold-climate mini-split', heatingBtu: 13600, coolingBtu: 12000, sensibleHeatRatio: 0.78, efficiency: '20 SEER2 / 10 HSPF2', watts: 1200, capacityAt17F: 12500 },
  { id: 'mini-1.5', kind: 'mini-split', name: '18,000 BTU/h cold-climate mini-split', heatingBtu: 20000, coolingBtu: 18000, sensibleHeatRatio: 0.78, efficiency: '19 SEER2 / 10 HSPF2', watts: 1800, capacityAt17F: 18000 },
  { id: 'mini-3', kind: 'mini-split', name: '36,000 BTU/h multi-zone mini-split', heatingBtu: 40000, coolingBtu: 36000, sensibleHeatRatio: 0.78, efficiency: '18 SEER2 / 9.5 HSPF2', watts: 3600, capacityAt17F: 34000 },

  // Boilers, for the hydronic option.
  { id: 'boiler-50', kind: 'boiler', name: '50,000 BTU/h condensing boiler', heatingBtu: 47000, coolingBtu: 0, sensibleHeatRatio: 1, efficiency: '95% AFUE', watts: 250 },
  { id: 'boiler-80', kind: 'boiler', name: '80,000 BTU/h condensing boiler', heatingBtu: 76000, coolingBtu: 0, sensibleHeatRatio: 1, efficiency: '95% AFUE', watts: 300 },
  { id: 'boiler-120', kind: 'boiler', name: '120,000 BTU/h condensing boiler', heatingBtu: 114000, coolingBtu: 0, sensibleHeatRatio: 1, efficiency: '95% AFUE', watts: 400 },
];

/** Everything of one kind, smallest first. */
export function equipmentOfKind(kind: EquipmentKind): EquipmentModel[] {
  return EQUIPMENT.filter((entry) => entry.kind === kind).sort(
    (a, b) => (a.heatingBtu || a.coolingBtu) - (b.heatingBtu || b.coolingBtu),
  );
}

export function getEquipment(id: string): EquipmentModel | null {
  return EQUIPMENT.find((entry) => entry.id === id) ?? null;
}

/**
 * A heat pump's output at an arbitrary outdoor temperature.
 *
 * Linear between the two rated points and extrapolated beyond them, which is
 * how the published performance tables behave over this range. It is what makes
 * the balance point computable rather than guessed.
 */
export function heatPumpCapacity(model: EquipmentModel, outdoorF: number): number {
  if (model.capacityAt17F === undefined) return model.heatingBtu;
  const slope = (model.heatingBtu - model.capacityAt17F) / (47 - 17);
  return Math.max(0, model.capacityAt17F + (outdoorF - 17) * slope);
}

/* ------------------------------- Manual D --------------------------------- */

/**
 * How much airflow a system moves, per unit of capacity.
 *
 * 400 cfm per ton is the design figure for ordinary cooling. It drops in a dry
 * climate where more of the duty is sensible, and rises where humidity control
 * matters less. Getting it wrong starves the coil and the system ices up.
 */
export const AIRFLOW = {
  cfmPerTon: 400,
  section: 'Manual S 3-4',
  /** Heating airflow from the furnace's temperature rise, typically 45–65°F. */
  typicalTemperatureRise: 55,
} as const;

/**
 * One round duct size and what it will carry.
 *
 * Sized at 0.1 in w.c. per 100 ft — the friction rate almost every residential
 * system is designed to, because it balances duct size against fan power. The
 * cfm figures are read off the Manual D friction chart at that rate.
 */
export interface DuctSize {
  /** Nominal round diameter, inches. */
  inches: number;
  asWritten: string;
  /** Most cfm at 0.1 in w.c. per 100 ft. */
  maxCfm: number;
}

export const ROUND_DUCTS: readonly DuctSize[] = [
  { inches: 4, asWritten: '4 in', maxCfm: 25 },
  { inches: 5, asWritten: '5 in', maxCfm: 50 },
  { inches: 6, asWritten: '6 in', maxCfm: 85 },
  { inches: 7, asWritten: '7 in', maxCfm: 125 },
  { inches: 8, asWritten: '8 in', maxCfm: 180 },
  { inches: 9, asWritten: '9 in', maxCfm: 245 },
  { inches: 10, asWritten: '10 in', maxCfm: 325 },
  { inches: 12, asWritten: '12 in', maxCfm: 525 },
  { inches: 14, asWritten: '14 in', maxCfm: 800 },
  { inches: 16, asWritten: '16 in', maxCfm: 1150 },
  { inches: 18, asWritten: '18 in', maxCfm: 1550 },
  { inches: 20, asWritten: '20 in', maxCfm: 2000 },
];

export const DUCT_SECTION = 'Manual D Appendix 3';

/** The smallest round duct that carries this airflow. */
export function ductForCfm(cfm: number): DuctSize {
  return ROUND_DUCTS.find((entry) => entry.maxCfm >= cfm) ?? ROUND_DUCTS[ROUND_DUCTS.length - 1]!;
}

/**
 * Air velocity limits, which are about NOISE rather than performance.
 *
 * A duct will happily carry air faster than this; you will simply be able to
 * hear it in the room, which is the most common complaint about a system that
 * is otherwise correctly designed.
 */
export const VELOCITY_LIMITS = {
  trunk: { feetPerMinute: 900, asWritten: '900 fpm', section: 'Manual D Table N1-8' },
  branch: { feetPerMinute: 600, asWritten: '600 fpm', section: 'Manual D Table N1-8' },
  /** At the register face, where the occupant is standing. */
  register: { feetPerMinute: 500, asWritten: '500 fpm', section: 'Manual D Table N1-8' },
} as const;

/** Air speed in a round duct, in feet per minute. */
export function velocityInDuct(cfm: number, diameterInches: number): number {
  const areaSqFt = Math.PI * Math.pow(diameterInches / 24, 2);
  return areaSqFt > 0 ? cfm / areaSqFt : 0;
}

/* ------------------------------- Ventilation ------------------------------ */

/**
 * How much outdoor air a tight house needs, ASHRAE 62.2 as adopted by the IRC.
 *
 * The rule that catches people who build tight without thinking about air. Seal
 * a house properly and it stops ventilating itself, and then the moisture from
 * cooking, washing and breathing has nowhere to go.
 */
export const VENTILATION = {
  section: 'IRC M1505.4 / ASHRAE 62.2',
  /** cfm per 100 square feet of floor area. */
  cfmPerHundredSqFt: 3,
  /** Plus this per bedroom, counting occupants as bedrooms plus one. */
  cfmPerBedroomPlusOne: 7.5,
  asWritten: '0.03 cfm per ft² plus 7.5 cfm per (bedrooms + 1)',
} as const;

/** The whole-house ventilation rate for a house of this size. */
export function ventilationCfm(floorAreaSqFt: number, bedrooms: number): number {
  return (
    (floorAreaSqFt / 100) * VENTILATION.cfmPerHundredSqFt +
    (bedrooms + 1) * VENTILATION.cfmPerBedroomPlusOne
  );
}

/* -------------------------------- Disclaimer ------------------------------ */

export const ACCA_DISCLAIMER =
  'Loads are calculated to ACCA Manual J, equipment selected to Manual S and ducts sized to Manual D, using the design conditions for the city you chose rather than for your own address. This is not a stamped design. The load is only as good as the envelope figures it was given, and those start as assumptions — check them before anybody orders equipment. Fuel-burning appliances, flues and combustion air are not designed here at all, and gas work must be done by a licensed installer.';

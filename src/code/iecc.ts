/**
 * The International Energy Conservation Code — what the envelope must achieve.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM MANUAL J.
 *
 * Manual J asks "how much heat does this building lose?" and takes the
 * construction as given. The IECC asks a different question: "is this
 * construction good enough to be legal?"
 *
 * They pull in opposite directions in a way worth understanding. A badly
 * insulated house has a large Manual J load, and the honest engineering
 * response is a bigger furnace — which the code will not allow, because the
 * answer to a leaky building is to fix the building. So the load and the
 * envelope check are reported side by side: this is what your house needs, and
 * this is whether your house is allowed to need it.
 *
 * -----------------------------------------------------------------------------
 * THE FIGURES ARE 2021 IECC TABLE R402.1.3, PRESCRIPTIVE PATH.
 *
 * The prescriptive path is a list of minimums per climate zone: this much loft
 * insulation, this good a window. It is the simplest of the three compliance
 * routes and the one a small house normally takes.
 *
 * The other two — the U-factor alternative (R402.1.2) and the total-UA
 * performance path (R405) — let a poor value in one place be traded against a
 * better one elsewhere. Both are genuinely useful and this app does NOT
 * implement them, so a design that fails here may still comply by another
 * route. Every finding says so, because telling somebody their perfectly legal
 * house is non-compliant is worse than saying nothing at all.
 *
 * -----------------------------------------------------------------------------
 * R-VALUES AND U-FACTORS ARE NOT THE SAME THING, AND BOTH APPEAR HERE.
 *
 * Insulation is specified as R — resistance, HIGHER is better. Windows and
 * doors are specified as U — conductance, LOWER is better. They are reciprocals
 * of one another and the code's own table mixes them freely, which is a
 * reliable source of inverted comparisons. They are separate branded types
 * below so that passing one where the other is wanted does not compile.
 */

/** Thermal resistance, h·ft²·°F/BTU. Higher is better. */
export type RValue = number & { readonly __rValue: unique symbol };
/** Thermal conductance, BTU/h·ft²·°F. Lower is better. */
export type UFactor = number & { readonly __uFactor: unique symbol };

export const asR = (value: number): RValue => value as RValue;
export const asU = (value: number): UFactor => value as UFactor;

/** R and U are reciprocals. Named, so the inversion is never done inline. */
export const rToU = (r: RValue): UFactor => asU(r > 0 ? 1 / r : 0);
export const uToR = (u: UFactor): RValue => asR(u > 0 ? 1 / u : 0);

/**
 * What one climate zone requires of the envelope.
 *
 * `solarHeatGain` is `null` rather than a number in the cold zones, because the
 * code genuinely does not set one there — and it is right not to. In a cold
 * climate the sun through a south-facing window is a benefit, and capping it
 * would make houses worse. A zero or an Infinity would both read as a real
 * limit to code that did not check; null cannot be compared by accident.
 */
export interface EnvelopeRequirement {
  zone: string;
  /** Minimum R for the ceiling or roof. */
  ceiling: RValue;
  /** Minimum R for above-grade wall cavity insulation. */
  wall: RValue;
  /** Minimum R for a floor over unconditioned space. */
  floor: RValue;
  /** Minimum R for a basement wall. */
  basementWall: RValue;
  /** Minimum R for slab edge insulation, and how far down it must run, in feet. */
  slab: RValue;
  slabDepthFeet: number;
  /** Maximum U-factor for a window, whole assembly including the frame. */
  window: UFactor;
  /** Maximum U-factor for a door. */
  door: UFactor;
  /** Maximum solar heat gain coefficient, or null where unregulated. */
  solarHeatGain: number | null;
}

const requirement = (
  zone: string,
  ceiling: number,
  wall: number,
  floor: number,
  basementWall: number,
  slab: number,
  slabDepthFeet: number,
  window: number,
  door: number,
  solarHeatGain: number | null,
): EnvelopeRequirement => ({
  zone,
  ceiling: asR(ceiling),
  wall: asR(wall),
  floor: asR(floor),
  basementWall: asR(basementWall),
  slab: asR(slab),
  slabDepthFeet,
  window: asU(window),
  door: asU(door),
  solarHeatGain,
});

/**
 * 2021 IECC Table R402.1.3, residential.
 *
 * The trend down the table is the story: a Miami house needs almost no wall
 * insulation and a very good window, because its problem is the sun; a
 * Minneapolis house needs the reverse. Anybody applying one climate's habits
 * in another gets it badly wrong, which is precisely why the zone is chosen
 * from the city rather than assumed.
 */
export const ENVELOPE_REQUIREMENTS: readonly EnvelopeRequirement[] = [
  //             zone  ceil  wall  floor  bsmt  slab  depth  window  door  shgc
  requirement('1A',    30,   13,   13,    0,    0,    0,     0.50,   0.77, 0.25),
  requirement('2A',    49,   13,   13,    0,    0,    0,     0.40,   0.65, 0.25),
  requirement('2B',    49,   13,   13,    0,    0,    0,     0.40,   0.65, 0.25),
  requirement('3A',    49,   20,   19,    5,    0,    0,     0.30,   0.65, 0.25),
  requirement('3B',    49,   20,   19,    5,    0,    0,     0.30,   0.65, 0.25),
  requirement('3C',    49,   20,   19,    5,    0,    0,     0.30,   0.65, 0.25),
  requirement('4A',    60,   20,   19,    10,   10,   2,     0.30,   0.50, null),
  requirement('4B',    60,   20,   19,    10,   10,   2,     0.30,   0.50, null),
  requirement('4C',    60,   20,   30,    10,   10,   2,     0.30,   0.50, null),
  requirement('5A',    60,   20,   30,    15,   10,   2,     0.30,   0.50, null),
  requirement('5B',    60,   20,   30,    15,   10,   2,     0.30,   0.50, null),
  requirement('6A',    60,   20,   30,    15,   10,   4,     0.30,   0.50, null),
  requirement('6B',    60,   20,   30,    15,   10,   4,     0.30,   0.50, null),
  requirement('7',     60,   20,   38,    15,   10,   4,     0.30,   0.50, null),
  requirement('8',     60,   20,   38,    15,   10,   4,     0.30,   0.50, null),
];

export const IECC_TABLE = {
  section: 'R402.1.3',
  title: 'Insulation and fenestration requirements by component',
  edition: '2021 IECC',
} as const;

/**
 * The requirement for a zone.
 *
 * Falls back to the base zone when a sub-zone is not listed — "5" resolves to
 * "5A" — because the A/B/C suffix is about humidity and only changes the
 * envelope table in the mildest zones.
 */
export function requirementForZone(zone: string): EnvelopeRequirement | null {
  const exact = ENVELOPE_REQUIREMENTS.find((entry) => entry.zone === zone);
  if (exact) return exact;
  const base = zone.replace(/[A-C]$/i, '');
  return ENVELOPE_REQUIREMENTS.find((entry) => entry.zone.startsWith(base)) ?? null;
}

/* ---------------------------- Assembly defaults --------------------------- */

/**
 * What a wall, roof or floor is actually built of.
 *
 * The load calculation needs a U-factor for every surface, and the user has
 * almost certainly not measured one. So the app offers real assemblies by
 * name — "2x6 studs at 16 in with R-21 batts" — and derives the number.
 *
 * `effectiveR` is deliberately lower than the insulation's nominal R. A stud
 * is a bridge straight through the insulation, and in a wall framed at 16 in
 * centres roughly a quarter of the area is timber, which is a far worse
 * insulator than what is between it. Quoting the batt's R as if it were the
 * wall's is the single most common way a load calculation comes out
 * optimistic — the wall performs perhaps three-quarters as well as the label
 * on the insulation says.
 */
export interface Assembly {
  id: string;
  label: string;
  description: string;
  /** R after thermal bridging, which is what the load calculation uses. */
  effectiveR: RValue;
  /** R of the insulation alone, which is what the code table asks for. */
  nominalR: RValue;
}

export const WALL_ASSEMBLIES: readonly Assembly[] = [
  { id: 'wall-2x4-r13', label: '2x4 studs, R-13 batts', description: 'The older standard. Fails the code in most of the country now.', effectiveR: asR(10.5), nominalR: asR(13) },
  { id: 'wall-2x4-r15', label: '2x4 studs, R-15 batts', description: 'Denser batts in a 2x4 wall.', effectiveR: asR(11.8), nominalR: asR(15) },
  { id: 'wall-2x6-r21', label: '2x6 studs, R-21 batts', description: 'The current mainstream wall for most of the country.', effectiveR: asR(16.5), nominalR: asR(21) },
  { id: 'wall-2x6-r21-ci5', label: '2x6 studs, R-21 plus R-5 continuous', description: 'Rigid insulation outside the studs, which breaks the thermal bridge.', effectiveR: asR(21.5), nominalR: asR(26) },
  { id: 'wall-2x6-r21-ci10', label: '2x6 studs, R-21 plus R-10 continuous', description: 'A cold-climate wall. Continuous insulation does most of the work.', effectiveR: asR(26.5), nominalR: asR(31) },
  { id: 'wall-double-r38', label: 'Double stud, R-38', description: 'Two walls with a gap. Near-passive performance, thick and expensive.', effectiveR: asR(34), nominalR: asR(38) },
  { id: 'wall-sip', label: 'Structural insulated panel, R-24', description: 'Foam core between boards. Almost no bridging.', effectiveR: asR(22.5), nominalR: asR(24) },
];

export const ROOF_ASSEMBLIES: readonly Assembly[] = [
  { id: 'roof-r30', label: 'R-30 loft insulation', description: 'Older standard. Below code almost everywhere now.', effectiveR: asR(28), nominalR: asR(30) },
  { id: 'roof-r38', label: 'R-38 loft insulation', description: 'Common in mild climates.', effectiveR: asR(36), nominalR: asR(38) },
  { id: 'roof-r49', label: 'R-49 loft insulation', description: 'The usual modern minimum.', effectiveR: asR(46), nominalR: asR(49) },
  { id: 'roof-r60', label: 'R-60 loft insulation', description: 'What zones 4 and colder now ask for. Blown, not batts.', effectiveR: asR(56), nominalR: asR(60) },
  { id: 'roof-cathedral-r38', label: 'Cathedral ceiling, R-38', description: 'Insulated between rafters. No loft, so bridging matters more.', effectiveR: asR(31), nominalR: asR(38) },
];

export const FLOOR_ASSEMBLIES: readonly Assembly[] = [
  { id: 'floor-slab', label: 'Slab on grade, uninsulated edge', description: 'Loses heat round its perimeter rather than through its middle.', effectiveR: asR(0), nominalR: asR(0) },
  { id: 'floor-slab-r10', label: 'Slab on grade, R-10 edge', description: 'Rigid insulation down the slab edge.', effectiveR: asR(10), nominalR: asR(10) },
  { id: 'floor-r19', label: 'R-19 over unconditioned space', description: 'Batts between joists over a crawl space or garage.', effectiveR: asR(17), nominalR: asR(19) },
  { id: 'floor-r30', label: 'R-30 over unconditioned space', description: 'What the colder zones ask for.', effectiveR: asR(27), nominalR: asR(30) },
  { id: 'floor-r38', label: 'R-38 over unconditioned space', description: 'Zone 7 and 8.', effectiveR: asR(34), nominalR: asR(38) },
];

/**
 * Windows, by what they actually are.
 *
 * The U-factor here is the WHOLE ASSEMBLY including the frame, which is what
 * the code regulates and what the load calculation needs. It is markedly worse
 * than the centre-of-glass figure on a manufacturer's sticker, because the
 * frame and the edge seal conduct far better than the glass does.
 */
export interface GlazingType {
  id: string;
  label: string;
  description: string;
  uFactor: UFactor;
  solarHeatGain: number;
}

export const GLAZING: readonly GlazingType[] = [
  { id: 'single', label: 'Single glazed', description: 'Original older windows. Fails the code everywhere.', uFactor: asU(1.04), solarHeatGain: 0.76 },
  { id: 'double-clear', label: 'Double glazed, clear', description: 'Two panes, no coating. Below code in most zones.', uFactor: asU(0.49), solarHeatGain: 0.6 },
  { id: 'double-lowe', label: 'Double glazed, low-E', description: 'The mainstream window. A coating reflects heat back.', uFactor: asU(0.3), solarHeatGain: 0.3 },
  { id: 'double-lowe-argon', label: 'Double glazed, low-E, argon filled', description: 'Argon between the panes conducts less than air.', uFactor: asU(0.27), solarHeatGain: 0.27 },
  { id: 'triple-lowe', label: 'Triple glazed, low-E', description: 'Cold-climate and passive-house glazing. Heavy and expensive.', uFactor: asU(0.18), solarHeatGain: 0.25 },
];

export const DOOR_TYPES: readonly GlazingType[] = [
  { id: 'door-solid-wood', label: 'Solid wood door', description: 'Traditional. Poor by modern standards.', uFactor: asU(0.6), solarHeatGain: 0 },
  { id: 'door-insulated-steel', label: 'Insulated steel door', description: 'Foam core. The usual front door.', uFactor: asU(0.35), solarHeatGain: 0 },
  { id: 'door-insulated-fibreglass', label: 'Insulated fibreglass door', description: 'Better again, and does not conduct at the edges the way steel does.', uFactor: asU(0.25), solarHeatGain: 0 },
  { id: 'door-patio-lowe', label: 'Glazed patio door, low-E', description: 'Mostly glass, so it behaves like a large window.', uFactor: asU(0.32), solarHeatGain: 0.3 },
];

export function getAssembly(list: readonly Assembly[], id: string): Assembly | null {
  return list.find((entry) => entry.id === id) ?? null;
}

export function getGlazing(id: string): GlazingType | null {
  return GLAZING.find((entry) => entry.id === id) ?? DOOR_TYPES.find((entry) => entry.id === id) ?? null;
}

/* -------------------------------- Air sealing ----------------------------- */

/**
 * R402.4.1.2 — the blower-door limit.
 *
 * Zones 3 and up must test at or below 3 air changes per hour at 50 pascals;
 * the two hottest zones get 5. This is a TESTED number, not a modelled one,
 * which is why the app can only say what will be required rather than whether
 * a design passes.
 */
export const AIR_LEAKAGE = {
  section: 'R402.4.1.2',
  title: 'Air leakage testing',
  hotZones: { zones: ['1A', '2A', '2B'], ach50: 5 },
  otherZones: { ach50: 3 },
  asWritten: '5 ACH50 in zones 1 and 2, 3 ACH50 elsewhere',
} as const;

/** The blower-door limit that applies in a zone. */
export function airLeakageLimit(zone: string): number {
  return (AIR_LEAKAGE.hotZones.zones as readonly string[]).includes(zone)
    ? AIR_LEAKAGE.hotZones.ach50
    : AIR_LEAKAGE.otherZones.ach50;
}

/**
 * R403.3.3 — duct leakage.
 *
 * Ducts outside the conditioned envelope leak conditioned air into a loft,
 * which is money straight out of the building. The code caps it at 4 cfm per
 * 100 square feet of floor area.
 */
export const DUCT_LEAKAGE = {
  section: 'R403.3.5',
  title: 'Duct testing',
  cfmPerHundredSqFt: 4,
  asWritten: '4 cfm25 per 100 ft² of conditioned floor area',
} as const;

export const IECC_DISCLAIMER =
  'Checked against the 2021 IECC prescriptive path (Table R402.1.3) for the climate zone of the city you chose. The code also allows a U-factor alternative and a whole-building performance path, neither of which this app evaluates — so an assembly flagged here may still comply by one of those routes. Air leakage and duct leakage are verified by testing on site, not by drawing, so those are stated rather than checked.';

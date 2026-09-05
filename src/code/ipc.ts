/**
 * International Plumbing Code — the numbers, with their section references.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND HOW IT MUST BE USED.
 *
 * The IPC is the model plumbing code published by the ICC. Most of the United
 * States adopts either it or the UPC, usually amended; the figures below are
 * from the 2021 edition of the IPC. Dwellings built under the IRC may instead
 * follow IRC chapters 25–33, whose tables are the same numbers under different
 * section headings — where a rule below has an IRC twin, the comment says so.
 *
 * This app CHECKS against them and CITES them. It does not certify anything,
 * and drainage is the discipline where that disclaimer earns its keep: a drain
 * laid at the wrong fall does not fail immediately, it fails in five years, in
 * a wall, expensively. Everything here catches the ordinary mistakes early and
 * shows its arithmetic. A licensed plumber still signs the work off.
 *
 * The same two rules as `irc.ts` and `nec.ts`:
 *
 *   1. EVERY LIMIT CITES ITS SECTION.
 *   2. EVERY LIMIT KEEPS ITS ORIGINAL WORDING, because a user told "the limit
 *      is 0.0508 m" cannot look it up, and "2 in" is what the table says.
 *
 * -----------------------------------------------------------------------------
 * THE ONE IDEA UNDERNEATH ALL OF IT: THE FIXTURE UNIT.
 *
 * You cannot size a drain by adding up the flow from every fixture, because
 * they are never all running at once — a house with ten fixtures does not need
 * a pipe big enough for ten. The code's answer is the FIXTURE UNIT: an abstract
 * loading number per fixture that already has the diversity baked into it. Add
 * the units, look the total up in a table, and the table gives you a pipe size.
 *
 * There are two separate currencies and they are NOT interchangeable:
 *
 *   • DFU — drainage fixture units (Table 709.1), for waste and soil.
 *   • WSFU — water supply fixture units (Table E103.3(2)), for hot and cold.
 *
 * A WC is 3 DFU going out and 2.2 WSFU coming in. Mixing them up produces a
 * plausible-looking drain that is a size too small, so they are separate types
 * here and the compiler will not let one be passed where the other is wanted.
 */

import { inches, feet, type CodeLimit } from './irc';

export { inches, feet };
export type { CodeLimit };

const limit = (
  section: string,
  title: string,
  metres: number,
  asWritten: string,
): CodeLimit => ({ section, title, metres, asWritten });

/**
 * Drainage fixture units, and water supply fixture units.
 *
 * Branded so they cannot be confused. The brands exist only in the type
 * system — at runtime both are plain numbers — but they make the one mistake
 * that would silently undersize a drain impossible to write.
 */
export type Dfu = number & { readonly __dfu: unique symbol };
export type Wsfu = number & { readonly __wsfu: unique symbol };

export const asDfu = (value: number): Dfu => value as Dfu;
export const asWsfu = (value: number): Wsfu => value as Wsfu;

/* ══════════════════════════════ DRAINAGE ══════════════════════════════════ */

/* ------------------------ Table 709.1 — fixture units --------------------- */

/**
 * What each fixture loads the drain with, and the trap it needs.
 *
 * Keyed by the app's own `FixtureKind`, not by the code's fixture names, so
 * that the catalogue is the single place a fixture is described and this table
 * is the single place the code's number for it lives.
 *
 * The private-use column is the right one throughout: this is a house.
 */
export interface DrainageLoad {
  /** Table 709.1, private use. */
  dfu: Dfu;
  /** Table 709.1 minimum trap size, in metres. */
  trapSize: number;
  trapAsWritten: string;
  /** Whether it discharges human waste, which decides what pipe it may join. */
  soil: boolean;
  /** How the code names it, so a schedule can print the code's word. */
  codeName: string;
}

const load = (
  dfu: number,
  trapInches: number,
  soil: boolean,
  codeName: string,
): DrainageLoad => ({
  dfu: asDfu(dfu),
  trapSize: inches(trapInches),
  trapAsWritten: trapInches === 1.5 ? '1 1/2 in' : trapInches === 1.25 ? '1 1/4 in' : `${trapInches} in`,
  soil,
  codeName,
});

/**
 * Table 709.1, private use, for everything this app can place.
 *
 * A WC has no trap size in the table because its trap is cast into the pan —
 * the "trap" is the water seal in the china — so it is given its outlet size
 * instead, which is what the branch has to be.
 */
export const DRAINAGE_LOADS: Record<string, DrainageLoad> = {
  wc: load(3, 3, true, 'Water closet, private, 1.6 gpf'),
  basin: load(1, 1.25, false, 'Lavatory'),
  'vanity-basin': load(1, 1.25, false, 'Lavatory'),
  bath: load(2, 1.5, false, 'Bathtub (with or without shower head)'),
  shower: load(2, 1.5, false, 'Shower stall'),
  bidet: load(1, 1.25, false, 'Bidet'),
  sink: load(2, 1.5, false, 'Kitchen sink, domestic'),
  dishwasher: load(2, 1.5, false, 'Dishwasher, domestic'),
  'washing-machine': load(2, 2, false, 'Clothes washer, domestic'),
};

/** Table 709.1 as a citation, for a finding that quotes it. */
export const TABLE_709_1 = {
  section: '709.1',
  title: 'Drainage fixture units for fixtures and groups',
} as const;

/**
 * Table E103.3(2) — water supply fixture units, private use.
 *
 * Hot and cold are listed separately and they do NOT sum to the total: a basin
 * is 0.5 hot, 0.5 cold and 0.7 total, because the diversity of "somebody uses
 * this tap" is not the diversity of "somebody uses the hot side of this tap".
 * Sizing the cold main by adding the hot and cold columns oversizes it, and
 * sizing a hot leg from the total undersizes it, so all three are kept.
 */
export interface SupplyLoad {
  cold: Wsfu;
  hot: Wsfu;
  total: Wsfu;
  codeName: string;
}

const supply = (cold: number, hot: number, total: number, codeName: string): SupplyLoad => ({
  cold: asWsfu(cold),
  hot: asWsfu(hot),
  total: asWsfu(total),
  codeName,
});

export const SUPPLY_LOADS: Record<string, SupplyLoad> = {
  wc: supply(2.2, 0, 2.2, 'Water closet, flush tank'),
  basin: supply(0.5, 0.5, 0.7, 'Lavatory'),
  'vanity-basin': supply(0.5, 0.5, 0.7, 'Lavatory'),
  bath: supply(1, 1, 1.4, 'Bathtub'),
  shower: supply(1, 1, 1.4, 'Shower head'),
  bidet: supply(0.5, 0.5, 0.7, 'Bidet'),
  sink: supply(1, 1, 1.4, 'Sink, kitchen'),
  dishwasher: supply(1, 0, 1, 'Dishwasher'),
  'washing-machine': supply(1, 1, 1.4, 'Clothes washer'),
  'towel-rail': supply(0, 0, 0, 'Heated towel rail (heating circuit, not a draw-off)'),
};

export const TABLE_E103_3_2 = {
  section: 'E103.3(2)',
  title: 'Load values assigned to fixtures',
} as const;

/* --------------- Tables 710.1(1) and 710.1(2) — drain sizing -------------- */

/**
 * One row of a pipe-sizing table: a diameter, and the most it may carry.
 *
 * Kept as a list of rows rather than a function because that is what the code
 * is — a table — and a reader checking this file against the book should be
 * able to read the rows off. The lookup walks it; the table stays quotable.
 */
export interface DrainSize {
  /** Nominal diameter in metres. */
  size: number;
  asWritten: string;
  /** Most DFU on a horizontal branch. Table 710.1(2). */
  branchDfu: Dfu;
  /**
   * Most DFU on one stack, total. Table 710.1(1).
   *
   * Null for the sizes that may never be a stack at all — a 1¼ in pipe is a
   * trap arm, never a stack, and the table simply has no row for it.
   */
  stackDfu: Dfu | null;
  /** Most DFU on a building drain at the minimum slope for this size. */
  buildingDrainDfu: Dfu | null;
}

/**
 * The sizing table, smallest first.
 *
 * The DFU figures are the 2021 IPC values for private dwellings. Two of them
 * carry rules the number alone does not express, and the checker applies them
 * separately rather than hiding them in this table:
 *
 *   • 710.1(1) note — not more than two water closets on a 3 in stack.
 *   • 710.1(2) note — a 3 in horizontal branch takes not more than two WCs.
 *
 * Both are the same real constraint: a 3 in pipe carries a WC's 3 DFU on paper
 * three times over, but a third pan will block it. The DFU total does not catch
 * that, so the WC count is checked in its own right.
 */
export const DRAIN_SIZES: readonly DrainSize[] = [
  { size: inches(1.25), asWritten: '1 1/4 in', branchDfu: asDfu(1), stackDfu: null, buildingDrainDfu: null },
  { size: inches(1.5), asWritten: '1 1/2 in', branchDfu: asDfu(3), stackDfu: asDfu(4), buildingDrainDfu: null },
  { size: inches(2), asWritten: '2 in', branchDfu: asDfu(6), stackDfu: asDfu(10), buildingDrainDfu: asDfu(21) },
  { size: inches(2.5), asWritten: '2 1/2 in', branchDfu: asDfu(12), stackDfu: asDfu(20), buildingDrainDfu: asDfu(24) },
  { size: inches(3), asWritten: '3 in', branchDfu: asDfu(20), stackDfu: asDfu(48), buildingDrainDfu: asDfu(42) },
  { size: inches(4), asWritten: '4 in', branchDfu: asDfu(160), stackDfu: asDfu(240), buildingDrainDfu: asDfu(216) },
  { size: inches(5), asWritten: '5 in', branchDfu: asDfu(360), stackDfu: asDfu(540), buildingDrainDfu: asDfu(480) },
  { size: inches(6), asWritten: '6 in', branchDfu: asDfu(620), stackDfu: asDfu(960), buildingDrainDfu: asDfu(840) },
];

/** Table 710.1(1) and (2), for a citation. */
export const TABLE_710_1 = {
  stack: { section: '710.1(1)', title: 'Building drains and sewers' },
  branch: { section: '710.1(2)', title: 'Horizontal fixture branches and stacks' },
} as const;

/**
 * Two WCs is the most a 3 in pipe may take, whatever the DFU arithmetic says.
 *
 * IPC Table 710.1(1) footnote a and Table 710.1(2) footnote a. Checked
 * separately because it is a count, not a loading, and no DFU total expresses
 * it: three WCs on a 3 in stack is 9 DFU against a 48 DFU limit and is still
 * a code violation.
 */
export const WC_LIMIT_3_INCH = {
  section: '710.1(1)',
  title: 'Water closets on a 3 in drain',
  maxWaterClosets: 2,
  asWritten: 'Not more than two water closets on a 3 in drain or stack',
} as const;

/* ------------------------- 704.1 — slope of a drain ----------------------- */

/**
 * How steeply a horizontal drain must fall, by size.
 *
 * Slope is where drainage is least forgiving and most misunderstood. Too flat
 * and the solids do not carry; too steep and the water outruns them, leaving
 * them behind — which is why the code sets a MINIMUM by size and good practice
 * sets a practical maximum. The IPC states only the minimum; the maximum below
 * is flagged as guidance, with an empty section, exactly as the ergonomics
 * findings elsewhere in this app are.
 *
 * Expressed as a ratio: 0.0208 is 1/4 in per foot, which is 1 in 48.
 */
export interface SlopeRule {
  /** Applies to pipe up to and including this diameter, in metres. */
  upToSize: number;
  /** Fall over run, as a ratio. */
  minSlope: number;
  asWritten: string;
}

export const DRAIN_SLOPES: readonly SlopeRule[] = [
  { upToSize: inches(2.5), minSlope: 0.25 / 12, asWritten: '1/4 in per foot' },
  { upToSize: inches(6), minSlope: 0.125 / 12, asWritten: '1/8 in per foot' },
  { upToSize: inches(64), minSlope: 0.0625 / 12, asWritten: '1/16 in per foot' },
];

export const IPC_SLOPE = {
  section: '704.1',
  title: 'Slope of horizontal drainage piping',
  /**
   * Not in the code. A drain much steeper than 1 in 12 self-siphons — the
   * water runs away and leaves the solids — and every plumbing guide says so.
   * Reported as guidance, never as a violation.
   */
  practicalMaxSlope: 1 / 12,
  practicalMaxAsWritten: 'about 1 in 12',
} as const;

/** The minimum fall for a pipe of this diameter, as a ratio. */
export function minSlopeFor(size: number): SlopeRule {
  return (
    DRAIN_SLOPES.find((rule) => size <= rule.upToSize + 1e-9) ??
    DRAIN_SLOPES[DRAIN_SLOPES.length - 1]!
  );
}

/* ------------------------- 909 — traps and trap arms ---------------------- */

/**
 * How far a trap may be from its vent, by trap-arm size.
 *
 * The rule that catches more real mistakes than any other in drainage. A trap
 * holds a water seal; the seal is what keeps sewer gas out of the room. Run the
 * pipe too far before venting it and the flow siphons the seal out, and the
 * room smells. Table 906.1 sets the distance by size.
 *
 * The distance is measured along the trap arm from the trap weir to the vent
 * fitting — not in a straight line, and not from the fixture.
 */
export interface TrapArmRule {
  size: number;
  asWritten: string;
  maxLength: number;
  maxAsWritten: string;
  /** 906.1: the arm must also fall at least this much, and no more than one pipe diameter in total. */
  minSlope: number;
}

export const TRAP_ARMS: readonly TrapArmRule[] = [
  { size: inches(1.25), asWritten: '1 1/4 in', maxLength: feet(5), maxAsWritten: '5 ft', minSlope: 0.25 / 12 },
  { size: inches(1.5), asWritten: '1 1/2 in', maxLength: feet(6), maxAsWritten: '6 ft', minSlope: 0.25 / 12 },
  { size: inches(2), asWritten: '2 in', maxLength: feet(8), maxAsWritten: '8 ft', minSlope: 0.25 / 12 },
  { size: inches(3), asWritten: '3 in', maxLength: feet(12), maxAsWritten: '12 ft', minSlope: 0.125 / 12 },
  { size: inches(4), asWritten: '4 in', maxLength: feet(16), maxAsWritten: '16 ft', minSlope: 0.125 / 12 },
];

export const IPC_TRAPS = {
  distanceToVent: { section: '906.1', title: 'Distance of trap from vent' },
  /**
   * 1002.4 — the seal itself. Two inches minimum, four maximum, except for a
   * trap designed to hold a deeper seal.
   */
  minSeal: limit('1002.4', 'Trap seal', inches(2), '2 in'),
  maxSeal: limit('1002.4', 'Trap seal', inches(4), '4 in'),
  /**
   * 1002.1 — one trap per fixture, and 1002.2 — no trap behind a trap. Double
   * trapping is the classic amateur error: it locks air between the two seals
   * and the fixture will not drain.
   */
  oneTrapPerFixture: { section: '1002.1', title: 'Fixture traps' },
  noDoubleTrapping: { section: '1002.2', title: 'Design of traps' },
} as const;

/** The trap-arm rule for a pipe of this size, rounding up to the next listed size. */
export function trapArmFor(size: number): TrapArmRule {
  return TRAP_ARMS.find((rule) => size <= rule.size + 1e-9) ?? TRAP_ARMS[TRAP_ARMS.length - 1]!;
}

/* ------------------------------- 916 — venting ---------------------------- */

/**
 * Why every drain needs a vent, in one paragraph.
 *
 * Water falling down a stack drags air with it. If no air can get in behind it,
 * the falling slug pulls a vacuum, and the nearest thing that will yield is the
 * water seal in somebody's trap — it siphons out, and the house smells of
 * sewer. A vent is simply a pipe that lets air in. That is all it does, and it
 * is why a drain without one is unusable rather than merely non-compliant.
 *
 * 916.2: a vent is sized off the drain it serves — at least half its diameter,
 * and never less than 1¼ in.
 */
export const IPC_VENTS = {
  sizing: {
    section: '916.2',
    title: 'Vent sizing',
    /** At least half the diameter of the drain served. */
    fractionOfDrain: 0.5,
    minimum: inches(1.25),
    minimumAsWritten: '1 1/4 in',
    asWritten: 'Not less than one-half the diameter of the drain served, and not less than 1 1/4 in',
  },
  /**
   * 903.1 — every building drain needs at least one stack vent or vent stack
   * carried through the roof.
   *
   * Note what this does NOT say: there is no universal 3 in minimum here. The
   * size comes from 916.2 like every other vent — half the drain served. The
   * 3 in figure people remember is the FROST rule below, which applies only in
   * a cold climate, and citing it as though it were 903.1.1 would put a section
   * number in front of a user that does not contain the limit it is quoted for.
   */
  stackVent: {
    section: '903.1',
    title: 'Main vent required',
  },
  /** 904.1 — the vent must go through the roof, not into an attic. */
  throughRoof: {
    section: '904.1',
    title: 'Roof extension',
    minAboveRoof: inches(6),
    minAboveRoofAsWritten: '6 in',
  },
  /**
   * 904.2 — frost closure. In a cold place a small vent frosts shut, and a
   * blocked vent is an unvented drain.
   *
   * CONDITIONAL, on the 97.5% winter design temperature. This app does not know
   * where the building is, so this can only ever be a caution that names the
   * condition — never a violation.
   */
  frostClosure: {
    section: '904.2',
    title: 'Frost closure',
    minimumSize: inches(3),
    minimumAsWritten: '3 in',
    appliesBelow: '0°F (−18°C) winter design temperature',
  },
  /** 904.5 — a vent may not open within 4 ft below or 10 ft horizontally of a window. */
  clearOfOpenings: {
    section: '904.5',
    title: 'Location of vent terminal',
    below: feet(4),
    belowAsWritten: '4 ft',
    horizontal: feet(10),
    horizontalAsWritten: '10 ft',
  },
  /**
   * 912 — wet venting, which is how nearly every real bathroom is vented.
   *
   * One vent serves a whole bathroom group by letting the drain of one fixture
   * be the vent of the next. The limits are strict: a maximum of two bathroom
   * groups, the dry vent taken off a fixture that is not a water closet, and
   * the horizontal wet vent sized for its DFU total.
   */
  wetVent: {
    section: '912.1',
    title: 'Wet vent permitted',
    maxBathroomGroups: 2,
    /** 912.2.1 — the dry vent connects to a fixture other than a WC. */
    ventFromNonWc: { section: '912.2.1', title: 'Vent connection' },
    asWritten: 'Any combination of fixtures within two bathroom groups',
  },
} as const;

/** A vent's minimum size for the drain it serves. IPC 916.2. */
export function ventSizeFor(drainSize: number): number {
  return Math.max(drainSize * IPC_VENTS.sizing.fractionOfDrain, IPC_VENTS.sizing.minimum);
}

/* ------------------------------ 708 — cleanouts --------------------------- */

/**
 * Where a drain must be openable, so it can be rodded when it blocks.
 *
 * Every one of these exists because somebody could not reach a blockage: at
 * the foot of the stack, at the point the drain leaves the building, at every
 * change of direction sharper than 45°, and never more than 100 ft apart.
 */
export const IPC_CLEANOUTS = {
  section: '708.1',
  title: 'Cleanouts required',
  maxSpacing: feet(100),
  maxSpacingAsWritten: '100 ft',
  /** 708.1.6 — at the junction of the building drain and the building sewer. */
  atSewer: { section: '708.1.6', title: 'Building drain and building sewer junction' },
  /** 708.1.3 — at each change of direction greater than 45 degrees. */
  atBend: { section: '708.1.3', title: 'Changes of direction', degrees: 45 },
  /** 708.1.5 — at the base of each waste or soil stack. */
  atStackBase: { section: '708.1.5', title: 'Base of stack' },
  /** 708.8 — 18 in of clearance to rod it, or 12 in for pipe 2 in and under. */
  clearance: limit('708.8', 'Cleanout clearance', inches(18), '18 in'),
  smallClearance: limit('708.8', 'Cleanout clearance, 2 in and smaller', inches(12), '12 in'),
} as const;

/* ══════════════════════════════ WATER SUPPLY ══════════════════════════════ */

/**
 * Appendix E — sizing the supply, and why it is a different problem.
 *
 * A drain is sized by what it can carry away under gravity. A supply is sized
 * by whether there is enough PRESSURE left at the far tap once the pipe has
 * eaten some of it in friction and the building has eaten some in height. So
 * supply sizing is a budget:
 *
 *      pressure at the main
 *    − what the meter takes
 *    − 0.433 psi for every foot of rise
 *    − friction along the longest run
 *    = what is left at the worst fixture, which must beat its minimum.
 *
 * Undersize the pipe and the shower goes cold when somebody flushes. That is
 * the failure this section exists to catch.
 */
export const IPC_SUPPLY = {
  /** 604.3 — the minimum flow pressure a fixture needs at its own inlet. */
  minFlowPressure: {
    section: '604.3',
    title: 'Water distribution system design criteria',
    /** kPa. The table is in psi; 8 psi for most fittings, 20 for a flushometer. */
    typicalKpa: 55.2,
    typicalAsWritten: '8 psi at most fittings',
    showerKpa: 55.2,
    showerAsWritten: '8 psi at a shower',
  },
  /** 604.4 — the highest pressure allowed before a reducing valve is needed. */
  maxStaticPressure: {
    section: '604.8',
    title: 'Water pressure-reducing valve',
    kpa: 552,
    asWritten: '80 psi',
  },
  /** 604.1 — the service to the building, never smaller than 3/4 in. */
  minServiceSize: limit('603.1', 'Water service pipe', inches(0.75), '3/4 in'),
  /**
   * Velocity. Not an IPC number — the code is silent — but universal practice
   * and the manufacturers' own limit: above about 8 ft/s copper erodes at the
   * fittings, and the pipe sings. Reported as guidance, with no section.
   */
  maxVelocity: {
    section: '',
    title: 'Water velocity',
    metresPerSecond: 2.4,
    asWritten: 'about 8 ft/s — manufacturers’ limit, not a code requirement',
  },
  /** E103.3 — the developed length used for sizing includes fittings. */
  fittingAllowance: {
    section: 'E103.3',
    title: 'Developed length',
    /** Add this fraction to the measured length to stand in for elbows and tees. */
    fraction: 0.5,
    asWritten: 'Allow for fittings — commonly taken as 50% of measured length',
  },
} as const;

/**
 * Supply pipe sizes, and the most WSFU each will carry.
 *
 * A simplification of Appendix E, which sizes properly by pressure range and
 * developed length. These figures are the common case — 46 to 60 psi at the
 * main, up to 100 ft developed — and the checker does the real pressure
 * arithmetic on top of them rather than trusting the table alone. Where the
 * two disagree, the pressure calculation wins and says so.
 */
export interface SupplySize {
  size: number;
  asWritten: string;
  maxWsfu: Wsfu;
  /** Internal bore, for the velocity check. Copper type L. */
  bore: number;
}

export const SUPPLY_SIZES: readonly SupplySize[] = [
  { size: inches(0.5), asWritten: '1/2 in', maxWsfu: asWsfu(3), bore: inches(0.545) },
  { size: inches(0.75), asWritten: '3/4 in', maxWsfu: asWsfu(11), bore: inches(0.785) },
  { size: inches(1), asWritten: '1 in', maxWsfu: asWsfu(28), bore: inches(1.025) },
  { size: inches(1.25), asWritten: '1 1/4 in', maxWsfu: asWsfu(58), bore: inches(1.265) },
  { size: inches(1.5), asWritten: '1 1/2 in', maxWsfu: asWsfu(96), bore: inches(1.505) },
  { size: inches(2), asWritten: '2 in', maxWsfu: asWsfu(215), bore: inches(1.985) },
];

/**
 * Hunter's curve: fixture units to actual flow, in litres per second.
 *
 * The WSFU tables stop at a pipe size. To check pressure and velocity you need
 * a real flow, and the conversion is Hunter's curve — the 1940 probability
 * study that the whole of fixture-unit sizing rests on. This is a piecewise fit
 * to the published curve for systems with flush tanks, which is what a house
 * has.
 *
 * The shape matters more than any single point: it is strongly concave. Ten
 * fixtures do not draw ten times one fixture, they draw about four times, and
 * that is the entire reason a 3/4 in pipe can feed a house.
 */
export function flowForWsfu(wsfu: Wsfu): number {
  const units = Math.max(0, wsfu);
  if (units === 0) return 0;
  // Litres per second. Below 5 WSFU the curve is close to linear.
  if (units <= 5) return units * 0.19;
  if (units <= 20) return 0.95 + (units - 5) * 0.082;
  if (units <= 100) return 2.18 + (units - 20) * 0.031;
  return 4.66 + (units - 100) * 0.019;
}

/**
 * Friction loss along a pipe, in kPa per metre.
 *
 * Hazen–Williams, with C = 140 for copper and plastic. Written out rather than
 * pulled from a chart because a chart cannot be tested and this can: the
 * exponents are the formula's, and a wrong one shows up immediately as a
 * pressure drop off by a factor of two.
 */
export function frictionLossPerMetre(flowLps: number, bore: number): number {
  if (flowLps <= 0 || bore <= 0) return 0;
  const c = 140;
  const flowM3s = flowLps / 1000;
  // Hazen–Williams head loss in metres of water per metre of pipe.
  const head =
    10.67 * Math.pow(flowM3s / c, 1.852) * Math.pow(bore, -4.8704);
  // Metres of water to kPa.
  return head * 9.80665;
}

/** Water velocity in a bore, in metres per second. */
export function velocityFor(flowLps: number, bore: number): number {
  if (bore <= 0) return 0;
  const area = Math.PI * (bore / 2) ** 2;
  return flowLps / 1000 / area;
}

/** Pressure lost climbing, in kPa per metre of rise. */
export const STATIC_HEAD_KPA_PER_METRE = 9.80665;

/* ------------------------------ Water heating ----------------------------- */

/**
 * Sizing the hot water, which the IPC does not do.
 *
 * The code says a water heater must be sized for the demand (IPC 501.1) and
 * leaves the arithmetic to the manufacturer. The figures below are the ordinary
 * industry rules of thumb, and they are labelled as guidance throughout — no
 * section number, because there is no section.
 */
export const HOT_WATER = {
  section: '',
  title: 'Water heater sizing',
  /** Litres of storage per bathroom, for a storage cylinder. */
  litresPerBathroom: 75,
  litresBase: 60,
  /** Common storage sizes, in litres. */
  storageSizes: [80, 120, 150, 180, 210, 250, 300] as const,
  /**
   * A recirculation loop is worth it beyond this run, because the wait at the
   * tap otherwise wastes both water and the user's patience.
   */
  recirculationBeyond: feet(50),
  recirculationAsWritten: 'about 50 ft of pipe from the heater to the furthest tap',
  /** IPC 607.1 requires hot water to fixtures that need it. */
  required: { section: '607.1', title: 'Where required' },
  /** 607.2 — a temperature-limiting device on a shower, against scalding. */
  scaldProtection: {
    section: '607.2',
    title: 'Hot or tempered water supply to fixtures',
    maxCelsius: 49,
    asWritten: '120°F maximum at a bathtub or shower outlet',
  },
} as const;

/* ------------------------------- Lookups ---------------------------------- */

/** The smallest drain that will take this DFU load on a horizontal branch. */
export function branchSizeFor(dfu: Dfu, hasWaterCloset: boolean): DrainSize {
  const minimum = hasWaterCloset ? inches(3) : 0;
  return (
    DRAIN_SIZES.find((row) => row.size >= minimum - 1e-9 && row.branchDfu >= dfu) ??
    DRAIN_SIZES[DRAIN_SIZES.length - 1]!
  );
}

/** The smallest stack that will take this DFU load. */
export function stackSizeFor(dfu: Dfu, waterClosets: number): DrainSize {
  const minimum = waterClosets > 0 ? inches(3) : 0;
  return (
    DRAIN_SIZES.find(
      (row) =>
        row.stackDfu !== null &&
        row.size >= minimum - 1e-9 &&
        row.stackDfu >= dfu &&
        // The two-WC rule on a 3 in stack, which no DFU total expresses.
        (row.size >= inches(4) - 1e-9 || waterClosets <= WC_LIMIT_3_INCH.maxWaterClosets),
    ) ?? DRAIN_SIZES[DRAIN_SIZES.length - 1]!
  );
}

/** The smallest building drain that will take this DFU load. */
export function buildingDrainSizeFor(dfu: Dfu, waterClosets: number): DrainSize {
  const minimum = waterClosets > 0 ? inches(3) : 0;
  return (
    DRAIN_SIZES.find(
      (row) =>
        row.buildingDrainDfu !== null &&
        row.size >= minimum - 1e-9 &&
        row.buildingDrainDfu >= dfu &&
        (row.size >= inches(4) - 1e-9 || waterClosets <= WC_LIMIT_3_INCH.maxWaterClosets),
    ) ?? DRAIN_SIZES[DRAIN_SIZES.length - 1]!
  );
}

/** The smallest supply pipe rated for this WSFU load. */
export function supplySizeFor(wsfu: Wsfu): SupplySize {
  return SUPPLY_SIZES.find((row) => row.maxWsfu >= wsfu) ?? SUPPLY_SIZES[SUPPLY_SIZES.length - 1]!;
}

/**
 * The smallest pipe allowed for the SERVICE — the one from the street.
 *
 * Different from `supplySizeFor` because IPC 603.1 puts a floor of 3/4 in under
 * the service whatever the load says, and a small house genuinely does compute
 * to 1/2 in on the fixture-unit table alone. Sizing it with the general
 * function produces a pipe that is arithmetically correct and illegal — which
 * is exactly what happened before this existed, and the checker duly reported
 * the app's own routing as a violation.
 *
 * Anything downstream of the service may be 1/2 in; only the service may not.
 */
export function serviceSizeFor(wsfu: Wsfu): SupplySize {
  const table = supplySizeFor(wsfu);
  if (table.size >= IPC_SUPPLY.minServiceSize.metres - 1e-9) return table;
  return (
    SUPPLY_SIZES.find((row) => row.size >= IPC_SUPPLY.minServiceSize.metres - 1e-9) ?? table
  );
}

/** The nearest listed pipe size at or above a diameter, for printing a vent. */
export function nearestDrainSize(size: number): DrainSize {
  return DRAIN_SIZES.find((row) => row.size >= size - 1e-9) ?? DRAIN_SIZES[DRAIN_SIZES.length - 1]!;
}

/**
 * How the app names what it does not certify.
 *
 * Printed wherever a plumbing result is shown, for the same reason the
 * electrical carries its own version: a passed check is not a permit.
 */
export const IPC_DISCLAIMER =
  'Checked against the 2021 IPC. This is not an approval. Drainage and water supply are permit work almost everywhere, and a licensed plumber must design and sign off what is actually built — local amendments to the code are common, and a fall or a vent that is wrong will not show itself for years.';

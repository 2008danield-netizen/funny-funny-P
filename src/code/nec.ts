/**
 * The National Electrical Code — the numbers, with their article references.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND HOW IT MUST BE USED.
 *
 * NFPA 70, the NEC, is the electrical code adopted in nearly every US
 * jurisdiction, usually with amendments and often a cycle or two behind. The
 * figures below are from the 2023 edition.
 *
 * The same two rules as `code/irc.ts`, and they matter more here, because an
 * electrical mistake is not a room that feels wrong — it is a fire:
 *
 *   1. EVERY LIMIT CITES ITS ARTICLE. A number without a reference cannot be
 *      checked, argued with, or updated when the code changes.
 *   2. EVERY LIMIT KEEPS ITS ORIGINAL WORDING. The code is written in feet and
 *      amps; this app stores metres. "1.8 m" is not something a person can look
 *      up, and "6 ft" is.
 *
 * And the standing warning, which is stronger here than anywhere else in this
 * app: THIS IS NOT AN ELECTRICAL DESIGN. It is a checked first draft. Every
 * jurisdiction amends the NEC, load calculations depend on equipment nobody has
 * chosen yet, and the work must be done by a licensed electrician and inspected.
 * What this saves is the tedium, not the electrician.
 * -----------------------------------------------------------------------------
 */

import { feet, inches, type CodeLimit } from './irc';

const limit = (
  article: string,
  title: string,
  metres: number,
  asWritten: string,
): CodeLimit => ({ section: article, title, metres, asWritten });

/* ------------------------- 210.52 Receptacle outlets ---------------------- */

export const NEC_OUTLETS = {
  /**
   * 210.52(A)(1) — the six-foot rule, which is really a twelve-foot rule.
   *
   * "Receptacles shall be installed such that no point measured horizontally
   * along the floor line of any wall space is more than 1.8 m (6 ft) from a
   * receptacle outlet." Which means outlets no more than 12 ft apart, and no
   * more than 6 ft from any corner — so that a lamp with a 6 ft cord reaches an
   * outlet from anywhere along the wall, which is exactly why the rule exists.
   */
  maxDistanceAlongWall: limit('210.52(A)(1)', 'Distance to a receptacle', feet(6), '6 ft'),
  /**
   * 210.52(A)(2) — what counts as wall space.
   *
   * Any space 600 mm (2 ft) or more in width, measured along the floor line and
   * unbroken by a doorway or a fireplace. A 450 mm return beside a door does not
   * need its own outlet.
   */
  minWallSpace: limit('210.52(A)(2)', 'Wall space needing an outlet', feet(2), '2 ft'),
  /** 210.52(C)(1) — kitchen counters: no point more than 600 mm from one. */
  maxCounterDistance: limit('210.52(C)(1)', 'Distance along a countertop', inches(24), '24 in'),
  /** 210.52(C)(1) — every counter this wide or more needs a receptacle. */
  minCounterWidth: limit('210.52(C)(1)', 'Countertop needing an outlet', inches(12), '12 in'),
  /** 210.52(D) — a receptacle within 900 mm of the outside edge of each basin. */
  maxBasinDistance: limit('210.52(D)', 'Distance from a basin', feet(3), '3 ft'),
  /** 406.12 — tamper-resistant receptacles throughout a dwelling. */
  tamperResistant: {
    section: '406.12',
    title: 'Tamper-resistant receptacles',
    asWritten: 'all 15 A and 20 A, 125 V receptacles in a dwelling shall be tamper-resistant',
  },
} as const;

/* ------------------------ 210.11 Circuits a home needs -------------------- */

export const NEC_CIRCUITS = {
  /**
   * 210.11(C)(1) — at least TWO 20 A circuits for the kitchen, pantry, dining
   * room and breakfast room receptacles, and they may serve nothing else.
   *
   * The commonest thing a first-time plan gets wrong, because one circuit looks
   * perfectly adequate until a kettle and a toaster are on it at once.
   */
  smallApplianceCount: 2,
  smallApplianceAmps: 20,
  smallAppliance: {
    section: '210.11(C)(1)',
    title: 'Small-appliance branch circuits',
    asWritten: 'two or more 20 A small-appliance branch circuits',
  },
  /** 210.11(C)(2) — one 20 A circuit for the laundry receptacles, and nothing else. */
  laundry: {
    section: '210.11(C)(2)',
    title: 'Laundry branch circuit',
    asWritten: 'at least one 20 A branch circuit for laundry receptacles',
  },
  /** 210.11(C)(3) — one 20 A circuit for the bathroom receptacles. */
  bathroom: {
    section: '210.11(C)(3)',
    title: 'Bathroom branch circuit',
    asWritten: 'at least one 20 A branch circuit for bathroom receptacle outlets',
  },
  /** 210.23 — a circuit may be loaded to 80 percent where the load is continuous. */
  continuousFactor: 0.8,
} as const;

/* --------------------- 210.8 / 210.12 Protective devices ------------------ */

/**
 * Where the code requires ground-fault protection, in the words it uses.
 *
 * GFCI protects PEOPLE: it trips on current leaking to earth through somebody,
 * long before a breaker would notice. That is why the list is every place water
 * and electricity meet.
 */
export const NEC_GFCI = {
  section: '210.8(A)',
  title: 'Ground-fault circuit-interrupter protection',
  asWritten:
    'bathrooms, garages and accessory buildings, outdoors, crawl spaces, basements, kitchens, sinks, boathouses, bathtubs and shower stalls, laundry areas, and indoor damp or wet locations',
  /** 210.8(A)(7) — within 1.8 m of the outside edge of a sink. */
  nearSink: limit('210.8(A)(7)', 'Distance from a sink', feet(6), '6 ft'),
} as const;

/**
 * And where it requires arc-fault protection.
 *
 * AFCI protects the BUILDING: it listens for the signature of an arcing
 * connection — a loose screw, a nail through a cable — which draws too little
 * current to trip a breaker and is quite hot enough to start a fire.
 */
export const NEC_AFCI = {
  section: '210.12(A)',
  title: 'Arc-fault circuit-interrupter protection',
  asWritten:
    'kitchens, family rooms, dining rooms, living rooms, parlors, libraries, dens, bedrooms, sunrooms, recreation rooms, closets, hallways, laundry areas, and similar rooms',
} as const;

/* ------------------------- 210.70 Lighting outlets ------------------------ */

export const NEC_LIGHTING = {
  /** 210.70(A)(1) — one wall-switched lighting outlet in every habitable room. */
  habitable: {
    section: '210.70(A)(1)',
    title: 'Lighting outlets in habitable rooms',
    asWritten: 'at least one wall switch-controlled lighting outlet in every habitable room, kitchen and bathroom',
  },
  /** 210.70(A)(2) — hallways, stairways, garages and outdoor entrances. */
  circulation: {
    section: '210.70(A)(2)',
    title: 'Lighting outlets elsewhere',
    asWritten:
      'at least one wall switch-controlled lighting outlet in hallways, stairways, attached garages, and at outdoor entrances with grade-level access',
  },
  /**
   * 210.70(A)(2)(3) — a stairway of six risers or more must be switched from
   * BOTH ends.
   *
   * Not a convenience. It is so that nobody ever has to walk down a dark stair
   * to reach the switch at the bottom.
   */
  stairwaySwitching: {
    section: '210.70(A)(2)(3)',
    title: 'Switching at both ends of a stairway',
    risers: 6,
    asWritten: 'where the stairway between floor levels has six risers or more, a wall switch at each floor level',
  },
} as const;

/* ---------------------- Article 220 The load calculation ------------------ */

export const NEC_LOAD = {
  /**
   * 220.12 — general lighting and general-use receptacles, at 3 VA per square
   * foot of floor area.
   *
   * A single number standing in for every lamp and every phone charger in the
   * house, and it is not a guess: it is the figure the code says to use, and an
   * inspector will check the arithmetic against it rather than against a
   * count of the outlets.
   */
  generalLighting: {
    section: '220.12',
    title: 'General lighting load',
    vaPerSquareFoot: 3,
    asWritten: '3 volt-amperes per square foot of floor area',
  },
  /** 220.52(A) — 1500 VA for each small-appliance circuit. */
  smallApplianceVa: {
    section: '220.52(A)',
    title: 'Small-appliance load',
    va: 1500,
    asWritten: '1500 volt-amperes for each 2-wire small-appliance branch circuit',
  },
  /** 220.52(B) — 1500 VA for the laundry circuit. */
  laundryVa: {
    section: '220.52(B)',
    title: 'Laundry load',
    va: 1500,
    asWritten: '1500 volt-amperes for each 2-wire laundry branch circuit',
  },
  /**
   * 220.82 — the optional method for a dwelling: the first 10 kVA at 100
   * percent and the remainder at 40, plus the LARGEST of heating or cooling.
   *
   * The demand factor is the code admitting what everybody knows — that nothing
   * in a house is ever all switched on at once — and it is the difference
   * between a 100 A service and a 400 A one.
   */
  optionalMethod: {
    section: '220.82',
    title: 'Optional calculation for a dwelling unit',
    firstVa: 10000,
    remainderFactor: 0.4,
    asWritten: 'the first 10 kVA at 100 percent and the remainder at 40 percent, plus the larger of heating or air conditioning',
  },
  /** 230.79(C) — the service disconnect for a one-family dwelling. */
  minService: {
    section: '230.79(C)',
    title: 'Minimum service size',
    amps: 100,
    asWritten: 'not less than 100 amperes, 3-wire, for a one-family dwelling',
  },
  /** The standard supply voltages a dwelling is wired at. */
  volts: { branch: 120, service: 240 },
} as const;

/* ----------------- 240.6 / 310.16 Breakers and conductors ----------------- */

/**
 * 240.6(A) — the standard ratings a breaker actually comes in.
 *
 * The list runs well past the 100 A a branch circuit could ever want because
 * the same function sizes the SERVICE, and a house with electric heat asks for
 * 150 or 200 A without being in any way unusual. Stopping the table at 100
 * would silently report every such house as needing exactly 100 A, which is
 * the worst kind of wrong: an undersized service that the check calls a pass.
 */
export const STANDARD_BREAKERS = [
  15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250, 300, 350,
  400, 450, 500, 600,
] as const;

/**
 * What each conductor may carry, and what may protect it.
 *
 * From Table 310.16 at 60°C, as 240.4(D) requires for 14, 12 and 10 AWG however
 * good the insulation is — the limit there is the terminal, not the wire. This
 * is the table that decides whether a circuit is safe or is a fire in a few
 * years' time, and getting it backwards (a 20 A breaker on 14 AWG) is the
 * single commonest dangerous mistake in domestic wiring.
 */
export const CONDUCTORS = [
  { size: '14 AWG', amps: 15, section: '240.4(D)(3)' },
  { size: '12 AWG', amps: 20, section: '240.4(D)(5)' },
  { size: '10 AWG', amps: 30, section: '240.4(D)(7)' },
  { size: '8 AWG', amps: 40, section: '310.16' },
  { size: '6 AWG', amps: 55, section: '310.16' },
  { size: '4 AWG', amps: 70, section: '310.16' },
  { size: '3 AWG', amps: 85, section: '310.16' },
  { size: '2 AWG', amps: 95, section: '310.16' },
  { size: '1 AWG', amps: 110, section: '310.16' },
  { size: '1/0 AWG', amps: 125, section: '310.16' },
  { size: '2/0 AWG', amps: 145, section: '310.16' },
  { size: '3/0 AWG', amps: 165, section: '310.16' },
  { size: '4/0 AWG', amps: 195, section: '310.16' },
] as const;

/** The smallest conductor that may carry a given breaker's rating. */
export function conductorFor(amps: number): (typeof CONDUCTORS)[number] {
  return CONDUCTORS.find((entry) => entry.amps >= amps) ?? CONDUCTORS[CONDUCTORS.length - 1]!;
}

/**
 * The smallest standard breaker at or above a load.
 *
 * A load past the end of the table falls back to the largest rating rather than
 * to the first, so the answer is at least honest about being big.
 */
export function breakerFor(amps: number): number {
  return STANDARD_BREAKERS.find((rating) => rating >= amps) ?? STANDARD_BREAKERS[STANDARD_BREAKERS.length - 1]!;
}

/* --------------------------- 300.4 Protecting cable ----------------------- */

export const NEC_CABLE = {
  /**
   * 300.4(D) — a cable run through a stud must be 32 mm from the face, or
   * protected by a steel plate.
   *
   * Which is to say: the depth of a screw. Somebody will one day hang a shelf
   * exactly where the wire is, and this is the rule that decides whether that
   * is an inconvenience or an electrocution.
   */
  edgeDistance: limit('300.4(D)', 'Cable distance from the face of a stud', inches(1.25), '1 1/4 in'),
  plateThickness: limit('300.4(D)', 'Protective steel plate', inches(0.0625), '1/16 in'),
} as const;

/* --------------------------- Mounting heights ----------------------------- */

/**
 * Where devices actually go on the wall.
 *
 * NOT code — the NEC is almost silent on mounting height for a dwelling. These
 * are the conventions every American electrician works to, and the accessible
 * ranges of ICC A117.1 and the ADA, which several jurisdictions adopt for
 * dwellings. They are labelled as conventions in the app for exactly that
 * reason: a person should be able to tell which numbers they could argue with.
 */
export const MOUNTING = {
  /** Centre of a receptacle above the floor. 12-16 in is usual. */
  receptacle: inches(15),
  /** Above a kitchen counter, which is itself 36 in. */
  counterReceptacle: inches(44),
  /** Centre of a switch. 48 in is the accessible maximum reach. */
  switch: inches(46),
  /** Ceiling fittings hang from the ceiling; this is the drop for a pendant. */
  pendantDrop: inches(30),
  /** Consumer unit / panel: 240.24(A) puts the top breaker at most 6 ft 7 in up. */
  panelCentre: feet(5),
  panelMaxHandle: limit('240.24(A)', 'Highest breaker handle', feet(6) + inches(7), '6 ft 7 in'),
} as const;

/** "20 A" — a rating the way an electrician says it. */
export function asAmps(amps: number): string {
  return `${Math.round(amps)} A`;
}

/** "1,240 VA" — a load with its thousands separated. */
export function asVoltAmperes(va: number): string {
  return `${Math.round(va).toLocaleString('en-US')} VA`;
}

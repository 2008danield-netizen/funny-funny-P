/**
 * International Residential Code — the numbers, with their section references.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND HOW IT MUST BE USED.
 *
 * The IRC is the model code for one- and two-family dwellings in the United
 * States. Nearly every state adopts it, most with amendments, and some
 * jurisdictions are a cycle or two behind. The figures below are from the 2021
 * edition.
 *
 * This app CHECKS against them and CITES them. It does not certify anything.
 * A design that passes every check here has not been approved by anybody, and
 * a real build needs a permit, an inspection, and where the work is structural,
 * electrical or gas, a licensed professional. The value of this module is that
 * it catches the ordinary mistakes early and shows its arithmetic — so that
 * when a professional does look at it, they are checking work rather than
 * redoing it.
 *
 * Two rules for anything added here:
 *
 *   1. EVERY LIMIT CITES ITS SECTION. A number without a reference cannot be
 *      checked, argued with, or updated when the code changes. If you cannot
 *      name the section, you do not yet know the rule.
 *   2. EVERY LIMIT KEEPS ITS ORIGINAL WORDING. The code is written in feet and
 *      inches; this app stores metres. 7¾ inches is 0.19685 m, and a user who
 *      is told "the limit is 0.197 m" cannot look it up. `asWritten` is what
 *      goes in front of a person.
 * -----------------------------------------------------------------------------
 */

/** Inches to metres. The code is written in inches; the app stores metres. */
export function inches(value: number): number {
  return value * 0.0254;
}

/** Feet to metres. */
export function feet(value: number): number {
  return value * 0.3048;
}

/**
 * One requirement, as the code states it.
 *
 * `metres` is what the app compares against; `asWritten` is what it says to
 * the user. Both refer to the same requirement, and `section` is how anybody
 * checks that we read it correctly.
 */
export interface CodeLimit {
  /** e.g. "R311.7.5.1". */
  section: string;
  /** e.g. "Riser height". */
  title: string;
  /** The limit, in metres. */
  metres: number;
  /** The limit exactly as the code writes it, e.g. "7 3/4 in". */
  asWritten: string;
}

const limit = (
  section: string,
  title: string,
  metres: number,
  asWritten: string,
): CodeLimit => ({ section, title, metres, asWritten });

/* ------------------------------ R311.7 Stairways -------------------------- */

export const IRC_STAIRS = {
  /**
   * R311.7.1 — Width.
   *
   * 36 in clear above the handrail height. Below it, a handrail may intrude:
   * 31.5 in clear with a rail on one side, 27 in with rails on both. Those two
   * are separate limits rather than one, because which applies depends on how
   * many handrails the stair has.
   */
  minWidth: limit('R311.7.1', 'Stairway width', inches(36), '36 in'),
  minWidthOneRail: limit(
    'R311.7.1',
    'Clear width at handrail height, one handrail',
    inches(31.5),
    '31 1/2 in',
  ),
  minWidthTwoRails: limit(
    'R311.7.1',
    'Clear width at handrail height, two handrails',
    inches(27),
    '27 in',
  ),

  /**
   * R311.7.2 — Headroom.
   *
   * Measured vertically from the sloped plane joining the tread nosings, NOT
   * from the treads themselves. The distinction matters: measuring from the
   * tread gives you a number a couple of inches larger than the code's, which
   * is exactly the sort of quiet error that gets a stair built too low.
   */
  minHeadroom: limit('R311.7.2', 'Headroom', feet(6) + inches(8), "6 ft 8 in"),

  /** R311.7.3 — Maximum vertical rise of a single flight, between landings. */
  maxFlightRise: limit('R311.7.3', 'Vertical rise of a flight', inches(151), '151 in'),

  /** R311.7.5.1 — Riser height. */
  maxRiser: limit('R311.7.5.1', 'Riser height', inches(7.75), '7 3/4 in'),

  /** R311.7.5.2 — Tread depth. */
  minTread: limit('R311.7.5.2', 'Tread depth', inches(10), '10 in'),

  /**
   * R311.7.5.1 and R311.7.5.2 — Uniformity.
   *
   * The tallest riser in a flight may exceed the shortest by no more than 3/8
   * in, and the same for treads. This is the single most-cited stair defect in
   * the country and the reason is physiology: people climb stairs by rhythm
   * rather than by looking, and a step that is half an inch out of pattern is
   * the one they fall on.
   */
  maxVariation: limit('R311.7.5.1', 'Variation between risers or treads', inches(0.375), '3/8 in'),

  /** R311.7.5.3 — Nosing projection, where the tread depth is under 11 in. */
  minNosing: limit('R311.7.5.3', 'Nosing projection', inches(0.75), '3/4 in'),
  maxNosing: limit('R311.7.5.3', 'Nosing projection', inches(1.25), '1 1/4 in'),
  /** Above this tread depth a nosing is not required at all. */
  nosingExemptTread: limit('R311.7.5.3', 'Tread depth exempting a nosing', inches(11), '11 in'),

  /** R311.7.6 — Landings, measured in the direction of travel. */
  minLanding: limit('R311.7.6', 'Landing depth', inches(36), '36 in'),

  /* ------------------------------ Winders ------------------------------- */

  /**
   * R311.7.5.2.1 — Winder treads.
   *
   * Depth is measured at the WALKLINE, 12 in in from the narrow edge — the
   * line somebody's feet actually follow round the turn — and never at the
   * middle of the tread. A winder can meet 10 in at its midpoint and still be
   * dangerously shallow where people walk, which is the whole reason the code
   * specifies where to hold the tape.
   */
  winderWalklineOffset: limit(
    'R311.7.5.2.1',
    'Walkline offset from the narrow edge',
    inches(12),
    '12 in',
  ),
  minWinderTreadAtWalkline: limit(
    'R311.7.5.2.1',
    'Winder tread depth at the walkline',
    inches(10),
    '10 in',
  ),
  minWinderTreadAnywhere: limit(
    'R311.7.5.2.1',
    'Winder tread depth at any point',
    inches(6),
    '6 in',
  ),

  /* ------------------------------- Spirals ------------------------------ */

  /**
   * R311.7.10.1 — Spiral stairways.
   *
   * A separate regime, and a more permissive one: steeper risers and shallower
   * treads are allowed than on any other stair, on the understanding that a
   * spiral is a secondary route rather than the main way between floors.
   */
  spiral: {
    minWidth: limit('R311.7.10.1', 'Spiral stairway clear width', inches(26), '26 in'),
    minTreadAtWalkline: limit(
      'R311.7.10.1',
      'Spiral tread depth 12 in from the narrow edge',
      inches(6.75),
      '6 3/4 in',
    ),
    walklineOffset: limit(
      'R311.7.10.1',
      'Walkline offset from the narrow edge',
      inches(12),
      '12 in',
    ),
    maxRiser: limit('R311.7.10.1', 'Spiral riser height', inches(9.5), '9 1/2 in'),
    minHeadroom: limit('R311.7.10.1', 'Spiral headroom', feet(6) + inches(6), '6 ft 6 in'),
  },

  /* ------------------------------ Handrails ----------------------------- */

  /** R311.7.8 — A handrail is required on any flight of four or more risers. */
  handrailRequiredAtRisers: 4,
  minHandrailHeight: limit('R311.7.8.1', 'Handrail height above the nosings', inches(34), '34 in'),
  maxHandrailHeight: limit('R311.7.8.1', 'Handrail height above the nosings', inches(38), '38 in'),
  /** R311.7.1 — How far a handrail may intrude into the required width. */
  maxHandrailProjection: limit('R311.7.1', 'Handrail projection', inches(4.5), '4 1/2 in'),
} as const;

/* -------------------------------- R312 Guards ----------------------------- */

export const IRC_GUARDS = {
  /**
   * R312.1.1 — Where a guard is required.
   *
   * Any walking surface more than 30 in above the floor or grade below, at any
   * point within 36 in horizontally of the edge. The second half is what
   * catches a stairwell opening: the floor beside the hole is the walking
   * surface, and the drop is the storey height.
   */
  requiredAboveDrop: limit('R312.1.1', 'Drop requiring a guard', inches(30), '30 in'),
  measuredWithin: limit('R312.1.1', 'Horizontal distance from the edge', inches(36), '36 in'),

  /** R312.1.2 — Guard height. */
  minHeight: limit('R312.1.2', 'Guard height', inches(36), '36 in'),
  /** R312.1.2 exception — on the open side of a stair, measured from nosings. */
  minHeightOnStair: limit('R312.1.2', 'Guard height on the open side of a stair', inches(34), '34 in'),

  /** R312.1.3 — Nothing that passes a 4 in sphere. */
  maxOpening: limit('R312.1.3', 'Guard opening', inches(4), '4 in'),
  /** R312.1.3 — The triangle at the open side of a stair gets 6 in. */
  maxOpeningStairTriangle: limit(
    'R312.1.3',
    'Opening in the triangle at the open side of a stair',
    inches(6),
    '6 in',
  ),
} as const;

/* ------------------------------ R305 Ceilings ----------------------------- */

export const IRC_CEILINGS = {
  /**
   * R305.1 — Minimum ceiling height in habitable space.
   *
   * 7 ft, dropping to 6 ft 8 in at beams and ducts spaced no closer than 4 ft.
   * Bathrooms, hallways and laundry rooms are allowed 6 ft 8 in throughout.
   */
  minHabitable: limit('R305.1', 'Ceiling height, habitable rooms', feet(7), '7 ft'),
  minAtBeams: limit('R305.1', 'Ceiling height at beams and ducts', feet(6) + inches(8), '6 ft 8 in'),
  minBathroom: limit(
    'R305.1',
    'Ceiling height, bathrooms and hallways',
    feet(6) + inches(8),
    '6 ft 8 in',
  ),
} as const;

/* --------------------- R905 Roof coverings: minimum slope ------------------ */

/**
 * A minimum roof slope, as the code writes it.
 *
 * Slopes in the IRC are given as "units vertical in 12 units horizontal", which
 * is a ratio and not a length — so this is its own type rather than a
 * `CodeLimit`, whose `metres` would be meaningless here. `pitch` is rise over
 * run, which is what the app stores; `asWritten` is the "4:12" a roofer says.
 */
export interface SlopeLimit {
  section: string;
  title: string;
  /** Rise over run. A 4:12 roof is 0.3333. */
  pitch: number;
  /** e.g. "four units vertical in 12 units horizontal (4:12)". */
  asWritten: string;
}

const slope = (
  section: string,
  title: string,
  riseIn12: number,
  asWritten: string,
): SlopeLimit => ({ section, title, pitch: riseIn12 / 12, asWritten });

/**
 * The minimum slope each covering may be laid at, and why it matters.
 *
 * A roof covering is a system for shedding water, and every one of them has an
 * angle below which water stops running off and starts sitting — then finding
 * its way under the laps and into the house. These are the angles. They are the
 * single most consequential set of numbers about a roof, and the one a person
 * designing by eye is most likely to get wrong, because a shallow roof looks
 * perfectly fine on a screen.
 *
 * Two of them have a second, lower figure attached: asphalt shingles and tile
 * may go shallower than their normal minimum if the underlayment is doubled.
 * That is a real allowance and worth surfacing, because it is the difference
 * between "you cannot do this" and "you can, and here is what it costs".
 */
export const IRC_ROOF_SLOPES = {
  asphaltShingle: slope(
    'R905.2.2',
    'Asphalt shingles',
    2,
    'two units vertical in 12 units horizontal (2:12)',
  ),
  /** R905.2.2 — below 4:12, R905.1.1 requires a doubled underlayment. */
  asphaltShingleDoubleUnderlayment: slope(
    'R905.2.2',
    'Asphalt shingles without doubled underlayment',
    4,
    'four units vertical in 12 units horizontal (4:12)',
  ),
  clayOrConcreteTile: slope(
    'R905.3.2',
    'Clay and concrete roof tile',
    2.5,
    'two and one-half units vertical in 12 units horizontal (2 1/2:12)',
  ),
  /** R905.3.2 — below 4:12, the underlayment is doubled. */
  tileDoubleUnderlayment: slope(
    'R905.3.2',
    'Roof tile without doubled underlayment',
    4,
    'four units vertical in 12 units horizontal (4:12)',
  ),
  metalShingle: slope(
    'R905.4.2',
    'Metal roof shingles',
    3,
    'three units vertical in 12 units horizontal (3:12)',
  ),
  slate: slope('R905.6.2', 'Slate shingles', 4, 'four units vertical in 12 units horizontal (4:12)'),
  woodShingle: slope(
    'R905.7.2',
    'Wood shingles',
    3,
    'three units vertical in 12 units horizontal (3:12)',
  ),
  woodShake: slope(
    'R905.8.2',
    'Wood shakes',
    4,
    'four units vertical in 12 units horizontal (4:12)',
  ),
  standingSeamMetal: slope(
    'R905.10.2',
    'Standing-seam metal roof panels',
    0.25,
    'one-fourth unit vertical in 12 units horizontal (1/4:12)',
  ),
  membrane: slope(
    'R905.11.1',
    'Membrane roofing',
    0.25,
    'one-fourth unit vertical in 12 units horizontal (1/4:12), a 2-percent slope, for drainage',
  ),
} as const;

/* ------------------------- R806/R807 The roof space ----------------------- */

export const IRC_ATTIC = {
  /**
   * R806.2 — Minimum net free ventilating area.
   *
   * One square foot of opening for every 150 square feet of the space being
   * ventilated. Stored as the RATIO rather than an area, because the required
   * area depends on the roof it is under.
   */
  ventilationRatio: {
    section: 'R806.2',
    title: 'Attic ventilation',
    ratio: 1 / 150,
    asWritten: '1/150 of the area of the space ventilated',
  },
  /**
   * R806.2 exception — 1/300 is permitted where a Class I or II vapour
   * retarder is fitted on the warm side in Climate Zones 6, 7 and 8, or where
   * between 40 and 50 percent of the ventilation is in the upper third of the
   * space with the rest at the eaves.
   */
  ventilationRatioReduced: {
    section: 'R806.2',
    title: 'Attic ventilation, reduced',
    ratio: 1 / 300,
    asWritten: '1/300 where the conditions of the R806.2 exception are met',
  },
  /** R806.3 — 1 in of airspace between the insulation and the sheathing. */
  minAirspace: limit('R806.3', 'Airspace above insulation', inches(1), '1 in'),
  /** R807.1 — an attic bigger than this, and taller than 30 in, needs a hatch. */
  accessRequiredArea: {
    section: 'R807.1',
    title: 'Attic access',
    squareMetres: 30 * 0.3048 * 0.3048,
    asWritten: '30 sq ft',
  },
  accessRequiredHeight: limit('R807.1', 'Attic height requiring access', inches(30), '30 in'),
  accessWidth: limit('R807.1', 'Attic access opening, width', inches(22), '22 in'),
  accessLength: limit('R807.1', 'Attic access opening, length', inches(30), '30 in'),
  accessHeadroom: limit('R807.1', 'Headroom above the attic access', inches(30), '30 in'),
} as const;

/* ---------------------- R302.1 Distance to the lot line ------------------- */

/**
 * How close a house and its eaves may come to the property line.
 *
 * Fire spread between buildings, which is why it is in the building code at all
 * — as opposed to the setbacks in a zoning ordinance, which are about light,
 * air and the look of a street, are set locally, and are the user's to enter.
 * Both are checked; only these come with a section number.
 */
export const IRC_LOT_LINE = {
  /** Table R302.1(1) — below this, the exterior wall must be fire-rated. */
  wallRated: limit('R302.1', 'Fire separation distance, exterior walls', feet(5), '5 ft'),
  /** Table R302.1(1) — projections are not permitted at all inside 2 ft. */
  projectionNone: limit('R302.1', 'Fire separation distance, projections', feet(2), '2 ft'),
  /** Table R302.1(1) — an eave between 2 ft and 5 ft needs 1-hour protection. */
  projectionRated: limit('R302.1', 'Projections requiring protection', feet(5), '5 ft'),
  /** Table R302.1(1) — no openings at all inside 3 ft. */
  openingsNone: limit('R302.1', 'Fire separation distance, openings', feet(3), '3 ft'),
} as const;

/* --------------------------- R308.6 Sloped glazing ------------------------ */

export const IRC_SKYLIGHTS = {
  /**
   * R308.6.2 — what a skylight may be glazed with.
   *
   * Not a measurement: a list. Ordinary annealed glass is not on it, because
   * overhead it breaks into pieces that fall on whoever is underneath.
   */
  permittedGlazing: {
    section: 'R308.6.2',
    title: 'Sloped glazing materials',
    asWritten:
      'laminated glass, fully tempered glass, heat-strengthened glass, wired glass or approved rigid plastic',
  },
  /**
   * R308.6.8 — a curb, where the manufacturer calls for one.
   *
   * Quoted rather than enforced: the requirement is to follow the
   * manufacturer's instructions, and this app does not know the unit.
   */
  curb: {
    section: 'R308.6.8',
    title: 'Skylight curbs',
    asWritten: 'installed on a curb where the manufacturer requires one',
  },
} as const;

/**
 * "4:12" — a pitch as a roofer says it.
 *
 * Rounded to the nearest quarter unit, which is as fine as roof slopes are ever
 * quoted, and written over 12 because that is the only denominator anybody uses.
 */
export function asPitch(pitch: number): string {
  const rise = Math.round(pitch * 12 * 4) / 4;
  const whole = Math.floor(rise);
  const fraction = rise - whole;
  const fractionText =
    fraction === 0.25 ? ' 1/4' : fraction === 0.5 ? ' 1/2' : fraction === 0.75 ? ' 3/4' : '';
  return `${whole}${fractionText}:12`;
}

/**
 * Formats a measurement the way an American builder would say it.
 *
 * Feet and inches, with the inches to the nearest sixteenth and the fraction
 * reduced — "6 ft 8 1/4 in", not "6.6875 ft" and not "2.038 m". The app stores
 * metres and this is the only place that decides how a length appears next to
 * a code citation, so that a figure and the limit it failed are always in the
 * same units.
 */
export function asFeetInches(metres: number): string {
  const totalInches = metres / 0.0254;
  const sixteenths = Math.round(totalInches * 16);

  const wholeFeet = Math.floor(sixteenths / (12 * 16));
  const remainder = sixteenths - wholeFeet * 12 * 16;
  const wholeInches = Math.floor(remainder / 16);
  let numerator = remainder - wholeInches * 16;
  let denominator = 16;

  while (numerator > 0 && numerator % 2 === 0) {
    numerator /= 2;
    denominator /= 2;
  }

  const fraction = numerator > 0 ? `${numerator}/${denominator}` : '';
  const inchPart =
    wholeInches > 0 && fraction
      ? `${wholeInches} ${fraction} in`
      : fraction
        ? `${fraction} in`
        : `${wholeInches} in`;

  if (wholeFeet === 0) return inchPart;
  if (remainder === 0) return `${wholeFeet} ft`;
  return `${wholeFeet} ft ${inchPart}`;
}

/** "8 1/8 in exceeds the 7 3/4 in allowed by IRC R311.7.5.1". */
export function citeExceeded(actual: number, against: CodeLimit): string {
  return `${asFeetInches(actual)} exceeds the ${against.asWritten} allowed by IRC ${against.section}`;
}

/** "9 1/2 in is short of the 10 in required by IRC R311.7.5.2". */
export function citeShortOf(actual: number, against: CodeLimit): string {
  return `${asFeetInches(actual)} is short of the ${against.asWritten} required by IRC ${against.section}`;
}

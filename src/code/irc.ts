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

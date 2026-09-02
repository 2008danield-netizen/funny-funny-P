/**
 * The design advisor's vocabulary.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * This is a RULES ENGINE, not a language model. Every judgement it makes is
 * written down as code in `rules.ts`, against a published interior-design
 * guideline, with the measurement that failed. It runs offline, instantly, for
 * free, and it gives the same answer twice.
 *
 * The trade is that it can only say what it has been taught to say. It does not
 * look at your room and think; it checks a list. That list is deliberately
 * explicit — every rule names its guideline and shows its arithmetic — so when
 * an LLM advisor is added later it has something to argue with rather than
 * something to replace. A model that says "the sofa is too far from the coffee
 * table" and a rule that says "the reach is 82 cm, the guideline is 30-45 cm"
 * are not competitors; the second is what makes the first checkable.
 * -----------------------------------------------------------------------------
 *
 * Two things every finding must have, or it is noise:
 *
 *   1. A MEASUREMENT. "The room feels unbalanced" is horoscope writing. "84% of
 *      the furniture mass sits on the north half of the room" is a fact someone
 *      can disagree with.
 *   2. A REASON. A user who is told to move the coffee table and not told why
 *      learns nothing and will make the same layout again tomorrow.
 *
 * And where it can be done safely, a FIX: a concrete, applicable change. A fix
 * is a data description of an edit, not a closure, so it can be inspected,
 * tested, and shown to the user before it happens.
 */

import type { Point2 } from '@/state/types';

/** What sort of design question a finding is about. */
export type FindingCategory =
  | 'empty'
  | 'focal'
  | 'conversation'
  | 'rug'
  | 'balance'
  | 'alignment'
  | 'scale'
  | 'lighting'
  | 'colour'
  | 'sleep'
  | 'work'
  | 'dining'
  | 'circulation';

/**
 * How much a finding matters.
 *
 * 'praise' is a first-class severity rather than an afterthought. A panel that
 * only ever lists faults trains the user to close it; one that says what is
 * working teaches the principle far more effectively than the same principle
 * stated as a complaint.
 */
export type FindingSeverity = 'critical' | 'improve' | 'polish' | 'praise';

/** What the app should select when the user clicks a finding. */
export type FindingFocus =
  | { kind: 'furniture'; id: string }
  | { kind: 'floor'; id: string }
  | { kind: 'opening'; id: string }
  | null;

/**
 * A change the advisor can make for you.
 *
 * Described as DATA, deliberately. A closure would be simpler to write and
 * impossible to show the user, to test in isolation, or to serialise into a
 * "here is what I would do" preview. Every variant carries its own `label`,
 * which is the button text, phrased as the action it performs.
 *
 * Applying a fix goes through the ordinary placement machinery in
 * `state/furnitureOps.ts`, so a fix is subject to exactly the same collision
 * and containment guarantees as a human drag. The advisor cannot produce a
 * layout you could not have produced yourself.
 */
export type Fix =
  /** Slide one piece to a new spot, optionally turning it at the same time. */
  | { kind: 'move'; label: string; itemId: string; to: Point2; rotation?: number }
  /** Turn one piece where it stands. */
  | { kind: 'rotate'; label: string; itemId: string; rotation: number }
  /** Several moves that only make sense together — chairs round a table. */
  | { kind: 'moveMany'; label: string; moves: Array<{ itemId: string; to: Point2; rotation?: number }> }
  /** Drop a new piece in. */
  | { kind: 'add'; label: string; catalogId: string; at: Point2; rotation: number }
  /** Take a piece out. */
  | { kind: 'remove'; label: string; itemId: string }
  /** Replace a piece with a different product in the same spot. */
  | { kind: 'swap'; label: string; itemId: string; toCatalogId: string }
  /** Repaint a room's walls. */
  | { kind: 'paint'; label: string; roomKey: string; color: string }
  /**
   * Hand off to the generator.
   *
   * Not applied by `applyFix` — the UI opens the furnish controls instead, so
   * the user chooses a budget and a style rather than having a room filled
   * with a guess at both.
   */
  | { kind: 'furnish'; label: string; roomKey: string; program: RoomProgram };

/** One thing the advisor noticed. */
export interface Finding {
  /** Stable within a report, so React keys and "applied" state survive a re-run. */
  id: string;
  /** Which rule produced it, for testing and for suppressing a rule later. */
  rule: string;
  category: FindingCategory;
  severity: FindingSeverity;
  /** One sentence naming what is going on. No jargon. */
  title: string;
  /** The measurement, and the guideline it is judged against. */
  detail: string;
  /** The design principle behind it — why anybody should care. */
  why: string;
  /** Region key of the room it concerns, or null for whole-design findings. */
  roomKey: string | null;
  focus: FindingFocus;
  /** Somewhere to point a marker, when there is a sensible place. */
  at: Point2 | null;
  /**
   * Points knocked off the design score. Zero for praise.
   *
   * Weights are small on purpose: a room with four polish-level notes should
   * still score well, because it is a good room with four small notes.
   */
  weight: number;
  fix: Fix | null;
}

/** What a room is for. Inferred from what stands in it. */
export type RoomProgram = 'living' | 'bedroom' | 'dining' | 'office' | 'unknown';

/** Per-room figures shown above the findings. */
export interface RoomSummary {
  roomKey: string;
  name: string;
  program: RoomProgram;
  /** Floor area in square metres. */
  area: number;
  itemCount: number;
  /** Furniture footprint as a fraction of floor area, 0-1. */
  density: number;
  /** This room's share of the score, 0-100. */
  score: number;
}

export type ScoreBand = 'needs-work' | 'fair' | 'good' | 'excellent';

export interface AdvisorReport {
  /** 0-100. See `scoreFrom` in `advise.ts` for exactly how it is computed. */
  score: number;
  band: ScoreBand;
  findings: Finding[];
  rooms: RoomSummary[];
  /** Counts by severity, for the panel's badge. */
  counts: Record<FindingSeverity, number>;
}

/* ------------------------------- Guidelines ---------------------------- */

/**
 * The numbers every rule is judged against, in metres unless stated.
 *
 * Gathered in one place and exported so they are inspectable rather than
 * scattered through comparisons. These are widely published interior-design
 * conventions, not building code — they are guidance, and the panel says so.
 * Anyone who disagrees with one can see precisely which number to argue with.
 */
export const GUIDELINES = {
  /** Comfortable reach from the front of a seat to a coffee table. */
  coffeeTableGap: { min: 0.3, max: 0.45, tooFar: 0.75 },
  /** Beyond this, people in a seating group have to raise their voices. */
  conversationSpan: 2.7,
  /** A rug under a seating group should reach at least this far past its front. */
  rugOvershoot: 0.3,
  /** Angle within which a seat counts as "facing" a focal point, in radians. */
  focalTolerance: (60 * Math.PI) / 180,
  /** How far a sofa should sit from a television. */
  tvViewing: { min: 1.8, max: 4.2 },
  /** Furniture footprint over floor area: below is sparse, above is crowded. */
  density: { sparse: 0.14, crowded: 0.55 },
  /** No single piece should be wider than this fraction of the room's short span. */
  dominantWidth: 0.62,
  /** Two pieces this close to parallel are meant to be parallel, in radians. */
  alignmentAngle: (8 * Math.PI) / 180,
  /** Edges this close to flush are meant to be flush. */
  alignmentOffset: 0.12,
  /** A room bigger than this wants more than one light source. */
  needsLampArea: 8,
  /** A room bigger than this wants a third. */
  needsSecondLampArea: 18,
  /** Below this luminance difference, two surfaces read as one. */
  contrastFloor: 0.07,
  /** A bed's headboard should sit this close to its wall. */
  headboardGap: 0.25,
  /** Access needed down at least one side of a bed. */
  bedSideAccess: 0.6,
  /** Everything within this of a wall means nothing is floating. */
  wallHugging: 0.35,
  /** A room this size or larger looks better with something off the walls. */
  floatingRoomArea: 17,
  /** Distinct hue families among the soft furnishings before a room reads busy. */
  paletteHues: 3,
} as const;

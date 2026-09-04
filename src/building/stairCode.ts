/**
 * Checking a staircase against the IRC.
 *
 * -----------------------------------------------------------------------------
 * WHAT A FINDING HERE HAS TO CONTAIN.
 *
 * Three things, every time, or it is not worth reporting:
 *
 *   1. THE MEASUREMENT — what this stair actually is. "8 1/8 in".
 *   2. THE LIMIT — what the code allows. "7 3/4 in".
 *   3. THE SECTION — where that comes from. "IRC R311.7.5.1".
 *
 * The third one is what separates this from an opinion. A builder, an inspector
 * or an engineer can take a finding from this app, open the code book at the
 * section named, and see in thirty seconds whether we read it right. Without the
 * citation they would have to redo the work to check it, and then the app has
 * saved nobody anything.
 *
 * It also means being wrong is recoverable. If a limit here is misread, or the
 * code moves on an edition, the finding says exactly which line to go and look
 * at — rather than the app quietly producing plausible numbers from an
 * unfindable source.
 * -----------------------------------------------------------------------------
 *
 * These are checks, not permission. Passing everything below does not make a
 * staircase approved by anybody; a real build needs a permit and an inspection.
 * What this does is catch the ordinary mistakes while they are still free to
 * fix, and show its arithmetic to the person who will sign it off.
 */

import {
  IRC_GUARDS,
  IRC_STAIRS,
  asFeetInches,
  citeExceeded,
  citeShortOf,
  inches,
  type CodeLimit,
} from '@/code/irc';
import { stairGeometry, type StairGeometry } from './stairs';
import { levelAbove, levelById } from '@/state/levels';
import { findRegions } from '@/scene/planGraph';
import { pointInPolygon } from '@/physics/collision';
import type { DesignDocument, Stair } from '@/state/types';

/**
 * How seriously to take a finding.
 *
 * 'violation' means the code says no. 'caution' means it is legal and worth
 * knowing — a stair at the very limit of what is allowed is a stair somebody
 * will find steep, and saying so is the difference between a compliance checker
 * and a useful one.
 */
export type CodeSeverity = 'violation' | 'caution' | 'pass';

export interface CodeFinding {
  id: string;
  severity: CodeSeverity;
  /** The code section, e.g. "R311.7.5.1". Empty only for non-code cautions. */
  section: string;
  /** One sentence naming the problem. */
  title: string;
  /** The measurement, the limit, and the citation. */
  detail: string;
  /** What it would take to comply — arithmetic, not vague advice. */
  remedy: string;
  stairId: string;
}

export interface StairReport {
  stairId: string;
  geometry: StairGeometry;
  findings: CodeFinding[];
  /** True when nothing on the stair breaks the code. */
  compliant: boolean;
}

/* -------------------------------- The checks ------------------------------ */

/**
 * Runs every check this app knows against one staircase.
 *
 * A spiral is judged under R311.7.10.1 rather than the general rules, because
 * the code gives it its own regime: steeper risers and shallower treads are
 * permitted on the understanding that a spiral is a secondary route rather
 * than the main way between floors. Applying the general limits to one would
 * report a perfectly legal stair as three violations.
 */
export function checkStair(doc: DesignDocument, stair: Stair): StairReport {
  const geometry = stairGeometry(doc, stair);
  const findings: CodeFinding[] = [];
  const spiral = stair.form.kind === 'spiral';

  const add = (
    id: string,
    severity: CodeSeverity,
    limit: CodeLimit | null,
    title: string,
    detail: string,
    remedy: string,
  ) => {
    findings.push({
      id: `${stair.id}:${id}`,
      severity,
      section: limit?.section ?? '',
      title,
      detail,
      remedy,
      stairId: stair.id,
    });
  };

  /* ---------------------------- Nothing to check --------------------------- */

  if (!levelAbove(doc, stair.fromLevelId)) {
    add(
      'no-storey',
      'caution',
      null,
      'This stair has nowhere to go',
      'There is no storey above the one it stands on.',
      'Add a floor above, or delete the stair.',
    );
    return { stairId: stair.id, geometry, findings, compliant: false };
  }

  /* -------------------------------- Risers -------------------------------- */

  const riserLimit = spiral ? IRC_STAIRS.spiral.maxRiser : IRC_STAIRS.maxRiser;
  if (geometry.riserHeight > riserLimit.metres + 1e-6) {
    // The remedy is arithmetic, not advice: how many steps it would take.
    const needed = Math.ceil(geometry.totalRise / riserLimit.metres);
    add(
      'riser-height',
      'violation',
      riserLimit,
      'The steps are too tall',
      `Each riser is ${citeExceeded(geometry.riserHeight, riserLimit)}.`,
      `${geometry.totalRise > 0 ? `${needed} risers` : 'More risers'} would bring it to ` +
        `${asFeetInches(geometry.totalRise / Math.max(1, needed))} a step.`,
    );
  } else if (geometry.riserHeight > riserLimit.metres - inches(0.25)) {
    add(
      'riser-steep',
      'caution',
      riserLimit,
      'The steps are at the limit of what is allowed',
      `${asFeetInches(geometry.riserHeight)} a step, against the ${riserLimit.asWritten} maximum in IRC ${riserLimit.section}.`,
      `Around ${asFeetInches(inches(7))} is the comfortable figure; one more riser would get you there.`,
    );
  }

  /* -------------------------------- Treads -------------------------------- */

  if (spiral) {
    const limit = IRC_STAIRS.spiral.minTreadAtWalkline;
    const depth = geometry.treads[0]?.depthAtWalkline ?? 0;
    if (depth < limit.metres - 1e-6) {
      add(
        'spiral-tread',
        'violation',
        limit,
        'The spiral treads are too shallow where people walk',
        `${citeShortOf(depth, limit)}, measured ${IRC_STAIRS.spiral.walklineOffset.asWritten} out from the pole as the section requires.`,
        `A wider pole or a deeper going would fix it: at this radius the tread needs ` +
          `${asFeetInches(limit.metres)} of arc.`,
      );
    }
  } else {
    const limit = IRC_STAIRS.minTread;
    const straight = geometry.treads.filter((tread) => tread.kind === 'straight');
    const shallowest = straight.reduce(
      (worst, tread) => Math.min(worst, tread.depthAtWalkline),
      Infinity,
    );
    if (straight.length > 0 && shallowest < limit.metres - 1e-6) {
      add(
        'tread-depth',
        'violation',
        limit,
        'The treads are too shallow',
        `${citeShortOf(shallowest, limit)}.`,
        `Deepen the going to at least ${limit.asWritten}. That lengthens the stair by ` +
          `${asFeetInches((limit.metres - shallowest) * straight.length)}.`,
      );
    }
  }

  /* -------------------------------- Winders -------------------------------- */

  const winders = geometry.treads.filter((tread) => tread.kind === 'winder');
  if (winders.length > 0) {
    const atWalkline = IRC_STAIRS.minWinderTreadAtWalkline;
    const anywhere = IRC_STAIRS.minWinderTreadAnywhere;

    const shallowestWalkline = winders.reduce(
      (worst, tread) => Math.min(worst, tread.depthAtWalkline),
      Infinity,
    );
    if (shallowestWalkline < atWalkline.metres - 1e-6) {
      /*
       * The arithmetic that rescues a winder, spelled out.
       *
       * Depth at the walkline is (newel radius + 12 in) x the angle per tread.
       * So there are exactly two ways out: a fatter newel, or fewer treads
       * across the turn. Telling somebody "this winder does not comply" without
       * that is telling them they have a problem and not how to solve it.
       */
      const form = stair.form.kind === 'winder' ? stair.form : null;
      const step = Math.PI / 2 / Math.max(1, form?.winderTreads ?? 1);
      const neededRadius = atWalkline.metres / step - IRC_STAIRS.winderWalklineOffset.metres;

      add(
        'winder-walkline',
        'violation',
        atWalkline,
        'The winder treads are too shallow where people walk',
        `${citeShortOf(shallowestWalkline, atWalkline)}, measured at the walkline ` +
          `${IRC_STAIRS.winderWalklineOffset.asWritten} out from the narrow edge.`,
        `Either a newel of at least ${asFeetInches(Math.max(0, neededRadius))} radius, or fewer ` +
          `treads across the turn. A winder that converges to a point cannot comply at any size.`,
      );
    }

    const pinch = winders.reduce((worst, tread) => Math.min(worst, tread.minDepth), Infinity);
    if (pinch < anywhere.metres - 1e-6) {
      add(
        'winder-pinch',
        'violation',
        anywhere,
        'The winder treads pinch to nothing at the inside',
        `${citeShortOf(pinch, anywhere)} at the narrow end.`,
        `The newel has to be at least ${asFeetInches(anywhere.metres / (Math.PI / 2 / Math.max(1, winders.length)))} in radius to hold ${anywhere.asWritten} there.`,
      );
    }
  }

  /* ------------------------------- Uniformity ------------------------------ */

  /*
   * Uniformity is guaranteed by construction here rather than checked: the
   * riser height is derived by dividing the storey rise by a whole number of
   * steps, so every riser in a flight is identical to the last floating-point
   * bit. This is the single most-cited stair defect in the country, and the
   * app makes it impossible rather than reporting it — which is the better
   * kind of compliance.
   *
   * Tread depth is not automatic, because a winder mixes tapered treads with
   * straight ones. The code measures those separately, which is exactly why
   * they are checked separately above.
   */

  /* --------------------------------- Width -------------------------------- */

  const widthLimit = spiral ? IRC_STAIRS.spiral.minWidth : IRC_STAIRS.minWidth;
  if (stair.width < widthLimit.metres - 1e-6) {
    add(
      'width',
      'violation',
      widthLimit,
      'The stair is too narrow',
      `${citeShortOf(stair.width, widthLimit)}.`,
      `Widen it to ${widthLimit.asWritten}.`,
    );
  } else if (!spiral && stair.handrail === 'both') {
    // Handrails eat into the clear width below rail height.
    const clear = stair.width - 2 * IRC_STAIRS.maxHandrailProjection.metres;
    const limit = IRC_STAIRS.minWidthTwoRails;
    if (clear < limit.metres - 1e-6) {
      add(
        'width-at-rails',
        'caution',
        limit,
        'Two handrails leave little room between them',
        `${asFeetInches(clear)} clear if both rails project the full ` +
          `${IRC_STAIRS.maxHandrailProjection.asWritten}; IRC ${limit.section} requires ` +
          `${limit.asWritten}.`,
        `Slimmer rails, one rail instead of two, or ${asFeetInches(limit.metres + 2 * IRC_STAIRS.maxHandrailProjection.metres)} of overall width.`,
      );
    }
  }

  /* -------------------------------- Landings ------------------------------- */

  for (const landing of geometry.landings) {
    const limit = IRC_STAIRS.minLanding;
    if (landing.depthAtWalkline < limit.metres - 1e-6) {
      add(
        `landing-${landing.index}`,
        'violation',
        limit,
        'The landing is too shallow',
        `${citeShortOf(landing.depthAtWalkline, limit)} measured in the direction of travel.`,
        `A landing is at least ${limit.asWritten} deep, whatever the stair's width.`,
      );
    }
  }

  /* ------------------------------ Flight rise ------------------------------ */

  const flightLimit = IRC_STAIRS.maxFlightRise;
  if (geometry.landings.length === 0 && geometry.totalRise > flightLimit.metres + 1e-6) {
    add(
      'flight-rise',
      'violation',
      flightLimit,
      'The flight climbs too far without a landing',
      `${citeExceeded(geometry.totalRise, flightLimit)} in one unbroken run.`,
      'Break it with a landing — an L-shaped or U-shaped stair does that by design.',
    );
  }

  /* ------------------------------- Handrails ------------------------------- */

  if (
    stair.handrail === 'none' &&
    geometry.riserCount >= IRC_STAIRS.handrailRequiredAtRisers
  ) {
    add(
      'handrail',
      'violation',
      IRC_STAIRS.minHandrailHeight,
      'This stair needs a handrail',
      `${geometry.riserCount} risers; IRC ${IRC_STAIRS.minHandrailHeight.section} requires a ` +
        `graspable handrail on at least one side of any flight of ` +
        `${IRC_STAIRS.handrailRequiredAtRisers} or more.`,
      `Add one, ${IRC_STAIRS.minHandrailHeight.asWritten} to ${IRC_STAIRS.maxHandrailHeight.asWritten} above the nosings.`,
    );
  }

  /* --------------------------------- Guards -------------------------------- */

  /*
   * A stairwell is a hole in a floor with a drop through it, so the floor
   * around it needs a guard. The rule is about the DROP, not about the stair:
   * anything more than 30 in above what is below it, within 36 in of the edge.
   * A storey is always more than 30 in, so a stairwell always needs one.
   */
  if (geometry.wellOpening.length >= 3) {
    add(
      'guard',
      'caution',
      IRC_GUARDS.minHeight,
      'The stairwell opening needs a guard around it',
      `The drop is ${asFeetInches(geometry.totalRise)}; IRC ${IRC_GUARDS.requiredAboveDrop.section} ` +
        `requires a guard wherever it exceeds ${IRC_GUARDS.requiredAboveDrop.asWritten}.`,
      `At least ${IRC_GUARDS.minHeight.asWritten} high, with nothing in it that passes a ` +
        `${IRC_GUARDS.maxOpening.asWritten} sphere (IRC ${IRC_GUARDS.maxOpening.section}).`,
    );
  }


  /* ------------------------------ Containment ------------------------------ */

  /*
   * Does the staircase actually fit inside the building?
   *
   * A stair is the one piece of a house whose length is not chosen directly —
   * it is the storey rise divided into steps, multiplied by the going. A
   * comfortable 16-riser flight at an 11 in going is over 13 ft long, which is
   * more than the depth of most rooms. So the commonest mistake by far is a
   * stair that runs straight out through a wall, and it is invisible in plan
   * until you look for it.
   *
   * Reported with the arithmetic, because the fix follows from it: a shorter
   * going, fewer risers, or a turn to fold the run back on itself.
   */
  const level = levelById(doc, stair.fromLevelId);
  if (level) {
    const regions = findRegions(level.plan);
    const outside = geometry.treads.filter(
      (tread) =>
        !tread.polygon.every((corner) =>
          regions.some((region) => pointInPolygon(corner, region.polygon)),
        ),
    );

    if (regions.length > 0 && outside.length > 0) {
      const run = totalRun(geometry);
      add(
        'containment',
        'violation',
        null,
        'The staircase runs outside the building',
        `${outside.length} of ${geometry.treads.length} treads fall outside every room on this ` +
          `storey. The flight is ${asFeetInches(run)} long — ${geometry.treads.length} treads at ` +
          `${asFeetInches(stair.treadDepth)}.`,
        'Turn it into an L or a U to fold the run back, shorten the going, or move it to a ' +
          'longer wall. A straight flight cannot be shorter than its own run.',
      );
    }
  }

  return {
    stairId: stair.id,
    geometry,
    findings,
    compliant: !findings.some((finding) => finding.severity === 'violation'),
  };
}


/**
 * How far a flight reaches, corner to corner in plan.
 *
 * Not the sum of the goings: a turned stair folds back on itself, so its
 * treads add up to far more than the floor it occupies. This is the figure
 * that matters when asking whether it fits in a room.
 */
function totalRun(geometry: StairGeometry): number {
  let longest = 0;
  const points = geometry.footprint;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      longest = Math.max(longest, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.z - points[j]!.z));
    }
  }
  return longest;
}

/** Every staircase in the building, checked. */
export function checkAllStairs(doc: DesignDocument): StairReport[] {
  return doc.stairs.map((stair) => checkStair(doc, stair));
}

/**
 * A one-line summary of a stair's proportions, for the inspector.
 *
 * Riser and going together, because that pair is how anybody who builds stairs
 * describes one — and because either number alone tells you nothing about
 * whether it will be comfortable to climb.
 */
export function describeStair(geometry: StairGeometry): string {
  return (
    `${geometry.riserCount} risers at ${asFeetInches(geometry.riserHeight)}, ` +
    `${asFeetInches(geometry.treads[0]?.depthAtWalkline ?? 0)} going`
  );
}

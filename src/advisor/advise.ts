/**
 * Running the rules, and turning what they say into a score.
 *
 * -----------------------------------------------------------------------------
 * ABOUT THE SCORE.
 *
 * A single number for "how good is this room" is a lie, and it is a useful one.
 * It is a lie because taste is not scalar and because the advisor only knows
 * the rules it has been given. It is useful because it makes the panel's state
 * legible at a glance, it gives a designer something to show a client, and — the
 * real reason — it makes the effect of a change visible immediately, which is
 * how people learn the guidelines rather than just obeying them.
 *
 * So it is computed transparently and stated modestly. Every point deducted
 * comes from a finding the user can read, with the measurement that caused it.
 * Nothing is hidden in a weighting nobody can see, and the panel never claims
 * the number means more than it does.
 *
 * The shape of the curve matters too. Deductions are summed and then applied
 * with diminishing returns rather than subtracted outright, because a room with
 * eight polish-level notes is not eight times worse than a room with one — it
 * is a room with a lot of small notes, and a linear score would put it below a
 * room with one genuinely serious problem. Critical findings are exempted from
 * the softening: something you cannot walk to should drag the score hard.
 * -----------------------------------------------------------------------------
 */

import { findRegions } from '@/scene/planGraph';
import { analyseClearance, type ClearanceReport } from '@/clearance/analyze';
import { readRooms, type RoomContext } from './rooms';
import { checkAllStairs } from '@/building/stairCode';
import { RULES } from './rules';
import type { AdvisorReport, Finding, FindingSeverity, RoomSummary, ScoreBand } from './types';
import type { DesignDocument, Level } from '@/state/types';

/**
 * The most that advisory notes alone can cost a design.
 *
 * A room with a dozen small observations is one somebody has furnished and not
 * yet tidied. It should land in "fair", not in "needs work" — that band is
 * reserved for designs with something genuinely wrong with them.
 */
const SOFT_CEILING = 45;

/** Sort order for the findings list: worst first, praise last. */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  improve: 1,
  polish: 2,
  praise: 3,
};

/**
 * Runs every rule over every room.
 *
 * `clearance` is optional and passed in by the UI, which has already computed
 * it for the Clearance panel. Recomputing it here would double the cost of the
 * most expensive analysis in the app on every drag frame.
 */
export function adviseDesign(
  doc: DesignDocument,
  level: Level,
  clearance?: ClearanceReport,
): AdvisorReport {
  const regions = findRegions(level.plan);
  const report = clearance ?? analyseClearance(doc, level);
  const contexts = readRooms(doc, level, regions, report.circulation);

  const findings: Finding[] = [...stairFindings(doc, level)];
  for (const context of contexts) {
    for (const rule of RULES) {
      try {
        findings.push(...rule(context));
      } catch (error) {
        // A rule that throws must not take the panel down with it. Design
        // advice is the least important thing on screen; the room is the most,
        // and a bad rule must never be able to blank the viewport.
        console.error('Advisor rule failed', error);
      }
    }
  }

  findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.weight - a.weight;
  });

  const rooms = contexts.map((context) => summarise(context, findings));

  const counts: Record<FindingSeverity, number> = {
    critical: 0,
    improve: 0,
    polish: 0,
    praise: 0,
  };
  for (const item of findings) counts[item.severity] += 1;

  const score = scoreFrom(findings);

  return { score, band: bandFor(score), findings, rooms, counts };
}

/**
 * The staircases on this storey, as advisor findings.
 *
 * Code violations arrive as 'critical' and carry real weight: unlike every
 * other rule in the advisor, these are not matters of taste that a designer may
 * knowingly trade away. A stair with 8 1/2 inch risers is not a bold choice.
 */
function stairFindings(doc: DesignDocument, level: Level): Finding[] {
  const findings: Finding[] = [];

  for (const report of checkAllStairs(doc)) {
    const stair = doc.stairs.find((candidate) => candidate.id === report.stairId);
    if (!stair || stair.fromLevelId !== level.id) continue;

    for (const finding of report.findings) {
      if (finding.severity === 'pass') continue;
      findings.push({
        id: finding.id,
        rule: 'irc-stairs',
        category: 'code',
        severity: finding.severity === 'violation' ? 'critical' : 'polish',
        title: `${stair.name}: ${finding.title}`,
        detail: finding.detail,
        why: finding.remedy,
        section: finding.section,
        roomKey: null,
        focus: null,
        at: stair.at,
        // A violation is a defect, not a preference, so it costs more than any
        // layout note can. Two of them should visibly wreck the score.
        weight: finding.severity === 'violation' ? 18 : 2,
        fix: null,
      });
    }
  }

  return findings;
}

/**
 * The score, from the findings alone.
 *
 * Exported and tested directly, so the curve can be argued with rather than
 * reverse-engineered from the panel.
 */
export function scoreFrom(findings: readonly Finding[]): number {
  let soft = 0;
  let hard = 0;

  for (const item of findings) {
    if (item.severity === 'praise') continue;
    if (item.severity === 'critical') hard += item.weight;
    else soft += item.weight;
  }

  /*
   * Diminishing returns on the soft pile.
   *
   * The curve is `k(1 - e^(-soft/k))`, and the two properties that matter both
   * come from using the SAME k in both places: its slope at zero is exactly 1,
   * so the first note costs its face value and no more, and it asymptotes at k,
   * so no quantity of small notes alone can take a room below 100 - k.
   *
   * Getting that wrong is not academic. An earlier version used a smaller
   * divisor, which gave the curve a slope of 2 at the origin — every early note
   * cost double its stated weight, and five polish notes outscored a room with
   * something in it you could not physically walk to. A design score has to
   * rank a real problem above a pile of small ones or it is worse than no score.
   */
  const softened = SOFT_CEILING * (1 - Math.exp(-soft / SOFT_CEILING));

  return Math.max(0, Math.round(100 - softened - hard));
}

export function bandFor(score: number): ScoreBand {
  if (score >= 88) return 'excellent';
  if (score >= 72) return 'good';
  if (score >= 55) return 'fair';
  return 'needs-work';
}

/** A human label for a band. */
export function bandLabel(band: ScoreBand): string {
  switch (band) {
    case 'excellent':
      return 'Excellent';
    case 'good':
      return 'Good';
    case 'fair':
      return 'Fair';
    case 'needs-work':
      return 'Needs work';
  }
}

function summarise(context: RoomContext, findings: readonly Finding[]): RoomSummary {
  const mine = findings.filter((item) => item.roomKey === context.region.key);
  return {
    roomKey: context.region.key,
    name: context.spec.name,
    program: context.program,
    area: context.area,
    itemCount: context.items.length,
    density: context.density,
    score: scoreFrom(mine),
  };
}

/**
 * The one-line summary shown beside the score.
 *
 * Written to be honest about what the number is: it is the rules' opinion, not
 * a verdict, and the wording keeps saying so without nagging.
 */
export function headline(report: AdvisorReport): string {
  const { critical, improve, polish } = report.counts;

  if (report.findings.length === 0) return 'Nothing to look at yet — draw a room and put something in it.';
  if (critical > 0) {
    return `${critical} thing${critical === 1 ? '' : 's'} to fix before anything else.`;
  }
  if (improve > 0) {
    return `${improve} change${improve === 1 ? '' : 's'} that would make a real difference.`;
  }
  if (polish > 0) {
    return `${polish} small note${polish === 1 ? '' : 's'} — the layout is sound.`;
  }
  return 'Every rule this app knows is satisfied.';
}

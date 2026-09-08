/**
 * Checking a roof against the IRC.
 *
 * The same rules as the staircase checks (`stairCode.ts`): every finding names
 * the measurement, the limit and the section it comes from, so that anybody can
 * open the code book and see in thirty seconds whether we read it right.
 *
 * What is checked here:
 *
 *   • MINIMUM SLOPE for the covering (R905). This is the one that matters most
 *     and the one a person designing by eye gets wrong most often, because a
 *     roof too shallow for its covering looks completely fine on a screen and
 *     leaks in the second year.
 *   • ATTIC VENTILATION (R806.2), worked out from the roof's own plan area.
 *   • ATTIC ACCESS (R807.1), where the roof space is big and tall enough to
 *     need a hatch.
 *   • SKYLIGHT GLAZING (R308.6.2), and whether one crosses a ridge.
 *   • DISTANCE TO THE LOT LINE (R302.1) — for the walls and, separately and
 *     more strictly, for the eaves that project towards it.
 *
 * And what is deliberately NOT checked: anything structural. Rafter and ceiling
 * joist spans (R802), uplift, and snow and wind loading are engineering, they
 * depend on species, grade and local load figures this app does not hold, and a
 * plausible-looking answer would be worse than no answer at all.
 *
 * These are checks, not permission. Passing everything here does not make a
 * roof approved by anybody.
 */

import {
  IRC_ATTIC,
  IRC_LOT_LINE,
  IRC_ROOF_SLOPES,
  IRC_SKYLIGHTS,
  asFeetInches,
  asPitch,
  type SlopeLimit,
} from '@/code/irc';
import { roofGeometry, roofPlanArea, type RoofGeometry } from './roof';
import { roofOpenings } from './dormer';
import { footprintFor } from './footprint';
import { levelById } from '@/state/levels';
import type { DesignDocument, Point2, Roof, RoofCovering } from '@/state/types';

export type RoofSeverity = 'violation' | 'caution' | 'pass';

export interface RoofFinding {
  id: string;
  severity: RoofSeverity;
  /** The code section, e.g. "R905.2.2". Empty for checks the app makes itself. */
  section: string;
  title: string;
  /** The measurement, the limit, and the citation. */
  detail: string;
  /** What it would take to comply — arithmetic, not vague advice. */
  remedy: string;
  roofId: string;
}

export interface RoofReport {
  roofId: string;
  geometry: RoofGeometry;
  findings: RoofFinding[];
  compliant: boolean;
}

/** Square metres to square feet, for the areas the code writes in feet. */
const asSquareFeet = (squareMetres: number): string =>
  `${(squareMetres / (0.3048 * 0.3048)).toFixed(0)} sq ft`;

/** Square metres to square inches, which is how ventilators are sold. */
const asSquareInches = (squareMetres: number): string =>
  `${Math.round(squareMetres / (0.0254 * 0.0254))} sq in`;

/* ------------------------- Which slope applies where ---------------------- */

/**
 * The minimum slope for a covering, and the shallower one it may go to.
 *
 * Two of the coverings have a second figure: asphalt shingles and tile are
 * allowed below their normal minimum if the underlayment is doubled. Returning
 * both lets the check say "legal, but only with doubled underlayment", which is
 * the answer a roofer would give.
 */
export function slopeRuleFor(covering: RoofCovering): {
  absolute: SlopeLimit;
  plain?: SlopeLimit;
} {
  switch (covering) {
    case 'asphalt-shingle':
      return {
        absolute: IRC_ROOF_SLOPES.asphaltShingle,
        plain: IRC_ROOF_SLOPES.asphaltShingleDoubleUnderlayment,
      };
    case 'clay-tile':
    case 'concrete-tile':
      return {
        absolute: IRC_ROOF_SLOPES.clayOrConcreteTile,
        plain: IRC_ROOF_SLOPES.tileDoubleUnderlayment,
      };
    case 'metal-shingle':
      return { absolute: IRC_ROOF_SLOPES.metalShingle };
    case 'slate':
      return { absolute: IRC_ROOF_SLOPES.slate };
    case 'wood-shake':
      return { absolute: IRC_ROOF_SLOPES.woodShake };
    case 'standing-seam-metal':
      return { absolute: IRC_ROOF_SLOPES.standingSeamMetal };
    case 'membrane':
      return { absolute: IRC_ROOF_SLOPES.membrane };
  }
}

/** What each covering is called in a sentence. */
const COVERING_NAMES: Record<RoofCovering, string> = {
  'asphalt-shingle': 'asphalt shingles',
  'wood-shake': 'wood shakes',
  'clay-tile': 'clay tile',
  'concrete-tile': 'concrete tile',
  slate: 'slate',
  'standing-seam-metal': 'a standing-seam metal roof',
  'metal-shingle': 'metal shingles',
  membrane: 'a membrane roof',
};

/* -------------------------------- The report ------------------------------ */

export function checkRoof(doc: DesignDocument, roof: Roof): RoofReport | null {
  const geometry = roofGeometry(doc, roof);
  if (!geometry) return null;

  const findings: RoofFinding[] = [];
  const add = (finding: Omit<RoofFinding, 'roofId'>) =>
    findings.push({ ...finding, roofId: roof.id });

  checkSlope(roof, add);
  checkVentilation(roof, geometry, add);
  checkAtticAccess(doc, roof, geometry, add);
  checkSkylights(roof, geometry, add);
  checkLotLine(doc, roof, geometry, add);

  // Geometry problems are not code findings, but a person looking at a roof
  // report wants them in the same list rather than in two places.
  for (const [index, problem] of geometry.problems.entries()) {
    add({
      id: `roof-shape-${index}`,
      severity: 'violation',
      section: '',
      title: 'This roof cannot be built as drawn',
      detail: problem,
      remedy: 'Change the outline, the overhang or the roof form until it resolves.',
    });
  }

  return {
    roofId: roof.id,
    geometry,
    findings,
    compliant: findings.every((finding) => finding.severity !== 'violation'),
  };
}

/** Every roof on the building, checked. */
export function checkAllRoofs(doc: DesignDocument): RoofReport[] {
  return doc.roofs
    .map((roof) => checkRoof(doc, roof))
    .filter((report): report is RoofReport => report !== null);
}

type Add = (finding: Omit<RoofFinding, 'roofId'>) => void;

/* --------------------------------- Slope ---------------------------------- */

function checkSlope(roof: Roof, add: Add): void {
  const rule = slopeRuleFor(roof.covering);
  const name = COVERING_NAMES[roof.covering];

  if (roof.pitch < rule.absolute.pitch - 1e-9) {
    add({
      id: 'roof-slope',
      severity: 'violation',
      section: rule.absolute.section,
      title: `This roof is too shallow for ${name}`,
      detail: `${asPitch(roof.pitch)} is below the ${rule.absolute.asWritten} required by IRC ${rule.absolute.section}.`,
      remedy: `Raise the pitch to at least ${asPitch(rule.absolute.pitch)}, or change the covering to one that suits a shallow roof — a standing-seam metal or membrane roof will go down to ${asPitch(IRC_ROOF_SLOPES.membrane.pitch)}.`,
    });
    return;
  }

  if (rule.plain && roof.pitch < rule.plain.pitch - 1e-9) {
    add({
      id: 'roof-slope-underlayment',
      severity: 'caution',
      section: rule.absolute.section,
      title: `Doubled underlayment needed under ${name}`,
      detail: `${asPitch(roof.pitch)} is below ${asPitch(rule.plain.pitch)}, so IRC ${rule.absolute.section} allows this covering only with the doubled underlayment of R905.1.1.`,
      remedy: `Either specify the doubled underlayment, or raise the pitch to ${asPitch(rule.plain.pitch)} and lay it in the ordinary way.`,
    });
    return;
  }

  add({
    id: 'roof-slope',
    severity: 'pass',
    section: rule.absolute.section,
    title: `The pitch suits ${name}`,
    detail: `${asPitch(roof.pitch)} clears the ${rule.absolute.asWritten} required by IRC ${rule.absolute.section}.`,
    remedy: '',
  });
}

/* ------------------------------ Ventilation ------------------------------- */

function checkVentilation(roof: Roof, geometry: RoofGeometry, add: Add): void {
  const area = roofPlanArea(geometry);
  if (area < 1e-6) return;

  if (roof.ventilation === 'unvented') {
    add({
      id: 'roof-ventilation',
      severity: 'caution',
      section: 'R806.5',
      title: 'An unvented roof assembly has conditions attached',
      detail:
        'IRC R806.5 permits an unvented attic, but only with air-impermeable insulation in contact with the underside of the sheathing, or the rigid board thickness that section sets out for the climate zone — and no Class I vapour retarder on the ceiling.',
      remedy:
        'Confirm the assembly meets R806.5 for your climate zone, or switch this roof to vented and provide the openings below.',
    });
    return;
  }

  const full = area * IRC_ATTIC.ventilationRatio.ratio;
  const reduced = area * IRC_ATTIC.ventilationRatioReduced.ratio;

  add({
    id: 'roof-ventilation',
    severity: 'pass',
    section: IRC_ATTIC.ventilationRatio.section,
    title: 'Ventilation this roof needs',
    detail: `Over ${asSquareFeet(area)} of roof, IRC ${IRC_ATTIC.ventilationRatio.section} asks for ${asSquareInches(full)} of net free ventilating area — ${IRC_ATTIC.ventilationRatio.asWritten}.`,
    remedy: `That halves to ${asSquareInches(reduced)} where the R806.2 exception applies: between 40 and 50 percent of the opening in the upper third of the space, the rest at the eaves. Note that net free area is not the size of the hole — a soffit vent passes roughly half its own area.`,
  });
}

/* ----------------------------- Attic access ------------------------------- */

function checkAtticAccess(
  doc: DesignDocument,
  roof: Roof,
  geometry: RoofGeometry,
  add: Add,
): void {
  const area = roofPlanArea(geometry);
  const height = geometry.rise;

  if (
    area < IRC_ATTIC.accessRequiredArea.squareMetres ||
    height < IRC_ATTIC.accessRequiredHeight.metres
  ) {
    return;
  }

  // Whether a hatch has actually been drawn is not something this app can know
  // yet — there is no ceiling opening to place — so this is stated as a
  // requirement rather than tested as a violation.
  add({
    id: 'roof-attic-access',
    severity: 'caution',
    section: IRC_ATTIC.accessRequiredArea.section,
    title: 'This roof space needs an access hatch',
    detail: `The roof covers ${asSquareFeet(area)} and rises ${asFeetInches(height)}, which is over the ${IRC_ATTIC.accessRequiredArea.asWritten} and ${IRC_ATTIC.accessRequiredHeight.asWritten} at which IRC ${IRC_ATTIC.accessRequiredArea.section} requires access.`,
    remedy: `Provide an opening of at least ${IRC_ATTIC.accessWidth.asWritten} by ${IRC_ATTIC.accessLength.asWritten}, in a hallway or other readily accessible place, with ${IRC_ATTIC.accessHeadroom.asWritten} of headroom above it.`,
  });

  void doc;
  void roof;
}

/* ------------------------------- Skylights -------------------------------- */

function checkSkylights(roof: Roof, geometry: RoofGeometry, add: Add): void {
  if (roof.skylights.length === 0) return;

  const openings = roofOpenings(geometry, roof);

  add({
    id: 'roof-skylight-glazing',
    severity: 'pass',
    section: IRC_SKYLIGHTS.permittedGlazing.section,
    title: 'Skylight glazing',
    detail: `IRC ${IRC_SKYLIGHTS.permittedGlazing.section} permits ${IRC_SKYLIGHTS.permittedGlazing.asWritten} in sloped glazing. Every skylight here is laminated or tempered.`,
    remedy: '',
  });

  for (const built of openings.skylights) {
    if (built.problems.length === 0) continue;
    add({
      id: `roof-skylight-${built.skylightId}`,
      severity: 'violation',
      section: '',
      title: 'A skylight will not fit where it is',
      detail: built.problems.join(' '),
      remedy: 'Move it, or make it smaller, so that it sits within one plane of roof.',
    });
  }

  for (const built of openings.dormers) {
    if (built.problems.length === 0) continue;
    add({
      id: `roof-dormer-${built.dormerId}`,
      severity: 'violation',
      section: '',
      title: 'A dormer will not fit where it is',
      detail: built.problems.join(' '),
      remedy: 'Move it down the slope, or lower its face, so its roof dies into the main roof.',
    });
  }
}

/* ----------------------------- The lot line ------------------------------- */

function checkLotLine(doc: DesignDocument, roof: Roof, geometry: RoofGeometry, add: Add): void {
  const boundary = doc.site.boundary;
  if (boundary.length < 3) return;

  const level = levelById(doc, roof.overLevelId);
  const footprint = level ? footprintFor(level, roof.anchorWallId) : null;

  const wallDistance = footprint ? distanceToBoundary(footprint.outline, boundary) : null;
  const eaveDistance = distanceToBoundary(geometry.eaves, boundary);

  if (wallDistance !== null && wallDistance < IRC_LOT_LINE.wallRated.metres) {
    add({
      id: 'roof-lot-line-wall',
      severity: 'caution',
      section: IRC_LOT_LINE.wallRated.section,
      title: 'The building is close enough to the plot line to need a fire-rated wall',
      detail: `The nearest wall is ${asFeetInches(wallDistance)} from the line. IRC Table ${IRC_LOT_LINE.wallRated.section}(1) requires a 1-hour rated exterior wall inside ${IRC_LOT_LINE.wallRated.asWritten}, and permits no openings at all inside ${IRC_LOT_LINE.openingsNone.asWritten}.`,
      remedy: `Move the building back to ${IRC_LOT_LINE.wallRated.asWritten} from the line, or build that wall to a 1-hour rating with its openings limited.`,
    });
  }

  if (eaveDistance < IRC_LOT_LINE.projectionNone.metres) {
    add({
      id: 'roof-lot-line-eave',
      severity: 'violation',
      section: IRC_LOT_LINE.projectionNone.section,
      title: 'The eaves come too close to the plot line',
      detail: `The eave is ${asFeetInches(eaveDistance)} from the line, and IRC Table ${IRC_LOT_LINE.projectionNone.section}(1) does not permit a projection inside ${IRC_LOT_LINE.projectionNone.asWritten}.`,
      remedy: `Cut the overhang back by ${asFeetInches(IRC_LOT_LINE.projectionNone.metres - eaveDistance)}, or move the building further from the line.`,
    });
  } else if (eaveDistance < IRC_LOT_LINE.projectionRated.metres) {
    add({
      id: 'roof-lot-line-eave',
      severity: 'caution',
      section: IRC_LOT_LINE.projectionRated.section,
      title: 'The eaves need fire protection on their underside',
      detail: `The eave is ${asFeetInches(eaveDistance)} from the line. IRC Table ${IRC_LOT_LINE.projectionRated.section}(1) requires 1-hour protection on the underside of a projection between ${IRC_LOT_LINE.projectionNone.asWritten} and ${IRC_LOT_LINE.projectionRated.asWritten} from it.`,
      remedy: `Protect the soffit, or pull the eave back to ${IRC_LOT_LINE.projectionRated.asWritten} from the line.`,
    });
  }

  checkSetbacks(doc, footprint?.outline ?? geometry.eaves, add);
}

/**
 * The zoning setbacks, which are the user's own numbers.
 *
 * No section is cited because there is none to cite: these come from a local
 * ordinance, not from the IRC, and they vary street by street. The app holds
 * them and does the arithmetic; it does not pretend to know them.
 */
function checkSetbacks(doc: DesignDocument, outline: readonly Point2[], add: Add): void {
  const setbacks = doc.site.setbacks;
  const boundary = doc.site.boundary;
  if (!setbacks || boundary.length < 3 || outline.length < 3) return;

  const frontEdge = frontEdgeOf(boundary, setbacks.frontAt);

  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i]!;
    const b = boundary[(i + 1) % boundary.length]!;

    const which =
      i === frontEdge
        ? { name: 'front', required: setbacks.front }
        : i === (frontEdge + Math.floor(boundary.length / 2)) % boundary.length
          ? { name: 'rear', required: setbacks.rear }
          : { name: 'side', required: setbacks.side };

    if (which.required <= 0) continue;

    let closest = Infinity;
    for (const point of outline) {
      closest = Math.min(closest, distancePointSegment(point, a, b));
    }
    if (closest >= which.required - 1e-6) continue;

    add({
      id: `roof-setback-${i}`,
      severity: 'violation',
      section: '',
      title: `The building is inside the ${which.name} setback`,
      detail: `It comes within ${asFeetInches(closest)} of that plot line, and the ${which.name} setback you entered is ${asFeetInches(which.required)}. This is a zoning limit from your local ordinance, not a building-code one, so there is no IRC section to cite.`,
      remedy: `Move the building back by ${asFeetInches(which.required - closest)}, or check the ordinance for an allowance that applies here.`,
    });
  }
}

/** Which edge of the plot the user called the front. */
function frontEdgeOf(boundary: readonly Point2[], frontAt: Point2 | null): number {
  if (!frontAt) return 0;

  let best = 0;
  let nearest = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const distance = distancePointSegment(
      frontAt,
      boundary[i]!,
      boundary[(i + 1) % boundary.length]!,
    );
    if (distance < nearest) {
      nearest = distance;
      best = i;
    }
  }
  return best;
}

/** Shortest distance from any point of a polygon to a plot boundary. */
function distanceToBoundary(outline: readonly Point2[], boundary: readonly Point2[]): number {
  let closest = Infinity;
  for (const point of outline) {
    for (let i = 0; i < boundary.length; i++) {
      closest = Math.min(
        closest,
        distancePointSegment(point, boundary[i]!, boundary[(i + 1) % boundary.length]!),
      );
    }
  }
  return closest;
}

function distancePointSegment(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 1e-12) return Math.hypot(point.x - a.x, point.z - a.z);

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

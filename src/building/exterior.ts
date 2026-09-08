/**
 * What the outside of the building is made of, and how much of it there is.
 *
 * A takeoff, in the builder's sense: the areas somebody would measure off a
 * drawing to price the job. Wall area net of its openings, gable ends, roof by
 * the sloped area rather than the plan area, and the eave and ridge lengths
 * that fascia, gutter and ridge capping are sold by.
 *
 * ---------------------------------------------------------------------------
 * ABOUT THE MONEY, which matters more than the code.
 *
 * The costs here are ESTIMATES written from general knowledge — the same
 * standing as the furniture prices, and carrying the same `PriceBasis` through
 * every total so that a number never loses the label saying what it is. They
 * are not quotes. Cladding and roofing prices move with the market, and vary by
 * a factor of two across the country and by more than that between a simple
 * gable and a roof with six valleys in it.
 *
 * What the areas ARE, though, is arithmetic, and those are worth trusting: they
 * come from the same geometry the roof is drawn from.
 * ---------------------------------------------------------------------------
 */

import { footprintsOf } from './footprint';
import { roofArea, roofGeometry, type RoofGeometry } from './roof';
import { getCladdingPreset, ROOF_COVERING_COSTS } from '@/scene/materials/cladding';
import { resolveWall, indexVertices } from '@/scene/planGraph';
import type { PriceBasis } from '@/furniture/pricing';
import type { DesignDocument, Level, Roof } from '@/state/types';

export interface ExteriorLine {
  id: string;
  label: string;
  /** How it is measured: square metres, or metres run. */
  unit: 'm²' | 'm';
  quantity: number;
  /** Rate per unit, or null where the app has no figure. */
  rate: number | null;
  total: number | null;
  basis: PriceBasis;
  /** Where the quantity came from, in a sentence. */
  note: string;
}

export interface ExteriorTakeoff {
  lines: ExteriorLine[];
  total: number | null;
  basis: PriceBasis;
  /** Total wall area to be clad, net of openings, in square metres. */
  claddingArea: number;
  /** Total roof area, measured on the slope, in square metres. */
  roofArea: number;
}

/* ------------------------------- The areas ------------------------------- */

/**
 * The area of exterior wall on one storey, net of its openings.
 *
 * Only the OUTSIDE walls count: an interior partition is not clad, and counting
 * it would roughly double the figure on a plan with rooms in it. The outer
 * walls are the ones the footprint tracer found, which is the same set the roof
 * sits on.
 */
export function claddingAreaOf(level: Level): number {
  const outerWallIds = new Set(footprintsOf(level).flatMap((footprint) => footprint.wallIds.flat()));
  const vertices = indexVertices(level.plan);

  let area = 0;
  for (const wall of level.plan.walls) {
    if (!outerWallIds.has(wall.id)) continue;

    const segment = resolveWall(wall, vertices);
    if (!segment) continue;

    area += segment.length * wall.height;
    // Doors and windows are not clad, and on a wall that is mostly glass the
    // difference is the whole estimate.
    for (const opening of wall.openings) {
      area -= opening.width * opening.height;
    }
  }

  return Math.max(0, area);
}

/** The area of the gable ends on a roof, which is wall rather than roof. */
export function gableAreaOf(geometry: RoofGeometry): number {
  return geometry.gables.reduce((total, gable) => {
    // The panel is vertical, so its area is its width times its average height
    // — worked out here by the shoelace formula on the panel's own plane.
    const points = gable.points;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const here = points[i]!;
      const next = points[(i + 1) % points.length]!;
      // Distance along the gable line, against height: the panel is flat, so
      // one horizontal axis is enough.
      const hereAlong = Math.hypot(here.x - points[0]!.x, here.z - points[0]!.z);
      const nextAlong = Math.hypot(next.x - points[0]!.x, next.z - points[0]!.z);
      sum += hereAlong * next.y - nextAlong * here.y;
    }
    return total + Math.abs(sum / 2);
  }, 0);
}

/** Metres run of each kind of roof line, for fascia, gutter and capping. */
export function roofLineLengths(geometry: RoofGeometry): Record<string, number> {
  const lengths: Record<string, number> = {};
  for (const edge of geometry.edges) {
    const run = Math.hypot(edge.to.x - edge.from.x, edge.to.z - edge.from.z);
    const rise = edge.to.y - edge.from.y;
    lengths[edge.kind] = (lengths[edge.kind] ?? 0) + Math.hypot(run, rise);
  }
  return lengths;
}

/* ------------------------------ The takeoff ------------------------------- */

export function exteriorTakeoff(doc: DesignDocument): ExteriorTakeoff {
  const lines: ExteriorLine[] = [];

  const cladding = getCladdingPreset(doc.exterior.cladding);
  let wallArea = 0;
  for (const level of doc.levels) wallArea += claddingAreaOf(level);

  let roofSlopedArea = 0;
  let gableArea = 0;
  const lineTotals: Record<string, number> = {};

  /*
   * Each roof is solved ONCE and kept.
   *
   * Working a roof out means running the straight skeleton over the whole
   * footprint, and this function is called from a React render — so solving
   * each roof twice, once for the areas and once for the lines, doubles the
   * cost of every keystroke in the panel for no gain at all.
   */
  const solved = doc.roofs
    .map((roof) => ({ roof, geometry: roofGeometry(doc, roof) }))
    .filter((entry): entry is { roof: Roof; geometry: RoofGeometry } => entry.geometry !== null);

  for (const { geometry } of solved) {
    roofSlopedArea += roofArea(geometry);
    gableArea += gableAreaOf(geometry);

    for (const [kind, length] of Object.entries(roofLineLengths(geometry))) {
      lineTotals[kind] = (lineTotals[kind] ?? 0) + length;
    }
  }

  const claddingTotal = wallArea + gableArea;
  lines.push({
    id: 'cladding',
    label: cladding.label,
    unit: 'm²',
    quantity: claddingTotal,
    rate: cladding.costPerSquareMetre,
    total: claddingTotal * cladding.costPerSquareMetre,
    basis: 'estimate',
    note:
      gableArea > 0
        ? 'Outside walls net of their doors and windows, plus the gable ends above the eaves.'
        : 'Outside walls net of their doors and windows.',
  });

  for (const { roof, geometry } of solved) {
    const covering = ROOF_COVERING_COSTS[roof.covering];
    const area = roofArea(geometry);
    lines.push({
      id: `roof-${roof.id}`,
      label: covering?.label ?? roof.covering,
      unit: 'm²',
      quantity: area,
      rate: covering?.costPerSquareMetre ?? null,
      total: covering ? area * covering.costPerSquareMetre : null,
      basis: covering ? 'estimate' : 'unknown',
      note: 'Measured on the slope, which is what a roof is bought by — not the plan area.',
    });
  }

  const eaves = lineTotals.eave ?? 0;
  if (eaves > 0) {
    lines.push({
      id: 'fascia',
      label: 'Fascia and gutter',
      unit: 'm',
      quantity: eaves,
      // Left unpriced on purpose: gutter costs depend on the material and the
      // number of downpipes, and a made-up rate here would be the weakest
      // figure in the list wearing the same clothes as the rest.
      rate: null,
      total: null,
      basis: 'unknown',
      note: 'Total length of eave. Rakes, ridges and valleys are listed separately below.',
    });
  }

  for (const kind of ['ridge', 'hip', 'valley', 'rake'] as const) {
    const length = lineTotals[kind] ?? 0;
    if (length <= 1e-6) continue;
    lines.push({
      id: `line-${kind}`,
      label: `${kind[0]!.toUpperCase()}${kind.slice(1)}`,
      unit: 'm',
      quantity: length,
      rate: null,
      total: null,
      basis: 'unknown',
      note:
        kind === 'valley'
          ? 'Needs flashing, and is where a roof leaks if it is done badly.'
          : kind === 'rake'
            ? 'The sloping edge of a gable, which takes a barge board.'
            : 'Takes capping.',
    });
  }

  const priced = lines.filter((line) => line.total !== null);
  const total = priced.length > 0 ? priced.reduce((sum, line) => sum + line.total!, 0) : null;
  const anyUnknown = lines.some((line) => line.basis === 'unknown');

  return {
    lines,
    total,
    basis: anyUnknown ? 'unknown' : 'estimate',
    claddingArea: claddingTotal,
    roofArea: roofSlopedArea,
  };
}

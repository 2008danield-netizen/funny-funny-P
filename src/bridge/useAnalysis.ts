/**
 * Shared analysis, computed once per document.
 *
 * Two panels now want the clearance report — the Clearance panel and the
 * Advisor, which reads its circulation figures rather than walking the same
 * grids again. Both re-render on every store change, which during a furniture
 * drag means every animation frame, so computing it twice per frame would
 * double the most expensive operation in the app for no benefit at all.
 *
 * A one-slot memo keyed by DOCUMENT IDENTITY is exactly right here, and it is
 * right because of how the store works: `designStore` hands out a new document
 * object on every edit and the identical one otherwise, so reference equality
 * is a precise "has anything changed" test rather than an approximation.
 *
 * THIS CACHE LIVES IN THE BRIDGE LAYER ON PURPOSE. It must never be used inside
 * a mutating code path — `designStore.edit` mutates a draft IN PLACE, so during
 * an edit the same object identity can hold two different states, and a memo
 * consulted mid-mutation would hand back an analysis of a document that no
 * longer exists. Everything under `state/`, `advisor/fixes.ts` and
 * `advisor/generate.ts` therefore calls `findRegions` and `analyseClearance`
 * directly. Read paths only, which is what a React hook is.
 */

import { useMemo } from 'react';

import { analyseClearance, type ClearanceReport } from '@/clearance/analyze';
import { adviseDesign } from '@/advisor/advise';
import { checkAllRoofs, type RoofReport } from '@/building/roofCode';
import { exteriorTakeoff, type ExteriorTakeoff } from '@/building/exterior';
import {
  calculateLoad,
  groupByRoom,
  panelSchedule,
  type LoadResult,
  type ScheduleRow,
} from '@/services/circuits';
import { checkElectrical, type NecReport } from '@/services/necCheck';
import { checkFittings, type FittingReport } from '@/services/fittingCheck';
import type { AdvisorReport } from '@/advisor/types';
import { activeLevel } from '@/state/levels';
import type { DesignDocument, Level } from '@/state/types';
import { useDesign } from './useDesign';

/*
 * The cache is keyed on the document AND the level, because switching storeys
 * changes the answer without changing the document. Keying on the document
 * alone would show the ground floor's clearance report while the first floor
 * was on screen — and it would look completely plausible.
 */
let clearanceKey: { doc: DesignDocument; level: Level } | null = null;
let clearanceCache: ClearanceReport | null = null;

/** The clearance report for one storey, computed at most once per version. */
export function clearanceFor(doc: DesignDocument, level: Level): ClearanceReport {
  if (clearanceKey && clearanceKey.doc === doc && clearanceKey.level === level && clearanceCache) {
    return clearanceCache;
  }
  clearanceCache = analyseClearance(doc, level);
  clearanceKey = { doc, level };
  return clearanceCache;
}

let advisorKey: { doc: DesignDocument; level: Level } | null = null;
let advisorCache: AdvisorReport | null = null;

/** The advisor report for one storey, reusing its clearance analysis. */
export function adviceFor(doc: DesignDocument, level: Level): AdvisorReport {
  if (advisorKey && advisorKey.doc === doc && advisorKey.level === level && advisorCache) {
    return advisorCache;
  }
  advisorCache = adviseDesign(doc, level, clearanceFor(doc, level));
  advisorKey = { doc, level };
  return advisorCache;
}

/*
 * The roofs, and what the outside of the building adds up to.
 *
 * Both are expensive for the same reason: working a roof out runs the straight
 * skeleton over the whole footprint, and the roof panel, the site panel and the
 * takeoff all want the answer. Without this they would each solve every roof
 * again on every keystroke in any of them.
 */
let roofKey: DesignDocument | null = null;
let roofCache: RoofReport[] | null = null;

/** Every roof on the building, checked, computed at most once per version. */
export function roofReportsFor(doc: DesignDocument): RoofReport[] {
  if (roofKey === doc && roofCache) return roofCache;
  roofCache = checkAllRoofs(doc);
  roofKey = doc;
  return roofCache;
}

let takeoffKey: DesignDocument | null = null;
let takeoffCache: ExteriorTakeoff | null = null;

/** The exterior takeoff, computed at most once per version. */
export function takeoffFor(doc: DesignDocument): ExteriorTakeoff {
  if (takeoffKey === doc && takeoffCache) return takeoffCache;
  takeoffCache = exteriorTakeoff(doc);
  takeoffKey = doc;
  return takeoffCache;
}

/*
 * The electrical: the checks, the load and the panel schedule.
 *
 * All three walk every room of every storey — the spacing check samples every
 * wall at 10 cm, and the load calculation runs `findRegions` over the whole
 * building — and the panel wants all three at once. Computed together and once
 * per document version, for the same reason the roof reports are.
 */
export interface ElectricalAnalysis {
  report: NecReport;
  load: LoadResult;
  schedule: ScheduleRow[];
  /** Devices grouped by the room they stand in, which is how they are wired. */
  rooms: ReturnType<typeof groupByRoom>;
}

let electricalKey: DesignDocument | null = null;
let electricalCache: ElectricalAnalysis | null = null;

/** The whole electrical analysis, computed at most once per version. */
export function electricalFor(doc: DesignDocument): ElectricalAnalysis {
  if (electricalKey === doc && electricalCache) return electricalCache;
  electricalCache = {
    report: checkElectrical(doc),
    load: calculateLoad(doc),
    schedule: panelSchedule(doc),
    rooms: groupByRoom(doc),
  };
  electricalKey = doc;
  return electricalCache;
}

/** Subscribes to the electrical analysis for the whole building. */
export function useElectrical(): ElectricalAnalysis {
  const doc = useDesign();
  return useMemo(() => electricalFor(doc), [doc]);
}

/*
 * The kitchens and bathrooms.
 *
 * Walks every room of every storey and steps clearances outwards in 25 mm
 * increments, so it is the same kind of expensive as the clearance report and
 * gets the same one-slot memo. The fittings panel and the issues list both want
 * it, and during a fixture drag both re-render on every frame.
 */
let fittingKey: DesignDocument | null = null;
let fittingCache: FittingReport | null = null;

/** The fitting checks for the whole building, computed at most once per version. */
export function fittingsFor(doc: DesignDocument): FittingReport {
  if (fittingKey === doc && fittingCache) return fittingCache;
  fittingCache = checkFittings(doc);
  fittingKey = doc;
  return fittingCache;
}

/** Subscribes to the fitting checks. */
export function useFittings(): FittingReport {
  const doc = useDesign();
  return useMemo(() => fittingsFor(doc), [doc]);
}

/** Subscribes to the roof reports for the whole building. */
export function useRoofReports(): RoofReport[] {
  const doc = useDesign();
  return useMemo(() => roofReportsFor(doc), [doc]);
}

/** Subscribes to the exterior takeoff. */
export function useExteriorTakeoff(): ExteriorTakeoff {
  const doc = useDesign();
  return useMemo(() => takeoffFor(doc), [doc]);
}

/** Subscribes to the clearance report for the storey being edited. */
export function useClearanceReport(): ClearanceReport {
  const doc = useDesign();
  const level = activeLevel(doc);
  return useMemo(() => clearanceFor(doc, level), [doc, level]);
}

/** Subscribes to the advisor's report for the storey being edited. */
export function useAdvice(): AdvisorReport {
  const doc = useDesign();
  const level = activeLevel(doc);
  return useMemo(() => adviceFor(doc, level), [doc, level]);
}

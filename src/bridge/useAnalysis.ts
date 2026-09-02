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
import type { AdvisorReport } from '@/advisor/types';
import type { DesignDocument } from '@/state/types';
import { useDesign } from './useDesign';

let clearanceDoc: DesignDocument | null = null;
let clearanceCache: ClearanceReport | null = null;

/** The clearance report for a document, computed at most once per version. */
export function clearanceFor(doc: DesignDocument): ClearanceReport {
  if (doc === clearanceDoc && clearanceCache) return clearanceCache;
  clearanceCache = analyseClearance(doc);
  clearanceDoc = doc;
  return clearanceCache;
}

let advisorDoc: DesignDocument | null = null;
let advisorCache: AdvisorReport | null = null;

/** The advisor report for a document, reusing its clearance analysis. */
export function adviceFor(doc: DesignDocument): AdvisorReport {
  if (doc === advisorDoc && advisorCache) return advisorCache;
  advisorCache = adviseDesign(doc, clearanceFor(doc));
  advisorDoc = doc;
  return advisorCache;
}

/** Subscribes to the clearance report for the live document. */
export function useClearanceReport(): ClearanceReport {
  const doc = useDesign();
  return useMemo(() => clearanceFor(doc), [doc]);
}

/** Subscribes to the advisor's report for the live document. */
export function useAdvice(): AdvisorReport {
  const doc = useDesign();
  return useMemo(() => adviceFor(doc), [doc]);
}

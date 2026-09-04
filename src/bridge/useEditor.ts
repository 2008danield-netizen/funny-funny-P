/**
 * React bindings for editor state and derived plan geometry.
 */

import { useMemo, useSyncExternalStore } from 'react';

import { findRegions, type Region } from '@/scene/planGraph';
import { designStore } from '@/state/store';
import { editorStore, type EditorState } from '@/state/selection';
import { activeLevel } from '@/state/levels';
import type { Level, PlanModel, Wall } from '@/state/types';
import { useDesign } from './useDesign';

/**
 * The storey the editor is working on.
 *
 * Subscribed to the whole document rather than to a slice, because "which
 * level is active" and "what is on it" are two different things that both have
 * to be current — selecting a slice of one would let a component render the
 * new level's name beside the old level's walls.
 */
export function useActiveLevel(): Level {
  const doc = useDesign();
  return activeLevel(doc);
}

/** Subscribes to the whole editor state (tool, selection, hover, snapping). */
export function useEditor(): EditorState {
  return useSyncExternalStore(
    (listener) => editorStore.subscribe(listener),
    () => editorStore.getState(),
  );
}

/**
 * The rooms enclosed by the current plan.
 *
 * Recomputed here rather than read back from the 3D engine, which keeps the UI
 * independent of whether the engine has mounted (it has not, on the very first
 * render) and avoids a second source of truth. `findRegions` is a pure function
 * of the plan, so memoising on the plan's identity is exact — the store hands
 * out a new plan object on every edit and the same one otherwise.
 */
export function useRegions(): Region[] {
  const plan = useActiveLevel().plan;
  return useMemo(() => findRegions(plan), [plan]);
}

/** The currently selected wall, or null. */
export function useSelectedWall(): Wall | null {
  const plan = useActiveLevel().plan;
  const { selection } = useEditor();

  return useMemo(() => {
    if (selection.kind !== 'wall' || !selection.id) return null;
    return plan.walls.find((wall) => wall.id === selection.id) ?? null;
  }, [plan, selection]);
}

/** The currently selected opening together with the wall it sits in. */
export function useSelectedOpening(): { wall: Wall; openingIndex: number } | null {
  const plan = useActiveLevel().plan;
  const { selection } = useEditor();

  return useMemo(() => {
    if (selection.kind !== 'opening' || !selection.id) return null;
    for (const wall of plan.walls) {
      const openingIndex = wall.openings.findIndex(
        (opening) => opening.id === selection.id,
      );
      if (openingIndex !== -1) return { wall, openingIndex };
    }
    return null;
  }, [plan, selection]);
}

/** The region key currently selected, if the selection is a floor. */
export function useSelectedRegion(): Region | null {
  const regions = useRegions();
  const { selection } = useEditor();

  return useMemo(() => {
    if (selection.kind !== 'floor' || !selection.id) return null;
    return regions.find((region) => region.key === selection.id) ?? null;
  }, [regions, selection]);
}

/** Convenience accessor for the live plan. */
export function usePlan(): PlanModel {
  return useActiveLevel().plan;
}

/** Length of a wall in metres, or 0 if it cannot be resolved. */
export function wallLength(plan: PlanModel, wall: Wall): number {
  const start = plan.vertices.find((vertex) => vertex.id === wall.start);
  const end = plan.vertices.find((vertex) => vertex.id === wall.end);
  if (!start || !end) return 0;
  return Math.hypot(end.x - start.x, end.z - start.z);
}

/** Re-export so panels can reach the store without importing two modules. */
export { editorStore, designStore };

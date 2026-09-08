/**
 * React bindings for the framework-neutral design store.
 *
 * `useSyncExternalStore` is the correct primitive here rather than a
 * `useState` + `useEffect` pairing: it is tear-free under concurrent rendering
 * and it lets components subscribe to a selected slice, so changing a wall
 * colour does not re-render the room-dimension panel.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { designStore, type EditOptions, type HistorySnapshot } from '@/state/store';
import type { DesignDocument } from '@/state/types';

/** Subscribes to the whole document. */
export function useDesign(): DesignDocument {
  return useSyncExternalStore(
    (listener) => designStore.subscribe(listener),
    () => designStore.getState(),
  );
}

/**
 * Subscribes to a slice of the document.
 *
 * The selector must return a stable reference for unchanged state — because the
 * store produces documents by structural cloning, selecting a sub-object such
 * as `doc.room.floor` satisfies this, but selecting a freshly built object
 * (`{ a: doc.a }`) would loop infinitely. Select primitives or existing objects.
 */
export function useDesignSlice<T>(selector: (doc: DesignDocument) => T): T {
  return useSyncExternalStore(
    (listener) => designStore.subscribe(listener),
    () => selector(designStore.getState()),
  );
}

/** Returns a stable `edit` function for mutating the document. */
export function useDesignEdit(): (
  recipe: (draft: DesignDocument) => void,
  options?: EditOptions,
) => void {
  return useCallback((recipe, options) => designStore.edit(recipe, options), []);
}

/**
 * Undo/redo availability.
 *
 * The store caches this snapshot and only replaces the object when one of the
 * flags actually changes. That is not an optimisation — `useSyncExternalStore`
 * compares snapshots by reference, so returning a freshly built object here
 * would make React believe the store changed on every read and loop forever.
 */
export function useHistoryState(): HistorySnapshot {
  return useSyncExternalStore(
    (listener) => designStore.subscribe(listener),
    () => designStore.getHistorySnapshot(),
  );
}

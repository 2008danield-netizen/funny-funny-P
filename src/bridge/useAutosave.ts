/**
 * Persists the design to localStorage as it changes.
 *
 * Writes are debounced so that dragging a slider — which produces a state
 * update per frame — results in one write after the drag settles rather than
 * sixty writes per second of JSON serialisation.
 */

import { useEffect } from 'react';

import { designStore } from '@/state/store';
import { debounce, saveAutosave } from '@/state/persistence';

const AUTOSAVE_DELAY_MS = 400;

export function useAutosave(): void {
  useEffect(() => {
    const persist = debounce(saveAutosave, AUTOSAVE_DELAY_MS);
    return designStore.subscribe((doc) => persist(doc));
  }, []);
}

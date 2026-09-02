/**
 * Global keyboard shortcuts.
 *
 * Deliberately minimal for session 1 — undo/redo and the viewpoint keys.
 *
 * The handler stands down while the user is typing, so that Ctrl+Z inside the
 * design-name field undoes their typing rather than a room change. Note that
 * "typing" means TEXT inputs specifically, not every `<input>`: sliders,
 * colour pickers and checkboxes keep focus after being used, and treating them
 * as text entry would silently disable undo at precisely the moment the user
 * wants it.
 */

import { useEffect } from 'react';

import { designStore } from '@/state/store';
import type { ViewpointId } from '@/controls/CameraController';

const VIEWPOINT_KEYS: Record<string, ViewpointId> = {
  '1': 'overview',
  '2': 'corner',
  '3': 'interior',
  '4': 'plan',
};

/** Input types that swallow keystrokes as text and own their own undo stack. */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date',
  'datetime-local', 'month', 'week', 'time',
]);

/** True when the event target is somewhere the user is genuinely typing. */
function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) {
    // `type` is lower-cased by the DOM and defaults to "text" when unset.
    return TEXT_INPUT_TYPES.has(target.type);
  }
  return false;
}

export function useKeyboardShortcuts(onViewpoint: (viewpoint: ViewpointId) => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;

      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        // Shift+Ctrl+Z is the conventional redo on macOS and Linux alike.
        if (event.shiftKey) designStore.redo();
        else designStore.undo();
        return;
      }

      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        designStore.redo();
        return;
      }

      const viewpoint = VIEWPOINT_KEYS[event.key];
      if (viewpoint && !modifier) {
        event.preventDefault();
        onViewpoint(viewpoint);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onViewpoint]);
}

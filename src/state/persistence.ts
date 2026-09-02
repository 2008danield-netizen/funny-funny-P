/**
 * Saving and loading designs.
 *
 * Everything here goes through a narrow interface so that swapping localStorage
 * for a real backend (or a native filesystem, if havavamama is later wrapped as
 * an app) touches only this file.
 */

import { sanitizeDocument } from './defaults';
import type { DesignDocument } from './types';

const STORAGE_KEY = 'havavamama.design.v1';

/**
 * Reads the autosaved document.
 *
 * Returns null rather than throwing on any failure — private browsing modes,
 * disabled storage and corrupt JSON must all degrade to "start fresh" instead
 * of a blank screen.
 */
export function loadAutosave(): DesignDocument | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizeDocument(JSON.parse(raw));
  } catch (error) {
    console.warn('[havavamama] Could not read the autosaved design:', error);
    return null;
  }
}

/** Writes the autosave slot. Silently no-ops if storage is unavailable or full. */
export function saveAutosave(doc: DesignDocument): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch (error) {
    console.warn('[havavamama] Could not autosave the design:', error);
  }
}

/** Clears the autosave slot, used by "Reset to default". */
export function clearAutosave(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing useful to do — the caller resets in-memory state either way.
  }
}

/** Turns a design name into a safe filename stem. */
function toFileStem(name: string): string {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem || 'havavamama-design';
}

/** Downloads the document as a formatted `.json` file. */
export function exportDocument(doc: DesignDocument): void {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${toFileStem(doc.name)}.havavamama.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoking immediately can cancel the download in some browsers; one frame
  // of delay is enough for the navigation to have started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Reads a design from a user-selected file.
 *
 * The contents are run through `sanitizeDocument`, so a malformed or hostile
 * file yields a valid (if partly default) document rather than corrupting state.
 */
export async function importDocument(file: File): Promise<DesignDocument> {
  const text = await file.text();
  return sanitizeDocument(JSON.parse(text));
}

/**
 * Calls `fn` at most once per `waitMs`, on the trailing edge.
 * Used to keep autosave off the critical path while a slider is being dragged.
 */
export function debounce<T extends (...args: never[]) => void>(fn: T, waitMs: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  }) as T;
}

/**
 * Saving and loading designs.
 *
 * Everything here goes through a narrow interface so that swapping localStorage
 * for a real backend (or a native filesystem, if havavamama is later wrapped as
 * an app) touches only this file.
 */

import { sanitizeDocument } from './defaults';
import { getImage, putImage } from './imageStore';
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

/**
 * The shape of an exported file.
 *
 * A design used to BE the document, and files written that way must keep
 * opening — so a bare document is still accepted on the way in. What is written
 * out now is a small envelope around it carrying the traced plan images as
 * well, because a design that arrives without the scan somebody traced it from
 * is a design nobody can carry on with.
 */
interface DesignBundle {
  /** Marks the envelope, and leaves room to change it later. */
  havavamama: number;
  document: DesignDocument;
  /** Plan images, keyed the way the underlays name them. */
  images: Record<string, { dataUrl: string; width: number; height: number }>;
}

const BUNDLE_VERSION = 1;

/** Every image key the document refers to. */
export function imageIdsIn(doc: DesignDocument): string[] {
  const ids = new Set<string>();
  for (const level of doc.levels) {
    if (level.underlay?.imageId) ids.add(level.underlay.imageId);
  }
  return [...ids];
}

/**
 * Gathers the images a document needs, ready to write into a file.
 *
 * An image this browser has never seen is simply left out rather than failing
 * the export: somebody who opened a colleague's design on a machine that never
 * had the scan should still be able to save their own work.
 */
async function gatherImages(doc: DesignDocument): Promise<DesignBundle['images']> {
  const images: DesignBundle['images'] = {};

  for (const id of imageIdsIn(doc)) {
    const stored = await getImage(id);
    if (!stored) continue;
    images[id] = { dataUrl: stored.dataUrl, width: stored.width, height: stored.height };
  }
  return images;
}

/** Downloads the document as a formatted `.json` file, images and all. */
export async function exportDocument(doc: DesignDocument): Promise<void> {
  const bundle: DesignBundle = {
    havavamama: BUNDLE_VERSION,
    document: doc,
    images: await gatherImages(doc),
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
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
  const parsed: unknown = JSON.parse(text);

  const bundle = asBundle(parsed);
  if (!bundle) return sanitizeDocument(parsed);

  /*
   * The images go back into the store under the SAME keys, which is what makes
   * the underlays in the document resolve. Restored before the document is
   * returned, so the first render already has them.
   */
  for (const [id, image] of Object.entries(bundle.images)) {
    if (typeof image?.dataUrl !== 'string') continue;
    await putImage(image.dataUrl, Number(image.width) || 1, Number(image.height) || 1, id);
  }

  return sanitizeDocument(bundle.document);
}

/** Recognises the envelope, and says no to anything else. */
function asBundle(value: unknown): DesignBundle | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (typeof raw.havavamama !== 'number') return null;
  if (typeof raw.document !== 'object' || raw.document === null) return null;

  return {
    havavamama: raw.havavamama,
    document: raw.document as DesignDocument,
    images:
      typeof raw.images === 'object' && raw.images !== null
        ? (raw.images as DesignBundle['images'])
        : {},
  };
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

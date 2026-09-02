/**
 * A tiny observable store for the design document.
 *
 * Why not Redux/Zustand/Jotai: the 3D scene is not a React component. It lives
 * in a plain Three.js class that needs to react to state changes on its own
 * terms, so the store has to be framework-neutral. React attaches to it through
 * `useSyncExternalStore` (see `bridge/useDesign.ts`); the renderer attaches
 * through a plain `subscribe()` callback. Neither knows the other exists.
 *
 * The document is treated as immutable: every mutation produces a new top-level
 * object, which is what makes cheap reference-equality diffing possible in both
 * consumers and what makes the undo history just an array of snapshots.
 */

import { createDefaultDocument, sanitizeDocument } from './defaults';
import type { DesignDocument } from './types';

export type Unsubscribe = () => void;
type Listener = (doc: DesignDocument) => void;

/**
 * How an edit interacts with undo history.
 *  - 'commit'  : push a new history entry (a discrete action, e.g. a preset click)
 *  - 'coalesce': merge into the previous entry if it shares the same key
 *                (a slider drag produces hundreds of updates but one undo step)
 *  - 'skip'    : do not record at all (used when applying undo/redo itself)
 */
export type HistoryMode = 'commit' | 'coalesce' | 'skip';

export interface EditOptions {
  history?: HistoryMode;
  /** Groups consecutive 'coalesce' edits, e.g. "room.width" or "wall.north.color". */
  coalesceKey?: string;
}

/** Immutable view of undo/redo availability, safe to use as a React snapshot. */
export interface HistorySnapshot {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** Maximum undo depth. Documents are small, but this bounds memory growth. */
const HISTORY_LIMIT = 100;

export class DesignStore {
  private doc: DesignDocument;
  private listeners = new Set<Listener>();

  /** Snapshots *before* each recorded edit, oldest first. */
  private past: DesignDocument[] = [];
  private future: DesignDocument[] = [];
  /** The coalesce key of the most recent recorded edit, if any. */
  private lastCoalesceKey: string | null = null;

  /**
   * Cached undo/redo availability.
   *
   * `useSyncExternalStore` compares snapshots by reference, so a getter that
   * built a fresh `{ canUndo, canRedo }` object on every call would report a
   * change on every read and spin React into an infinite render loop. The
   * object is therefore rebuilt only when one of the two booleans actually
   * flips, and returned by reference otherwise.
   */
  private historySnapshot: HistorySnapshot = { canUndo: false, canRedo: false };

  constructor(initial?: DesignDocument) {
    this.doc = initial ?? createDefaultDocument();
  }

  /** Current document. Never mutate the returned object. */
  getState(): DesignDocument {
    return this.doc;
  }

  /** Registers a listener and returns its unsubscribe function. */
  subscribe(listener: Listener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Applies an edit.
   *
   * `recipe` receives a structured clone of the current document and mutates it
   * freely — the clone is what becomes the new state, so callers get the
   * ergonomics of mutation without the hazards of shared references.
   */
  edit(recipe: (draft: DesignDocument) => void, options: EditOptions = {}): void {
    const { history = 'commit', coalesceKey } = options;
    const previous = this.doc;

    const draft = structuredClone(previous);
    recipe(draft);
    draft.updatedAt = new Date().toISOString();

    if (history !== 'skip') {
      const shouldMerge =
        history === 'coalesce' &&
        coalesceKey !== undefined &&
        coalesceKey === this.lastCoalesceKey &&
        this.past.length > 0;

      // A merged edit extends the entry already on the stack, so the whole drag
      // collapses into a single undo step ending at the drag's starting value.
      if (!shouldMerge) {
        this.past.push(previous);
        if (this.past.length > HISTORY_LIMIT) this.past.shift();
      }

      this.lastCoalesceKey = history === 'coalesce' ? (coalesceKey ?? null) : null;
      // Any fresh edit invalidates the redo branch.
      this.future = [];
    }

    this.doc = draft;
    this.emit();
  }

  /**
   * Installs a document without recording a history step.
   *
   * Used once at start-up to restore the autosave. This is deliberately not
   * `edit()`: that method applies a recipe which MUTATES a draft, so a caller
   * writing `edit(() => restored)` would have its return value silently
   * discarded and the restore would do nothing. It is also not `replace()`,
   * because the restored document is the session's starting point — being able
   * to "undo" past it to an empty default room would make no sense.
   */
  hydrate(doc: DesignDocument): void {
    this.doc = sanitizeDocument(doc);
    this.past = [];
    this.future = [];
    this.lastCoalesceKey = null;
    this.emit();
  }

  /** Replaces the entire document (load, import, reset). Always a history step. */
  replace(next: DesignDocument): void {
    this.past.push(this.doc);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.lastCoalesceKey = null;
    this.doc = sanitizeDocument(next);
    this.emit();
  }

  /** Reference-stable snapshot of undo/redo availability. */
  getHistorySnapshot(): HistorySnapshot {
    return this.historySnapshot;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.doc);
    this.doc = previous;
    this.lastCoalesceKey = null;
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.doc);
    this.doc = next;
    this.lastCoalesceKey = null;
    this.emit();
  }

  private emit(): void {
    this.refreshHistorySnapshot();
    // Iterate a copy: a listener may unsubscribe itself during notification.
    for (const listener of [...this.listeners]) listener(this.doc);
  }

  /** Replaces the cached snapshot only when its contents have changed. */
  private refreshHistorySnapshot(): void {
    const canUndo = this.canUndo();
    const canRedo = this.canRedo();
    if (canUndo === this.historySnapshot.canUndo && canRedo === this.historySnapshot.canRedo) {
      return;
    }
    this.historySnapshot = { canUndo, canRedo };
  }
}

/**
 * The single application-wide store instance.
 *
 * A module-level singleton is the right call while there is exactly one design
 * open at a time. If havavamama later supports multiple open projects, this
 * becomes a React context holding one store per project — every consumer
 * already goes through the hooks in `bridge/`, so the blast radius is small.
 */
export const designStore = new DesignStore();

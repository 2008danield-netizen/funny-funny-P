/**
 * What the user has selected, and which editing tool is active.
 *
 * This is VIEW state, deliberately kept out of the design document: it must not
 * be autosaved, exported, or pushed onto the undo stack. Undoing a wall move
 * should restore the wall, not restore which wall happened to be highlighted at
 * the time.
 *
 * It lives in its own tiny store rather than in React state because both the
 * React panels and the Three.js interaction layer need to read and write it,
 * and neither owns the other.
 */

export type SelectionKind = 'wall' | 'vertex' | 'opening' | 'floor' | 'furniture';

export interface Selection {
  kind: SelectionKind | null;
  id: string | null;
}

/** Which pointer gesture the viewport is currently interpreting. */
export type EditTool =
  /** Orbit the camera; clicking selects but nothing drags. */
  | 'select'
  /** Corners and walls can be dragged; the grid is shown. */
  | 'move'
  /** Click two points to draw a new wall. */
  | 'draw'
  /** Click a wall to place a door. */
  | 'door'
  /** Click a wall to place a window. */
  | 'window'
  /** Click inside a room to drop the armed catalogue item. */
  | 'furnish';

export interface EditorState {
  tool: EditTool;
  selection: Selection;
  hover: Selection;
  /** Snap dragged positions to the grid and to alignments with other corners. */
  snapEnabled: boolean;
  /** Grid spacing in metres. */
  gridSize: number;
  /** Preset used when the door or window tool places an opening. */
  doorPresetId: string;
  windowPresetId: string;
  /** Live feedback shown in the viewport while dragging or drawing. */
  readout: string | null;

  /**
   * The catalogue item armed for placement, or null.
   *
   * View state rather than design state: an armed item is an intention, not a
   * part of the design, and it must not survive a reload or land in an export.
   */
  pendingCatalogId: string | null;

  /** Items currently overlapping something, for the warning tint. */
  collidingIds: string[];

  /** Whether clearance zones are drawn on the floor. */
  showClearance: boolean;
}

const EMPTY: Selection = { kind: null, id: null };

function initialState(): EditorState {
  return {
    tool: 'select',
    selection: EMPTY,
    hover: EMPTY,
    snapEnabled: true,
    // 5 cm: fine enough to place a wall precisely, coarse enough that dragging
    // lands on round numbers rather than 2.3847 m.
    gridSize: 0.05,
    doorPresetId: 'door-single',
    windowPresetId: 'window-casement',
    readout: null,
    pendingCatalogId: null,
    collidingIds: [],
    // Off by default: the zones are analysis, and a first-time visitor should
    // see their room rather than a floor covered in blue rectangles.
    showClearance: false,
  };
}

type Listener = (state: EditorState) => void;

class EditorStore {
  private state: EditorState = initialState();
  private listeners = new Set<Listener>();

  getState(): EditorState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Applies a partial update.
   *
   * Bails out when nothing actually changed. That matters more than it looks:
   * hover updates fire on every pointer move, and without this guard the React
   * panels would re-render sixty times a second while the mouse crosses a wall.
   */
  patch(update: Partial<EditorState>): void {
    let changed = false;
    const next = { ...this.state };

    for (const [key, value] of Object.entries(update) as Array<
      [keyof EditorState, EditorState[keyof EditorState]]
    >) {
      if (key === 'selection' || key === 'hover') {
        const current = this.state[key];
        const incoming = value as Selection;
        if (current.kind === incoming.kind && current.id === incoming.id) continue;
      } else if (key === 'collidingIds') {
        // Compared by content: this is recomputed on every drag frame and would
        // otherwise report a change sixty times a second while nothing altered.
        const current = this.state.collidingIds;
        const incoming = value as string[];
        if (
          current.length === incoming.length &&
          current.every((id, index) => id === incoming[index])
        ) {
          continue;
        }
      } else if (this.state[key] === value) {
        continue;
      }
      (next as Record<string, unknown>)[key] = value;
      changed = true;
    }

    if (!changed) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener(this.state);
  }

  select(kind: SelectionKind | null, id: string | null): void {
    this.patch({ selection: kind && id ? { kind, id } : EMPTY });
  }

  setHover(kind: SelectionKind | null, id: string | null): void {
    this.patch({ hover: kind && id ? { kind, id } : EMPTY });
  }

  clearSelection(): void {
    this.patch({ selection: EMPTY });
  }

  setTool(tool: EditTool): void {
    // Changing tool drops the selection unless the new tool acts on it, so the
    // inspector never shows a wall's properties while the draw tool is active.
    this.patch({
      tool,
      readout: null,
      selection: tool === 'select' ? this.state.selection : EMPTY,
      // Switching away from furnishing disarms whatever was on the cursor.
      pendingCatalogId: tool === 'furnish' ? this.state.pendingCatalogId : null,
    });
  }

  /** Arms a catalogue item and switches to the furnish tool. */
  armCatalogItem(catalogId: string | null): void {
    this.patch({
      pendingCatalogId: catalogId,
      tool: catalogId ? 'furnish' : 'select',
      readout: catalogId ? 'Click inside a room to place it' : null,
    });
  }
}

export const editorStore = new EditorStore();

/** True when the tool places openings by clicking a wall. */
export function isOpeningTool(tool: EditTool): boolean {
  return tool === 'door' || tool === 'window';
}

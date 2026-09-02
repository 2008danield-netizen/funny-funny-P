/**
 * The editing toolbar that floats over the viewport.
 *
 * Kept in the viewport rather than the sidebar because the tools change what a
 * click in the 3D view does — putting them anywhere else breaks the connection
 * between the control and the thing it controls.
 */

import { editorStore } from '@/state/selection';
import { useEditor } from '@/bridge/useEditor';
import type { EditTool } from '@/state/selection';

interface ToolDefinition {
  id: EditTool;
  label: string;
  icon: string;
  hint: string;
  shortcut: string;
}

const TOOLS: ToolDefinition[] = [
  {
    id: 'select',
    label: 'Select',
    icon: 'S',
    hint: 'Click to select. Orbit freely.',
    shortcut: 'V',
  },
  {
    id: 'move',
    label: 'Move',
    icon: 'M',
    hint: 'Drag corners, walls, doors and windows.',
    shortcut: 'M',
  },
  {
    id: 'draw',
    label: 'Wall',
    icon: 'W',
    hint: 'Click to place corners; walls chain as you go. Esc to stop.',
    shortcut: 'W',
  },
  {
    id: 'door',
    label: 'Door',
    icon: 'D',
    hint: 'Click a wall to cut a doorway.',
    shortcut: 'D',
  },
  {
    id: 'window',
    label: 'Window',
    icon: 'N',
    hint: 'Click a wall to cut a window.',
    shortcut: 'N',
  },
];

export function Toolbar() {
  const { tool, snapEnabled, readout } = useEditor();
  const active = TOOLS.find((entry) => entry.id === tool) ?? TOOLS[0]!;

  return (
    <div className="toolbar">
      <div className="toolbar__tools" role="toolbar" aria-label="Editing tools">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`toolbar__tool ${entry.id === tool ? 'toolbar__tool--active' : ''}`}
            title={`${entry.label} (${entry.shortcut}) — ${entry.hint}`}
            aria-pressed={entry.id === tool}
            onClick={() => editorStore.setTool(entry.id)}
          >
            <span className="toolbar__icon" aria-hidden="true">
              {entry.icon}
            </span>
            <span className="toolbar__label">{entry.label}</span>
          </button>
        ))}

        <span className="toolbar__divider" aria-hidden="true" />

        <button
          type="button"
          className={`toolbar__tool ${snapEnabled ? 'toolbar__tool--active' : ''}`}
          title="Snap to the grid, to other corners, and to 15-degree angles (G)"
          aria-pressed={snapEnabled}
          onClick={() => editorStore.patch({ snapEnabled: !snapEnabled })}
        >
          <span className="toolbar__icon" aria-hidden="true">
            #
          </span>
          <span className="toolbar__label">Snap</span>
        </button>
      </div>

      {/* One line of context: what the active tool does, or live drag feedback. */}
      <div className="toolbar__status">{readout ?? active.hint}</div>
    </div>
  );
}

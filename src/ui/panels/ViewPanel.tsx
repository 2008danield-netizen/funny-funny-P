/**
 * Viewport and editing preferences.
 *
 * These are display and interaction preferences rather than design data, so they
 * live in the editor store or component state — they must never end up in an
 * exported design file.
 */

import { useState } from 'react';

import { Panel } from '../components/Panel';
import { Segmented } from '../components/Segmented';
import { Toggle } from '../components/Toggle';
import { useEditor } from '@/bridge/useEditor';
import { editorStore } from '@/state/selection';

/** Grid spacings offered, in metres. */
const GRID_OPTIONS = [
  { id: '0.01', label: '1 cm' },
  { id: '0.05', label: '5 cm' },
  { id: '0.1', label: '10 cm' },
  { id: '0.25', label: '25 cm' },
] as const;

interface ViewPanelProps {
  onAutoHideWallsChange: (enabled: boolean) => void;
}

export function ViewPanel({ onAutoHideWallsChange }: ViewPanelProps) {
  const [autoHideWalls, setAutoHideWalls] = useState(true);
  const { snapEnabled, gridSize } = useEditor();

  return (
    <Panel title="View & Snapping" defaultOpen={false}>
      <Toggle
        label="Hide outside walls facing the camera"
        checked={autoHideWalls}
        onChange={(checked) => {
          setAutoHideWalls(checked);
          onAutoHideWallsChange(checked);
        }}
      />

      <Toggle
        label="Snap while dragging"
        checked={snapEnabled}
        onChange={(checked) => editorStore.patch({ snapEnabled: checked })}
      />

      <Segmented
        label="Grid"
        options={GRID_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
        value={String(gridSize) as (typeof GRID_OPTIONS)[number]['id']}
        onChange={(id) => editorStore.patch({ gridSize: Number(id) })}
      />

      <p className="field__hint">
        Snapping pulls corners onto the grid, onto other corners, and onto
        15-degree angles while drawing. Landing exactly on an existing corner is
        what closes a room — without it two walls can look joined while the plan
        still sees a gap.
      </p>

      <div className="field">
        <span className="field__label">Keyboard</span>
        <p className="field__hint">
          <strong>V M W D N</strong> pick tools · <strong>G</strong> toggles snap ·{' '}
          <strong>1-4</strong> jump between viewpoints · <strong>Delete</strong>{' '}
          removes the selection · <strong>Esc</strong> cancels ·{' '}
          <strong>Ctrl/&#8984; + Z</strong> undo.
        </p>
      </div>

      <p className="field__hint">
        Editing is most precise from the <strong>Plan</strong> viewpoint (press
        4): looking straight down, one pixel of cursor travel is a fixed distance
        on the floor, exactly as it would be in a 2D floor-plan editor.
      </p>
    </Panel>
  );
}

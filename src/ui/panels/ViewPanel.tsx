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
  /** Turns the refining renderer on. Null until the engine is running. */
  onProgressiveChange: ((enabled: boolean) => void) | null;
  progressive: boolean;
}

export function ViewPanel({
  onAutoHideWallsChange,
  onProgressiveChange,
  progressive,
}: ViewPanelProps) {
  const [autoHideWalls, setAutoHideWalls] = useState(true);
  const { snapEnabled, gridSize } = useEditor();

  return (
    <Panel title="View & Snapping" defaultOpen={false}>
      {/* ---------------------------- Picture quality --------------------- */}

      <Toggle
        label="Refine the picture when you stop moving"
        checked={progressive}
        onChange={(checked) => onProgressiveChange?.(checked)}
      />
      <p className="field__hint">
        While you are moving the camera the view is drawn once, fast. The moment you
        stop, it starts again and keeps adding samples &mdash; each one with the sun
        treated as a disc rather than a point, and with ambient occlusion computed
        afresh. Over about a second the corners darken the way real corners do, the
        shadows go soft at their edges, and the jagged edges disappear.
        <br />
        <br />
        It is the difference between a diagram and a photograph, and it is the single
        biggest thing available here. It was written in session 11 and has been
        switched off ever since, because the machine it was built on has no real GPU
        and I could not confirm it worked &mdash; on a software renderer it draws the
        sky and no building at all, and shipping a default that might blank the model
        on somebody&rsquo;s laptop was not a trade worth making.
        <br />
        <br />
        <strong>If the model disappears when you switch this on, turn it off and tell
        me.</strong> That is the bug I could never reproduce.
      </p>

      <Toggle
        label="Hide outside walls facing the camera"
        checked={autoHideWalls}
        onChange={(checked) => {
          setAutoHideWalls(checked);
          onAutoHideWallsChange(checked);
        }}
      />
      <p className="field__hint">
        The roof comes off with them, because a house with its near walls hidden and its roof still
        on can be seen into from the side and not at all from above. Switch this off to look at the
        building from outside as it would be built.
      </p>

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

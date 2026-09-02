/**
 * Viewport behaviour.
 *
 * These are display preferences rather than design data, so they are held in
 * component state and pushed to the engine directly — they must never end up in
 * an exported design file.
 */

import { useState } from 'react';

import { Panel } from '../components/Panel';
import { Toggle } from '../components/Toggle';

interface ViewPanelProps {
  onAutoHideWallsChange: (enabled: boolean) => void;
}

export function ViewPanel({ onAutoHideWallsChange }: ViewPanelProps) {
  const [autoHideWalls, setAutoHideWalls] = useState(true);

  return (
    <Panel title="View" defaultOpen={false}>
      <Toggle
        label="Hide walls in front of the camera"
        checked={autoHideWalls}
        onChange={(checked) => {
          setAutoHideWalls(checked);
          onAutoHideWallsChange(checked);
        }}
      />

      <p className="field__hint">
        With this on, any wall standing between you and the room fades out as you
        orbit, so you are always looking into the space rather than at the
        outside of a box. Turn it off to inspect the building envelope.
      </p>

      <div className="field">
        <span className="field__label">Keyboard</span>
        <p className="field__hint">
          <strong>1–4</strong> jump between viewpoints · <strong>Ctrl/⌘ + Z</strong>{' '}
          undo · <strong>Ctrl/⌘ + Shift + Z</strong> redo · drag to orbit ·
          right-drag to pan · scroll to zoom.
        </p>
      </div>
    </Panel>
  );
}

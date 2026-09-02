/**
 * Lighting mood and ceiling visibility.
 *
 * Ceiling COLOUR moved into the room inspector in session 2, since a multi-room
 * plan can have a different ceiling per room. What stays here is the global
 * show/hide, which is a way of looking at the plan rather than a property of it.
 */

import { Panel } from '../components/Panel';
import { Segmented } from '../components/Segmented';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { useDesignEdit, useDesignSlice } from '@/bridge/useDesign';
import { LIGHTING_PRESETS } from '@/scene/Lighting';
import type { LightingPresetId } from '@/state/types';

const LIGHTING_OPTIONS = (Object.keys(LIGHTING_PRESETS) as LightingPresetId[]).map((id) => ({
  id,
  label: LIGHTING_PRESETS[id].label,
  title: LIGHTING_PRESETS[id].description,
}));

export function LightingPanel() {
  const lighting = useDesignSlice((doc) => doc.lighting);
  const showCeilings = useDesignSlice((doc) => doc.showCeilings);
  const edit = useDesignEdit();

  return (
    <Panel title="Light" badge={LIGHTING_PRESETS[lighting.presetId].label}>
      <Segmented
        label="Lighting"
        options={LIGHTING_OPTIONS}
        value={lighting.presetId}
        onChange={(id) =>
          edit((draft) => {
            draft.lighting.presetId = id;
          })
        }
      />

      <Slider
        label="Brightness"
        displayValue={`${Math.round(lighting.intensity * 100)}%`}
        value={lighting.intensity}
        min={0.2}
        max={2}
        step={0.05}
        onChange={(value) =>
          edit((draft) => {
            draft.lighting.intensity = value;
          }, { history: 'coalesce', coalesceKey: 'lighting.intensity' })
        }
      />

      <Toggle
        label="Cast shadows"
        checked={lighting.shadowsEnabled}
        onChange={(checked) =>
          edit((draft) => {
            draft.lighting.shadowsEnabled = checked;
          })
        }
      />

      <Toggle
        label="Show ceilings"
        checked={showCeilings}
        onChange={(checked) =>
          edit((draft) => {
            draft.showCeilings = checked;
          })
        }
      />

      <p className="field__hint">
        Ceilings are hidden by default so you can look down into the plan. Turn
        them on before switching to the inside view — they change how light
        bounces around a room. Each room's ceiling colour is set in its own
        inspector.
      </p>
    </Panel>
  );
}

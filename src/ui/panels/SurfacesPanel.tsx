/**
 * Ceiling and lighting — the two settings that change how every other surface
 * in the room reads, which is why they share a panel.
 */

import { Panel } from '../components/Panel';
import { ColorInput } from '../components/ColorInput';
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

export function SurfacesPanel() {
  const ceiling = useDesignSlice((doc) => doc.room.ceiling);
  const lighting = useDesignSlice((doc) => doc.lighting);
  const edit = useDesignEdit();

  return (
    <Panel title="Ceiling & Light" badge={LIGHTING_PRESETS[lighting.presetId].label}>
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
        label="Show ceiling"
        checked={ceiling.visible}
        onChange={(checked) =>
          edit((draft) => {
            draft.room.ceiling.visible = checked;
          })
        }
      />

      {ceiling.visible && (
        <ColorInput
          label="Ceiling colour"
          value={ceiling.color}
          onChange={(hex) =>
            edit((draft) => {
              draft.room.ceiling.color = hex;
            }, { history: 'coalesce', coalesceKey: 'ceiling.color' })
          }
        />
      )}

      <p className="field__hint">
        The ceiling is hidden by default so you can look down into the room.
        Turn it on before switching to the inside view — it changes how light
        bounces around the space.
      </p>
    </Panel>
  );
}

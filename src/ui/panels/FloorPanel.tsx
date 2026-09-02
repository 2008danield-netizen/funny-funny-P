/**
 * Floor material, tint and pattern scale.
 */

import { Panel } from '../components/Panel';
import { ColorInput } from '../components/ColorInput';
import { MaterialPicker } from '../components/MaterialPicker';
import { Slider } from '../components/Slider';
import { useDesignEdit, useDesignSlice } from '@/bridge/useDesign';
import { getFloorPreset } from '@/scene/materials/presets';

export function FloorPanel() {
  const floor = useDesignSlice((doc) => doc.room.floor);
  const edit = useDesignEdit();
  const preset = getFloorPreset(floor.presetId);

  return (
    <Panel title="Floor" badge={preset.label}>
      <MaterialPicker
        value={floor.presetId}
        onSelect={(presetId) =>
          edit((draft) => {
            draft.room.floor.presetId = presetId;
          })
        }
      />

      <p className="field__hint">{preset.description}</p>

      <ColorInput
        label="Tint"
        value={floor.color}
        onChange={(hex) =>
          edit((draft) => {
            draft.room.floor.color = hex;
          }, { history: 'coalesce', coalesceKey: 'floor.color' })
        }
      />

      <Slider
        label="Pattern scale"
        displayValue={`${floor.textureScale.toFixed(2)}×`}
        value={floor.textureScale}
        min={0.25}
        max={3}
        step={0.05}
        onChange={(value) =>
          edit((draft) => {
            draft.room.floor.textureScale = value;
          }, { history: 'coalesce', coalesceKey: 'floor.textureScale' })
        }
      />

      <div className="button-row">
        <button
          type="button"
          className="btn"
          disabled={floor.color === '#ffffff' && floor.textureScale === 1}
          onClick={() =>
            edit((draft) => {
              draft.room.floor.color = '#ffffff';
              draft.room.floor.textureScale = 1;
            })
          }
        >
          Reset tint &amp; scale
        </button>
      </div>

      <p className="field__hint">
        Tint multiplies over the material, so white leaves it untouched. Pattern
        scale changes the real-world size of planks or tiles — it does not
        stretch them when the room is resized.
      </p>
    </Panel>
  );
}

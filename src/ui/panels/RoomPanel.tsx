/**
 * Room dimensions.
 *
 * Sliders write through to the store on every frame of a drag using the
 * 'coalesce' history mode, keyed per dimension. That gives instant visual
 * feedback while still collapsing the whole drag into one undo step.
 */

import { Panel } from '../components/Panel';
import { Slider } from '../components/Slider';
import { Segmented } from '../components/Segmented';
import { useDesignEdit, useDesignSlice } from '@/bridge/useDesign';
import { floorArea, perimeter } from '@/scene/roomGeometry';
import { ROOM_LIMITS, type UnitSystem } from '@/state/types';
import {
  formatArea,
  formatLength,
  fromDisplayNumber,
  toDisplayNumber,
} from '@/state/units';

const UNIT_OPTIONS: ReadonlyArray<{ id: UnitSystem; label: string }> = [
  { id: 'metric', label: 'Metric (m)' },
  { id: 'imperial', label: 'Imperial (ft)' },
];

export function RoomPanel() {
  const room = useDesignSlice((doc) => doc.room);
  const units = useDesignSlice((doc) => doc.units);
  const edit = useDesignEdit();

  /** Builds a slider whose values are shown in the user's chosen unit system. */
  const dimensionSlider = (
    key: 'width' | 'depth' | 'height',
    label: string,
  ) => {
    const limits = ROOM_LIMITS[key];
    const metres = room[key];

    return (
      <Slider
        label={label}
        displayValue={formatLength(metres, units)}
        // The slider itself always works in metres; only the label converts.
        // Keeping the control metric avoids rounding drift when the user
        // switches unit systems mid-drag.
        value={metres}
        min={limits.min}
        max={limits.max}
        step={limits.step}
        onChange={(value) =>
          edit((draft) => {
            draft.room[key] = value;
          }, { history: 'coalesce', coalesceKey: `room.${key}` })
        }
      />
    );
  };

  const area = floorArea(room);

  return (
    <Panel
      title="Room"
      badge={`${formatLength(room.width, units)} × ${formatLength(room.depth, units)}`}
    >
      <Segmented
        label="Units"
        options={UNIT_OPTIONS}
        value={units}
        onChange={(value) =>
          edit((draft) => {
            draft.units = value;
          })
        }
      />

      {dimensionSlider('width', 'Width')}
      {dimensionSlider('depth', 'Depth')}
      {dimensionSlider('height', 'Ceiling height')}

      <Slider
        label="Wall thickness"
        displayValue={
          units === 'imperial'
            ? `${(toDisplayNumber(room.wallThickness, units) * 12).toFixed(1)} in`
            : `${Math.round(room.wallThickness * 100)} cm`
        }
        value={room.wallThickness}
        min={ROOM_LIMITS.wallThickness.min}
        max={ROOM_LIMITS.wallThickness.max}
        step={ROOM_LIMITS.wallThickness.step}
        onChange={(value) =>
          edit((draft) => {
            draft.room.wallThickness = value;
          }, { history: 'coalesce', coalesceKey: 'room.wallThickness' })
        }
      />

      <div className="summary">
        <div className="summary__item">
          <span className="summary__label">Floor area</span>
          <span className="summary__value">{formatArea(area, units)}</span>
        </div>
        <div className="summary__item">
          <span className="summary__label">Perimeter</span>
          <span className="summary__value">{formatLength(perimeter(room), units)}</span>
        </div>
        <div className="summary__item">
          <span className="summary__label">Volume</span>
          <span className="summary__value">
            {units === 'imperial'
              ? `${Math.round(area * room.height * 35.315)} ft³`
              : `${(area * room.height).toFixed(1)} m³`}
          </span>
        </div>
      </div>

      <p className="field__hint">
        Dimensions are interior measurements. Everything is stored in metres —
        switching units only changes how values are displayed, never the design.
        {units === 'imperial' && ` One foot is ${fromDisplayNumber(1, units).toFixed(4)} m.`}
      </p>
    </Panel>
  );
}

/**
 * Plan-wide settings and the list of detected rooms.
 *
 * The room list is the honest readout of what the wall graph currently encloses.
 * If a room is missing from it, the walls that should surround it are not
 * actually joined — which is far more useful feedback than a silently
 * untextured floor, and is why the list shows even when only one room exists.
 */

import { Panel } from '../components/Panel';
import { NumberField } from '../components/NumberField';
import { useDesignEdit, useDesignSlice } from '@/bridge/useDesign';
import { useEditor, useRegions } from '@/bridge/useEditor';
import { editorStore } from '@/state/selection';
import { addRectangle, resolveRoomSpec } from '@/state/planOps';
import { planBounds, totalFloorArea } from '@/scene/planGraph';
import { PLAN_LIMITS } from '@/state/types';
import { formatArea, formatLength } from '@/state/units';

export function PlanPanel() {
  const plan = useDesignSlice((doc) => doc.plan);
  const units = useDesignSlice((doc) => doc.units);
  const regions = useRegions();
  const { selection } = useEditor();
  const edit = useDesignEdit();

  const area = totalFloorArea(regions);
  const bounds = planBounds(plan);

  return (
    <Panel
      title="Plan"
      badge={`${regions.length} ${regions.length === 1 ? 'room' : 'rooms'}`}
    >
      <div className="summary">
        <div className="summary__item">
          <span className="summary__label">Floor area</span>
          <span className="summary__value">{formatArea(area, units)}</span>
        </div>
        <div className="summary__item">
          <span className="summary__label">Walls</span>
          <span className="summary__value">{plan.walls.length}</span>
        </div>
        <div className="summary__item">
          <span className="summary__label">Footprint</span>
          <span className="summary__value">
            {formatLength(bounds.width, units)} x {formatLength(bounds.depth, units)}
          </span>
        </div>
      </div>

      {/* Room list. Clicking a row selects that room's floor, which is also how
          the inspector is reached without hunting for the floor in 3D. */}
      <div className="room-list">
        {regions.length === 0 && (
          <p className="field__hint">
            No enclosed rooms yet. Rooms appear here as soon as a loop of walls
            closes — if one is missing, two corners that look joined probably are
            not quite touching.
          </p>
        )}
        {regions.map((region) => {
          const spec = resolveRoomSpec(plan, region.key);
          const active = selection.kind === 'floor' && selection.id === region.key;
          return (
            <button
              key={region.key}
              type="button"
              className={`room-list__item ${active ? 'room-list__item--active' : ''}`}
              onClick={() => editorStore.select('floor', region.key)}
            >
              <span className="room-list__name">{spec.name}</span>
              <span className="room-list__area">{formatArea(region.area, units)}</span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="btn btn--accent"
        onClick={() =>
          edit((draft) => {
            // Placed clear of the existing footprint so the new room does not
            // land on top of what is already there.
            const offset = planBounds(draft.plan).max.x + 2.5;
            addRectangle(draft.plan, { x: offset, z: 0 }, 3.6, 3 );
          })
        }
      >
        Add a room
      </button>

      <p className="field__hint">
        A new room appears beside the plan. Drag its walls with the Move tool to
        butt it against an existing room, then put a door between them.
      </p>

      {/* Defaults applied to walls drawn from here on. */}
      <NumberField
        label="New wall height"
        value={plan.defaultWallHeight}
        units={units}
        min={PLAN_LIMITS.wallHeight.min}
        max={PLAN_LIMITS.wallHeight.max}
        onChange={(metres) =>
          edit((draft) => {
            draft.plan.defaultWallHeight = metres;
          })
        }
      />
      <NumberField
        label="New wall thickness"
        value={plan.defaultWallThickness}
        units={units}
        min={PLAN_LIMITS.wallThickness.min}
        max={PLAN_LIMITS.wallThickness.max}
        onChange={(metres) =>
          edit((draft) => {
            draft.plan.defaultWallThickness = metres;
          })
        }
      />

      <div className="button-row">
        <button
          type="button"
          className="btn"
          onClick={() =>
            edit((draft) => {
              // Applying to every wall is the common case after deciding on a
              // ceiling height; per-wall overrides remain available in the
              // inspector for a raked or split-level space.
              for (const wall of draft.plan.walls) wall.height = draft.plan.defaultWallHeight;
            })
          }
        >
          Apply height to all walls
        </button>
      </div>
    </Panel>
  );
}

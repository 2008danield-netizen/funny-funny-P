/**
 * Wall colours and finishes.
 *
 * Each wall is independently colourable — accent walls are one of the first
 * things anyone reaches for — with an "apply to all" shortcut for the common
 * case of painting the whole room one colour.
 */

import { useState } from 'react';

import { Panel } from '../components/Panel';
import { ColorInput } from '../components/ColorInput';
import { Segmented } from '../components/Segmented';
import { SwatchGrid } from '../components/SwatchGrid';
import { useDesignEdit, useDesignSlice } from '@/bridge/useDesign';
import { WALL_FINISHES, WALL_PAINTS, nearestFinishId } from '@/scene/materials/presets';
import { WALL_IDS, WALL_LABELS, type WallId } from '@/state/types';

/** Finish IDs as a plain union, for the segmented control's generic parameter. */
type FinishId = (typeof WALL_FINISHES)[number]['id'];

export function WallsPanel() {
  const walls = useDesignSlice((doc) => doc.room.walls);
  const edit = useDesignEdit();

  // Which wall the colour controls currently target. View state, not design
  // state, so it lives in the component.
  const [selected, setSelected] = useState<WallId>('north');
  const active = walls[selected];

  /** Applies a change to the selected wall, or to all four. */
  const setWallColor = (hex: string, allWalls = false) => {
    edit(
      (draft) => {
        if (allWalls) {
          for (const id of WALL_IDS) draft.room.walls[id].color = hex;
        } else {
          draft.room.walls[selected].color = hex;
        }
      },
      // Dragging the native colour picker fires continuously; coalescing keyed
      // by wall keeps that to one undo step per wall.
      { history: 'coalesce', coalesceKey: `wall.${allWalls ? 'all' : selected}.color` },
    );
  };

  const allSameColor = WALL_IDS.every((id) => walls[id].color === active.color);

  return (
    <Panel title="Walls" badge={allSameColor ? active.color.toUpperCase() : 'Mixed'}>
      {/* Wall selector. Each tab carries a strip of its own colour so the user
          can see the whole room's scheme at a glance. */}
      <div className="wall-tabs" role="tablist" aria-label="Select a wall">
        {WALL_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === selected}
            className={`wall-tab ${id === selected ? 'wall-tab--active' : ''}`}
            onClick={() => setSelected(id)}
          >
            <span className="wall-tab__dot" style={{ background: walls[id].color }} />
            {WALL_LABELS[id]}
          </button>
        ))}
      </div>

      <SwatchGrid swatches={WALL_PAINTS} value={active.color} onSelect={(hex) => setWallColor(hex)} />

      <ColorInput
        label={`${WALL_LABELS[selected]} wall colour`}
        value={active.color}
        onChange={(hex) => setWallColor(hex)}
      />

      <Segmented<FinishId>
        label="Paint finish"
        options={WALL_FINISHES.map((finish) => ({
          id: finish.id,
          label: finish.label,
          title: `Roughness ${finish.roughness}`,
        }))}
        value={nearestFinishId(active.roughness) as FinishId}
        onChange={(id) => {
          const finish = WALL_FINISHES.find((entry) => entry.id === id);
          if (!finish) return;
          edit((draft) => {
            draft.room.walls[selected].roughness = finish.roughness;
          });
        }}
      />

      <div className="button-row">
        <button
          type="button"
          className="btn"
          onClick={() => setWallColor(active.color, true)}
          disabled={allSameColor}
        >
          Apply colour to all walls
        </button>
      </div>

      <p className="field__hint">
        Finish controls how much light the paint reflects. Matte hides wall
        imperfections; gloss shows off colour but reveals every bump.
      </p>
    </Panel>
  );
}

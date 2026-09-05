/**
 * The contextual inspector: properties for whatever is selected.
 *
 * One panel rather than four, because in a direct-manipulation editor the
 * selection IS the context. Showing a wall panel, a room panel and a door panel
 * simultaneously would mean three of them are always stale.
 */

import { Panel } from '../components/Panel';
import { ColorInput } from '../components/ColorInput';
import { MaterialPicker } from '../components/MaterialPicker';
import { NumberField } from '../components/NumberField';
import { Segmented } from '../components/Segmented';
import { Slider } from '../components/Slider';
import { SwatchGrid } from '../components/SwatchGrid';
import {
  useEditor,
  useSelectedOpening,
  useSelectedRegion,
  useSelectedWall,
  wallLength,
} from '@/bridge/useEditor';
import { activeLevel } from '@/state/levels';
import { useDesign, useDesignEdit, useDesignSlice } from '@/bridge/useDesign';
import { getFloorPreset, WALL_FINISHES, WALL_PAINTS, nearestFinishId } from '@/scene/materials/presets';
import {
  openingPresetsOfKind,
  getOpeningPreset,
  type OpeningPreset,
} from '@/scene/openings/presets';
import { editorStore } from '@/state/selection';
import { removeOpening, deleteWall, resolveRoomSpec, setRoomSpec, updateOpening } from '@/state/planOps';
import { duplicateFurniture, removeFurniture, resizeFurniture } from '@/state/furnitureOps';
import { removeDevice, updateDevice } from '@/state/buildingOps';
import { getCatalogEntry } from '@/furniture/catalog';
import { itemDimensions } from '@/physics/colliders';
import { OPENING_LIMITS, PLAN_LIMITS, type DeviceKind, type WallSide } from '@/state/types';
import { formatArea, formatLength } from '@/state/units';

type FinishId = (typeof WALL_FINISHES)[number]['id'];

interface InspectorPanelProps {
  /** Inserts a corner at the middle of the selected wall. */
  onSplitWall: () => void;
  /** Turns the selected piece of furniture by one step. */
  onRotate: (direction: number) => void;
}

export function InspectorPanel({ onSplitWall, onRotate }: InspectorPanelProps) {
  const { selection } = useEditor();
  const wall = useSelectedWall();
  const openingSelection = useSelectedOpening();
  const region = useSelectedRegion();

  if (selection.kind === 'furniture') return <FurnitureInspector onRotate={onRotate} />;
  if (selection.kind === 'device') return <DeviceInspector />;
  if (wall) return <WallInspector onSplitWall={onSplitWall} />;
  if (openingSelection) return <OpeningInspector />;
  if (region) return <RoomInspector />;

  return (
    <Panel title="Inspector">
      <p className="field__hint">
        {selection.kind === 'vertex'
          ? 'Corner selected. Drag it with the Move tool, or press Delete to remove it — the walls either side will join up.'
          : 'Nothing selected. Click a wall, floor, door or window in the 3D view to edit it.'}
      </p>
    </Panel>
  );
}

/* --------------------------------- Wall -------------------------------- */

function WallInspector({ onSplitWall }: Pick<InspectorPanelProps, 'onSplitWall'>) {
  const wall = useSelectedWall();
  const plan = useDesignSlice((doc) => activeLevel(doc).plan);
  const units = useDesignSlice((doc) => doc.units);
  const edit = useDesignEdit();

  if (!wall) return null;
  const wallId = wall.id;
  const length = wallLength(plan, wall);

  /** Paints one face of this wall, creating the override if needed. */
  const paintFace = (side: WallSide, color: string) => {
    edit(
      (draft) => {
        const target = activeLevel(draft).plan.walls.find((candidate) => candidate.id === wallId);
        if (!target) return;
        const existing = target.faces[side];
        target.faces[side] = {
          color,
          roughness: existing?.roughness ?? 0.88,
        };
      },
      { history: 'coalesce', coalesceKey: `wall.${wallId}.${side}.color` },
    );
  };

  const clearFace = (side: WallSide) => {
    edit((draft) => {
      const target = activeLevel(draft).plan.walls.find((candidate) => candidate.id === wallId);
      if (target) delete target.faces[side];
    });
  };

  return (
    <Panel title="Wall" badge={formatLength(length, units)}>
      <NumberField
        label="Height"
        value={wall.height}
        units={units}
        min={PLAN_LIMITS.wallHeight.min}
        max={PLAN_LIMITS.wallHeight.max}
        onChange={(metres) =>
          edit((draft) => {
            const target = activeLevel(draft).plan.walls.find((candidate) => candidate.id === wallId);
            if (target) target.height = metres;
          })
        }
      />

      <NumberField
        label="Thickness"
        value={wall.thickness}
        units={units}
        min={PLAN_LIMITS.wallThickness.min}
        max={PLAN_LIMITS.wallThickness.max}
        onChange={(metres) =>
          edit((draft) => {
            const target = activeLevel(draft).plan.walls.find((candidate) => candidate.id === wallId);
            if (target) target.thickness = metres;
          })
        }
      />

      {/* Each face is painted separately: a wall between two rooms belongs to
          both of them, and an accent wall is exactly a single-face override. */}
      {(['a', 'b'] as const).map((side) => {
        const override = wall.faces[side];
        return (
          <div key={side} className="field">
            <span className="field__label">
              <span>Side {side.toUpperCase()}</span>
              <span className="field__value">{override ? 'custom' : 'room colour'}</span>
            </span>
            <SwatchGrid
              swatches={WALL_PAINTS}
              value={override?.color ?? ''}
              onSelect={(hex) => paintFace(side, hex)}
            />
            {override && (
              <>
                <ColorInput
                  label=""
                  value={override.color}
                  onChange={(hex) => paintFace(side, hex)}
                />
                <button type="button" className="btn" onClick={() => clearFace(side)}>
                  Match the room again
                </button>
              </>
            )}
          </div>
        );
      })}

      <div className="button-row">
        <button type="button" className="btn" onClick={onSplitWall}>
          Add corner
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => {
            edit((draft) => deleteWall(activeLevel(draft).plan, wallId));
            editorStore.clearSelection();
          }}
        >
          Delete wall
        </button>
      </div>

      <p className="field__hint">
        Adding a corner splits this wall in two so you can bend it — the fastest
        way to turn a rectangle into an L-shaped room.
      </p>
    </Panel>
  );
}

/* ------------------------------ Furniture ------------------------------ */

function FurnitureInspector({ onRotate }: Pick<InspectorPanelProps, 'onRotate'>) {
  const { selection } = useEditor();
  const furniture = useDesignSlice((doc) => activeLevel(doc).furniture);
  const units = useDesignSlice((doc) => doc.units);
  const edit = useDesignEdit();

  const item = furniture.find((candidate) => candidate.id === selection.id);
  if (!item) return null;

  const itemId = item.id;
  const entry = getCatalogEntry(item.catalogId);
  const dimensions = itemDimensions(item);
  const degrees = Math.round((item.rotation * 180) / Math.PI);

  return (
    <Panel title={entry.name} badge={entry.series}>
      <p className="field__hint">{entry.description}</p>

      <div className="summary">
        <div className="summary__item">
          <span className="summary__label">Width</span>
          <span className="summary__value">{formatLength(dimensions.width, units)}</span>
        </div>
        <div className="summary__item">
          <span className="summary__label">Depth</span>
          <span className="summary__value">{formatLength(dimensions.depth, units)}</span>
        </div>
        <div className="summary__item">
          <span className="summary__label">Height</span>
          <span className="summary__value">{formatLength(dimensions.height, units)}</span>
        </div>
      </div>

      {/* Colourways. Each swatch shows the frame and upholstery colours
          together, since for most pieces both are visible at once. */}
      <div className="field">
        <span className="field__label">Finish</span>
        <div className="colorways">
          {entry.colorways.map((colorway) => {
            const active = (item.colorwayId ?? entry.colorways[0]!.id) === colorway.id;
            return (
              <button
                key={colorway.id}
                type="button"
                title={colorway.label}
                aria-label={colorway.label}
                aria-pressed={active}
                className={`colorways__item ${active ? 'colorways__item--active' : ''}`}
                onClick={() =>
                  edit((draft) => {
                    const target = activeLevel(draft).furniture.find((candidate) => candidate.id === itemId);
                    if (target) target.colorwayId = colorway.id;
                  })
                }
              >
                <span style={{ background: colorway.frame }} />
                <span style={{ background: colorway.soft }} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <label className="field__label">
          <span>Rotation</span>
          <span className="field__value">{degrees}&deg;</span>
        </label>
        <div className="button-row">
          <button type="button" className="btn" onClick={() => onRotate(-1)} title="Rotate anticlockwise (Shift+R)">
            &#8630; 15&deg;
          </button>
          <button type="button" className="btn" onClick={() => onRotate(1)} title="Rotate clockwise (R)">
            15&deg; &#8631;
          </button>
        </div>
      </div>

      {/* Only a genuinely variable product is resizable — see the note on
          `resizable` in the catalogue. */}
      {entry.resizable?.width && (
        <Slider
          label="Length"
          displayValue={formatLength(dimensions.width, units)}
          value={dimensions.width}
          min={entry.resizable.width[0]}
          max={entry.resizable.width[1]}
          step={0.01}
          onChange={(value) =>
            edit(
              (draft) => {
                resizeFurniture(draft, activeLevel(draft), itemId, { width: value });
              },
              { history: 'coalesce', coalesceKey: `furniture.${itemId}.width` },
            )
          }
        />
      )}

      <div className="button-row">
        <button
          type="button"
          className="btn"
          title="Duplicate (Ctrl/Cmd + D)"
          onClick={() => {
            let created: string | null = null;
            edit((draft) => {
              created = duplicateFurniture(draft, activeLevel(draft), itemId);
            });
            if (created) editorStore.select('furniture', created);
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => {
            edit((draft) => removeFurniture(activeLevel(draft), itemId));
            editorStore.clearSelection();
          }}
        >
          Remove
        </button>
      </div>

      <p className="field__hint">
        Drag it anywhere in the room — it will not pass through a wall or another
        piece, and things that belong against a wall snap flush to one as they
        get close.
      </p>
    </Panel>
  );
}

/* ------------------------------- Opening ------------------------------- */

function OpeningInspector() {
  const selection = useSelectedOpening();
  const plan = useDesignSlice((doc) => activeLevel(doc).plan);
  const units = useDesignSlice((doc) => doc.units);
  const edit = useDesignEdit();

  if (!selection) return null;
  const { wall, openingIndex } = selection;
  const opening = wall.openings[openingIndex];
  if (!opening) return null;

  const openingId = opening.id;
  const preset = getOpeningPreset(opening.presetId);
  const isDoor = opening.kind === 'door';
  const length = wallLength(plan, wall);

  const patch = (update: Parameters<typeof updateOpening>[2], coalesceKey?: string) => {
    edit(
      (draft) => updateOpening(activeLevel(draft).plan, openingId, update),
      coalesceKey ? { history: 'coalesce', coalesceKey } : {},
    );
  };

  return (
    <Panel title={isDoor ? 'Door' : 'Window'} badge={preset.label}>
      <div className="materials">
        {openingPresetsOfKind(opening.kind).map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            title={candidate.description}
            aria-pressed={candidate.id === opening.presetId}
            className={`material-tile ${
              candidate.id === opening.presetId ? 'material-tile--active' : ''
            }`}
            onClick={() =>
              // Switching preset also adopts its dimensions, which is what makes
              // the choice feel like picking a real product rather than a label.
              patch({
                presetId: candidate.id,
                width: candidate.width,
                height: candidate.height,
                sillHeight: candidate.sillHeight,
              })
            }
          >
            {/* Drawn as inline SVG rather than a Unicode glyph: the box-drawing
                characters that would suit here are missing from many system
                fonts and render as an empty tofu box. */}
            <span className="material-tile__glyph" aria-hidden="true">
              <OpeningGlyph preset={candidate} />
            </span>
            <span className="material-tile__label">{candidate.label}</span>
          </button>
        ))}
      </div>

      <NumberField
        label="Width"
        value={opening.width}
        units={units}
        min={OPENING_LIMITS.width.min}
        max={OPENING_LIMITS.width.max}
        onChange={(metres) => patch({ width: metres })}
      />
      <NumberField
        label="Height"
        value={opening.height}
        units={units}
        min={OPENING_LIMITS.height.min}
        max={OPENING_LIMITS.height.max}
        onChange={(metres) => patch({ height: metres })}
      />
      {!isDoor && (
        <NumberField
          label="Sill height"
          value={opening.sillHeight}
          units={units}
          min={OPENING_LIMITS.sillHeight.min}
          max={OPENING_LIMITS.sillHeight.max}
          onChange={(metres) => patch({ sillHeight: metres })}
        />
      )}

      <Slider
        label="Position along wall"
        displayValue={formatLength(opening.offset, units)}
        value={opening.offset}
        min={0}
        max={Math.max(0.5, length)}
        step={0.01}
        onChange={(value) => patch({ offset: value }, `opening.${openingId}.offset`)}
      />

      {isDoor && preset.leaf !== 'none' && preset.leaf !== 'sliding' && (
        <>
          <Segmented
            label="Hinge side"
            options={[
              { id: 'start', label: 'Start' },
              { id: 'end', label: 'End' },
            ]}
            value={opening.hinge}
            onChange={(id) => patch({ hinge: id })}
          />
          <Segmented
            label="Opens towards"
            options={[
              { id: 'a', label: 'Side A' },
              { id: 'b', label: 'Side B' },
            ]}
            value={opening.swing}
            onChange={(id) => patch({ swing: id })}
          />
        </>
      )}

      <button
        type="button"
        className="btn btn--danger"
        onClick={() => {
          edit((draft) => removeOpening(activeLevel(draft).plan, openingId));
          editorStore.clearSelection();
        }}
      >
        Remove {isDoor ? 'door' : 'window'}
      </button>

      <p className="field__hint">
        Doors are drawn standing open so you can see the floor area the swing
        uses up — that clearance is what session 4 will enforce against furniture.
      </p>
    </Panel>
  );
}

/**
 * A miniature elevation of an opening: the wall, the aperture, and its glazing
 * bars or door leaf. Proportional to the real preset, so the tiles read as
 * different products rather than as identical icons with different captions.
 */
function OpeningGlyph({ preset }: { preset: OpeningPreset }) {
  // Lay the preset out inside a 40 x 40 box, scaled by a nominal 2.4 m wall.
  const wallHeight = 2.4;
  const scale = 34 / wallHeight;
  const width = Math.min(34, preset.width * scale);
  const height = Math.min(34, preset.height * scale);
  const x = (40 - width) / 2;
  const y = 37 - preset.sillHeight * scale - height;

  return (
    <svg viewBox="0 0 40 40" width="100%" height="100%" role="presentation">
      <rect x="2" y="3" width="36" height="34" rx="1.5" fill="currentColor" opacity="0.14" />
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill="currentColor"
        opacity="0.32"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {/* Glazing bars for windows, a leaf edge for doors. */}
      {preset.glazed &&
        Array.from({ length: preset.mullions }, (_, i) => (
          <line
            key={i}
            x1={x + (width / (preset.mullions + 1)) * (i + 1)}
            y1={y}
            x2={x + (width / (preset.mullions + 1)) * (i + 1)}
            y2={y + height}
            stroke="currentColor"
            strokeWidth="1"
          />
        ))}
      {preset.leaf === 'single' && (
        <path
          d={`M ${x} ${y + height} A ${width} ${width} 0 0 1 ${x + width} ${y + height - width}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          opacity="0.7"
        />
      )}
      {preset.leaf === 'double' && (
        <line
          x1={x + width / 2}
          y1={y}
          x2={x + width / 2}
          y2={y + height}
          stroke="currentColor"
          strokeWidth="1.2"
        />
      )}
    </svg>
  );
}

/* --------------------------------- Room -------------------------------- */

function RoomInspector() {
  const region = useSelectedRegion();
  const plan = useDesignSlice((doc) => activeLevel(doc).plan);
  const units = useDesignSlice((doc) => doc.units);
  const edit = useDesignEdit();

  if (!region) return null;
  const key = region.key;
  const spec = resolveRoomSpec(plan, key);
  const preset = getFloorPreset(spec.floor.presetId);

  const update = (
    change: Parameters<typeof setRoomSpec>[2],
    coalesceKey?: string,
  ) => {
    edit(
      (draft) => setRoomSpec(activeLevel(draft).plan, key, change),
      coalesceKey ? { history: 'coalesce', coalesceKey } : {},
    );
  };

  return (
    <Panel title="Room" badge={formatArea(region.area, units)}>
      <div className="field">
        <span className="field__label">Name</span>
        <input
          className="text-input"
          value={spec.name}
          onChange={(event) => update({ name: event.target.value }, `room.${key}.name`)}
          aria-label="Room name"
        />
      </div>

      <MaterialPicker
        value={spec.floor.presetId}
        onSelect={(presetId) => update({ floor: { ...spec.floor, presetId } })}
      />
      <p className="field__hint">{preset.description}</p>

      <ColorInput
        label="Floor tint"
        value={spec.floor.color}
        onChange={(hex) => update({ floor: { ...spec.floor, color: hex } }, `room.${key}.tint`)}
      />

      <Slider
        label="Pattern scale"
        displayValue={`${spec.floor.textureScale.toFixed(2)}x`}
        value={spec.floor.textureScale}
        min={0.25}
        max={3}
        step={0.05}
        onChange={(value) =>
          update({ floor: { ...spec.floor, textureScale: value } }, `room.${key}.scale`)
        }
      />

      <div className="field">
        <span className="field__label">Wall colour</span>
        <SwatchGrid
          swatches={WALL_PAINTS}
          value={spec.wall.color}
          onSelect={(hex) => update({ wall: { ...spec.wall, color: hex } })}
        />
      </div>

      <ColorInput
        label="Custom wall colour"
        value={spec.wall.color}
        onChange={(hex) => update({ wall: { ...spec.wall, color: hex } }, `room.${key}.wall`)}
      />

      <Segmented<FinishId>
        label="Paint finish"
        options={WALL_FINISHES.map((finish) => ({ id: finish.id, label: finish.label }))}
        value={nearestFinishId(spec.wall.roughness) as FinishId}
        onChange={(id) => {
          const finish = WALL_FINISHES.find((entry) => entry.id === id);
          if (finish) update({ wall: { ...spec.wall, roughness: finish.roughness } });
        }}
      />

      <ColorInput
        label="Ceiling colour"
        value={spec.ceilingColor}
        onChange={(hex) => update({ ceilingColor: hex }, `room.${key}.ceiling`)}
      />

      <p className="field__hint">
        This colour applies to every wall facing into this room. To make one wall
        an accent, select that wall and paint its side directly.
      </p>
    </Panel>
  );
}

/* -------------------------------- Device -------------------------------- */

/**
 * A selected electrical device.
 *
 * This is the "then let you adjust" half of the electrical: the app lays a
 * house out to satisfy the code, and everything it placed is the user's to
 * move, retype or delete. What it deliberately does NOT do is re-run the code
 * checks quietly in the background and move things back — the checks report,
 * the user decides.
 *
 * Changing a device does not re-assign circuits. That is a separate, explicit
 * button on the Electrical panel, because re-wiring renumbers every circuit in
 * the house and having that happen because somebody nudged a socket would be
 * astonishing.
 */
const DEVICE_KINDS: ReadonlyArray<{ id: DeviceKind; label: string }> = [
  { id: 'receptacle', label: 'Receptacle' },
  { id: 'receptacle-gfci', label: 'Receptacle, GFCI' },
  { id: 'receptacle-counter', label: 'Counter receptacle' },
  { id: 'receptacle-appliance', label: 'Appliance receptacle' },
  { id: 'switch', label: 'Switch' },
  { id: 'switch-3way', label: 'Switch, three-way' },
  { id: 'switch-dimmer', label: 'Dimmer' },
  { id: 'light-ceiling', label: 'Ceiling light' },
  { id: 'light-recessed', label: 'Recessed light' },
  { id: 'light-wall', label: 'Wall light' },
  { id: 'fan', label: 'Ceiling fan' },
  { id: 'smoke-alarm', label: 'Smoke alarm' },
  { id: 'thermostat', label: 'Thermostat' },
];

function DeviceInspector() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const { selection } = useEditor();

  const device = doc.electrical.devices.find((entry) => entry.id === selection.id);
  if (!device) {
    return (
      <Panel title="Inspector">
        <p className="field__hint">That device is gone.</p>
      </Panel>
    );
  }

  const circuit = doc.electrical.circuits.find((entry) => entry.id === device.circuitId);

  return (
    <Panel title={device.label || 'Device'}>
      <div className="field">
        <span className="field__label">What it is</span>
        <select
          className="select"
          value={device.kind}
          onChange={(event) =>
            edit((draft) =>
              updateDevice(draft, device.id, { kind: event.target.value as DeviceKind }),
            )
          }
        >
          {DEVICE_KINDS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <NumberField
        label="Height above the floor"
        value={device.height}
        units={doc.units}
        min={0}
        max={3}
        onChange={(height) =>
          edit((draft) => updateDevice(draft, device.id, { height }), {
            history: 'coalesce',
            coalesceKey: `device.${device.id}.height`,
          })
        }
      />

      <p className="field__hint">
        {circuit
          ? `On circuit ${circuit.reference} — ${circuit.name}, ${circuit.amps} A on ${circuit.conductor}.`
          : 'Not on a circuit yet. Press "Assign the circuits again" on the Electrical panel to sweep it up.'}
      </p>

      <p className="field__hint">
        Drag it in the 3D view to move it. A receptacle or a switch stays flush against the nearest
        wall and turns to face into the room; anything else goes where you put it.
      </p>

      <button
        type="button"
        className="btn btn--danger btn--wide"
        onClick={() => {
          edit((draft) => removeDevice(draft, device.id));
          editorStore.clearSelection();
        }}
      >
        Delete this device
      </button>
    </Panel>
  );
}

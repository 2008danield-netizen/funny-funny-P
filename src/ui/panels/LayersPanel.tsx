/**
 * The Layers panel: one place that says what is drawn.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS REPLACES.
 *
 * Four services, four visibility flags, four panels. Getting all of them on
 * screen at once meant opening "Electrical", then "Water & Drainage", then
 * "Heating & Cooling" and finding a checkbox in each — and the result was still
 * unreadable, because nothing in the app could hide the building. You could
 * switch the pipework on and then look at it through a solid wall.
 *
 * -----------------------------------------------------------------------------
 * WHY THE PRESETS COME FIRST.
 *
 * Because almost nobody wants a combination. They want one of four views, and
 * the most useful of those — services in a ghosted shell — takes seven clicks
 * to reach one checkbox at a time. Putting the presets above the list makes the
 * common case one click and leaves the list for the case that is not covered.
 *
 * The preset buttons are stateful: whichever one matches the current set is
 * marked, and it un-marks itself the moment a single layer is changed, so the
 * panel never claims you are in a view you have since edited.
 */

import { Panel } from '../components/Panel';
import { useEditor } from '@/bridge/useEditor';
import { editorStore } from '@/state/selection';
import {
  LAYERS,
  LAYER_GROUP_LABELS,
  LAYER_PRESETS,
  activePreset,
  cycleLayer,
  type LayerGroup,
  type LayerState,
} from '@/state/layers';

/** The word shown on a layer's button, and the class that colours it. */
const STATE_LABEL: Record<LayerState, string> = {
  solid: 'Shown',
  ghost: 'Ghosted',
  hidden: 'Hidden',
};

const GROUP_ORDER: readonly LayerGroup[] = ['shell', 'services', 'analysis'];

export function LayersPanel() {
  const { layers } = useEditor();
  const preset = activePreset(layers);

  const hiddenCount = LAYERS.filter((layer) => layers[layer.id] === 'hidden').length;

  return (
    <Panel
      title="Layers"
      badge={hiddenCount > 0 ? `${LAYERS.length - hiddenCount}/${LAYERS.length}` : undefined}
      defaultOpen={false}
    >
      <div className="layers__presets">
        {LAYER_PRESETS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`layers__preset ${preset === entry.id ? 'layers__preset--active' : ''}`}
            onClick={() => editorStore.setLayers(entry.layers)}
            title={entry.hint}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <p className="field__hint">
        {preset
          ? LAYER_PRESETS.find((entry) => entry.id === preset)?.hint
          : 'A view of your own. Click a layer to cycle it.'}
      </p>

      {GROUP_ORDER.map((group) => {
        const rows = LAYERS.filter((layer) => layer.group === group);
        if (rows.length === 0) return null;

        return (
          <div key={group} className="layers__group">
            <div className="elec__section-title">{LAYER_GROUP_LABELS[group]}</div>
            {rows.map((layer) => {
              const state = layers[layer.id];
              return (
                <button
                  key={layer.id}
                  type="button"
                  className={`layers__row layers__row--${state}`}
                  onClick={() => editorStore.setLayer(layer.id, cycleLayer(layer, state))}
                  title={layer.hint}
                  /*
                   * Announced as a toggle rather than as a plain button, so a
                   * screen reader says "Walls, ghosted" rather than just
                   * "Walls". `aria-pressed` is only false when the layer
                   * contributes nothing — a ghost is still pressed.
                   */
                  aria-pressed={state !== 'hidden'}
                >
                  <span className="layers__label">{layer.label}</span>
                  <span className="layers__state">{STATE_LABEL[state]}</span>
                </button>
              );
            })}
          </div>
        );
      })}

      <p className="field__hint">
        Ghosting leaves a surface in place but see-through, which is usually
        what you want behind pipework — a drain stack floating in empty space
        does not tell you which wall it is in. Services are shown or hidden;
        a half-visible pipe is just a pipe you cannot read.
      </p>
    </Panel>
  );
}

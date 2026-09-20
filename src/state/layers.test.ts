/**
 * The layer set has to stay usable no matter what is clicked.
 *
 * -----------------------------------------------------------------------------
 * THE FAILURE THIS GUARDS AGAINST.
 *
 * A layers feature has one catastrophic state: everything hidden. The screen
 * goes empty, and because the panel that would fix it is in a sidebar the user
 * may have collapsed, "the app broke" is a perfectly reasonable conclusion to
 * reach. Nothing here can prevent somebody deliberately hiding every layer —
 * that is a legitimate thing to want — but the PRESETS must never do it, the
 * cycle must always come back round, and a corrupted value read from storage
 * must never land there.
 *
 * The other half is the store, where the whole-record shape has a specific
 * trap: `patch({ layers: { walls: 'ghost' } })` type-errors, but a caller who
 * silences it wipes the other nine layers. `setLayer` exists to make that
 * impossible, and these tests hold it to that.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYERS,
  LAYERS,
  LAYER_PRESETS,
  activePreset,
  cycleLayer,
  isVisible,
  safeLayers,
  type LayerId,
} from './layers';
import { editorStore } from './selection';

describe('the layer catalogue', () => {
  it('gives every layer a default', () => {
    for (const layer of LAYERS) {
      expect(DEFAULT_LAYERS[layer.id], `${layer.id} has no default`).toBeDefined();
    }
  });

  it('has no duplicate ids', () => {
    const ids = LAYERS.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never ghosts a layer that cannot ghost', () => {
    /*
     * A translucent duct reads as a rendering error rather than as
     * information, so the services are solid or nothing — and a default or a
     * preset that ghosts one would put the app in a state its own UI cannot
     * describe, since the cycle for those layers only has two stops.
     */
    for (const layer of LAYERS) {
      if (layer.ghostable) continue;
      expect(DEFAULT_LAYERS[layer.id], `${layer.id} defaults to ghost`).not.toBe('ghost');
      for (const preset of LAYER_PRESETS) {
        expect(preset.layers[layer.id], `${preset.id} ghosts ${layer.id}`).not.toBe('ghost');
      }
    }
  });
});

describe('presets', () => {
  it('covers every layer in every preset', () => {
    // A preset missing a key would leave that layer at whatever it happened to
    // be, so the same button would produce different views depending on what
    // was on screen before it.
    for (const preset of LAYER_PRESETS) {
      for (const layer of LAYERS) {
        expect(preset.layers[layer.id], `${preset.id} omits ${layer.id}`).toBeDefined();
      }
    }
  });

  it('never leaves the screen empty', () => {
    for (const preset of LAYER_PRESETS) {
      const showing = LAYERS.filter((layer) => isVisible(preset.layers[layer.id]));
      expect(showing.length, `${preset.id} shows nothing`).toBeGreaterThan(0);
    }
  });

  it('always leaves something of the building to orient by', () => {
    /*
     * The point of ghosting rather than hiding. Every preset has to keep at
     * least one of walls or floors on screen in some form, or the services
     * float in a void and stop meaning anything.
     */
    for (const preset of LAYER_PRESETS) {
      const shell = isVisible(preset.layers.walls) || isVisible(preset.layers.floors);
      expect(shell, `${preset.id} has no shell at all`).toBe(true);
    }
  });

  it('actually shows the services in the two service views', () => {
    for (const id of ['services', 'first-fix']) {
      const preset = LAYER_PRESETS.find((entry) => entry.id === id);
      expect(preset, `${id} is missing`).toBeDefined();
      expect(preset!.layers.electrical).toBe('solid');
      expect(preset!.layers.plumbing).toBe('solid');
      expect(preset!.layers.hvac).toBe('solid');
    }
  });

  it('recognises itself', () => {
    for (const preset of LAYER_PRESETS) {
      expect(activePreset(preset.layers)).toBe(preset.id);
    }
  });

  it('stops claiming a preset once a single layer is changed', () => {
    const services = LAYER_PRESETS.find((entry) => entry.id === 'services')!;
    const edited = { ...services.layers, ceilings: 'solid' as const };
    expect(activePreset(edited)).toBeNull();
  });

  it('has a preset matching the defaults, so the opening view has a name', () => {
    expect(activePreset(DEFAULT_LAYERS)).toBe('everything');
  });
});

describe('cycling', () => {
  it('returns a ghostable layer to where it started in three clicks', () => {
    const walls = LAYERS.find((layer) => layer.id === 'walls')!;
    let state = DEFAULT_LAYERS.walls;
    const seen = [state];
    for (let i = 0; i < 3; i++) {
      state = cycleLayer(walls, state);
      seen.push(state);
    }
    expect(seen).toEqual(['solid', 'ghost', 'hidden', 'solid']);
  });

  it('returns a service to where it started in two clicks', () => {
    const hvac = LAYERS.find((layer) => layer.id === 'hvac')!;
    const once = cycleLayer(hvac, 'hidden');
    expect(once).toBe('solid');
    expect(cycleLayer(hvac, once)).toBe('hidden');
  });

  it('never produces a state outside the three', () => {
    for (const layer of LAYERS) {
      for (const from of ['solid', 'ghost', 'hidden'] as const) {
        expect(['solid', 'ghost', 'hidden']).toContain(cycleLayer(layer, from));
      }
    }
  });
});

describe('safeLayers', () => {
  it('fills in everything from nothing', () => {
    expect(safeLayers(undefined)).toEqual(DEFAULT_LAYERS);
    expect(safeLayers({})).toEqual(DEFAULT_LAYERS);
    expect(safeLayers('nonsense')).toEqual(DEFAULT_LAYERS);
  });

  it('keeps values it recognises', () => {
    const result = safeLayers({ walls: 'ghost', hvac: 'solid' });
    expect(result.walls).toBe('ghost');
    expect(result.hvac).toBe('solid');
    // And leaves the rest at their defaults rather than dropping them.
    expect(result.floors).toBe(DEFAULT_LAYERS.floors);
  });

  it('falls back to solid, not hidden, for a ghost that cannot ghost', () => {
    /*
     * The direction of the fallback is the point. Both are "wrong", and one of
     * them leaves something on screen while the other takes it away — and a
     * user who cannot see their building assumes the app is broken, where a
     * user seeing a solid duct assumes nothing at all.
     */
    expect(safeLayers({ plumbing: 'ghost' }).plumbing).toBe('solid');
  });

  it('ignores a value that is not a state at all', () => {
    expect(safeLayers({ walls: 'translucent' }).walls).toBe(DEFAULT_LAYERS.walls);
    expect(safeLayers({ walls: 7 }).walls).toBe(DEFAULT_LAYERS.walls);
    expect(safeLayers({ walls: null }).walls).toBe(DEFAULT_LAYERS.walls);
  });

  it('ignores a key that is not a layer', () => {
    const result = safeLayers({ basement: 'solid' });
    expect(result).toEqual(DEFAULT_LAYERS);
  });
});

describe('the editor store', () => {
  beforeEach(() => {
    editorStore.setLayers(DEFAULT_LAYERS);
  });

  it('changes one layer and leaves the other nine alone', () => {
    editorStore.setLayer('walls', 'ghost');
    const layers = editorStore.getState().layers;

    expect(layers.walls).toBe('ghost');
    for (const layer of LAYERS) {
      if (layer.id === 'walls') continue;
      expect(layers[layer.id], `${layer.id} was clobbered`).toBe(DEFAULT_LAYERS[layer.id]);
    }
  });

  it('does not notify when the value is unchanged', () => {
    /*
     * Hover fires on every pointer move and the panels re-render on every
     * store change, so a no-op that still notifies is sixty renders a second
     * while the mouse crosses a wall. `patch` already guards this; `setLayer`
     * must not defeat it by building a fresh record every call.
     */
    let calls = 0;
    const stop = editorStore.subscribe(() => {
      calls++;
    });
    editorStore.setLayer('walls', DEFAULT_LAYERS.walls);
    stop();
    expect(calls).toBe(0);
  });

  it('showLayer turns a hidden layer on and leaves a ghost alone', () => {
    editorStore.setLayer('plumbing', 'hidden');
    editorStore.showLayer('plumbing');
    expect(editorStore.getState().layers.plumbing).toBe('solid');

    /*
     * The case this protects: a service panel calls `showLayer` whenever it
     * lays something out, and a user in the "Services only" view has the walls
     * ghosted deliberately. Promoting a ghost to solid there would undo their
     * view every time they pressed a button in another panel.
     */
    editorStore.setLayer('walls', 'ghost');
    editorStore.showLayer('walls');
    expect(editorStore.getState().layers.walls).toBe('ghost');
  });

  it('applies a whole preset by copy, not by reference', () => {
    const preset = LAYER_PRESETS.find((entry) => entry.id === 'services')!;
    editorStore.setLayers(preset.layers);
    editorStore.setLayer('ceilings', 'solid');

    // Mutating the store must not have edited the preset constant, or the
    // button would produce a different view the second time it is pressed.
    expect(preset.layers.ceilings).toBe('hidden');
  });

  it('round-trips every layer through every state', () => {
    for (const layer of LAYERS) {
      const states = layer.ghostable
        ? (['solid', 'ghost', 'hidden'] as const)
        : (['solid', 'hidden'] as const);
      for (const state of states) {
        editorStore.setLayer(layer.id as LayerId, state);
        expect(editorStore.getState().layers[layer.id]).toBe(state);
      }
    }
  });
});

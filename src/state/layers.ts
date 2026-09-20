/**
 * Layers: what is drawn, asked in one place.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS.
 *
 * Eighteen sessions built four services into this app — electrical, drainage,
 * water supply and ductwork — each with its own visibility flag, each flag
 * buried in its own panel. Turning all three on meant hunting through
 * "Electrical", then "Water & Drainage", then "Heating & Cooling". And having
 * found them, the result was unusable anyway, because NOTHING COULD HIDE THE
 * BUILDING. You could switch the pipework on and then look at it through a
 * solid wall.
 *
 * That is the whole gap this closes. A services drawing is the normal way a
 * builder reads a house, and it was the one view the app could not produce.
 *
 * -----------------------------------------------------------------------------
 * WHY THE SHELL GHOSTS RATHER THAN DISAPPEARING.
 *
 * The obvious design is a checkbox per layer and "off" means gone. Tried that
 * way round first in the head, and it is wrong for the same reason an
 * architect's services drawing still shows the walls in a thin grey line: a
 * drain stack floating in empty space tells you nothing. You need to know
 * WHICH WALL it is in.
 *
 * So the shell has three states rather than two, and the middle one is the
 * useful one:
 *
 *   solid    the building as built
 *   ghost    translucent — you can see the services through it and still read
 *            where the rooms are
 *   hidden   gone entirely, for when even a ghost is in the way
 *
 * The services are plain on/off, because a half-visible pipe is just a pipe
 * you cannot read.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS VIEW STATE AND NOT DOCUMENT STATE.
 *
 * Which layers you are looking at is not part of the design. Two people opening
 * the same file should each get their own view of it, and a layer toggle should
 * not mark the document dirty, should not land in the undo stack, and should
 * not travel in an export.
 *
 * The app already had that rule and already broke it: `showCeilings` and
 * `showRoofs` lived in the DesignDocument, so hiding the ceiling to look at a
 * room was an undoable edit that got saved to disk. Schema v14 removes them,
 * and they arrive here instead.
 */

/** Everything that can be shown or hidden. */
export type LayerId =
  | 'walls'
  | 'floors'
  | 'ceilings'
  | 'roofs'
  | 'furniture'
  | 'fittings'
  | 'electrical'
  | 'plumbing'
  | 'hvac'
  | 'clearance';

/** How solid a layer is drawn. Only the shell uses `ghost`. */
export type LayerState = 'solid' | 'ghost' | 'hidden';

export type LayerVisibility = Record<LayerId, LayerState>;

/** Which part of the building a layer belongs to, for grouping in the UI. */
export type LayerGroup = 'shell' | 'services' | 'analysis';

export interface LayerSpec {
  id: LayerId;
  label: string;
  group: LayerGroup;
  /** One line in the panel, saying what it is for. */
  hint: string;
  /**
   * Whether this layer can be ghosted.
   *
   * Only the shell can. A translucent duct is not a useful thing to look at —
   * it reads as a rendering error rather than as information — so the services
   * offer solid or nothing.
   */
  ghostable: boolean;
}

/**
 * The layers, in the order the panel lists them.
 *
 * Shell first, because that is what somebody reaches for when a service is
 * hidden behind something. Analysis last, because it is the least often wanted.
 */
export const LAYERS: readonly LayerSpec[] = [
  {
    id: 'walls',
    label: 'Walls',
    group: 'shell',
    hint: 'Walls, doors and windows.',
    ghostable: true,
  },
  {
    id: 'floors',
    label: 'Floors',
    group: 'shell',
    hint: 'Floor slabs and skirting.',
    ghostable: true,
  },
  {
    id: 'ceilings',
    label: 'Ceilings',
    group: 'shell',
    hint: 'Hidden by default, or you would be looking at the underside of one.',
    ghostable: true,
  },
  {
    id: 'roofs',
    label: 'Roof',
    group: 'shell',
    hint: 'Comes off on its own when the camera goes inside.',
    ghostable: true,
  },
  {
    id: 'furniture',
    label: 'Furniture',
    group: 'shell',
    hint: 'Everything loose — seating, tables, rugs, lamps.',
    ghostable: true,
  },
  {
    id: 'fittings',
    label: 'Kitchen & bathroom',
    group: 'shell',
    hint: 'Fitted units, worktops and sanitaryware.',
    ghostable: true,
  },
  {
    id: 'electrical',
    label: 'Electrical',
    group: 'services',
    hint: 'Outlets, switches, lights and the circuits between them.',
    ghostable: false,
  },
  {
    id: 'plumbing',
    label: 'Water & drainage',
    group: 'services',
    hint: 'The stack, branches, vents, and the hot and cold trees.',
    ghostable: false,
  },
  {
    id: 'hvac',
    label: 'Heating & cooling',
    group: 'services',
    hint: 'Ducts, registers and the air handler, or radiators.',
    ghostable: false,
  },
  {
    id: 'clearance',
    label: 'Clearance zones',
    group: 'analysis',
    hint: 'The floor each piece needs kept free to be usable.',
    ghostable: false,
  },
];

export const LAYER_GROUP_LABELS: Record<LayerGroup, string> = {
  shell: 'The building',
  services: 'Services',
  analysis: 'Analysis',
};

/**
 * What you see before touching anything: the building, and none of the
 * machinery inside it.
 *
 * Ceilings are hidden rather than ghosted because a ghosted ceiling still
 * fogs everything under it, and the overwhelmingly common case is looking down
 * into a room from outside.
 */
export const DEFAULT_LAYERS: LayerVisibility = {
  walls: 'solid',
  floors: 'solid',
  ceilings: 'hidden',
  roofs: 'solid',
  furniture: 'solid',
  fittings: 'solid',
  electrical: 'hidden',
  plumbing: 'hidden',
  hvac: 'hidden',
  clearance: 'hidden',
};

export interface LayerPreset {
  id: string;
  label: string;
  hint: string;
  layers: LayerVisibility;
}

/**
 * The four views worth one click.
 *
 * Deliberately few. A preset list long enough to need reading is a list nobody
 * reads, and every combination is still available one checkbox at a time.
 */
export const LAYER_PRESETS: readonly LayerPreset[] = [
  {
    id: 'everything',
    label: 'Everything',
    hint: 'The building as built, services hidden.',
    layers: { ...DEFAULT_LAYERS },
  },
  {
    id: 'services',
    label: 'Services only',
    hint: 'All three services, with the building ghosted behind them.',
    layers: {
      walls: 'ghost',
      floors: 'ghost',
      ceilings: 'hidden',
      roofs: 'hidden',
      furniture: 'hidden',
      fittings: 'ghost',
      electrical: 'solid',
      plumbing: 'solid',
      hvac: 'solid',
      clearance: 'hidden',
    },
  },
  {
    id: 'shell',
    label: 'Bare shell',
    hint: 'Structure only — nothing loose, nothing fitted, no services.',
    layers: {
      walls: 'solid',
      floors: 'solid',
      ceilings: 'hidden',
      roofs: 'solid',
      furniture: 'hidden',
      fittings: 'hidden',
      electrical: 'hidden',
      plumbing: 'hidden',
      hvac: 'hidden',
      clearance: 'hidden',
    },
  },
  {
    id: 'first-fix',
    label: 'First fix',
    hint: 'Pipework and wiring in a bare shell, the way it is installed.',
    layers: {
      walls: 'ghost',
      floors: 'solid',
      ceilings: 'hidden',
      roofs: 'hidden',
      furniture: 'hidden',
      fittings: 'hidden',
      electrical: 'solid',
      plumbing: 'solid',
      hvac: 'solid',
      clearance: 'hidden',
    },
  },
];

/** Whether the current visibility is exactly one of the presets. */
export function activePreset(layers: LayerVisibility): string | null {
  for (const preset of LAYER_PRESETS) {
    const same = LAYERS.every((layer) => preset.layers[layer.id] === layers[layer.id]);
    if (same) return preset.id;
  }
  return null;
}

/** Whether a layer contributes anything to the picture at all. */
export function isVisible(state: LayerState): boolean {
  return state !== 'hidden';
}

/**
 * The next state when the layer's button is clicked.
 *
 * Ghostable layers cycle solid → ghost → hidden → solid; the rest just toggle.
 * A three-way cycle on a single control is normally a poor idea, and it earns
 * its place here because the alternative is two controls per row across ten
 * rows, and because the states have an obvious order — most visible to least.
 */
export function cycleLayer(spec: LayerSpec, current: LayerState): LayerState {
  if (!spec.ghostable) return current === 'hidden' ? 'solid' : 'hidden';
  if (current === 'solid') return 'ghost';
  if (current === 'ghost') return 'hidden';
  return 'solid';
}

/**
 * Coerces anything parsed from outside into a usable set.
 *
 * View state is not exported today, but it is remembered per browser, and a
 * value read back from storage after a layer is renamed must not be able to
 * leave the scene in a state no UI can undo.
 */
export function safeLayers(raw: unknown): LayerVisibility {
  const source = (raw ?? {}) as Partial<Record<LayerId, unknown>>;
  const out = { ...DEFAULT_LAYERS };
  for (const layer of LAYERS) {
    const value = source[layer.id];
    if (value === 'solid' || value === 'hidden') out[layer.id] = value;
    // A layer that cannot ghost falls back to solid rather than to hidden: the
    // failure should leave something on screen, not take it away.
    else if (value === 'ghost') out[layer.id] = layer.ghostable ? 'ghost' : 'solid';
  }
  return out;
}

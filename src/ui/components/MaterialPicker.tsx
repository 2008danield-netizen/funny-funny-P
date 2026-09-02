/**
 * The floor-material swatch grid.
 *
 * Previews are rendered by running each preset's real generator at a small
 * resolution, so a swatch is a true sample of the material rather than an
 * approximation that drifts out of sync when a generator is tweaked.
 *
 * Generation happens once per preset and is memoised at module scope: the
 * results are pure functions of the preset definition, so they stay valid for
 * the lifetime of the page and survive component unmounts.
 */

import { useMemo } from 'react';

import { MaterialLibrary } from '@/scene/materials/MaterialLibrary';
import { floorPresetsByCategory, type FloorPreset } from '@/scene/materials/presets';

/** presetId → PNG data URL. */
const previewCache = new Map<string, string>();

function previewFor(preset: FloorPreset): string {
  const cached = previewCache.get(preset.id);
  if (cached) return cached;

  try {
    const url = MaterialLibrary.renderPreview(preset.id, 96);
    previewCache.set(preset.id, url);
    return url;
  } catch {
    // Canvas can be unavailable in exotic environments; the tile falls back to
    // its flat swatch colour rather than breaking the panel.
    return '';
  }
}

interface MaterialPickerProps {
  value: string;
  onSelect: (presetId: string) => void;
}

export function MaterialPicker({ value, onSelect }: MaterialPickerProps) {
  const groups = useMemo(() => floorPresetsByCategory(), []);

  return (
    <>
      {groups.map((group) => (
        <div key={group.category}>
          <div className="material-group__title">{group.category}</div>
          <div className="materials">
            {group.presets.map((preset) => {
              const preview = previewFor(preset);
              return (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.description}
                  aria-pressed={preset.id === value}
                  className={`material-tile ${
                    preset.id === value ? 'material-tile--active' : ''
                  }`}
                  onClick={() => onSelect(preset.id)}
                >
                  <span
                    className="material-tile__preview"
                    style={{
                      backgroundImage: preview ? `url(${preview})` : undefined,
                      backgroundColor: preset.swatchColor,
                    }}
                  />
                  <span className="material-tile__label">{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

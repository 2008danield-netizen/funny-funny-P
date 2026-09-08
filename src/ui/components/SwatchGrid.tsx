/** A grid of named colour swatches. */

import type { PaintSwatch } from '@/scene/materials/presets';

interface SwatchGridProps {
  swatches: readonly PaintSwatch[];
  /** The currently applied colour, used to highlight a matching swatch. */
  value: string;
  onSelect: (hex: string) => void;
}

export function SwatchGrid({ swatches, value, onSelect }: SwatchGridProps) {
  const normalized = value.toLowerCase();

  return (
    <div className="swatches">
      {swatches.map((swatch) => (
        <button
          key={swatch.hex}
          type="button"
          title={`${swatch.name} · ${swatch.hex}`}
          aria-label={swatch.name}
          aria-pressed={swatch.hex.toLowerCase() === normalized}
          className={`swatches__item ${
            swatch.hex.toLowerCase() === normalized ? 'swatches__item--active' : ''
          }`}
          style={{ background: swatch.hex }}
          onClick={() => onSelect(swatch.hex)}
        />
      ))}
    </div>
  );
}

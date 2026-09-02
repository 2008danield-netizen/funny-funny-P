/**
 * A colour field combining a native picker with an editable hex field.
 *
 * The hex field keeps its own draft state while being typed: writing straight
 * through to the store on every keystroke would push invalid partial values
 * ("#a", "#ab3") into the design document, and the sanitiser would reject them
 * mid-word. The draft is committed only once it parses.
 */

import { useEffect, useState } from 'react';

interface ColorInputProps {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}

/** Accepts "#rgb" or "#rrggbb", with or without the leading hash. */
function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '');

  if (/^[0-9a-f]{3}$/i.test(raw)) {
    // Expand shorthand: "abc" → "aabbcc".
    return `#${raw
      .split('')
      .map((char) => char + char)
      .join('')}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

export function ColorInput({ label, value, onChange }: ColorInputProps) {
  const [draft, setDraft] = useState(value);

  // Re-sync when the value changes elsewhere (a swatch click, an undo, a load).
  useEffect(() => setDraft(value), [value]);

  const commitDraft = () => {
    const normalized = normalizeHex(draft);
    if (normalized) onChange(normalized);
    else setDraft(value); // Reject invalid input by snapping back.
  };

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="color-input">
        <input
          className="color-input__swatch"
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${label} colour picker`}
        />
        <input
          className="color-input__hex"
          type="text"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setDraft(value);
          }}
          aria-label={`${label} hex value`}
        />
      </div>
    </div>
  );
}

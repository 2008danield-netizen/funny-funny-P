/**
 * A numeric input that displays in the user's chosen units but stores metres.
 *
 * This is the precision half of direct 3D editing: dragging gets you close, and
 * typing an exact number finishes the job. Every dimension in the inspector is
 * one of these, so a designer who needs a wall at exactly 3.6 m never has to
 * fight the cursor for it.
 *
 * Like `ColorInput`, it keeps a draft while being typed — writing through on
 * every keystroke would push "3." and "3.6e" into the document as NaN.
 */

import { useEffect, useState } from 'react';

import type { UnitSystem } from '@/state/types';
import { fromDisplayNumber, toDisplayNumber, unitSuffix } from '@/state/units';

interface NumberFieldProps {
  label: string;
  /** Value in metres. */
  value: number;
  units: UnitSystem;
  /** Bounds in metres. */
  min: number;
  max: number;
  /** Step in display units. */
  step?: number;
  disabled?: boolean;
  /** Called with a value in metres. */
  onChange: (metres: number) => void;
}

export function NumberField({
  label,
  value,
  units,
  min,
  max,
  step = 0.01,
  disabled,
  onChange,
}: NumberFieldProps) {
  const toDisplay = (metres: number) => toDisplayNumber(metres, units).toFixed(2);
  const [draft, setDraft] = useState(() => toDisplay(value));

  // Re-sync when the value changes elsewhere: a drag, an undo, a unit switch.
  useEffect(() => setDraft(toDisplay(value)), [value, units]);

  const commit = () => {
    const parsed = Number.parseFloat(draft.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setDraft(toDisplay(value));
      return;
    }
    const metres = Math.min(max, Math.max(min, fromDisplayNumber(parsed, units)));
    onChange(metres);
    setDraft(toDisplay(metres));
  };

  return (
    <div className="field">
      <label className="field__label">
        <span>{label}</span>
        <span className="field__value">{unitSuffix(units)}</span>
      </label>
      <input
        className="number-input"
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        step={step}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') setDraft(toDisplay(value));
        }}
        aria-label={`${label} in ${unitSuffix(units)}`}
      />
    </div>
  );
}

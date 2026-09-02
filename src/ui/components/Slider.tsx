/**
 * A labelled range slider.
 *
 * The `onCommit` / `onChange` split matters for undo history: `onChange` fires
 * continuously during a drag and is recorded as a coalesced edit, so the whole
 * drag collapses to a single undo step (see `state/store.ts`).
 */

interface SliderProps {
  label: string;
  /** Formatted current value shown beside the label. */
  displayValue: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function Slider({
  label,
  displayValue,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: SliderProps) {
  return (
    <div className="field">
      <label className="field__label">
        <span>{label}</span>
        <span className="field__value">{displayValue}</span>
      </label>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
      />
    </div>
  );
}

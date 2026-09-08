/**
 * A segmented control — a radio group styled as adjacent buttons.
 *
 * Generic over the option ID so callers get exhaustive type checking on the
 * value they receive back rather than a bare string.
 */

interface SegmentedProps<T extends string> {
  label?: string;
  options: ReadonlyArray<{ id: T; label: string; title?: string }>;
  value: T;
  onChange: (id: T) => void;
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="field">
      {label && <span className="field__label">{label}</span>}
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={option.id === value}
            title={option.title}
            className={`segmented__option ${
              option.id === value ? 'segmented__option--active' : ''
            }`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** An accessible on/off switch. */

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="toggle">
      <span className="toggle__label">{label}</span>
      {/* The real checkbox is kept in the DOM (visually hidden) so the control
          is reachable by keyboard and announced correctly by screen readers. */}
      <input
        className="visually-hidden"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`toggle__track ${checked ? 'toggle__track--on' : ''}`} aria-hidden="true">
        <span className="toggle__knob" />
      </span>
    </label>
  );
}

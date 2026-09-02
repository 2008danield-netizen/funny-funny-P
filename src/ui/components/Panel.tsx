/**
 * A collapsible section in the sidebar.
 *
 * Open/closed state lives here rather than in the design document — it is a
 * view preference, not part of the design, and must not end up in an exported
 * file or trigger a scene update.
 */

import { useState, type ReactNode } from 'react';

interface PanelProps {
  title: string;
  /** Short status text shown on the right of the header, e.g. "4.2 × 3.4 m". */
  badge?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Panel({ title, badge, defaultOpen = true, children }: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="panel">
      <button
        type="button"
        className="panel__header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={`panel__chevron ${open ? 'panel__chevron--open' : ''}`}>▶</span>
        <span className="panel__title">{title}</span>
        {badge && <span className="panel__badge">{badge}</span>}
      </button>
      {open && <div className="panel__body">{children}</div>}
    </section>
  );
}

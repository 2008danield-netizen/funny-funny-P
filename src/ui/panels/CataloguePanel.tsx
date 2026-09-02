/**
 * The furniture catalogue.
 *
 * Clicking a tile arms it; the next click inside a room drops it. The tile stays
 * armed afterwards so a row of six dining chairs is six clicks rather than
 * twelve, which is how people actually furnish a room.
 *
 * Every tile shows the real dimensions, because that is the entire point of a
 * catalogue with real products in it — the decision a user is making is "does a
 * 228 cm sofa fit along that wall", and the answer has to be visible before they
 * place it, not after.
 */

import { useMemo, useState } from 'react';

import { Panel } from '../components/Panel';
import { useDesignSlice } from '@/bridge/useDesign';
import { useEditor } from '@/bridge/useEditor';
import { editorStore } from '@/state/selection';
import {
  CATALOG_ATTRIBUTION,
  CATALOG_CATEGORIES,
  catalogByCategory,
  type CatalogCategory,
  type CatalogEntry,
} from '@/furniture/catalog';
import { formatLength } from '@/state/units';
import type { UnitSystem } from '@/state/types';

export function CataloguePanel() {
  const [category, setCategory] = useState<CatalogCategory>('Seating');
  const [query, setQuery] = useState('');
  const units = useDesignSlice((doc) => doc.units);
  const { pendingCatalogId } = useEditor();

  const entries = useMemo(() => {
    const search = query.trim().toLowerCase();
    // A search cuts across categories: someone typing "billy" wants the
    // bookcase, not to be told it is filed under Storage.
    if (search) {
      return CATALOG_CATEGORIES.flatMap((name) => catalogByCategory(name)).filter(
        (entry) =>
          entry.name.toLowerCase().includes(search) ||
          entry.series.toLowerCase().includes(search) ||
          entry.category.toLowerCase().includes(search) ||
          entry.description.toLowerCase().includes(search),
      );
    }
    return catalogByCategory(category);
  }, [category, query]);

  return (
    <Panel title="Furniture" badge={pendingCatalogId ? 'placing' : undefined}>
      <input
        className="text-input"
        type="search"
        value={query}
        placeholder="Search the catalogue"
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search furniture"
      />

      {!query && (
        <div className="catalog__tabs" role="tablist" aria-label="Furniture categories">
          {CATALOG_CATEGORIES.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === category}
              className={`catalog__tab ${name === category ? 'catalog__tab--active' : ''}`}
              onClick={() => setCategory(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="catalog__list">
        {entries.map((entry) => (
          <CatalogTile
            key={entry.id}
            entry={entry}
            units={units}
            armed={entry.id === pendingCatalogId}
          />
        ))}
        {entries.length === 0 && (
          <p className="field__hint">Nothing matches &ldquo;{query}&rdquo;.</p>
        )}
      </div>

      {pendingCatalogId && (
        <button type="button" className="btn" onClick={() => editorStore.armCatalogItem(null)}>
          Stop placing
        </button>
      )}

      <p className="field__hint catalog__attribution">{CATALOG_ATTRIBUTION}</p>
    </Panel>
  );
}

interface CatalogTileProps {
  entry: CatalogEntry;
  units: UnitSystem;
  armed: boolean;
}

function CatalogTile({ entry, units, armed }: CatalogTileProps) {
  return (
    <button
      type="button"
      className={`catalog__item ${armed ? 'catalog__item--armed' : ''}`}
      aria-pressed={armed}
      title={entry.description}
      onClick={() => editorStore.armCatalogItem(armed ? null : entry.id)}
    >
      {/* A plan-view thumbnail: the footprint, drawn to the entry's real
          proportions. More useful than a picture for the decision being made,
          since what the user is judging is how much floor it eats. */}
      <span className="catalog__thumb" aria-hidden="true">
        <FootprintGlyph entry={entry} />
      </span>

      <span className="catalog__text">
        <span className="catalog__name">{entry.name}</span>
        <span className="catalog__dims">
          {formatLength(entry.width, units)} &times; {formatLength(entry.depth, units)}
          {entry.placement === 'wall' && <span className="catalog__badge">wall</span>}
        </span>
      </span>
    </button>
  );
}

/** A scale drawing of the piece's footprint, normalised into a square. */
function FootprintGlyph({ entry }: { entry: CatalogEntry }) {
  const longest = Math.max(entry.width, entry.depth);
  const w = (entry.width / longest) * 28;
  const d = (entry.depth / longest) * 28;

  return (
    <svg viewBox="0 0 34 34" width="100%" height="100%" role="presentation">
      <rect
        x={(34 - w) / 2}
        y={(34 - d) / 2}
        width={w}
        height={d}
        rx={entry.build.kind === 'rug' ? 1 : 2}
        fill="currentColor"
        opacity="0.28"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {/* A tick on the front edge, so orientation is legible at a glance. */}
      <line
        x1={17 - w / 4}
        y1={(34 + d) / 2}
        x2={17 + w / 4}
        y2={(34 + d) / 2}
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

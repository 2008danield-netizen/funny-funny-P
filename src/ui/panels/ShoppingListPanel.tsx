/**
 * The shopping list.
 *
 * The design constraint here is honesty about the numbers. The catalogue ships
 * rough price estimates so the totals work out of the box, and those estimates
 * are guesses — so every figure derived from one is labelled as an estimate, at
 * the line, at the total, and in the exported CSV. A price the user has typed in
 * is shown as a fact, because it is one.
 *
 * The alternative — a clean-looking total with no indication of where it came
 * from — is the version of this panel that gets somebody to the checkout with
 * the wrong budget.
 */

import { useMemo } from 'react';

import { Panel } from '../components/Panel';
import { activeLevel } from '@/state/levels';
import { useDesign } from '@/bridge/useDesign';
import { useDesignEdit } from '@/bridge/useDesign';
import { useRegions } from '@/bridge/useEditor';
import { editorStore } from '@/state/selection';
import { basisLabel, buildShoppingList, downloadCsv, type LineItem } from '@/furniture/pricing';
import { resolveRoomSpec } from '@/state/planOps';
import { pointInPolygon } from '@/scene/planGraph';
import type { FurnitureItem } from '@/state/types';

export function ShoppingListPanel() {
  const doc = useDesign();
  const regions = useRegions();
  const edit = useDesignEdit();

  /** Which room a piece stands in, by name — used to group the list. */
  const roomNameOf = useMemo(
    () => (item: FurnitureItem) => {
      const region = regions.find((candidate) =>
        pointInPolygon({ x: item.x, z: item.z }, candidate.polygon),
      );
      return region ? resolveRoomSpec(activeLevel(doc).plan, region.key).name : null;
    },
    [regions, activeLevel(doc).plan],
  );

  const list = useMemo(() => buildShoppingList(doc, roomNameOf), [doc, roomNameOf]);

  if (list.itemCount === 0) {
    return (
      <Panel title="Shopping list" defaultOpen={false}>
        <p className="field__hint">
          Nothing placed yet. Anything you add to the plan appears here with
          quantities and a running total.
        </p>
      </Panel>
    );
  }

  const money = (amount: number | null) =>
    amount === null ? '—' : `${doc.currency} ${amount.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}`;

  return (
    <Panel
      title="Shopping list"
      badge={`${list.itemCount} ${list.itemCount === 1 ? 'piece' : 'pieces'}`}
      defaultOpen={false}
    >
      <div className="shopping">
        {list.lines.map((line) => (
          <ShoppingRow
            key={line.catalogId}
            line={line}
            currency={doc.currency}
            onSelect={() => {
              const first = line.itemIds[0];
              if (first) editorStore.select('furniture', first);
            }}
            onPrice={(value) =>
              edit((draft) => {
                // Applies to every piece of this product: someone confirming a
                // price has confirmed it for all six of their dining chairs.
                for (const item of activeLevel(draft).furniture) {
                  if (item.catalogId === line.catalogId) item.price = value;
                }
              })
            }
          />
        ))}
      </div>

      <div className="shopping__total">
        <span className="shopping__total-label">Total</span>
        <span className="shopping__total-value">{money(list.total)}</span>
      </div>

      {/* The basis line is the point of the whole panel. */}
      <p className={`shopping__basis shopping__basis--${list.basis}`}>
        {list.basis === 'confirmed'
          ? 'Every price here was entered by you.'
          : list.basis === 'estimate'
            ? 'Includes rough estimates shipped with the app — not checked against any IKEA listing. Type a real price over any of them.'
            : `${list.unpricedLines} ${list.unpricedLines === 1 ? 'line has' : 'lines have'} no price, so the total is incomplete.`}
      </p>

      <button
        type="button"
        className="btn"
        onClick={() => downloadCsv(list, doc.currency, doc.name)}
      >
        Export as CSV
      </button>

      <div className="field">
        <span className="field__label">Currency</span>
        <input
          className="text-input"
          value={doc.currency}
          maxLength={6}
          aria-label="Currency label"
          onChange={(event) =>
            edit(
              (draft) => {
                draft.currency = event.target.value;
              },
              { history: 'coalesce', coalesceKey: 'doc.currency' },
            )
          }
        />
        <p className="field__hint">
          A label only — nothing is converted. The bundled estimates are nominal
          euro figures, so if you work in another currency, type your own prices
          over them.
        </p>
      </div>
    </Panel>
  );
}

interface ShoppingRowProps {
  line: LineItem;
  currency: string;
  onSelect: () => void;
  onPrice: (value: number) => void;
}

function ShoppingRow({ line, currency, onSelect, onPrice }: ShoppingRowProps) {
  return (
    <div className={`shopping__row shopping__row--${line.unitBasis}`}>
      <button type="button" className="shopping__name" onClick={onSelect}>
        <span className="shopping__quantity">{line.quantity}&times;</span>
        <span>
          {line.entry.name}
          {line.rooms.length > 0 && (
            <span className="shopping__rooms"> {line.rooms.join(', ')}</span>
          )}
        </span>
      </button>

      <label className="shopping__price" title={`${currency} each — ${basisLabel(line.unitBasis)}`}>
        <span className="visually-hidden">{line.entry.name} unit price</span>
        <input
          className="shopping__price-input"
          type="text"
          inputMode="decimal"
          defaultValue={line.unitPrice ?? ''}
          placeholder="—"
          onBlur={(event) => {
            const parsed = Number.parseFloat(event.target.value.replace(',', '.'));
            if (Number.isFinite(parsed) && parsed >= 0) onPrice(parsed);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        {line.unitBasis === 'estimate' && (
          <span className="shopping__est" title="Rough estimate, not verified">
            est
          </span>
        )}
      </label>
    </div>
  );
}

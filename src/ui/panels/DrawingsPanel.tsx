/**
 * Exporting the drawing set.
 *
 * Deliberately a small panel with one button. The set is derived entirely from
 * the document — there is no drawing state to configure, no layers to manage,
 * nothing to keep in step — so the only genuine choices are the sheet size, the
 * measurement system, and whether the furniture appears on the plans.
 *
 * The list of what will be produced is shown before the button rather than
 * after, because "eleven sheets" is the thing somebody wants to know before
 * they wait for a file, and because seeing "no elevations — draw a roof first"
 * is more useful than getting a set with a missing sheet.
 */

import { useState } from 'react';

import { Panel } from '../components/Panel';
import { Segmented } from '../components/Segmented';
import { Toggle } from '../components/Toggle';
import { useDesign } from '@/bridge/useDesign';
import { buildDrawingSet } from '@/drawing/set';
import { PAGE_SIZES, type PageSizeId } from '@/drawing/pdf';
import { asFeetInches } from '@/code/irc';
import { formatArea, formatLength } from '@/state/units';
import { findRegions } from '@/scene/planGraph';

const SIZES: ReadonlyArray<{ id: PageSizeId; label: string; title: string }> = [
  { id: 'letter', label: 'Letter', title: '8.5 × 11 in, printed landscape' },
  { id: 'tabloid', label: 'Tabloid', title: '11 × 17 in, printed landscape' },
  { id: 'a4', label: 'A4', title: '210 × 297 mm, printed landscape' },
  { id: 'a3', label: 'A3', title: '297 × 420 mm, printed landscape' },
];

export function DrawingsPanel() {
  const doc = useDesign();
  const [pageSize, setPageSize] = useState<PageSizeId>('tabloid');
  const [showFurniture, setShowFurniture] = useState(true);
  const [message, setMessage] = useState('');

  const storeys = doc.levels.filter((level) => level.plan.walls.length > 0);
  const rooms = doc.levels.reduce((total, level) => total + findRegions(level.plan).length, 0);
  const hasElectrical = doc.electrical.devices.length > 0;

  const sheets =
    1 + // the cover
    storeys.length +
    (storeys.length > 0 ? 4 : 0) +
    (hasElectrical ? storeys.length + 1 : 0);

  const exportSet = () => {
    const imperial = doc.units === 'imperial';

    const pdf = buildDrawingSet(doc, {
      pageSize: PAGE_SIZES[pageSize],
      imperial,
      showFurniture,
      // The date the set was issued, which every drawing needs and which is
      // the user's local date rather than UTC — a set issued on the evening of
      // the 3rd should not be dated the 4th.
      date: new Date().toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
      formats: {
        length: (metres) => (imperial ? asFeetInches(metres) : formatLength(metres, 'metric')),
        area: (square) => formatArea(square, doc.units),
        money: (amount) =>
          `${doc.currency} ${amount.toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}`,
      },
    });

    const url = URL.createObjectURL(pdf.toBlob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${doc.name.replace(/\s+/g, '-').toLowerCase() || 'design'}-drawings.pdf`;
    link.click();
    // Revoked on the next tick: revoking immediately can cancel the download in
    // some browsers, and never revoking leaks the whole file for the session.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

    setMessage(`${pdf.pageCount} sheets exported.`);
  };

  return (
    <Panel title="Drawings" defaultOpen={false} badge={sheets > 1 ? `${sheets}` : undefined}>
      <p className="field__hint">
        A printable set, drawn to a stated scale: plans of every storey with dimensions, an
        elevation of each side, the electrical, and schedules of the doors, windows, rooms and
        fittings.
      </p>

      <div className="elec__section">
        <div className="elec__section-title">What will be drawn</div>
        <table className="elec__table">
          <tbody>
            <tr>
              <td>Floor plans</td>
              <td className="elec__amount">{storeys.length}</td>
            </tr>
            <tr>
              <td>Elevations</td>
              <td className="elec__amount">{storeys.length > 0 ? 4 : 0}</td>
            </tr>
            <tr>
              <td>Electrical plans</td>
              <td className="elec__amount">{hasElectrical ? storeys.length : 0}</td>
            </tr>
            <tr>
              <td>Rooms scheduled</td>
              <td className="elec__amount">{rooms}</td>
            </tr>
          </tbody>
        </table>
        {!hasElectrical && (
          <p className="field__hint">
            No electrical sheets: nothing is wired yet. Lay the electrical out first if the set
            needs them.
          </p>
        )}
      </div>

      <Segmented label="Sheet size" options={SIZES} value={pageSize} onChange={setPageSize} />
      <p className="field__hint">
        Sheets are landscape. The scale is chosen to fit the sheet, from the standard architectural
        series — {doc.units === 'imperial' ? '1/4 in = 1 ft-0 in and below' : '1:50, 1:100 and below'} —
        so the drawings can be read with an ordinary rule.
      </p>

      <Toggle
        label="Show the furniture on the plans"
        checked={showFurniture}
        onChange={setShowFurniture}
      />

      <button
        type="button"
        className="btn btn--wide btn--primary"
        onClick={exportSet}
        disabled={storeys.length === 0}
      >
        Export the drawing set
      </button>

      {message && <p className="field__hint">{message}</p>}

      <p className="advisor__note">
        Print at 100 percent, not "fit to page", or the stated scale will be wrong — every sheet
        carries a printed scale bar so you can check. The set is not for construction: nothing in
        it has been checked or stamped by a licensed professional, and no structural design has
        been done at all.
      </p>
    </Panel>
  );
}

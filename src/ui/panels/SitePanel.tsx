/**
 * The site: the ground, the plot, and the outside of the building.
 *
 * Grouped together because they are the same act of design — what the house is
 * standing on and what it looks like from the street — and because all three
 * only start to matter once there is a building rather than a room.
 *
 * The setback numbers are the user's own. They come from a local zoning
 * ordinance, not from the building code, and the panel says so where the
 * numbers are entered rather than in a footnote nobody reads.
 */

import { useMemo } from 'react';

import { Panel } from '../components/Panel';
import { ColorInput } from '../components/ColorInput';
import { Segmented } from '../components/Segmented';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { setRectangularPlot } from '@/state/buildingOps';
import { buildableArea, compassPoint, earthworks, lotCoverage, plotArea } from '@/building/site';
import { useExteriorTakeoff } from '@/bridge/useAnalysis';
import { CLADDING_PRESETS } from '@/scene/materials/cladding';
import { activeLevel } from '@/state/levels';
import { asFeetInches } from '@/code/irc';
import { formatArea, formatLength } from '@/state/units';
import { SITE_LIMITS, type Cladding, type GroundCover } from '@/state/types';

const GROUNDS: ReadonlyArray<{ id: GroundCover; label: string }> = [
  { id: 'grass', label: 'Grass' },
  { id: 'gravel', label: 'Gravel' },
  { id: 'paving', label: 'Paving' },
  { id: 'earth', label: 'Earth' },
  { id: 'sand', label: 'Sand' },
  { id: 'concrete', label: 'Concrete' },
];

export function SitePanel() {
  const doc = useDesign();
  const edit = useDesignEdit();

  const level = activeLevel(doc);
  const terrain = doc.site.terrain;
  const plot = plotArea(doc.site);
  const takeoff = useExteriorTakeoff();
  /*
   * Earthworks samples the ground on a grid under the whole building, so it is
   * held rather than re-run on every render — dragging the fall slider would
   * otherwise re-sample the site on every animation frame.
   */
  const ground = useMemo(() => earthworks(doc.site, level), [doc.site, level]);

  const length = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');
  const volume = (cubic: number) =>
    doc.units === 'imperial'
      ? `${(cubic / 0.764555).toFixed(1)} cu yd`
      : `${cubic.toFixed(1)} m³`;

  return (
    <Panel title="Site & Exterior" defaultOpen={false}>
      {/* ------------------------------ North ----------------------------- */}
      <Slider
        label="North"
        displayValue={`${Math.round((doc.site.northAngle * 180) / Math.PI)}° · up the screen is ${compassPoint(
          ((doc.site.northAngle * 180) / Math.PI + 360) % 360,
        )}`}
        value={doc.site.northAngle}
        min={0}
        max={Math.PI * 2}
        step={Math.PI / 36}
        onChange={(northAngle) =>
          edit(
            (draft) => {
              draft.site.northAngle = northAngle;
            },
            { history: 'coalesce', coalesceKey: 'site.north' },
          )
        }
      />
      <p className="field__hint">
        Which way the building faces decides where the sun falls, and every plan drawing needs a
        north point on it. Until this is set, the app assumes up the screen is north — which it
        usually is not.
      </p>

      {/* ----------------------------- The ground -------------------------- */}
      <Segmented
        label="Ground"
        options={GROUNDS}
        value={doc.site.ground}
        onChange={(groundCover) =>
          edit((draft) => {
            draft.site.ground = groundCover;
          })
        }
      />

      <Segmented
        label="Shape of the ground"
        options={[
          { id: 'flat', label: 'Flat', title: 'Level ground at the datum' },
          { id: 'slope', label: 'Slope', title: 'One constant fall in one direction' },
          { id: 'spots', label: 'Surveyed', title: 'Interpolated between measured heights' },
        ]}
        value={terrain.kind}
        onChange={(kind) =>
          edit((draft) => {
            draft.site.terrain.kind = kind;
          })
        }
      />

      {terrain.kind === 'slope' && (
        <>
          <Slider
            label="Fall"
            displayValue={`1 in ${terrain.fall > 0 ? Math.round(1 / terrain.fall) : '∞'} · ${(
              terrain.fall * 100
            ).toFixed(1)}%`}
            value={terrain.fall}
            min={SITE_LIMITS.fall.min}
            max={SITE_LIMITS.fall.max}
            step={SITE_LIMITS.fall.step}
            onChange={(fall) =>
              edit(
                (draft) => {
                  draft.site.terrain.fall = fall;
                },
                { history: 'coalesce', coalesceKey: 'site.fall' },
              )
            }
          />
          <Slider
            label="Falls towards"
            displayValue={compassPoint(
              (((terrain.fallDirection * 180) / Math.PI + 90 + 360) % 360) +
                (doc.site.northAngle * 180) / Math.PI,
            )}
            value={terrain.fallDirection}
            min={0}
            max={Math.PI * 2}
            step={Math.PI / 36}
            onChange={(fallDirection) =>
              edit(
                (draft) => {
                  draft.site.terrain.fallDirection = fallDirection;
                },
                { history: 'coalesce', coalesceKey: 'site.falldir' },
              )
            }
          />
        </>
      )}

      {terrain.kind === 'spots' && (
        <p className="field__hint">
          Surveyed heights are interpolated between. None have been entered yet, so the ground is
          flat at the datum — a survey import is what this mode is waiting for.
        </p>
      )}

      <Slider
        label="Ground at the building"
        displayValue={`${length(Math.abs(terrain.datum))} ${terrain.datum <= 0 ? 'below' : 'above'} the floor`}
        value={terrain.datum}
        min={-2}
        max={0.3}
        step={0.05}
        onChange={(datum) =>
          edit(
            (draft) => {
              draft.site.terrain.datum = datum;
            },
            { history: 'coalesce', coalesceKey: 'site.datum' },
          )
        }
      />

      {(ground.cut > 0.05 || ground.fill > 0.05) && (
        <p className="field__hint">
          Levelling a pad under this building means{' '}
          {ground.cut > 0.05 && <>digging out {volume(ground.cut)}</>}
          {ground.cut > 0.05 && ground.fill > 0.05 && ' and '}
          {ground.fill > 0.05 && <>bringing in {volume(ground.fill)}</>}. The ground under it runs
          between {length(Math.abs(ground.highest))}{' '}
          {ground.highest >= 0 ? 'above' : 'below'} the floor and{' '}
          {length(Math.abs(ground.lowest))} {ground.lowest >= 0 ? 'above' : 'below'} it.
        </p>
      )}

      {/* ------------------------------ The plot --------------------------- */}
      <div className="field">
        <span className="field__label">Plot</span>
        {plot > 0 ? (
          <p className="field__hint">
            {formatArea(plot, doc.units)}, and the building covers{' '}
            {(lotCoverage(doc.site, level) * 100).toFixed(0)}% of it.
            {doc.site.setbacks && buildableArea(doc.site).length === 0 && (
              <>
                {' '}
                The setbacks entered below leave nothing that may be built on.
              </>
            )}
          </p>
        ) : (
          <p className="field__hint">
            No plot drawn. Without one there is no plot line to measure setbacks from, and no lot
            coverage to report.
          </p>
        )}
        <button
          type="button"
          className="btn btn--wide"
          onClick={() => edit((draft) => setRectangularPlot(draft, 24, 32))}
        >
          {plot > 0 ? 'Reset to a 24 × 32 m plot' : 'Draw a 24 × 32 m plot'}
        </button>
      </div>

      <Toggle
        label="Check zoning setbacks"
        checked={doc.site.setbacks !== null}
        onChange={(checked) =>
          edit((draft) => {
            draft.site.setbacks = checked
              ? { front: 6, rear: 6, side: 1.5, frontAt: draft.site.boundary[0] ?? null }
              : null;
          })
        }
      />

      {doc.site.setbacks && (
        <>
          {(['front', 'rear', 'side'] as const).map((which) => (
            <Slider
              key={which}
              label={`${which[0]!.toUpperCase()}${which.slice(1)} setback`}
              displayValue={length(doc.site.setbacks![which])}
              value={doc.site.setbacks![which]}
              min={SITE_LIMITS.setback.min}
              max={SITE_LIMITS.setback.max}
              step={SITE_LIMITS.setback.step}
              onChange={(value) =>
                edit(
                  (draft) => {
                    if (draft.site.setbacks) draft.site.setbacks[which] = value;
                  },
                  { history: 'coalesce', coalesceKey: `site.setback.${which}` },
                )
              }
            />
          ))}
          <p className="field__hint">
            These are from your local zoning ordinance, not from the building code — so there is no
            section to cite and the app cannot look them up for you. The blue line on the ground is
            what is left to build on.
          </p>
        </>
      )}

      {/* ----------------------------- The exterior ------------------------ */}
      <div className="field">
        <span className="field__label">Cladding</span>
        <select
          className="select"
          value={doc.exterior.cladding}
          onChange={(event) =>
            edit((draft) => {
              const cladding = event.target.value as Cladding;
              draft.exterior.cladding = cladding;
              const preset = CLADDING_PRESETS.find((entry) => entry.id === cladding);
              if (preset) draft.exterior.claddingColour = preset.suggestedColour;
            })
          }
        >
          {CLADDING_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        <p className="field__hint">
          {CLADDING_PRESETS.find((preset) => preset.id === doc.exterior.cladding)?.description}
        </p>
      </div>

      <ColorInput
        label="Cladding colour"
        value={doc.exterior.claddingColour}
        onChange={(claddingColour) =>
          edit((draft) => {
            draft.exterior.claddingColour = claddingColour;
          })
        }
      />

      <ColorInput
        label="Trim colour"
        value={doc.exterior.trimColour}
        onChange={(trimColour) =>
          edit((draft) => {
            draft.exterior.trimColour = trimColour;
          })
        }
      />

      {/* ------------------------------ The takeoff ------------------------ */}
      {takeoff.lines.length > 0 && (
        <div className="takeoff">
          <span className="field__label">What that adds up to</span>
          <table className="takeoff__table">
            <tbody>
              {takeoff.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.label}</td>
                  <td className="takeoff__quantity">
                    {line.quantity.toFixed(line.unit === 'm' ? 1 : 0)} {line.unit}
                  </td>
                  <td className="takeoff__total">
                    {line.total === null
                      ? '—'
                      : `${doc.currency} ${Math.round(line.total).toLocaleString()}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field__hint">
            {takeoff.total === null
              ? 'Nothing priced yet.'
              : `About ${doc.currency} ${Math.round(takeoff.total).toLocaleString()} for the parts that carry a rate.`}{' '}
            The areas are arithmetic off the same geometry the roof is drawn from and can be
            trusted. The rates are rough estimates written from general knowledge — not quotes —
            and the lines showing a dash have no rate at all, which is why the total is marked
            incomplete rather than looking finished.
          </p>
        </div>
      )}
    </Panel>
  );
}

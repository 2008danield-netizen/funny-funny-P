/**
 * Heating and cooling.
 *
 * -----------------------------------------------------------------------------
 * THE PANEL IS ORDERED THE WAY THE DECISION IS ACTUALLY MADE.
 *
 * Where, then what the building is made of, then what the load is, then what
 * to buy, then where it goes. That order is not cosmetic — each step is
 * meaningless without the one above it, and the panel refuses to show the
 * later steps until the earlier ones exist, rather than showing a plausible
 * zero.
 *
 * The design location comes first and has no default, because a load computed
 * for the wrong climate does not look wrong. It looks like an answer.
 *
 * The envelope comes second and is the honest weak point of the whole
 * calculation: six dropdowns that start as the app's guesses and that the load
 * is only ever as good as. So there is a confirm tick, changing anything
 * retracts it, and every figure downstream carries the caveat while it is
 * unticked.
 */

import { useState } from 'react';

import { Panel } from '../components/Panel';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { useHvac, useHvacCheck } from '@/bridge/useAnalysis';
import { editorStore } from '@/state/selection';
import { useEditor } from '@/bridge/useEditor';
import {
  clearHvac,
  layoutHvac,
  layoutUnderfloor,
  setDesignLocation,
  setEnvelope,
  setEquipment,
  setSystemKind,
  confirmEnvelope,
} from '@/state/hvacOps';
import {
  ACCA_DISCLAIMER,
  DESIGN_CONDITIONS,
  TON_BTU,
  conditionsKey,
  wattsToBtu,
} from '@/code/acca';
import { INFILTRATION } from '@/code/acca';
import {
  DOOR_TYPES,
  FLOOR_ASSEMBLIES,
  GLAZING,
  IECC_DISCLAIMER,
  ROOF_ASSEMBLIES,
  WALL_ASSEMBLIES,
} from '@/code/iecc';
import { alternativesFor } from '@/services/manualS';
import { sizeAllDucts, ductTotals } from '@/services/ductSize';
import { FLOW_REGIMES } from '@/services/hydronic';
import { asFeetInches } from '@/code/irc';
import { formatLength } from '@/state/units';
import type { HvacSystemKind } from '@/state/types';

const SYSTEM_LABELS: Array<{ id: HvacSystemKind; label: string; hint: string }> = [
  {
    id: 'forced-air',
    label: 'Furnace and air conditioner',
    hint: 'Two machines sharing one set of ducts. The American default.',
  },
  {
    id: 'heat-pump',
    label: 'Heat pump, ducted',
    hint: 'One machine for both. Needs backup heat below its balance point.',
  },
  {
    id: 'mini-split',
    label: 'Mini-splits, ductless',
    hint: 'A head in each room. No ductwork at all, so no duct losses.',
  },
  {
    id: 'hydronic',
    label: 'Boiler, radiators or underfloor',
    hint: 'Moves water, not air. Heating only — a wet system does not cool.',
  },
  {
    id: 'load-only',
    label: 'Work out the load and stop',
    hint: 'The calculation without the specification.',
  },
];

export function HvacPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const { load, selection } = useHvac();
  const report = useHvacCheck();
  const { showHvac, showSupplyAir, showReturnAir } = useEditor();

  const [notice, setNotice] = useState('');
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [regimeId, setRegimeId] = useState('condensing-55');

  const envelope = doc.hvac.envelope;
  const located = load.conditions !== null;
  const laidOut = doc.hvac.ducts.length > 0 || doc.hvac.emitters.length > 0;
  const violations = report.findings.filter((finding) => finding.severity === 'violation').length;

  const length = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');

  const btu = (watts: number) => Math.round(wattsToBtu(watts)).toLocaleString();
  const sqFt = load.floorArea / 0.092903;

  const ducts = laidOut && doc.hvac.ducts.length > 0
    ? ductTotals(sizeAllDucts(doc, load, selection), doc)
    : null;

  /** Lays it all out and switches the layer on, so the result is visible. */
  const run = (underfloor: boolean) => {
    const results: Array<ReturnType<typeof layoutHvac>> = [];
    edit((draft) => {
      results.push(underfloor ? layoutUnderfloor(draft, regimeId) : layoutHvac(draft));
    });

    const result = results[0];
    setAssumptions(result?.assumptions ?? []);
    setNotice(
      !result
        ? 'Nothing was laid out.'
        : result.emitters > 0
          ? `${result.emitters} ${result.emitters === 1 ? 'emitter' : 'emitters'} placed.`
          : result.ducts > 0
            ? `${result.registers} ${result.registers === 1 ? 'register' : 'registers'} on ${result.ducts} ${result.ducts === 1 ? 'run' : 'runs'} of duct.`
            : 'Nothing was laid out.',
    );

    editorStore.patch({ showHvac: true });
  };

  return (
    <Panel
      title="Heating & Cooling"
      badge={!located ? undefined : violations > 0 ? `${violations}` : 'ok'}
      defaultOpen={false}
    >
      {/* ---------------------------- Where it is ---------------------------- */}

      <div className="elec__section">
        <div className="elec__section-title">
          Design location
          <span className="elec__meta">no default on purpose</span>
        </div>
        <div className="field">
          <select
            className="select"
            value={doc.hvac.locationKey}
            onChange={(event) => edit((draft) => setDesignLocation(draft, event.target.value))}
          >
            <option value="">Choose a city…</option>
            {DESIGN_CONDITIONS.map((entry) => (
              <option key={conditionsKey(entry)} value={conditionsKey(entry)}>
                {entry.city}, {entry.state}
              </option>
            ))}
          </select>
        </div>
        {load.conditions ? (
          <p className="field__hint">
            Sized for {load.conditions.winterDryBulb}°F in winter and{' '}
            {load.conditions.summerDryBulb}°F in summer, climate zone{' '}
            {load.conditions.climateZone}. These are the figures for that city, not for your
            address — pick the nearest place with the same climate.
          </p>
        ) : (
          <p className="field__hint">
            Nothing can be calculated without this, and there is deliberately no default: a load
            worked out for the wrong climate does not look wrong, it looks like an answer.
          </p>
        )}
      </div>

      {/* ---------------------------- The envelope --------------------------- */}

      {located && (
        <div className="elec__section">
          <div className="elec__section-title">
            What the building is made of
            <span className="elec__meta">{envelope.confirmed ? 'confirmed' : 'assumed'}</span>
          </div>

          <div className="field">
            <span className="field__label">Walls</span>
            <select
              className="select"
              value={envelope.wallAssemblyId}
              onChange={(event) =>
                edit((draft) => setEnvelope(draft, { wallAssemblyId: event.target.value }))
              }
            >
              {WALL_ASSEMBLIES.map((assembly) => (
                <option key={assembly.id} value={assembly.id}>
                  {assembly.label} — R-{assembly.effectiveR.toFixed(1)} as built
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field__label">Roof or ceiling</span>
            <select
              className="select"
              value={envelope.roofAssemblyId}
              onChange={(event) =>
                edit((draft) => setEnvelope(draft, { roofAssemblyId: event.target.value }))
              }
            >
              {ROOF_ASSEMBLIES.map((assembly) => (
                <option key={assembly.id} value={assembly.id}>
                  {assembly.label} — R-{assembly.effectiveR.toFixed(1)} as built
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field__label">Floor</span>
            <select
              className="select"
              value={envelope.floorAssemblyId}
              onChange={(event) =>
                edit((draft) => setEnvelope(draft, { floorAssemblyId: event.target.value }))
              }
            >
              {FLOOR_ASSEMBLIES.map((assembly) => (
                <option key={assembly.id} value={assembly.id}>
                  {assembly.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field__label">Windows</span>
            <select
              className="select"
              value={envelope.glazingId}
              onChange={(event) =>
                edit((draft) => setEnvelope(draft, { glazingId: event.target.value }))
              }
            >
              {GLAZING.map((glazing) => (
                <option key={glazing.id} value={glazing.id}>
                  {glazing.label} — U-{glazing.uFactor.toFixed(2)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field__label">Doors</span>
            <select
              className="select"
              value={envelope.doorId}
              onChange={(event) =>
                edit((draft) => setEnvelope(draft, { doorId: event.target.value }))
              }
            >
              {DOOR_TYPES.map((door) => (
                <option key={door.id} value={door.id}>
                  {door.label} — U-{door.uFactor.toFixed(2)}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field__label">How draughty</span>
            <select
              className="select"
              value={envelope.infiltrationId}
              onChange={(event) =>
                edit((draft) => setEnvelope(draft, { infiltrationId: event.target.value }))
              }
            >
              {INFILTRATION.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={envelope.confirmed}
              onChange={(event) => edit((draft) => confirmEnvelope(draft, event.target.checked))}
            />
            <span>These are the real numbers, not guesses</span>
          </label>
          <p className="field__hint">
            The load is only ever as good as these six figures. Changing any of them un-ticks the
            box, because "confirmed" has to mean the numbers were checked rather than that somebody
            clicked once.
          </p>
        </div>
      )}

      {/* ------------------------------ The load ----------------------------- */}

      {located && load.rooms.length > 0 && (
        <div className="elec__section">
          <div className="elec__section-title">
            The load
            <span className="elec__meta">ACCA Manual J</span>
          </div>
          <table className="elec__table">
            <tbody>
              <tr>
                <td>Heating</td>
                <td className="elec__amount">{btu(load.heatingTotal)} BTU/h</td>
              </tr>
              <tr>
                <td>Cooling, sensible</td>
                <td className="elec__amount">{btu(load.coolingSensible)} BTU/h</td>
              </tr>
              <tr>
                <td>Cooling, latent</td>
                <td className="elec__amount">{btu(load.coolingLatent)} BTU/h</td>
              </tr>
              <tr>
                <td>
                  <strong>Cooling, total</strong>
                </td>
                <td className="elec__amount">
                  <strong>
                    {(wattsToBtu(load.coolingTotal) / TON_BTU).toFixed(1)} tons
                  </strong>
                </td>
              </tr>
              <tr>
                <td>Conditioned area</td>
                <td className="elec__amount">{Math.round(sqFt).toLocaleString()} ft²</td>
              </tr>
            </tbody>
          </table>
          <p className="field__hint">
            Latent heat is what it costs to take the moisture out of the air rather than to change
            its temperature. It is sized separately because a coil with the right total capacity
            and the wrong split leaves a house cold and damp.
          </p>
        </div>
      )}

      {/* ------------------------------ The system --------------------------- */}

      {located && (
        <div className="elec__section">
          <div className="elec__section-title">System</div>
          <div className="field">
            <select
              className="select"
              value={doc.hvac.system}
              onChange={(event) =>
                edit((draft) => setSystemKind(draft, event.target.value as HvacSystemKind))
              }
            >
              {SYSTEM_LABELS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          <p className="field__hint">
            {SYSTEM_LABELS.find((entry) => entry.id === doc.hvac.system)?.hint}
          </p>

          {doc.hvac.system === 'hydronic' && (
            <div className="field">
              <span className="field__label">Flow temperature</span>
              <select
                className="select"
                value={regimeId}
                onChange={(event) => setRegimeId(event.target.value)}
              >
                {FLOW_REGIMES.map((regime) => (
                  <option key={regime.id} value={regime.id}>
                    {regime.name}
                  </option>
                ))}
              </select>
              <p className="field__hint">
                {FLOW_REGIMES.find((regime) => regime.id === regimeId)?.note} A radiator at 55/45
                gives roughly half its catalogue output, which is why this is a choice rather than
                a constant.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---------------------------- The equipment -------------------------- */}

      {(selection.heating || selection.cooling) && (
        <div className="elec__section">
          <div className="elec__section-title">
            The equipment
            <span className="elec__meta">ACCA Manual S</span>
          </div>

          {selection.heating && (
            <div className="field">
              <span className="field__label">
                Heating
                <span className="field__value">
                  {Math.round(selection.heating.fraction * 100)}% of load
                </span>
              </span>
              <select
                className="select"
                value={selection.heating.model.id}
                onChange={(event) =>
                  edit((draft) =>
                    setEquipment(
                      draft,
                      event.target.value,
                      selection.cooling?.model.id ?? null,
                    ),
                  )
                }
              >
                {alternativesFor(doc.hvac.system)
                  .filter((model) => model.heatingBtu > 0)
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
              </select>
              <p className="field__hint">{selection.heating.reason}</p>
            </div>
          )}

          {selection.cooling && (
            <div className="field">
              <span className="field__label">
                Cooling
                <span className="field__value">
                  {Math.round(selection.cooling.fraction * 100)}% of load
                </span>
              </span>
              <select
                className="select"
                value={selection.cooling.model.id}
                onChange={(event) =>
                  edit((draft) =>
                    setEquipment(draft, selection.heating?.model.id ?? null, event.target.value),
                  )
                }
              >
                {alternativesFor(doc.hvac.system)
                  .filter((model) => model.coolingBtu > 0)
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
              </select>
              <p className="field__hint">{selection.cooling.reason}</p>
            </div>
          )}

          {doc.hvac.equipmentManual && (
            <button
              type="button"
              className="btn btn--wide"
              onClick={() => edit((draft) => setEquipment(draft, null, null))}
            >
              Back to the automatic choice
            </button>
          )}

          {selection.balancePoint && !selection.balancePoint.coversDesignDay && (
            <table className="elec__table">
              <tbody>
                <tr>
                  <td>Balance point</td>
                  <td className="elec__amount">
                    {Math.round(selection.balancePoint.outdoorF)}°F
                  </td>
                </tr>
                <tr>
                  <td>Backup heat needed</td>
                  <td className="elec__amount">
                    {selection.balancePoint.supplementalKw.toFixed(1)} kW
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ------------------------------ Lay it out --------------------------- */}

      {located && doc.hvac.system !== 'load-only' && (
        <>
          <button
            type="button"
            className="btn btn--wide btn--primary"
            onClick={() => run(false)}
          >
            {doc.hvac.system === 'hydronic' ? 'Place the radiators' : 'Route the ducts'}
          </button>

          {doc.hvac.system === 'hydronic' && (
            <button type="button" className="btn btn--wide" onClick={() => run(true)}>
              Underfloor where it will work
            </button>
          )}

          {laidOut && (
            <button
              type="button"
              className="btn btn--wide"
              onClick={() => {
                edit((draft) => clearHvac(draft));
                setNotice('');
                setAssumptions([]);
              }}
            >
              Clear it
            </button>
          )}
        </>
      )}

      {notice && <p className="field__hint">{notice}</p>}

      {assumptions.length > 0 && (
        <div className="elec__assumptions">
          <span className="elec__assumptions-title">What it had to assume</span>
          {assumptions.map((assumption) => (
            <p className="elec__assumption" key={assumption}>
              {assumption}
            </p>
          ))}
        </div>
      )}

      {/* ------------------------------- Show it ----------------------------- */}

      {laidOut && (
        <div className="elec__section">
          <div className="elec__section-title">Show it</div>
          <label className="check">
            <input
              type="checkbox"
              checked={showHvac}
              onChange={(event) => editorStore.patch({ showHvac: event.target.checked })}
            />
            <span>Draw it in the model</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showSupplyAir}
              disabled={!showHvac}
              onChange={(event) => editorStore.patch({ showSupplyAir: event.target.checked })}
            />
            <span>Supply</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showReturnAir}
              disabled={!showHvac}
              onChange={(event) => editorStore.patch({ showReturnAir: event.target.checked })}
            />
            <span>Return</span>
          </label>
        </div>
      )}

      {/* ------------------------------ The ducts ---------------------------- */}

      {ducts && (
        <div className="elec__section">
          <div className="elec__section-title">
            The ductwork
            <span className="elec__meta">ACCA Manual D</span>
          </div>
          <table className="elec__table">
            <tbody>
              <tr>
                <td>Air moved</td>
                <td className="elec__amount">{Math.round(selection.supplyCfm)} cfm</td>
              </tr>
              <tr>
                <td>Supply registers</td>
                <td className="elec__amount">{ducts.registers}</td>
              </tr>
              <tr>
                <td>Returns</td>
                <td className="elec__amount">{ducts.returns}</td>
              </tr>
              <tr>
                <td>Largest duct</td>
                <td className="elec__amount">{ducts.largestInches} in</td>
              </tr>
              <tr>
                <td>Total duct</td>
                <td className="elec__amount">{length(ducts.length)}</td>
              </tr>
              <tr>
                <td>Outdoor air needed</td>
                <td className="elec__amount">{Math.round(selection.ventilationCfm)} cfm</td>
              </tr>
            </tbody>
          </table>
          <p className="field__hint">
            The largest duct is the one worth looking at: {ducts.largestInches} in is{' '}
            {length(ducts.largestInches * 0.0254)} across, and it has to fit in the floor void
            along with everything else. Ducts are drawn at their real diameter for exactly that
            reason.
          </p>
        </div>
      )}

      {/* -------------------------------- Findings --------------------------- */}

      {report.findings.length > 0 && (
        <div className="stairs__code">
          {report.findings.map((finding) => (
            <div
              key={finding.id}
              className={`stairs__finding stairs__finding--${
                finding.severity === 'advice' ? 'caution' : finding.severity
              }`}
            >
              <span className="stairs__finding-title">
                {finding.title}
                {/* The finding says which book it is in; the panel does not
                    guess. An earlier version inferred it from the shape of the
                    section string and printed "IECC IRC M1505.4" — an energy
                    code prefix on a mechanical code citation. A visibly wrong
                    citation is worse than none, because it teaches the reader
                    to distrust the ones that are right.

                    "Guidance" is not a hedge either: the IECC is law where it
                    is adopted, ACCA's manuals are the methods the IRC points
                    at, and some of what this app says is neither. */}
                <span className="stairs__section">
                  {finding.authority === 'none'
                    ? 'Guidance'
                    : `${finding.authority} ${finding.section}`}
                </span>
              </span>
              <span className="stairs__finding-detail">{finding.detail}</span>
              {finding.remedy && <span className="stairs__finding-remedy">{finding.remedy}</span>}
            </div>
          ))}
        </div>
      )}

      {located && (
        <>
          <p className="field__hint">{ACCA_DISCLAIMER}</p>
          <p className="field__hint">{IECC_DISCLAIMER}</p>
        </>
      )}
    </Panel>
  );
}

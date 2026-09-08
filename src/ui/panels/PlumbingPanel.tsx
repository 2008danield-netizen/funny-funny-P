/**
 * Water and drainage.
 *
 * The panel is built around the one thing that makes plumbing different from
 * every other discipline in this app: it depends on TWO NUMBERS THE MODEL
 * CANNOT KNOW — how deep the sewer is, and what the street pressure is. Get
 * either wrong and everything below is confidently wrong, so both are the first
 * things on screen rather than buried in an advanced section, and the checks
 * say plainly when a figure is an assumption.
 *
 * Below that: route it, look at what it worked out, and read the findings.
 */

import { useState } from 'react';

import { Panel } from '../components/Panel';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { usePlumbing } from '@/bridge/useAnalysis';
import { editorStore } from '@/state/selection';
import { useEditor } from '@/bridge/useEditor';
import {
  clearPlumbing,
  routeAll,
  setHeaterKind,
  setMainPressure,
  setRecirculation,
  setSewerConnection,
} from '@/state/plumbingOps';
import { plumbingTotals, sizeAllDrainage } from '@/services/plumbingSize';
import { IPC_DISCLAIMER, serviceSizeFor } from '@/code/ipc';
import { PLUMBING_LIMITS } from '@/state/types';
import { asFeetInches } from '@/code/irc';
import { formatLength } from '@/state/units';

/** kPa to psi, which is what the code and every gauge are written in. */
const toPsi = (kpa: number) => kpa / 6.895;
const fromPsi = (psi: number) => psi * 6.895;

export function PlumbingPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const report = usePlumbing();
  const { showPlumbing, showDrainage, showSupply } = useEditor();

  const [notice, setNotice] = useState('');
  const [assumptions, setAssumptions] = useState<string[]>([]);

  const totals = plumbingTotals(doc);
  const routed = doc.plumbing.drainage.length > 0 || doc.plumbing.supply.length > 0;
  const violations = report.findings.filter((finding) => finding.severity === 'violation').length;

  const length = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');

  const sized = routed ? sizeAllDrainage(doc) : [];
  const buildingDrain = sized.find((entry) => entry.role === 'building-drain');

  /** Routes everything and switches the layer on, so the result is visible. */
  const route = () => {
    const results: Array<ReturnType<typeof routeAll>> = [];
    edit((draft) => {
      results.push(routeAll(draft));
    });

    const result = results[0];
    setAssumptions(result?.assumptions ?? []);
    setNotice(
      result && result.connected > 0
        ? `${result.connected} ${result.connected === 1 ? 'fixture' : 'fixtures'} connected: ${result.branches} waste ${result.branches === 1 ? 'branch' : 'branches'}, ${result.vents} ${result.vents === 1 ? 'vent' : 'vents'}, ${result.supplyRuns} supply runs.`
        : 'Nothing was routed.',
    );

    // Showing what was just built is the whole point of pressing the button.
    editorStore.patch({ showPlumbing: true });
  };

  return (
    <Panel
      title="Water & Drainage"
      badge={!routed ? undefined : violations > 0 ? `${violations}` : 'ok'}
      defaultOpen={false}
    >
      {/* ------------------------- The two unknown numbers ------------------- */}

      <div className="elec__section">
        <div className="elec__section-title">
          Where it meets the street
          <span className="elec__meta">the model cannot know these</span>
        </div>

        <div className="field">
          <span className="field__label">
            Sewer invert, below the ground floor
            <span className="field__value">
              {doc.site.sewerConnection
                ? length(doc.site.sewerConnection.invertDepth)
                : `${length(PLUMBING_LIMITS.defaultInvertDepth)} (assumed)`}
            </span>
          </span>
          <input
            type="range"
            className="slider"
            min={PLUMBING_LIMITS.minInvertDepth}
            max={PLUMBING_LIMITS.maxInvertDepth}
            step={0.05}
            value={doc.site.sewerConnection?.invertDepth ?? PLUMBING_LIMITS.defaultInvertDepth}
            onChange={(event) =>
              edit((draft) =>
                setSewerConnection(
                  draft,
                  // Keeps wherever it already is; the router assumes the nearest
                  // boundary until somebody places one on the site plan.
                  draft.site.sewerConnection?.at ?? { x: 0, z: 8 },
                  Number(event.target.value),
                ),
              )
            }
          />
          <p className="field__hint">
            Every fall in the building is measured back from this. It is on the drainage plan for
            your street, or written on the manhole cover survey. A sewer 300 mm shallower than you
            assumed can make a whole layout unbuildable.
          </p>
        </div>

        <div className="field">
          <span className="field__label">
            Street pressure
            <span className="field__value">
              {toPsi(doc.plumbing.mainPressureKpa).toFixed(0)} psi
              {doc.plumbing.mainPressureMeasured ? '' : ' (assumed)'}
            </span>
          </span>
          <input
            type="range"
            className="slider"
            min={Math.round(toPsi(PLUMBING_LIMITS.minMainPressureKpa))}
            max={Math.round(toPsi(PLUMBING_LIMITS.maxMainPressureKpa))}
            step={1}
            value={Math.round(toPsi(doc.plumbing.mainPressureKpa))}
            onChange={(event) =>
              edit((draft) => setMainPressure(draft, fromPsi(Number(event.target.value)), true))
            }
          />
          <p className="field__hint">
            Put a gauge on an outside tap. This is the single number the supply sizing is most
            sensitive to, and moving this slider marks it as measured rather than assumed.
          </p>
        </div>
      </div>

      {/* ------------------------------- Route it ---------------------------- */}

      <button
        type="button"
        className="btn btn--wide btn--primary"
        onClick={route}
        disabled={totals.drainageFixtures + totals.supplyFixtures === 0}
      >
        {totals.drainageFixtures + totals.supplyFixtures === 0
          ? 'Nothing in this building uses water'
          : routed
            ? 'Route it again'
            : 'Route the water and drainage'}
      </button>

      {routed && (
        <button
          type="button"
          className="btn btn--wide"
          onClick={() => {
            edit((draft) => clearPlumbing(draft));
            setNotice('');
            setAssumptions([]);
          }}
        >
          Clear it all
        </button>
      )}

      <p className="field__hint">
        The router puts the stack where the WCs are, hangs every branch off it at the minimum fall
        its size allows, and carries the vent through the roof. Move a pipe and it stays moved — a
        hand-edited run is left alone next time.
      </p>

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

      {/* -------------------------------- Layers ----------------------------- */}

      {routed && (
        <div className="elec__section">
          <div className="elec__section-title">Show it</div>
          <label className="check">
            <input
              type="checkbox"
              checked={showPlumbing}
              onChange={(event) => editorStore.patch({ showPlumbing: event.target.checked })}
            />
            <span>Draw the pipework</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showDrainage}
              disabled={!showPlumbing}
              onChange={(event) => editorStore.patch({ showDrainage: event.target.checked })}
            />
            <span>Drainage, vents and the stack</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={showSupply}
              disabled={!showPlumbing}
              onChange={(event) => editorStore.patch({ showSupply: event.target.checked })}
            />
            <span>Hot and cold supply</span>
          </label>
        </div>
      )}

      {/* ------------------------------ The loads ---------------------------- */}

      {totals.drainageFixtures + totals.supplyFixtures > 0 && (
        <div className="elec__section">
          <div className="elec__section-title">
            What it adds up to
            <span className="elec__meta">2021 IPC</span>
          </div>
          <table className="elec__table">
            <tbody>
              <tr>
                <td>Fixtures draining</td>
                <td className="elec__amount">{totals.drainageFixtures}</td>
              </tr>
              <tr>
                <td>Drainage fixture units</td>
                <td className="elec__amount">{totals.totalDfu}</td>
              </tr>
              {buildingDrain && (
                <tr>
                  <td>Building drain</td>
                  <td className="elec__amount">{buildingDrain.size.asWritten}</td>
                </tr>
              )}
              <tr>
                <td>Water supply fixture units</td>
                <td className="elec__amount">{totals.totalWsfu.toFixed(1)}</td>
              </tr>
              <tr>
                <td>Water service</td>
                <td className="elec__amount">{serviceSizeFor(totals.totalWsfu).asWritten}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------ The pressure ------------------------- */}

      {report.pressure && (
        <div className="elec__section">
          <div className="elec__section-title">
            Pressure at the worst fixture
            <span className="elec__meta">{report.pressure.worstFixture}</span>
          </div>
          <table className="elec__table">
            <tbody>
              <tr>
                <td>At the main</td>
                <td className="elec__amount">{toPsi(report.pressure.mainKpa).toFixed(0)} psi</td>
              </tr>
              <tr>
                <td>Lost climbing</td>
                <td className="elec__amount">−{toPsi(report.pressure.staticKpa).toFixed(1)} psi</td>
              </tr>
              <tr>
                <td>Lost to friction</td>
                <td className="elec__amount">
                  −{toPsi(report.pressure.frictionKpa).toFixed(1)} psi
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Left at the fitting</strong>
                </td>
                <td className="elec__amount">
                  <strong>{toPsi(report.pressure.residualKpa).toFixed(0)} psi</strong>
                </td>
              </tr>
              <tr>
                <td>Fastest water</td>
                <td className="elec__amount">
                  {report.pressure.peakVelocity.toFixed(1)} m/s
                </td>
              </tr>
            </tbody>
          </table>
          <p className="field__hint">
            {report.pressure.length.toFixed(1)} m of pipe from the main, allowing 50% on top of the
            measured length for fittings, as IPC Appendix E does.
          </p>
        </div>
      )}

      {/* ------------------------------ Hot water ---------------------------- */}

      {doc.plumbing.heater && (
        <div className="elec__section">
          <div className="elec__section-title">Hot water</div>
          <div className="field">
            <span className="field__label">Heater</span>
            <select
              className="select"
              value={doc.plumbing.heater.kind}
              onChange={(event) =>
                edit((draft) =>
                  setHeaterKind(draft, event.target.value as 'storage' | 'instantaneous'),
                )
              }
            >
              <option value="storage">
                Storage cylinder — {doc.plumbing.heater.litres} litres
              </option>
              <option value="instantaneous">Instantaneous</option>
            </select>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={doc.plumbing.heater.recirculation}
              onChange={(event) => edit((draft) => setRecirculation(draft, event.target.checked))}
            />
            <span>Flow and return loop</span>
          </label>
          <p className="field__hint">
            Sizing a water heater is guidance, not code — IPC 501.1 asks for one big enough and
            leaves the arithmetic to the manufacturer. This is the usual allowance per bathroom.
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
                {/* An empty section means guidance, not code. Printing a
                    citation that does not exist is how people stop trusting
                    all of them — velocity and heater sizing are both real
                    engineering and neither is in the book. */}
                {finding.section ? (
                  <span className="stairs__section">IPC {finding.section}</span>
                ) : (
                  <span className="stairs__section">Guidance</span>
                )}
              </span>
              <span className="stairs__finding-detail">{finding.detail}</span>
              {finding.remedy && <span className="stairs__finding-remedy">{finding.remedy}</span>}
            </div>
          ))}
        </div>
      )}

      {routed && <p className="field__hint">{IPC_DISCLAIMER}</p>}
    </Panel>
  );
}

/**
 * Kitchens and bathrooms.
 *
 * Two ways in, and the toggle at the top chooses between them:
 *
 *   • LAY IT OUT and adjust, which is what most people want most of the time.
 *   • DRAW IT YOURSELF, a run at a time, which is what somebody replanning
 *     their own kitchen wants — they already know where everything goes and
 *     being given a layout to undo is worse than being given nothing.
 *
 * Neither is the "advanced" one. They are two different jobs.
 */

import { useState } from 'react';

import { Panel } from '../components/Panel';
import { Segmented } from '../components/Segmented';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { useFittings } from '@/bridge/useAnalysis';
import { editorStore } from '@/state/selection';
import { useEditor } from '@/bridge/useEditor';
import { layoutAllKitchens, kitchensIn } from '@/services/kitchen';
import { layoutAllBathrooms, bathroomsIn } from '@/services/bathroom';
import { runsOn, fixturesOn } from '@/state/fittingOps';
import { runGeometry } from '@/building/cabinetRun';
import { MODULE_ATTRIBUTION, worktopHeight } from '@/fittings/modules';
import { getFixture, fixturesOfFamily } from '@/fittings/fixtures';
import { activeLevel } from '@/state/levels';
import { asFeetInches } from '@/code/irc';
import { formatLength } from '@/state/units';

type Mode = 'layout' | 'draw';

export function FittingsPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const report = useFittings();
  const { tool } = useEditor();

  const [mode, setMode] = useState<Mode>('layout');
  const [notice, setNotice] = useState('');
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [pendingFixture, setPendingFixture] = useState('wc-close-coupled');

  const level = activeLevel(doc);
  const runs = runsOn(doc, level.id);
  const fixtures = fixturesOn(doc, level.id);
  const kitchens = kitchensIn(doc).length;
  const bathrooms = bathroomsIn(doc).length;

  const violations = report.findings.filter((finding) => finding.severity === 'violation').length;
  const length = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');

  /** Runs one of the two layouts and reports what it did. */
  const runLayout = (which: 'kitchen' | 'bathroom') => {
    const results: Array<{ runs: number; fixtures: number; assumptions: string[] }> = [];
    edit((draft) => {
      results.push(which === 'kitchen' ? layoutAllKitchens(draft) : layoutAllBathrooms(draft));
    });

    const result = results[0];
    setAssumptions(result?.assumptions ?? []);
    setNotice(
      result && result.runs + result.fixtures > 0
        ? `${result.runs} runs and ${result.fixtures} fixtures.`
        : 'Nothing was laid out.',
    );
  };

  const worktopArea = runs
    .filter((run) => run.kind === 'base')
    .reduce((total, run) => total + runGeometry(run).worktopArea, 0);

  return (
    <Panel
      title="Kitchen & Bathroom"
      badge={
        runs.length + fixtures.length === 0
          ? undefined
          : violations > 0
            ? `${violations}`
            : 'ok'
      }
      defaultOpen={false}
    >
      <Segmented<Mode>
        label="How to build it"
        options={[
          { id: 'layout', label: 'Lay it out', title: 'The app proposes; you adjust' },
          { id: 'draw', label: 'Draw it', title: 'You place every run and fixture yourself' },
        ]}
        value={mode}
        onChange={setMode}
      />

      {mode === 'layout' ? (
        <>
          <p className="field__hint">
            The app reads the room’s shape, doors and windows and proposes cabinetry — sink under
            the window, hob on a different run, nothing across a doorway. Everything it places is
            then yours to drag, swap or delete.
          </p>

          <button
            type="button"
            className="btn btn--wide"
            onClick={() => runLayout('kitchen')}
            disabled={kitchens === 0}
          >
            {kitchens === 0
              ? 'No room is named as a kitchen'
              : `Lay out ${kitchens === 1 ? 'the kitchen' : `${kitchens} kitchens`}`}
          </button>

          <button
            type="button"
            className="btn btn--wide"
            onClick={() => runLayout('bathroom')}
            disabled={bathrooms === 0}
          >
            {bathrooms === 0
              ? 'No room is named as a bathroom'
              : `Lay out ${bathrooms === 1 ? 'the bathroom' : `${bathrooms} bathrooms`}`}
          </button>

          {(kitchens === 0 || bathrooms === 0) && (
            <p className="field__hint">
              Rooms are classified by the name you typed. Rename a room to “Kitchen” or “Bathroom”
              in the inspector and it will be laid out.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="field__hint">
            Pick the Cabinet tool and drag along a wall to draw a run — it fills itself with real
            module widths as you go, and turns corners with a corner unit. Or drop a fixture and
            drag it where you want it.
          </p>

          <button
            type="button"
            className={`btn btn--wide ${tool === 'cabinet' ? 'btn--primary' : ''}`}
            onClick={() => editorStore.setTool(tool === 'cabinet' ? 'select' : 'cabinet')}
          >
            {tool === 'cabinet' ? 'Drawing runs — click to stop' : 'Draw a run of cabinets'}
          </button>

          <div className="field">
            <span className="field__label">Fixture</span>
            <select
              className="select"
              value={pendingFixture}
              onChange={(event) => setPendingFixture(event.target.value)}
            >
              <optgroup label="Bathroom">
                {fixturesOfFamily('sanitary').map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Kitchen">
                {fixturesOfFamily('kitchen').map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Appliances">
                {fixturesOfFamily('appliance').map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          <button
            type="button"
            className={`btn btn--wide ${tool === 'fixture' ? 'btn--primary' : ''}`}
            onClick={() => {
              editorStore.patch({ pendingFixtureId: pendingFixture });
              editorStore.setTool(tool === 'fixture' ? 'select' : 'fixture');
            }}
          >
            {tool === 'fixture' ? 'Placing — click to stop' : 'Place this fixture'}
          </button>
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

      {/* ------------------------------- What is in it ----------------------- */}
      {runs.length + fixtures.length > 0 && (
        <div className="elec__section">
          <div className="elec__section-title">
            On this storey
            <span className="elec__meta">worktop at {length(worktopHeight())}</span>
          </div>
          <table className="elec__table">
            <tbody>
              <tr>
                <td>Runs of cabinets</td>
                <td className="elec__amount">{runs.length}</td>
              </tr>
              <tr>
                <td>Units</td>
                <td className="elec__amount">
                  {runs.reduce((total, run) => total + run.units.length, 0)}
                </td>
              </tr>
              <tr>
                <td>Worktop</td>
                <td className="elec__amount">
                  {worktopArea > 0 ? `${worktopArea.toFixed(1)} m²` : '—'}
                </td>
              </tr>
              <tr>
                <td>Fixtures and appliances</td>
                <td className="elec__amount">{fixtures.length}</td>
              </tr>
            </tbody>
          </table>
          <p className="field__hint">
            Click any cabinet or fixture in the 3D view to select it. A fixture drags; a cabinet is
            swapped for a different module of the same width, because moving one would push every
            unit after it through the wall.
          </p>
        </div>
      )}

      {/* --------------------------------- Checks ---------------------------- */}
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
                {/* No section means it is ergonomics, not code — and printing a
                    citation that does not exist is how people stop trusting
                    all of them. */}
                {finding.section ? (
                  <span className="stairs__section">IRC {finding.section}</span>
                ) : (
                  <span className="stairs__section">Guidance</span>
                )}
              </span>
              <span className="stairs__finding-detail">
                <strong>{finding.roomName}.</strong> {finding.detail}
              </span>
              {finding.remedy && (
                <span className="stairs__finding-remedy">{finding.remedy}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {(runs.length > 0 || fixtures.length > 0) && (
        <p className="advisor__note">
          Bathroom clearances are checked against the 2021 IRC — R307 for the clear floor space and
          R303 for ventilation — and the counter receptacles against NEC 210.52(C). The working
          triangle and the worktop guidance are <em>not</em> code: no section anywhere requires
          them, and a kitchen that fails them is perfectly legal. {MODULE_ATTRIBUTION}
        </p>
      )}
    </Panel>
  );
}

/** Used by the inspector to name a fixture. */
export function fixtureName(fixtureId: string): string {
  return getFixture(fixtureId)?.name ?? fixtureId;
}

/**
 * The electrical: laying it out, the panel schedule, the load, and the checks.
 *
 * Read top to bottom it is the order the work actually happens in. Lay it out,
 * look at it in the model, adjust what the app could not know, re-wire, and
 * then read what the code has to say about the result.
 *
 * Two things this panel is careful about.
 *
 *   • THE ASSUMPTIONS ARE SHOWN, not buried. The layout has to guess where a
 *     counter and a basin are, because nothing in the document says. Those
 *     guesses are printed under the button that made them, in the same place
 *     and at the same time as the result, rather than in a help page.
 *   • THE LOAD CALCULATION SHOWS ITS WORKING. Every line names its article and
 *     says in words how the figure was arrived at, so somebody can check it
 *     against the code book instead of trusting it.
 */

import { useState } from 'react';

import { Panel } from '../components/Panel';
import { Toggle } from '../components/Toggle';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { useElectrical, type ElectricalAnalysis } from '@/bridge/useAnalysis';
import { useEditor } from '@/bridge/useEditor';
import { editorStore } from '@/state/selection';
import { addDevice, clearElectrical, layOutElectrical, wireElectrical } from '@/state/buildingOps';
import { asAmps, asVoltAmperes } from '@/code/nec';
import { purposeLabel } from '@/services/rooms';
import { activeLevel } from '@/state/levels';
import type { DeviceKind } from '@/state/types';

/** The kinds somebody adds by hand, in the order they are usually wanted. */
const ADDABLE: ReadonlyArray<{ id: DeviceKind; label: string }> = [
  { id: 'receptacle', label: 'Receptacle' },
  { id: 'receptacle-gfci', label: 'Receptacle, GFCI' },
  { id: 'receptacle-counter', label: 'Counter receptacle' },
  { id: 'receptacle-appliance', label: 'Appliance receptacle' },
  { id: 'switch', label: 'Switch' },
  { id: 'switch-3way', label: 'Switch, three-way' },
  { id: 'switch-dimmer', label: 'Dimmer' },
  { id: 'light-ceiling', label: 'Ceiling light' },
  { id: 'light-recessed', label: 'Recessed light' },
  { id: 'light-wall', label: 'Wall light' },
  { id: 'fan', label: 'Ceiling fan' },
  { id: 'smoke-alarm', label: 'Smoke alarm' },
  { id: 'thermostat', label: 'Thermostat' },
];

export function ElectricalPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const { showElectrical, showElectricalRuns } = useEditor();
  const { report, load, schedule, rooms } = useElectrical();

  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [pendingKind, setPendingKind] = useState<DeviceKind>('receptacle');

  const devices = doc.electrical.devices;
  const violations = report.findings.filter((finding) => finding.severity === 'violation').length;
  const onThisLevel = devices.filter(
    (device) => device.levelId === activeLevel(doc).id,
  ).length;

  /** Lays the whole house out, and switches the layer on so it can be seen. */
  const layOut = () => {
    // The recipe runs exactly once on a draft, so carrying its result out this
    // way is safe — and it is the only way to report what the layout assumed,
    // which is the half of the answer that matters most.
    const results: Array<{ devices: number; circuits: number; assumptions: string[] }> = [];
    edit((draft) => {
      results.push(layOutElectrical(draft));
    });

    editorStore.patch({ showElectrical: true });
    const result = results[0];
    setAssumptions(result?.assumptions ?? []);
    setNotice(
      result && result.devices > 0
        ? `${result.devices} devices on ${result.circuits} circuits.`
        : 'Nothing was placed — there are no enclosed, named rooms yet.',
    );
  };

  /** Drops one device on this storey and selects it, ready to be dragged. */
  const addOne = () => {
    const levelId = activeLevel(doc).id;
    const ids: Array<string | null> = [];
    edit((draft) => {
      ids.push(addDevice(draft, levelId, pendingKind));
    });

    const id = ids[0];
    if (id) {
      editorStore.patch({ showElectrical: true });
      editorStore.select('device', id);
      setNotice('Added. Drag it in the 3D view to place it.');
    } else {
      setNotice('There is no enclosed room on this storey to put it in.');
    }
  };

  return (
    <Panel
      title="Electrical"
      badge={devices.length === 0 ? undefined : violations > 0 ? `${violations}` : 'ok'}
      defaultOpen={false}
    >
      {devices.length === 0 && (
        <p className="field__hint">
          Nothing is wired yet. The app will place receptacles, switches, lights and smoke alarms
          to satisfy the NEC's spacing rules — and then everything it placed is yours to move, add
          to or delete.
        </p>
      )}

      <button type="button" className="btn btn--wide" onClick={layOut}>
        {devices.length === 0 ? 'Lay out the electrical' : 'Lay it out again from scratch'}
      </button>

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

      {devices.length > 0 && (
        <>
          <Toggle
            label="Show the electrical in the model"
            checked={showElectrical}
            onChange={(checked) => editorStore.patch({ showElectrical: checked })}
          />
          <Toggle
            label="Show home runs back to the panel"
            checked={showElectricalRuns}
            onChange={(checked) => editorStore.patch({ showElectricalRuns: checked })}
          />
          <p className="field__hint">
            {onThisLevel} device{onThisLevel === 1 ? '' : 's'} on this storey. The home runs are a
            diagram of which breaker each device is on, not a cable route — where a cable actually
            goes depends on framing nobody has decided yet.
          </p>

          <button
            type="button"
            className="btn btn--wide"
            onClick={() =>
              edit((draft) => {
                wireElectrical(draft);
              })
            }
          >
            Assign the circuits again
          </button>
          <p className="field__hint">
            Re-groups whatever is there now onto breakers and re-sizes the service, without moving
            anything. This is what to press after adding a device by hand.
          </p>

          {/* --------------------------- Adding by hand -------------------- */}
          <div className="elec__section">
            <div className="elec__section-title">Add one by hand</div>
            <div className="elec__add">
              <select
                className="select"
                value={pendingKind}
                onChange={(event) => setPendingKind(event.target.value as DeviceKind)}
              >
                {ADDABLE.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn" onClick={addOne}>
                Add
              </button>
            </div>
            <p className="field__hint">
              It lands in the middle of the biggest room on this storey and is selected, ready to
              drag where you want it. Click any device in the 3D view to move, retype or delete it.
            </p>
          </div>

          {/* ------------------------------ By room ------------------------- */}
          <RoomBreakdown rooms={rooms} />

          {/* --------------------------- Panel schedule --------------------- */}
          {doc.electrical.panel && (
            <div className="elec__section">
              <div className="elec__section-title">
                Panel schedule
                <span className="elec__meta">
                  {asAmps(doc.electrical.panel.mainAmps)} · {doc.electrical.panel.volts} V ·{' '}
                  {doc.electrical.panel.spaces} spaces
                </span>
              </div>
              <table className="elec__table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Circuit</th>
                    <th>Breaker</th>
                    <th>Wire</th>
                    <th>Load</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((row) => (
                    <tr key={row.circuit.id}>
                      <td className="elec__ref">{row.circuit.reference}</td>
                      <td>
                        {row.circuit.name}
                        {(row.circuit.gfci || row.circuit.afci) && (
                          <span className="elec__tags">
                            {row.circuit.gfci && <span className="elec__tag">GFCI</span>}
                            {row.circuit.afci && <span className="elec__tag">AFCI</span>}
                          </span>
                        )}
                      </td>
                      <td>{asAmps(row.circuit.amps)}</td>
                      <td>{row.circuit.conductor}</td>
                      <td>
                        <span className="elec__bar">
                          <span
                            className={`elec__bar-fill ${
                              row.utilisation > 1 ? 'elec__bar-fill--over' : ''
                            }`}
                            style={{ width: `${Math.min(100, row.utilisation * 100)}%` }}
                          />
                        </span>
                        {asVoltAmperes(row.va)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="field__hint">
                The load shown per circuit counts each receptacle at 180 VA. That is a working
                figure for judging one breaker, not the code's method for sizing the service —
                220.14(J) folds dwelling receptacles into the calculation below instead.
              </p>
            </div>
          )}

          {/* ------------------------- The load calculation ------------------ */}
          <div className="elec__section">
            <div className="elec__section-title">
              Service load
              <span className="elec__meta">NEC 220.82</span>
            </div>
            <table className="elec__table">
              <tbody>
                {load.lines.map((line) => (
                  <tr key={line.label}>
                    <td>
                      {line.label}
                      <span className="elec__working">{line.working}</span>
                    </td>
                    <td className="elec__section-ref">{line.section}</td>
                    <td className="elec__amount">{asVoltAmperes(line.va)}</td>
                  </tr>
                ))}
                <tr className="elec__total">
                  <td>Connected</td>
                  <td />
                  <td className="elec__amount">{asVoltAmperes(load.connectedVa)}</td>
                </tr>
                <tr className="elec__total">
                  <td>
                    After the demand factor
                    <span className="elec__working">
                      first 10,000 VA in full, the rest at 40 percent, plus the larger of heating
                      and cooling
                    </span>
                  </td>
                  <td className="elec__section-ref">220.82</td>
                  <td className="elec__amount">{asVoltAmperes(load.demandVa)}</td>
                </tr>
                <tr className="elec__total elec__total--headline">
                  <td>Service</td>
                  <td />
                  <td className="elec__amount">
                    {load.amps.toFixed(0)} A → {asAmps(load.serviceAmps)}
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Heating and cooling are the user's to enter: nothing in the
                document says what kind of heat the house has, and guessing
                would produce a confident, wrong service size. */}
            <div className="elec__climate">
              <label className="elec__climate-field">
                <span className="field__label">Heating, VA</span>
                <input
                  className="number-input"
                  type="number"
                  min={0}
                  step={500}
                  value={doc.electrical.heatingVa}
                  onChange={(event) =>
                    edit((draft) => {
                      draft.electrical.heatingVa = Math.max(0, Number(event.target.value) || 0);
                    })
                  }
                />
              </label>
              <label className="elec__climate-field">
                <span className="field__label">Cooling, VA</span>
                <input
                  className="number-input"
                  type="number"
                  min={0}
                  step={500}
                  value={doc.electrical.coolingVa}
                  onChange={(event) =>
                    edit((draft) => {
                      draft.electrical.coolingVa = Math.max(0, Number(event.target.value) || 0);
                    })
                  }
                />
              </label>
            </div>
          </div>

          {/* ------------------------------ The checks ----------------------- */}
          {report.findings.length > 0 && (
            <div className="stairs__code">
              {report.findings.map((finding) => (
                <div
                  key={finding.id}
                  className={`stairs__finding stairs__finding--${finding.severity}`}
                >
                  <span className="stairs__finding-title">
                    {finding.title}
                    {finding.section && (
                      <span className="stairs__section">NEC {finding.section}</span>
                    )}
                  </span>
                  <span className="stairs__finding-detail">{finding.detail}</span>
                  {finding.remedy && (
                    <span className="stairs__finding-remedy">{finding.remedy}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="btn btn--danger btn--wide"
            onClick={() => {
              edit((draft) => clearElectrical(draft));
              setAssumptions([]);
              setNotice('');
            }}
          >
            Remove all of it
          </button>

          <p className="advisor__note">
            Checked against the 2023 National Electrical Code — the six-foot rule, the circuits
            Article 210 requires, ground-fault and arc-fault protection, switched lighting, and the
            service against an Article 220 calculation. Checking is not approval, and this is not a
            design: the work must be done by a licensed electrician and inspected. Box fill,
            derating, voltage drop and anything on the supply side of the meter are deliberately
            out of scope.
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * What is in each room, as a reminder of why the circuits came out as they did.
 *
 * Grouped the same way the circuits are, by the room a device stands in, so
 * that "why is the landing on the bedroom circuit" has a visible answer.
 */
function RoomBreakdown({ rooms }: { rooms: ElectricalAnalysis['rooms'] }) {
  if (rooms.length === 0) return null;

  return (
    <div className="elec__section">
      <div className="elec__section-title">By room</div>
      <table className="elec__table">
        <tbody>
          {rooms.map((room, index) => (
            <tr key={`${room.name}-${index}`}>
              <td>{room.name}</td>
              <td className="elec__section-ref">{purposeLabel(room.purpose)}</td>
              <td className="elec__amount">{room.devices.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

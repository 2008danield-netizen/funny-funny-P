/**
 * The roof.
 *
 * Everything here changes ONE number and lets the geometry follow. There is no
 * control for where the ridge goes, because the ridge is not a decision — it is
 * what the footprint and the pitch produce, and a roof whose ridge could be
 * dragged independently of its walls would be a drawing rather than a roof.
 *
 * The code findings sit at the bottom, in the same form as the stair checks: a
 * measurement, a limit, and the section it comes from.
 */

import { Panel } from '../components/Panel';
import { ColorInput } from '../components/ColorInput';
import { Segmented } from '../components/Segmented';
import { Slider } from '../components/Slider';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import {
  addDormer,
  addRoof,
  addSkylight,
  removeDormer,
  removeRoof,
  removeSkylight,
  toggleGable,
  updateDormer,
  updateRoof,
  updateSkylight,
} from '@/state/buildingOps';
import { footprintsOf } from '@/building/footprint';
import { roofArea } from '@/building/roof';
import { roofOpenings } from '@/building/dormer';
import { checkRoof } from '@/building/roofCode';
import { asFeetInches, asPitch } from '@/code/irc';
import { levelById } from '@/state/levels';
import { formatArea, formatLength } from '@/state/units';
import {
  DORMER_LIMITS,
  ROOF_LIMITS,
  SKYLIGHT_LIMITS,
  type RoofCovering,
  type RoofKind,
} from '@/state/types';

const KINDS: ReadonlyArray<{ id: RoofKind; label: string; title: string }> = [
  { id: 'hip', label: 'Hip', title: 'Every side slopes up to a ridge. No gable walls.' },
  { id: 'gable', label: 'Gable', title: 'Two slopes, with a triangle of wall at each end.' },
  { id: 'shed', label: 'Shed', title: 'One plane, falling from a high side to a low one.' },
  { id: 'flat', label: 'Flat', title: 'Nearly level, but still falling — or it ponds.' },
];

const COVERINGS: ReadonlyArray<{ id: RoofCovering; label: string }> = [
  { id: 'asphalt-shingle', label: 'Asphalt shingle' },
  { id: 'wood-shake', label: 'Wood shake' },
  { id: 'clay-tile', label: 'Clay tile' },
  { id: 'concrete-tile', label: 'Concrete tile' },
  { id: 'slate', label: 'Slate' },
  { id: 'standing-seam-metal', label: 'Standing-seam metal' },
  { id: 'metal-shingle', label: 'Metal shingle' },
  { id: 'membrane', label: 'Membrane' },
];

export function RoofPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();

  const length = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');

  return (
    <Panel title="Roof" badge={doc.roofs.length > 0 ? `${doc.roofs.length}` : undefined}>
      {doc.roofs.length === 0 && (
        <p className="field__hint">
          No roof yet. A roof follows the walls of the storey it covers — its ridges, hips and
          valleys are worked out from the plan, so it stays right when the plan changes.
        </p>
      )}

      <button
        type="button"
        className="btn btn--wide"
        onClick={() => edit((draft) => void addRoof(draft))}
      >
        {doc.roofs.length === 0 ? 'Add a roof' : 'Add another roof'}
      </button>

      {doc.roofs.map((roof) => {
        const report = checkRoof(doc, roof);
        const geometry = report?.geometry;
        const level = levelById(doc, roof.overLevelId);
        const openings = geometry ? roofOpenings(geometry, roof) : null;
        const eaves = level ? footprintsOf(level)[0] : undefined;

        return (
          <div className="roof" key={roof.id}>
            <div className="roof__header">
              <span className="roof__name">Over {level?.name ?? 'a storey that is gone'}</span>
              {geometry && geometry.planes.length > 0 && (
                <span className="roof__meta">
                  {formatArea(roofArea(geometry), doc.units)} · rises {length(geometry.rise)}
                </span>
              )}
            </div>

            <Segmented
              label="Shape"
              options={KINDS}
              value={roof.kind}
              onChange={(kind) => edit((draft) => updateRoof(draft, roof.id, { kind }))}
            />

            <Slider
              label="Pitch"
              displayValue={asPitch(roof.pitch)}
              value={roof.pitch}
              min={ROOF_LIMITS.pitch.min}
              max={ROOF_LIMITS.pitch.max}
              step={ROOF_LIMITS.pitch.step}
              onChange={(pitch) =>
                edit((draft) => updateRoof(draft, roof.id, { pitch }), {
                  history: 'coalesce',
                  coalesceKey: `roof.${roof.id}.pitch`,
                })
              }
            />

            <Slider
              label="Overhang"
              displayValue={length(roof.overhang)}
              value={roof.overhang}
              min={ROOF_LIMITS.overhang.min}
              max={ROOF_LIMITS.overhang.max}
              step={ROOF_LIMITS.overhang.step}
              onChange={(overhang) =>
                edit((draft) => updateRoof(draft, roof.id, { overhang }), {
                  history: 'coalesce',
                  coalesceKey: `roof.${roof.id}.overhang`,
                })
              }
            />

            <div className="field">
              <span className="field__label">Covering</span>
              <select
                className="select"
                value={roof.covering}
                onChange={(event) =>
                  edit((draft) =>
                    updateRoof(draft, roof.id, {
                      covering: event.target.value as RoofCovering,
                    }),
                  )
                }
              >
                {COVERINGS.map((covering) => (
                  <option key={covering.id} value={covering.id}>
                    {covering.label}
                  </option>
                ))}
              </select>
            </div>

            <ColorInput
              label="Colour"
              value={roof.colour}
              onChange={(colour) => edit((draft) => updateRoof(draft, roof.id, { colour }))}
            />

            <Segmented
              label="Roof space"
              options={[
                { id: 'vented', label: 'Vented', title: 'A ventilated attic, per IRC R806' },
                { id: 'unvented', label: 'Unvented', title: 'A sealed assembly, per IRC R806.5' },
              ]}
              value={roof.ventilation}
              onChange={(ventilation) =>
                edit((draft) => updateRoof(draft, roof.id, { ventilation }))
              }
            />

            {roof.kind === 'gable' && eaves && (
              <div className="field">
                <span className="field__label">Which ends are gabled</span>
                <div className="roof__gables">
                  {eaves.wallIds.map((ids, index) => {
                    const wallId = ids[0];
                    if (!wallId) return null;
                    const on = ids.some((id) => roof.gableWallIds.includes(id));
                    return (
                      <button
                        key={wallId}
                        type="button"
                        className={`chip ${on ? 'chip--on' : ''}`}
                        onClick={() => edit((draft) => toggleGable(draft, roof.id, wallId))}
                      >
                        Side {index + 1}
                      </button>
                    );
                  })}
                </div>
                <p className="field__hint">
                  Leave them all off and the ends of the main ridge are gabled, which is what most
                  people mean. Turn one on and you get a half-hipped house.
                </p>
              </div>
            )}

            {/* ---- Dormers ---- */}
            <div className="roof__openings">
              <div className="roof__openings-header">
                <span className="field__label">Dormers</span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => edit((draft) => void addDormer(draft, roof.id))}
                >
                  Add
                </button>
              </div>

              {roof.dormers.map((dormer) => {
                const built = openings?.dormers.find((entry) => entry.dormerId === dormer.id);
                return (
                  <div className="roof__opening" key={dormer.id}>
                    <Segmented
                      options={[
                        { id: 'gable', label: 'Gable' },
                        { id: 'shed', label: 'Shed' },
                        { id: 'hipped', label: 'Hipped' },
                      ]}
                      value={dormer.kind}
                      onChange={(kind) =>
                        edit((draft) => updateDormer(draft, roof.id, dormer.id, { kind }))
                      }
                    />
                    <Slider
                      label="Width"
                      displayValue={length(dormer.width)}
                      value={dormer.width}
                      min={DORMER_LIMITS.width.min}
                      max={DORMER_LIMITS.width.max}
                      step={DORMER_LIMITS.width.step}
                      onChange={(width) =>
                        edit((draft) => updateDormer(draft, roof.id, dormer.id, { width }), {
                          history: 'coalesce',
                          coalesceKey: `dormer.${dormer.id}.width`,
                        })
                      }
                    />
                    <Slider
                      label="Face height"
                      displayValue={length(dormer.faceHeight)}
                      value={dormer.faceHeight}
                      min={DORMER_LIMITS.faceHeight.min}
                      max={DORMER_LIMITS.faceHeight.max}
                      step={DORMER_LIMITS.faceHeight.step}
                      onChange={(faceHeight) =>
                        edit((draft) => updateDormer(draft, roof.id, dormer.id, { faceHeight }), {
                          history: 'coalesce',
                          coalesceKey: `dormer.${dormer.id}.face`,
                        })
                      }
                    />
                    {built && built.problems.length === 0 && (
                      <p className="field__hint">
                        Reaches {length(built.depth)} back up the slope, which is where its roof
                        meets the main one. That depth is not a choice — it follows from the face
                        height and the two pitches.
                      </p>
                    )}
                    {built?.problems.map((problem) => (
                      <p className="roof__problem" key={problem}>
                        {problem}
                      </p>
                    ))}
                    <button
                      type="button"
                      className="btn btn--danger btn--wide"
                      onClick={() => edit((draft) => removeDormer(draft, roof.id, dormer.id))}
                    >
                      Remove this dormer
                    </button>
                  </div>
                );
              })}
            </div>

            {/* ---- Skylights ---- */}
            <div className="roof__openings">
              <div className="roof__openings-header">
                <span className="field__label">Skylights</span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => edit((draft) => void addSkylight(draft, roof.id))}
                >
                  Add
                </button>
              </div>

              {roof.skylights.map((skylight) => {
                const built = openings?.skylights.find(
                  (entry) => entry.skylightId === skylight.id,
                );
                return (
                  <div className="roof__opening" key={skylight.id}>
                    <Slider
                      label="Width"
                      displayValue={length(skylight.width)}
                      value={skylight.width}
                      min={SKYLIGHT_LIMITS.width.min}
                      max={SKYLIGHT_LIMITS.width.max}
                      step={SKYLIGHT_LIMITS.width.step}
                      onChange={(width) =>
                        edit((draft) => updateSkylight(draft, roof.id, skylight.id, { width }), {
                          history: 'coalesce',
                          coalesceKey: `skylight.${skylight.id}.width`,
                        })
                      }
                    />
                    <Slider
                      label="Length up the slope"
                      displayValue={length(skylight.length)}
                      value={skylight.length}
                      min={SKYLIGHT_LIMITS.length.min}
                      max={SKYLIGHT_LIMITS.length.max}
                      step={SKYLIGHT_LIMITS.length.step}
                      onChange={(value) =>
                        edit(
                          (draft) =>
                            updateSkylight(draft, roof.id, skylight.id, { length: value }),
                          { history: 'coalesce', coalesceKey: `skylight.${skylight.id}.length` },
                        )
                      }
                    />
                    <Segmented
                      label="Glazing"
                      options={[
                        { id: 'laminated', label: 'Laminated' },
                        { id: 'tempered', label: 'Tempered' },
                      ]}
                      value={skylight.glazing}
                      onChange={(glazing) =>
                        edit((draft) => updateSkylight(draft, roof.id, skylight.id, { glazing }))
                      }
                    />
                    {built?.problems.map((problem) => (
                      <p className="roof__problem" key={problem}>
                        {problem}
                      </p>
                    ))}
                    <button
                      type="button"
                      className="btn btn--danger btn--wide"
                      onClick={() => edit((draft) => removeSkylight(draft, roof.id, skylight.id))}
                    >
                      Remove this skylight
                    </button>
                  </div>
                );
              })}
            </div>

            {report && report.findings.length > 0 && (
              <div className="stairs__code">
                {report.findings.map((finding) => (
                  <div
                    key={finding.id}
                    className={`stairs__finding stairs__finding--${finding.severity}`}
                  >
                    <span className="stairs__finding-title">
                      {finding.title}
                      {finding.section && (
                        <span className="stairs__section">IRC {finding.section}</span>
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
              onClick={() => edit((draft) => removeRoof(draft, roof.id))}
            >
              Remove this roof
            </button>
          </div>
        );
      })}

      {doc.roofs.length > 0 && (
        <p className="advisor__note">
          Roofs are checked against the 2021 International Residential Code — minimum slope for the
          covering, attic ventilation and access, and distance to the plot line. Checking is not
          approval. Structural design, which is to say whether the rafters hold it up, is
          deliberately out of scope.
        </p>
      )}
    </Panel>
  );
}

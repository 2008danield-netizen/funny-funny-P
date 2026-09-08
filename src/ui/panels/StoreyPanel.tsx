/**
 * Storeys and staircases.
 *
 * Two things that belong together because one determines the other: change a
 * ceiling height and every staircase in the building re-proportions itself, so
 * the controls for both want to be in the same place where that is visible.
 *
 * The code findings live here rather than in the advisor's list because they
 * are a different kind of statement. Everything the advisor says is guidance a
 * designer may knowingly overrule; a riser height is not. Mixing them would
 * teach people to skim past both.
 */

import { Panel } from '../components/Panel';
import { Segmented } from '../components/Segmented';
import { Slider } from '../components/Slider';
import { LevelStrip } from '../LevelStrip';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { useEditor } from '@/bridge/useEditor';
import { editorStore } from '@/state/selection';
import { removeStair, updateStair, wellArea } from '@/state/buildingOps';
import { activeLevel, riseAbove, stairsOn } from '@/state/levels';
import { checkStair, describeStair } from '@/building/stairCode';
import { asFeetInches } from '@/code/irc';
import { formatArea, formatLength } from '@/state/units';
import { LEVEL_LIMITS, STAIR_LIMITS, type StairForm, type StairKind } from '@/state/types';

const STAIR_FORMS: ReadonlyArray<{ id: StairKind; label: string; title: string }> = [
  { id: 'straight', label: 'Straight', title: 'One flight, bottom to top' },
  { id: 'l-shaped', label: 'L', title: 'Two flights at 90°, with a landing' },
  { id: 'u-shaped', label: 'U', title: 'Two flights at 180°, with a half-landing' },
  { id: 'winder', label: 'Winder', title: 'A turn made of tapered treads, not a landing' },
  { id: 'spiral', label: 'Spiral', title: 'A helix around a central pole' },
];

export function StoreyPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const { selection, tool } = useEditor();

  const level = activeLevel(doc);
  const stairs = stairsOn(doc, level.id);
  const rise = riseAbove(doc, level.id);

  const length = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');

  const selectedStair =
    selection.kind === 'stair' ? stairs.find((stair) => stair.id === selection.id) : undefined;

  return (
    <Panel title="Storeys" badge={doc.levels.length > 1 ? `${doc.levels.length} floors` : undefined}>
      <LevelStrip />

      <Slider
        label="Ceiling height"
        displayValue={length(level.wallHeight)}
        value={level.wallHeight}
        min={LEVEL_LIMITS.wallHeight.min}
        max={LEVEL_LIMITS.wallHeight.max}
        step={LEVEL_LIMITS.wallHeight.step}
        onChange={(value) =>
          edit(
            (draft) => {
              activeLevel(draft).wallHeight = value;
            },
            { history: 'coalesce', coalesceKey: `level.${level.id}.height` },
          )
        }
      />

      <Slider
        label="Floor thickness above"
        displayValue={length(level.slabThickness)}
        value={level.slabThickness}
        min={LEVEL_LIMITS.slabThickness.min}
        max={LEVEL_LIMITS.slabThickness.max}
        step={LEVEL_LIMITS.slabThickness.step}
        onChange={(value) =>
          edit(
            (draft) => {
              activeLevel(draft).slabThickness = value;
            },
            { history: 'coalesce', coalesceKey: `level.${level.id}.slab` },
          )
        }
      />

      <p className="field__hint">
        Ceiling height and floor thickness together make the{' '}
        <strong>floor-to-floor rise</strong>
        {rise > 0 ? ` — ${length(rise)} on this storey` : ''}. That is the figure a staircase has
        to climb, and it is bigger than the ceiling height people usually quote. A stair built to
        the wrong one of the two arrives a step short.
      </p>

      {/* -------------------------------- Stairs ------------------------------- */}

      <div className="field">
        <span className="field__label">Staircases</span>
        <button
          type="button"
          className={`btn btn--wide ${tool === 'stair' ? 'btn--accent' : ''}`}
          onClick={() =>
            editorStore.patch({ tool: tool === 'stair' ? 'select' : 'stair', readout: null })
          }
          disabled={rise <= 0}
          title={
            rise <= 0
              ? 'Add a storey above before putting a stair in'
              : 'Click a spot on the floor to put the foot of a staircase there'
          }
        >
          {tool === 'stair' ? 'Click the floor to place it' : 'Add a staircase'}
        </button>
        {rise <= 0 && (
          <p className="field__hint">
            This is the top storey, so there is nothing to climb to. Add a floor above first.
          </p>
        )}
      </div>

      {stairs.length > 0 && (
        <div className="stairs">
          {stairs.map((stair) => {
            const report = checkStair(doc, stair);
            const violations = report.findings.filter((finding) => finding.severity === 'violation');
            const selected = selectedStair?.id === stair.id;

            return (
              <div
                key={stair.id}
                className={`stairs__item ${selected ? 'stairs__item--active' : ''} ${
                  violations.length > 0 ? 'stairs__item--violation' : ''
                }`}
              >
                <button
                  type="button"
                  className="stairs__head"
                  onClick={() => editorStore.select('stair', stair.id)}
                >
                  <span className="stairs__name">{stair.name}</span>
                  <span className="stairs__meta">{describeStair(report.geometry)}</span>
                  <span className="stairs__meta">
                    Takes {formatArea(wellArea(doc, stair.id), doc.units)} out of the floor above
                  </span>
                </button>

                {selected && (
                  <div className="stairs__editor">
                    <Segmented
                      label="Shape"
                      options={STAIR_FORMS}
                      value={stair.form.kind}
                      onChange={(kind) =>
                        edit((draft) => updateStair(draft, stair.id, { form: formFor(kind, stair.form) }))
                      }
                    />

                    <Slider
                      label="Steps"
                      displayValue={`${stair.riserCount} risers, ${asFeetInches(report.geometry.riserHeight)} each`}
                      value={stair.riserCount}
                      min={STAIR_LIMITS.riserCount.min}
                      max={STAIR_LIMITS.riserCount.max}
                      step={1}
                      onChange={(value) =>
                        edit(
                          (draft) => updateStair(draft, stair.id, { riserCount: value }),
                          { history: 'coalesce', coalesceKey: `stair.${stair.id}.risers` },
                        )
                      }
                    />

                    <Slider
                      label="Going"
                      displayValue={length(stair.treadDepth)}
                      value={stair.treadDepth}
                      min={STAIR_LIMITS.treadDepth.min}
                      max={STAIR_LIMITS.treadDepth.max}
                      step={STAIR_LIMITS.treadDepth.step}
                      onChange={(value) =>
                        edit(
                          (draft) => updateStair(draft, stair.id, { treadDepth: value }),
                          { history: 'coalesce', coalesceKey: `stair.${stair.id}.tread` },
                        )
                      }
                    />

                    <Slider
                      label="Width"
                      displayValue={length(stair.width)}
                      value={stair.width}
                      min={STAIR_LIMITS.width.min}
                      max={STAIR_LIMITS.width.max}
                      step={STAIR_LIMITS.width.step}
                      onChange={(value) =>
                        edit(
                          (draft) => updateStair(draft, stair.id, { width: value }),
                          { history: 'coalesce', coalesceKey: `stair.${stair.id}.width` },
                        )
                      }
                    />

                    <Segmented
                      label="Handrails"
                      options={[
                        { id: 'both', label: 'Both' },
                        { id: 'left', label: 'Left' },
                        { id: 'right', label: 'Right' },
                        { id: 'none', label: 'None' },
                      ]}
                      value={stair.handrail}
                      onChange={(handrail) =>
                        edit((draft) => updateStair(draft, stair.id, { handrail }))
                      }
                    />

                    <button
                      type="button"
                      className="btn btn--danger btn--wide"
                      onClick={() => {
                        edit((draft) => removeStair(draft, stair.id));
                        editorStore.clearSelection();
                      }}
                    >
                      Remove this staircase
                    </button>
                  </div>
                )}

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
                            <span className="stairs__section">IRC {finding.section}</span>
                          )}
                        </span>
                        <span className="stairs__finding-detail">{finding.detail}</span>
                        <span className="stairs__finding-remedy">{finding.remedy}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="advisor__note">
        Stairs are checked against the 2021 International Residential Code, and every finding
        names the section it comes from so it can be looked up and argued with. Checking is not
        approval: a real build needs a permit and an inspection, and your jurisdiction may amend
        the code or be a cycle behind it.
      </p>
    </Panel>
  );
}

/**
 * Keeps what carries over when a stair changes shape.
 *
 * Switching from an L to a U should keep which way it turns and roughly where
 * the landing falls, because those are decisions the user made about their
 * house rather than properties of the shape. Resetting them every time makes
 * trying the four options feel like starting over.
 */
function formFor(kind: StairKind, previous: StairForm): StairForm {
  const turn = 'turn' in previous ? previous.turn : 'right';
  const before =
    'risersBeforeLanding' in previous
      ? previous.risersBeforeLanding
      : 'risersBeforeWinder' in previous
        ? previous.risersBeforeWinder
        : 7;
  const innerRadius = 'innerRadius' in previous ? previous.innerRadius : 0.15;

  switch (kind) {
    case 'straight':
      return { kind: 'straight' };
    case 'l-shaped':
      return { kind: 'l-shaped', turn, risersBeforeLanding: before };
    case 'u-shaped':
      return { kind: 'u-shaped', turn, risersBeforeLanding: before };
    case 'winder':
      return {
        kind: 'winder',
        turn,
        risersBeforeWinder: before,
        winderTreads: 2,
        // 2 treads across the turn needs about 13 in of walkline radius, which
        // a 50 mm newel provides. Starting compliant beats starting pretty.
        innerRadius: Math.max(0.05, innerRadius),
      };
    case 'spiral':
      return { kind: 'spiral', clockwise: true, innerRadius };
  }
}

/**
 * Sections.
 *
 * -----------------------------------------------------------------------------
 * THE DRAWING THAT ANSWERS THE QUESTIONS THE OTHERS CANNOT.
 *
 * A plan says where things are. An elevation says what it looks like from
 * outside. Neither says how tall anything is inside, how thick the floor is,
 * whether the stair fits under the ceiling it passes through, or whether the
 * duct and the joist want the same 200 mm. This panel is where those get
 * asked.
 *
 * Two cuts are offered ready-made, because the first thing anybody wants is
 * the standard pair and making them draw it first is friction for nothing. The
 * presets follow the building as it changes; anything drawn by hand never
 * moves again.
 */

import { Panel } from '../components/Panel';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { editorStore } from '@/state/selection';
import { useEditor } from '@/bridge/useEditor';
import {
  addSection,
  buildingBounds,
  flipSection,
  refreshPresets,
  removeSection,
  renameSection,
} from '@/state/sectionOps';
import { buildSection } from '@/building/section';
import { formatLength } from '@/state/units';
import { asFeetInches } from '@/code/irc';

export function SectionPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const { activeSectionId, selection } = useEditor();

  const bounds = buildingBounds(doc);
  const length = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');

  /** Adds the standard pair, and switches the first one on so it is visible. */
  const addPresets = () => {
    edit((draft) => refreshPresets(draft));
    const first = doc.sections.find((section) => section.automatic);
    editorStore.patch({ activeSectionId: first?.id ?? null });
  };

  /** Draws a new cut across the middle, which the user then drags. */
  const addByHand = () => {
    if (!bounds) return;
    const midZ = (bounds.minZ + bounds.maxZ) / 2;
    let created: string | null = null;
    edit((draft) => {
      created = addSection(
        draft,
        { x: bounds.minX - 1.5, z: midZ + 1 },
        { x: bounds.maxX + 1.5, z: midZ + 1 },
      );
    });
    if (created) {
      editorStore.patch({ activeSectionId: created, selection: { kind: 'section', id: created } });
    }
  };

  return (
    <Panel title="Sections" badge={doc.sections.length > 0 ? `${doc.sections.length}` : undefined} defaultOpen={false}>
      {!bounds && (
        <p className="field__hint">
          Draw some walls first. A section is a cut through a building, and there is nothing here
          to cut.
        </p>
      )}

      {bounds && doc.sections.length === 0 && (
        <p className="field__hint">
          A section shows the heights a plan cannot: floor to ceiling, the thickness of the floor
          build-up, whether the stair clears the storey above, and whether a duct and a joist want
          the same space.
        </p>
      )}

      {bounds && (
        <>
          <button type="button" className="btn btn--wide btn--primary" onClick={addPresets}>
            {doc.sections.some((section) => section.automatic)
              ? 'Re-centre the standard pair'
              : 'Add the standard pair'}
          </button>
          <button type="button" className="btn btn--wide" onClick={addByHand}>
            Draw one by hand
          </button>
          <p className="field__hint">
            The standard pair cuts through the middle each way and follows the building as it
            changes. A cut you place yourself is never moved for you.
          </p>
        </>
      )}

      {/* ------------------------------ The cuts ------------------------------ */}

      {doc.sections.map((section) => {
        const model = buildSection(doc, section);
        const live = activeSectionId === section.id;
        const chosen = selection.kind === 'section' && selection.id === section.id;

        return (
          <div
            key={section.id}
            className={`elec__section${chosen ? ' elec__section--selected' : ''}`}
          >
            <div className="elec__section-title">
              {section.mark} — {section.name}
              <span className="elec__meta">{section.automatic ? 'automatic' : 'placed by hand'}</span>
            </div>

            <div className="field">
              <input
                className="text-input"
                value={section.name}
                onChange={(event) => edit((draft) => renameSection(draft, section.id, event.target.value))}
              />
            </div>

            <table className="elec__table">
              <tbody>
                <tr>
                  <td>Length of cut</td>
                  <td className="elec__amount">{length(model.frame.length)}</td>
                </tr>
                <tr>
                  <td>Walls cut</td>
                  <td className="elec__amount">{model.walls.length}</td>
                </tr>
                <tr>
                  <td>Height shown</td>
                  <td className="elec__amount">
                    {length(model.extent.maxY - model.extent.minY)}
                  </td>
                </tr>
              </tbody>
            </table>

            <label className="check">
              <input
                type="checkbox"
                checked={live}
                onChange={(event) =>
                  editorStore.patch({ activeSectionId: event.target.checked ? section.id : null })
                }
              />
              <span>Cut the model open here</span>
            </label>

            <button
              type="button"
              className="btn btn--wide"
              onClick={() => edit((draft) => flipSection(draft, section.id))}
            >
              Look the other way
            </button>

            <button
              type="button"
              className="btn btn--wide btn--danger"
              onClick={() => {
                edit((draft) => removeSection(draft, section.id));
                if (live) editorStore.patch({ activeSectionId: null });
              }}
            >
              Delete {section.mark}
            </button>

            {model.notes.length > 0 && (
              <div className="elec__assumptions">
                {model.notes.map((note) => (
                  <p className="elec__assumption" key={note}>
                    {note}
                  </p>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {doc.sections.length > 0 && (
        <p className="field__hint">
          Cutting the model open slices the geometry rather than hiding whole walls, so the cut
          edges are hollow — you are seeing the inside face of what is behind. That is for
          orientation. The printed section draws the real construction layers, hatched and to
          scale.
        </p>
      )}
    </Panel>
  );
}

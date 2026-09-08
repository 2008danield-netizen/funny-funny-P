/**
 * The clearance report.
 *
 * Two halves, deliberately: the count and the toggles at the top, then the
 * issues themselves. A designer preparing a client presentation wants to know
 * "is this layout clean" at a glance and only then wants the detail.
 *
 * Every row is clickable and selects the offending piece, because an issue you
 * cannot navigate to is a complaint rather than a tool.
 */

import { Panel } from '../components/Panel';
import { Toggle } from '../components/Toggle';
import { Slider } from '../components/Slider';
import type { ClearanceIssue } from '@/clearance/analyze';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { useClearanceReport } from '@/bridge/useAnalysis';
import { useEditor } from '@/bridge/useEditor';
import { editorStore } from '@/state/selection';
import { formatLength } from '@/state/units';

export function IssuesPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const { showClearance, selection } = useEditor();

  // Shared with the Advisor panel, which reads the same circulation figures.
  // The analysis walks a grid per room and both panels re-render on every
  // store change, drag frames included, so it is computed once per document.
  const report = useClearanceReport();

  const { required, advisory } = report.counts;
  const clean = required === 0 && advisory === 0;

  return (
    <Panel
      title="Clearance"
      badge={clean ? 'clear' : `${required + advisory}`}
      defaultOpen={false}
    >
      <Toggle
        label="Show clearance zones on the floor"
        checked={showClearance}
        onChange={(checked) => editorStore.patch({ showClearance: checked })}
      />

      <Toggle
        label="Enforce clearances while placing"
        checked={doc.clearance.strict}
        onChange={(checked) =>
          edit((draft) => {
            draft.clearance.strict = checked;
          })
        }
      />

      <Slider
        label="Walkway width"
        displayValue={formatLength(doc.clearance.walkwayWidth, doc.units)}
        value={doc.clearance.walkwayWidth}
        min={0.5}
        max={1.5}
        step={0.05}
        onChange={(value) =>
          edit(
            (draft) => {
              draft.clearance.walkwayWidth = value;
            },
            { history: 'coalesce', coalesceKey: 'clearance.walkway' },
          )
        }
      />

      {clean ? (
        <p className="field__hint">
          Nothing is in anything else&rsquo;s way. Doors can open, drawers can
          come out, and there is a{' '}
          {formatLength(doc.clearance.walkwayWidth, doc.units)} route through
          every room.
        </p>
      ) : (
        <div className="issues">
          {report.issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              active={
                issue.focus !== null &&
                selection.kind === issue.focus.kind &&
                selection.id === issue.focus.id
              }
            />
          ))}
        </div>
      )}

      <p className="field__hint">
        {doc.clearance.strict
          ? 'Enforcing means furniture is pushed out of door swings and pull-out space as you drag, the same way it is pushed out of walls. Advisory guidance — legroom, room to walk round a bed — is still only advice.'
          : 'These are guidelines, not rules. A tight walkway in a small flat may be exactly the right trade to make; the panel tells you what you are trading.'}
      </p>
    </Panel>
  );
}

function IssueRow({ issue, active }: { issue: ClearanceIssue; active: boolean }) {
  return (
    <button
      type="button"
      className={`issue issue--${issue.severity} ${active ? 'issue--active' : ''}`}
      onClick={() => {
        if (issue.focus) editorStore.select(issue.focus.kind, issue.focus.id);
      }}
    >
      <span className="issue__dot" aria-hidden="true" />
      <span className="issue__text">
        <span className="issue__title">{issue.title}</span>
        <span className="issue__detail">{issue.detail}</span>
      </span>
    </button>
  );
}

/**
 * The design advisor.
 *
 * Three things, in the order somebody actually uses them:
 *
 *   1. A SCORE, so the state of the design is legible without reading anything.
 *   2. The FINDINGS, each with the measurement behind it, the principle behind
 *      that, and — where the advisor is confident — a button that makes the
 *      change for you.
 *   3. The GENERATOR, which lays a room out from scratch.
 *
 * The tone is the design decision that matters most here. This panel is telling
 * somebody their home is wrong, which is a thing to do carefully: every finding
 * gives its reasoning so it can be disagreed with, praise is shown alongside
 * faults rather than buried, and the footnote says plainly that this is a list
 * of rules rather than an opinion about their taste. A tool that lectures gets
 * turned off, and then none of the good advice lands either.
 */

import { useCallback, useState } from 'react';

import { Panel } from '../components/Panel';
import { Segmented } from '../components/Segmented';
import { Toggle } from '../components/Toggle';
import { useAdvice } from '@/bridge/useAnalysis';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { editorStore } from '@/state/selection';
import { bandLabel, headline } from '@/advisor/advise';
import { applyFix } from '@/advisor/fixes';
import { furnishRoom, suggestProgram, type FurnishStyle } from '@/advisor/generate';
import { programLabel } from '@/advisor/rooms';
import type { Finding, RoomProgram, RoomSummary } from '@/advisor/types';
import { formatArea } from '@/state/units';

/** Programs offered by the generator, in the order the buttons appear. */
const PROGRAMS: ReadonlyArray<{ id: Exclude<RoomProgram, 'unknown'>; label: string }> = [
  { id: 'living', label: 'Living' },
  { id: 'bedroom', label: 'Bedroom' },
  { id: 'dining', label: 'Dining' },
  { id: 'office', label: 'Office' },
];

const STYLES: ReadonlyArray<{ id: FurnishStyle; label: string; title: string }> = [
  { id: 'calm', label: 'Calm', title: 'Sage, linen and pale woods' },
  { id: 'warm', label: 'Warm', title: 'Rust, oak and pine' },
  { id: 'monochrome', label: 'Mono', title: 'Charcoal, white and black-brown' },
  { id: 'bold', label: 'Bold', title: 'Navy, rust and dark timber' },
];

export function AdvisorPanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const report = useAdvice();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [furnishOpen, setFurnishOpen] = useState(false);
  const [targetRoom, setTargetRoom] = useState<string | null>(null);
  const [program, setProgram] = useState<Exclude<RoomProgram, 'unknown'> | null>(null);
  const [style, setStyle] = useState<FurnishStyle>('calm');
  const [budget, setBudget] = useState('');
  const [replace, setReplace] = useState(false);

  const rooms = report.rooms;
  const room =
    rooms.find((candidate) => candidate.roomKey === targetRoom) ?? rooms[0] ?? null;

  /** Opens the furnish controls, pre-set for one room. */
  const openFurnish = useCallback(
    (summary: RoomSummary | null) => {
      if (summary) {
        setTargetRoom(summary.roomKey);
        setProgram(
          summary.program === 'unknown' ? suggestProgram(summary.area) : summary.program,
        );
      }
      setFurnishOpen(true);
      setStatus('');
    },
    [],
  );

  const handleApply = useCallback(
    (found: Finding) => {
      if (!found.fix) return;

      if (found.fix.kind === 'furnish') {
        openFurnish(rooms.find((candidate) => candidate.roomKey === found.roomKey) ?? null);
        return;
      }

      let outcome = { applied: false, message: '', touched: [] as string[] };
      edit((draft) => {
        outcome = applyFix(draft, found.fix!);
      });

      // Select what moved, so the change is visible rather than merely reported.
      const first = outcome.touched[0];
      if (outcome.applied && first) editorStore.select('furniture', first);
      setStatus(outcome.applied ? outcome.message || 'Done.' : outcome.message);
    },
    [edit, openFurnish, rooms],
  );

  const handleFurnish = useCallback(() => {
    if (!room) return;
    const parsed = Number.parseFloat(budget.replace(',', '.'));
    const ceiling = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

    let outcome: ReturnType<typeof furnishRoom> | null = null;
    edit((draft) => {
      outcome = furnishRoom(draft, room.roomKey, {
        program: program ?? undefined,
        budget: ceiling,
        style,
        clearExisting: replace,
      });
    });

    if (!outcome) return;
    const result = outcome as ReturnType<typeof furnishRoom>;

    if (result.placed.length === 0) {
      setStatus(
        result.skipped[0]
          ? `Nothing placed — ${result.skipped[0].reason}.`
          : 'Nothing would fit in that room.',
      );
      return;
    }

    const missed = result.skipped.length > 0 ? ` No room for ${listOf(result.skipped.map((s) => s.what))}.` : '';
    setStatus(
      `Placed ${result.placed.length} piece${result.placed.length === 1 ? '' : 's'}` +
        `, about ${doc.currency} ${Math.round(result.spend)} in estimates.${missed}` +
        ' Undo puts the room back as it was.',
    );
  }, [budget, doc.currency, edit, program, replace, room, style]);

  const badge =
    report.findings.length === 0
      ? undefined
      : report.counts.critical > 0
        ? `${report.counts.critical} critical`
        : `${report.score}`;

  return (
    <Panel title="Design advisor" badge={badge}>
      <div className={`advisor__score advisor__score--${report.band}`}>
        <div className="advisor__number">
          {report.score}
          <span className="advisor__outof">/100</span>
        </div>
        <div className="advisor__band">
          <strong>{bandLabel(report.band)}</strong>
          <span>{headline(report)}</span>
        </div>
      </div>

      <div className="advisor__meter" role="img" aria-label={`Design score ${report.score} out of 100`}>
        <span className={`advisor__meter-fill advisor__meter-fill--${report.band}`} style={{ width: `${report.score}%` }} />
      </div>

      {rooms.length > 0 && (
        <div className="advisor__rooms">
          {rooms.map((summary) => (
            <button
              key={summary.roomKey}
              type="button"
              className="advisor__room"
              onClick={() => {
                editorStore.select('floor', summary.roomKey);
                openFurnish(summary);
              }}
              title={`Furnish ${summary.name}`}
            >
              <span className="advisor__room-name">{summary.name}</span>
              <span className="advisor__room-meta">
                {programLabel(summary.program)} · {formatArea(summary.area, doc.units)} ·{' '}
                {summary.itemCount} piece{summary.itemCount === 1 ? '' : 's'}
              </span>
            </button>
          ))}
        </div>
      )}

      {report.findings.length === 0 ? (
        <p className="field__hint">
          Draw a room and put something in it, and this panel will tell you what
          it makes of the layout.
        </p>
      ) : (
        <div className="advisor__findings">
          {report.findings.map((found) => (
            <FindingRow
              key={found.id}
              finding={found}
              open={expanded === found.id}
              onToggle={() => setExpanded(expanded === found.id ? null : found.id)}
              onApply={() => handleApply(found)}
            />
          ))}
        </div>
      )}

      {status && <p className="advisor__status">{status}</p>}

      {/* ------------------------------ Generator ---------------------------- */}

      <button
        type="button"
        className="btn btn--wide"
        onClick={() => (furnishOpen ? setFurnishOpen(false) : openFurnish(room))}
        aria-expanded={furnishOpen}
        disabled={rooms.length === 0}
      >
        {furnishOpen ? 'Hide the furnisher' : 'Furnish a room for me'}
      </button>

      {furnishOpen && room && (
        <div className="advisor__furnish">
          {rooms.length > 1 && (
            <Segmented
              label="Room"
              options={rooms.map((summary) => ({ id: summary.roomKey, label: summary.name }))}
              value={room.roomKey}
              onChange={(key) => {
                setTargetRoom(key);
                const next = rooms.find((candidate) => candidate.roomKey === key);
                if (next) {
                  setProgram(
                    next.program === 'unknown' ? suggestProgram(next.area) : next.program,
                  );
                }
              }}
            />
          )}

          <Segmented
            label="What it is for"
            options={PROGRAMS}
            value={program ?? suggestProgram(room.area)}
            onChange={setProgram}
          />

          <Segmented label="Palette" options={STYLES} value={style} onChange={setStyle} />

          <div className="field">
            <span className="field__label">Budget ({doc.currency}, optional)</span>
            <input
              className="text-input"
              type="text"
              inputMode="decimal"
              value={budget}
              placeholder="No limit"
              onChange={(event) => setBudget(event.target.value)}
              aria-label="Budget"
            />
            <p className="field__hint">
              Measured against the catalogue&rsquo;s rough estimates, which have
              not been checked against any listing. Treat it as a size guide,
              not a quote.
            </p>
          </div>

          <Toggle
            label="Clear what is already in the room first"
            checked={replace}
            onChange={setReplace}
          />

          <button type="button" className="btn btn--accent btn--wide" onClick={handleFurnish}>
            Lay out {room.name}
          </button>

          <p className="field__hint">
            You get a first draft that obeys the guidelines above — a better
            starting point than an empty floor, not a finished room. It arrives
            as one undo step, so Ctrl+Z removes the lot.
          </p>
        </div>
      )}

      <p className="advisor__note">
        These are written rules, not an AI opinion: every judgement above names
        the measurement and the published guideline it failed, and runs offline
        on your machine. They are guidance about layout, not a verdict on your
        taste — overrule any of them.
      </p>
    </Panel>
  );
}

/** Joins a list the way a person would say it. */
function listOf(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

interface FindingRowProps {
  finding: Finding;
  open: boolean;
  onToggle: () => void;
  onApply: () => void;
}

function FindingRow({ finding, open, onToggle, onApply }: FindingRowProps) {
  return (
    <div className={`advisor__finding advisor__finding--${finding.severity}`}>
      <button
        type="button"
        className="advisor__finding-head"
        onClick={() => {
          // Clicking a finding both selects what it is about and shows the
          // reasoning: an issue you cannot navigate to is a complaint.
          if (finding.focus) editorStore.select(finding.focus.kind, finding.focus.id);
          onToggle();
        }}
        aria-expanded={open}
      >
        <span className="advisor__dot" aria-hidden="true" />
        <span className="advisor__finding-text">
          <span className="advisor__finding-title">{finding.title}</span>
          <span className="advisor__finding-detail">{finding.detail}</span>
        </span>
      </button>

      {open && <p className="advisor__why">{finding.why}</p>}

      {finding.fix && (
        <button type="button" className="advisor__apply" onClick={onApply}>
          {finding.fix.label}
        </button>
      )}
    </div>
  );
}

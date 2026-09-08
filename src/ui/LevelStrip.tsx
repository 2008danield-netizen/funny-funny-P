/**
 * The storey switcher.
 *
 * Bottom to top on screen the way a building is bottom to top in life — the
 * ground floor at the bottom of the strip, not the top of a list. Getting that
 * backwards is a small thing that makes a person hesitate every single time
 * they use it.
 *
 * Only one storey is editable at a time. That is a deliberate constraint rather
 * than a limitation: with three floors stacked above a point on the ground,
 * a click has to guess which one you meant, and a tool that guesses wrong about
 * where your changes land is worse than one that makes you say.
 */

import { useState } from 'react';

import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { addLevel, copyWallsInto, removeLevel, renameLevel, setActiveLevel } from '@/state/buildingOps';
import { activeLevel, elevationOf, levelBelow } from '@/state/levels';
import { asFeetInches } from '@/code/irc';
import { formatLength } from '@/state/units';
import { LEVEL_LIMITS } from '@/state/types';

export function LevelStrip() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const current = activeLevel(doc);
  const atLimit = doc.levels.length >= LEVEL_LIMITS.maxLevels;

  const height = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');

  return (
    <div className="levels">
      <div className="levels__list">
        {/* Reversed: the top storey is at the top of the strip. */}
        {[...doc.levels].reverse().map((level) => {
          const active = level.id === current.id;
          return (
            <div key={level.id} className={`levels__row ${active ? 'levels__row--active' : ''}`}>
              {renaming === level.id ? (
                <input
                  className="levels__rename"
                  autoFocus
                  defaultValue={level.name}
                  onBlur={(event) => {
                    edit((draft) => renameLevel(draft, level.id, event.target.value));
                    setRenaming(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="levels__pick"
                  onClick={() => edit((draft) => setActiveLevel(draft, level.id), { history: 'skip' })}
                  onDoubleClick={() => setRenaming(level.id)}
                  title="Click to edit this storey; double-click to rename"
                >
                  <span className="levels__name">{level.name}</span>
                  <span className="levels__meta">
                    {elevationOf(doc, level.id) < 1e-6
                      ? 'ground level'
                      : `${height(elevationOf(doc, level.id))} up`}{' '}
                    &middot; {height(level.wallHeight)} ceiling
                  </span>
                </button>
              )}

              {doc.levels.length > 1 && (
                <button
                  type="button"
                  className="levels__remove"
                  aria-label={`Delete ${level.name}`}
                  title={`Delete ${level.name}`}
                  onClick={() => {
                    edit((draft) => {
                      removeLevel(draft, level.id);
                    });
                    setStatus(`${level.name} removed. Undo puts it back.`);
                  }}
                >
                  &times;
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="levels__actions">
        <button
          type="button"
          className="btn btn--wide"
          disabled={atLimit}
          title={
            atLimit
              ? `A building here tops out at ${LEVEL_LIMITS.maxLevels} storeys`
              : 'Add a storey, tracing the walls of the one below'
          }
          onClick={() => {
            edit((draft) => {
              const result = addLevel(draft, { copyWalls: true });
              setStatus(
                result.id
                  ? 'Storey added, tracing the walls below. Delete what you do not want.'
                  : (result.reason ?? ''),
              );
            });
          }}
        >
          Add a storey above
        </button>

        {levelBelow(doc, current.id) && (
          <button
            type="button"
            className="btn btn--wide"
            title="Replace this storey's walls with a copy of the one below"
            onClick={() => {
              edit((draft) => {
                const level = activeLevel(draft);
                const below = levelBelow(draft, level.id);
                if (below) copyWallsInto(level, below);
              });
              setStatus('Walls traced from the storey below.');
            }}
          >
            Trace the walls below
          </button>
        )}
      </div>

      {status && <p className="levels__status">{status}</p>}
    </div>
  );
}

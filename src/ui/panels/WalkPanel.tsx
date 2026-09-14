/**
 * Walking through the building.
 *
 * -----------------------------------------------------------------------------
 * THE COMFORT SETTINGS ARE NOT DECORATION.
 *
 * Everything else in this app can be got wrong and merely produce a bad
 * drawing. Getting these wrong makes a real fraction of people physically
 * unwell inside a minute, and once that happens they take the headset off and
 * do not put it back on. So they are on the first screen rather than behind an
 * "advanced" disclosure, they default to the cautious settings, and the panel
 * says plainly what each one is for.
 *
 * -----------------------------------------------------------------------------
 * AND THE FRAME READOUT IS HERE ON PURPOSE.
 *
 * A low frame rate in a headset is a physical problem rather than an aesthetic
 * one, so the number is shown to the person rather than hidden in a console.
 * It is also what the next session's quality decisions will be made from —
 * measured, rather than guessed at in advance.
 */

import { useEffect, useState } from 'react';

import { Panel } from '../components/Panel';
import { useDesign } from '@/bridge/useDesign';
import { useEditor } from '@/bridge/useEditor';
import { editorStore, DEFAULT_COMFORT } from '@/state/selection';
import { buildingBounds } from '@/state/sectionOps';
import type { Engine } from '@/core/Engine';

interface WalkPanelProps {
  engine: Engine | null;
}

export function WalkPanel({ engine }: WalkPanelProps) {
  const doc = useDesign();
  const { walkthrough, comfort } = useEditor();

  const [xrReady, setXrReady] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [locked, setLocked] = useState(false);
  const [frames, setFrames] = useState('no frames measured yet');
  const [notice, setNotice] = useState('');

  const somewhereToGo = buildingBounds(doc) !== null;

  /* ---- Whether this browser can actually offer a headset session ---- */

  useEffect(() => {
    let alive = true;
    // Asked rather than assumed: plenty of browsers have `navigator.xr` and
    // will still refuse the session, and a button that does nothing is worse
    // than no button.
    void (async () => {
      const { Engine: EngineClass } = await import('@/core/Engine');
      const available = await EngineClass.xrAvailable();
      if (alive) setXrReady(available);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ---- Follow the engine's own mode changes ---- */

  useEffect(() => {
    if (!engine) return;
    const sync = () => {
      setPresenting(engine.presenting);
      setLocked(engine.pointerLocked);
      // Leaving the walkthrough from inside the engine — losing a session,
      // for instance — has to be reflected back into the editor state, or the
      // panel and the viewport disagree about what mode this is.
      if (!engine.walkingThrough && editorStore.getState().walkthrough) {
        editorStore.patch({ walkthrough: false });
      }
    };
    engine.setWalkHandler(sync);
    sync();
    return () => engine.setWalkHandler(null);
  }, [engine]);

  /* ---- The frame readout, once a second while walking ---- */

  useEffect(() => {
    if (!engine || !walkthrough) return;
    const timer = window.setInterval(() => setFrames(engine.frameSummary), 1000);
    return () => window.clearInterval(timer);
  }, [engine, walkthrough]);

  const patchComfort = (change: Partial<typeof comfort>) => {
    editorStore.patch({ comfort: { ...comfort, ...change } });
  };

  return (
    <Panel title="Walk through" badge={walkthrough ? 'on' : undefined} defaultOpen={false}>
      {!somewhereToGo && (
        <p className="field__hint">
          Draw some walls first. There is nothing to walk through yet.
        </p>
      )}

      {somewhereToGo && !walkthrough && (
        <>
          <button
            type="button"
            className="btn btn--wide btn--primary"
            onClick={() => {
              setNotice('');
              editorStore.patch({ walkthrough: true });
            }}
          >
            Walk through it
          </button>
          <p className="field__hint">
            Stand in the building at eye height and walk about. The floor, the stairs and the
            doorways are the ones you drew — if a doorway is too narrow to walk through here, it
            is too narrow.
          </p>
        </>
      )}

      {walkthrough && (
        <>
          {!locked && !presenting && (
            <button
              type="button"
              className="btn btn--wide btn--primary"
              onClick={() => engine?.resumeWalkPointer()}
            >
              Click to look around
            </button>
          )}

          <p className="field__hint">
            <strong>W A S D</strong> to walk, mouse to look, <strong>Shift</strong> to hurry,
            <strong> Q</strong> and <strong>E</strong> to turn in steps. Hold the{' '}
            <strong>right mouse button</strong> to aim a jump and release to take it.{' '}
            <strong>Esc</strong> releases the mouse.
          </p>

          <button
            type="button"
            className="btn btn--wide"
            onClick={() => editorStore.patch({ walkthrough: false })}
          >
            Stop walking
          </button>
        </>
      )}

      {/* ------------------------------ The headset ------------------------- */}

      {somewhereToGo && (
        <div className="elec__section">
          <div className="elec__section-title">
            Headset
            <span className="elec__meta">{xrReady ? 'available' : 'not available here'}</span>
          </div>

          {xrReady ? (
            <button
              type="button"
              className="btn btn--wide"
              onClick={() => {
                void (presenting ? engine?.exitXr() : engine?.enterXr())?.catch((error: unknown) =>
                  setNotice(error instanceof Error ? error.message : 'The headset refused.'),
                );
              }}
            >
              {presenting ? 'Leave the headset' : 'Enter in a headset'}
            </button>
          ) : (
            <p className="field__hint">
              This browser cannot open an immersive session. A headset's own browser can, and so
              can a desktop browser with a headset plugged in. The walkthrough above works
              either way.
            </p>
          )}

          {notice && <p className="field__hint">{notice}</p>}
        </div>
      )}

      {/* ------------------------------- Comfort ---------------------------- */}

      <div className="elec__section">
        <div className="elec__section-title">
          Comfort
          <span className="elec__meta">cautious by default</span>
        </div>

        <div className="field">
          <span className="field__label">Moving</span>
          <select
            className="select"
            value={comfort.locomotion}
            onChange={(event) =>
              patchComfort({ locomotion: event.target.value as 'smooth' | 'teleport' })
            }
          >
            <option value="smooth">Smooth — walk with the stick or the keys</option>
            <option value="teleport">Teleport only — hop from place to place</option>
          </select>
          <p className="field__hint">
            {comfort.locomotion === 'smooth'
              ? 'Best for judging how big a room is, because you cross it at walking pace. Some people find it makes them queasy; the vignette below is what fixes that.'
              : 'Nobody gets motion sick hopping. The cost is that you stop feeling how far apart things are, which is most of what a walkthrough is for.'}
          </p>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={comfort.vignette}
            onChange={(event) => patchComfort({ vignette: event.target.checked })}
          />
          <span>Narrow the view while moving</span>
        </label>
        <p className="field__hint">
          The periphery is where your eyes and your inner ear disagree most, so covering it while
          you move removes most of the problem — and costs almost nothing, because what you are
          looking at is in the middle.
        </p>

        {comfort.vignette && (
          <div className="field">
            <span className="field__label">
              How much
              <span className="field__value">{Math.round(comfort.vignetteStrength * 100)}%</span>
            </span>
            <input
              type="range"
              className="slider"
              min={0.2}
              max={1}
              step={0.05}
              value={comfort.vignetteStrength}
              onChange={(event) => patchComfort({ vignetteStrength: Number(event.target.value) })}
            />
          </div>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={comfort.snapTurn}
            onChange={(event) => patchComfort({ snapTurn: event.target.checked })}
          />
          <span>Turn in steps rather than smoothly</span>
        </label>
        <p className="field__hint">
          Turning is the worse offender of the two, worse than moving. In steps your eyes never
          see a slow rotation your ears disagree with.
        </p>

        <button
          type="button"
          className="btn btn--wide"
          onClick={() => editorStore.patch({ comfort: { ...DEFAULT_COMFORT } })}
        >
          Back to the cautious settings
        </button>
      </div>

      {/* ----------------------------- Frame budget ------------------------- */}

      {walkthrough && (
        <div className="elec__section">
          <div className="elec__section-title">
            Frames
            <span className="elec__meta">{presenting ? '9.6 ms budget' : '16.6 ms budget'}</span>
          </div>
          <p className="field__hint">{frames}</p>
          <p className="field__hint">
            A slow frame on a screen is a slow frame. In a headset it is felt in the inner ear, so
            the budget there is far tighter. Nothing has been cut from the renderer for the
            headset yet — this is the measurement that decides what should be.
          </p>
        </div>
      )}
    </Panel>
  );
}

/**
 * Tracing a real floor plan.
 *
 * The order of the controls is the order of the job, and that is the whole
 * design of this panel: bring the plan in, straighten it if it is a photograph,
 * tell the app how big something on it is, line it up, then let it find the
 * walls and pick which ones are right. Anything out of order is disabled rather
 * than hidden, so the sequence is discoverable rather than remembered.
 *
 * The one thing worth insisting on is the scale. Everything traced before it is
 * set inherits a guess, and a house traced 15 percent out looks completely
 * normal — every room in proportion, every number wrong. So the panel says so,
 * loudly, until it has been set.
 */

import { useEffect, useState } from 'react';

import { Panel } from '../components/Panel';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { PlanSetup, type SetupMode } from '../PlanSetup';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { activeLevel, levelBelow } from '@/state/levels';
import { editorStore } from '@/state/selection';
import { useEditor } from '@/bridge/useEditor';
import { acceptCandidates, candidatesFrom } from '@/state/traceOps';
import {
  importImage,
  getImage,
  loadImageElement,
  readFileAsDataUrl,
} from '@/state/imageStore';
import {
  boundsOf,
  calibrateUnderlay,
  calibrationSpan,
  isCalibrated,
  placeNewUnderlay,
  suggestAlignment,
  underlaySize,
} from '@/plan/underlay';
import { straightenImage } from '@/plan/perspective';
import { contentBounds, detectWalls } from '@/plan/detect';
import { pixelsFrom } from '@/plan/pixels';
import { isPdf, openPdf } from '@/plan/pdf';
import { resolveWalls } from '@/scene/planGraph';
import { asFeetInches } from '@/code/irc';
import { formatLength } from '@/state/units';
import { UNDERLAY_LIMITS, type Point2 } from '@/state/types';

export function TracePanel() {
  const doc = useDesign();
  const edit = useDesignEdit();
  const { traceCandidates, acceptedTraceIds } = useEditor();

  const level = activeLevel(doc);
  const underlay = level.underlay;

  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [setup, setSetup] = useState<SetupMode | null>(null);
  const [pending, setPending] = useState<Point2[] | null>(null);
  const [known, setKnown] = useState('4.2');
  const [label, setLabel] = useState('the front wall');

  const length = (metres: number) =>
    doc.units === 'imperial' ? asFeetInches(metres) : formatLength(metres, 'metric');

  /* Reading the image out of the store, whenever the storey or the plan changes. */
  useEffect(() => {
    let cancelled = false;
    if (!underlay) {
      setDataUrl(null);
      setMissing(false);
      return;
    }

    void getImage(underlay.imageId).then((stored) => {
      if (cancelled) return;
      setDataUrl(stored?.dataUrl ?? null);
      setMissing(!stored);
    });
    return () => {
      cancelled = true;
    };
  }, [underlay?.imageId, underlay]);

  /* ------------------------------ Importing ------------------------------ */

  const importFile = async (file: File) => {
    setNotice('');
    setBusy(isPdf(file) ? 'Reading the PDF…' : 'Reading the image…');

    try {
      let source: HTMLImageElement | HTMLCanvasElement;

      if (isPdf(file)) {
        const pdf = await openPdf(await file.arrayBuffer());
        // The first page, which is the plan in the overwhelming majority of
        // files. A page picker is offered afterwards if there are more.
        source = await pdf.renderPage(1, UNDERLAY_LIMITS.maxPixels);
        await pdf.close();
        if (pdf.pageCount > 1) {
          setNotice(`Page 1 of ${pdf.pageCount}. Import again and pick another page if that is not the plan.`);
        }
      } else {
        source = await loadImageElement(await readFileAsDataUrl(file));
      }

      const imported = await importImage(source, UNDERLAY_LIMITS.maxPixels);
      edit((draft) => {
        activeLevel(draft).underlay = placeNewUnderlay(
          imported.id,
          imported.width,
          imported.height,
        );
      });
      editorStore.patch({ traceCandidates: [], acceptedTraceIds: [] });
      if (imported.downscaled) {
        setNotice('That was a big picture, so it was scaled down — plenty for tracing.');
      }
    } catch (error) {
      console.error('[havavamama] Could not read that plan:', error);
      setNotice('That file could not be read as a plan. An image or a PDF is what this wants.');
    } finally {
      setBusy('');
    }
  };

  /* ----------------------------- Straightening --------------------------- */

  const straighten = async (corners: Point2[]) => {
    if (!dataUrl || !underlay) return;
    setBusy('Straightening…');

    try {
      const image = await loadImageElement(dataUrl);
      const canvas = straightenImage(image, corners);
      if (!canvas) {
        setNotice('Those four corners do not make a sheet. Try again, going round the edge.');
        return;
      }

      const imported = await importImage(canvas, UNDERLAY_LIMITS.maxPixels);
      edit((draft) => {
        const target = activeLevel(draft);
        if (!target.underlay) return;
        target.underlay = {
          ...target.underlay,
          imageId: imported.id,
          pixelWidth: imported.width,
          pixelHeight: imported.height,
          // Straightening moves every pixel, so any scale set from the old
          // image is now wrong. Clearing it is the honest thing: a stale
          // calibration would leave the plan looking measured and be out by
          // however much the camera was tilted.
          calibration: null,
        };
      });
      editorStore.patch({ traceCandidates: [], acceptedTraceIds: [] });
      setNotice('Straightened. Set the scale again — the old one was measured on the tilted picture.');
    } finally {
      setBusy('');
    }
  };

  /* ------------------------------ Detection ------------------------------ */

  const findWalls = async () => {
    if (!dataUrl || !underlay) return;
    setBusy('Looking for walls…');

    try {
      const pixels = await pixelsFrom(dataUrl);
      // The detector thinks in pixels, and what a wall IS is a fact about
      // metres — so the limits are converted here, where the scale is known.
      const perMetre = 1 / underlay.metresPerPixel;
      const detected = detectWalls(pixels, {
        minLength: Math.max(20, 0.6 * perMetre),
        maxGap: Math.max(6, 0.25 * perMetre),
        minThickness: Math.max(2, 0.05 * perMetre),
        maxThickness: Math.max(6, 0.6 * perMetre),
      });

      const candidates = candidatesFrom(underlay, detected);
      editorStore.patch({
        traceCandidates: candidates,
        // Ticked by default: the user asked for them, and unticking the few
        // that are wrong is far less work than ticking the many that are right.
        acceptedTraceIds: candidates.map((one) => one.id),
      });
      setNotice(
        candidates.length === 0
          ? 'Nothing that looks like a wall. A sharper scan, or a different scale, usually fixes it.'
          : `${candidates.length} walls found. Untick anything that is not one.`,
      );
    } catch (error) {
      console.error('[havavamama] Wall detection failed:', error);
      setNotice('Something went wrong looking for walls.');
    } finally {
      setBusy('');
    }
  };

  const accepted = new Set(acceptedTraceIds);

  const acceptAll = () => {
    const chosen = traceCandidates.filter((one) => accepted.has(one.id));
    if (chosen.length === 0) return;

    edit((draft) => {
      const result = acceptCandidates(draft, level.id, chosen);
      setNotice(`${result.added} walls added. Undo puts the plan back as it was.`);
    });
    editorStore.patch({ traceCandidates: [], acceptedTraceIds: [] });
  };

  /* ------------------------------- Aligning ------------------------------ */

  const alignToBelow = async () => {
    if (!underlay || !dataUrl) return;
    const below = levelBelow(doc, level.id);
    if (!below) return;

    setBusy('Lining it up…');
    try {
      const pixels = await pixelsFrom(dataUrl);
      const content = contentBounds(pixels);
      const outline = boundsOf(
        resolveWalls(below.plan).flatMap((segment) => [segment.start, segment.end]),
      );
      if (!content || !outline) {
        setNotice('There is nothing on the storey below to line this up with.');
        return;
      }

      edit((draft) => {
        const target = activeLevel(draft);
        if (target.underlay) target.underlay = suggestAlignment(target.underlay, content, outline);
      });
      setNotice('Lined up with the storey below. Nudge it from here if it is not quite right.');
    } finally {
      setBusy('');
    }
  };

  /* -------------------------------- Render ------------------------------- */

  const setupOverlay =
    setup && dataUrl ? (
      <PlanSetup
        dataUrl={dataUrl}
        mode={setup}
        onCancel={() => {
          setSetup(null);
          setPending(null);
        }}
        onDone={(points) => {
          setSetup(null);
          if (setup === 'corners') void straighten(points);
          else setPending(points);
        }}
      />
    ) : null;

  return (
    <>
      {setupOverlay}

      <Panel title="Trace a plan" defaultOpen={false}>
        {!underlay && (
          <p className="field__hint">
            Nobody draws their own house from memory. Bring in the plan you already have — a PDF
            from an agent or an architect, a scan, or a photograph of a printed sheet — and draw
            over it.
          </p>
        )}

        <label className="btn btn--wide trace__import">
          {underlay ? 'Replace the plan' : 'Import a plan'}
          <input
            type="file"
            accept="image/*,application/pdf,.pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
        </label>

        {busy && <p className="field__hint">{busy}</p>}
        {notice && <p className="trace__notice">{notice}</p>}

        {missing && (
          <p className="roof__problem">
            This storey names a plan image that is not in this browser. It was probably traced on
            another machine, or in a private window. Import it again to carry on.
          </p>
        )}

        {underlay && dataUrl && (
          <>
            {/* ---- The scale ---- */}
            <div className="field">
              <span className="field__label">Scale</span>
              {isCalibrated(underlay) ? (
                <p className="field__hint">
                  {length(underlay.calibration!.metres)} across {underlay.calibration!.label},
                  measured over {Math.round(calibrationSpan(underlay))} pixels. The plan is{' '}
                  {length(underlaySize(underlay).width)} by {length(underlaySize(underlay).depth)}.
                  {calibrationSpan(underlay) < 120 && (
                    <>
                      {' '}
                      That is a short measurement to scale a whole house from — a couple of pixels
                      of slop in each click is a real error over this distance. A longer one would
                      be worth redoing.
                    </>
                  )}
                </p>
              ) : (
                <p className="roof__problem">
                  The scale has not been set, so this plan is only a guess at{' '}
                  {length(underlaySize(underlay).width)} across. Anything traced now will be the
                  wrong size — in proportion, and wrong.
                </p>
              )}
              <button
                type="button"
                className="btn btn--wide"
                onClick={() => {
                  setPending(null);
                  setSetup('calibrate');
                }}
              >
                {isCalibrated(underlay) ? 'Set the scale again' : 'Set the scale'}
              </button>
            </div>

            {pending && pending.length === 2 && (
              <div className="trace__calibrate">
                <label className="field">
                  <span className="field__label">How far is that, really?</span>
                  <input
                    className="text-input"
                    value={known}
                    inputMode="decimal"
                    onChange={(event) => setKnown(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field__label">What is it?</span>
                  <input
                    className="text-input"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </label>
                <p className="field__hint">
                  In metres. {doc.units === 'imperial' && 'Feet and inches are shown everywhere else, but this one field is metric — 4.2 rather than 13 ft 9 in.'}
                </p>
                <button
                  type="button"
                  className="btn btn--wide"
                  onClick={() => {
                    const metres = Number(known);
                    if (!Number.isFinite(metres) || metres <= 0) {
                      setNotice('That distance is not a number of metres.');
                      return;
                    }
                    edit((draft) => {
                      const target = activeLevel(draft);
                      if (!target.underlay) return;
                      target.underlay = calibrateUnderlay(
                        target.underlay,
                        pending[0]!,
                        pending[1]!,
                        metres,
                        label.trim() || 'a known length',
                      );
                    });
                    setPending(null);
                    setNotice('Scale set. Everything traced from here is in real metres.');
                  }}
                >
                  Use that as the scale
                </button>
              </div>
            )}

            {/* ---- Placing it ---- */}
            <Slider
              label="Turn"
              displayValue={`${Math.round((underlay.rotation * 180) / Math.PI)}°`}
              value={underlay.rotation}
              min={-Math.PI}
              max={Math.PI}
              step={Math.PI / 360}
              disabled={underlay.locked}
              onChange={(rotation) =>
                edit(
                  (draft) => {
                    const target = activeLevel(draft);
                    if (target.underlay) target.underlay.rotation = rotation;
                  },
                  { history: 'coalesce', coalesceKey: 'underlay.rotation' },
                )
              }
            />

            {(['x', 'z'] as const).map((axis) => (
              <Slider
                key={axis}
                label={axis === 'x' ? 'Move across' : 'Move up and down the plan'}
                displayValue={length(underlay.at[axis])}
                value={underlay.at[axis]}
                min={-30}
                max={30}
                step={0.05}
                disabled={underlay.locked}
                onChange={(value) =>
                  edit(
                    (draft) => {
                      const target = activeLevel(draft);
                      if (target.underlay) target.underlay.at[axis] = value;
                    },
                    { history: 'coalesce', coalesceKey: `underlay.at.${axis}` },
                  )
                }
              />
            ))}

            <Slider
              label="Fade"
              displayValue={`${Math.round(underlay.opacity * 100)}%`}
              value={underlay.opacity}
              min={UNDERLAY_LIMITS.opacity.min}
              max={UNDERLAY_LIMITS.opacity.max}
              step={UNDERLAY_LIMITS.opacity.step}
              onChange={(opacity) =>
                edit(
                  (draft) => {
                    const target = activeLevel(draft);
                    if (target.underlay) target.underlay.opacity = opacity;
                  },
                  { history: 'coalesce', coalesceKey: 'underlay.opacity' },
                )
              }
            />

            <Toggle
              label="Lock it in place"
              checked={underlay.locked}
              onChange={(locked) =>
                edit((draft) => {
                  const target = activeLevel(draft);
                  if (target.underlay) target.underlay.locked = locked;
                })
              }
            />

            <div className="button-row">
              <button type="button" className="btn" onClick={() => setSetup('corners')}>
                Straighten a photo
              </button>
              {levelBelow(doc, level.id) && (
                <button type="button" className="btn" onClick={() => void alignToBelow()}>
                  Line up with below
                </button>
              )}
            </div>

            {/* ---- Finding the walls ---- */}
            <button
              type="button"
              className="btn btn--wide"
              disabled={!!busy}
              onClick={() => void findWalls()}
            >
              Find the walls
            </button>

            {traceCandidates.length > 0 && (
              <div className="trace__found">
                <div className="trace__found-header">
                  <span className="field__label">
                    {accepted.size} of {traceCandidates.length} ticked
                  </span>
                  <div className="button-row">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() =>
                        editorStore.patch({
                          acceptedTraceIds: traceCandidates.map((one) => one.id),
                        })
                      }
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => editorStore.patch({ acceptedTraceIds: [] })}
                    >
                      None
                    </button>
                  </div>
                </div>

                <div className="trace__list">
                  {traceCandidates.map((candidate) => {
                    const run = Math.hypot(
                      candidate.to.x - candidate.from.x,
                      candidate.to.z - candidate.from.z,
                    );
                    const on = accepted.has(candidate.id);
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        className={`trace__candidate ${on ? 'trace__candidate--on' : ''}`}
                        onClick={() =>
                          editorStore.patch({
                            acceptedTraceIds: on
                              ? acceptedTraceIds.filter((id) => id !== candidate.id)
                              : [...acceptedTraceIds, candidate.id],
                          })
                        }
                      >
                        <span>{length(run)}</span>
                        <span className="trace__candidate-meta">
                          {candidate.thickness === null
                            ? 'one face only'
                            : `${length(candidate.thickness)} thick`}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className="btn btn--wide btn--accent"
                  disabled={accepted.size === 0}
                  onClick={acceptAll}
                >
                  Add {accepted.size} walls to the plan
                </button>
                <p className="field__hint">
                  They arrive as one change, so a single undo takes them all back out. Corners that
                  nearly meet are joined, and a plan drawn a degree or two off square is
                  straightened — which is what makes the rooms close.
                </p>
              </div>
            )}

            <button
              type="button"
              className="btn btn--danger btn--wide"
              onClick={() => {
                edit((draft) => {
                  activeLevel(draft).underlay = null;
                });
                editorStore.patch({ traceCandidates: [], acceptedTraceIds: [] });
              }}
            >
              Remove this plan
            </button>
          </>
        )}
      </Panel>
    </>
  );
}

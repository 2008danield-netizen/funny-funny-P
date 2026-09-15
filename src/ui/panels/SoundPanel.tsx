/**
 * Sound: what the house sounds like, and what that tells you.
 *
 * -----------------------------------------------------------------------------
 * TWO HALVES, AND THEY ARE DIFFERENT KINDS OF THING.
 *
 * The top half is playback — how loud, which beds are on. None of it is the
 * design and none of it is saved, exactly like the comfort settings.
 *
 * The bottom half is a report. Reverberation time per room against the range
 * that kind of room wants, which surface is responsible, and the findings. That
 * IS about the design, and the two acoustic facts the model cannot derive —
 * what is outside the plot and how the partitions are built — are edited here
 * because this is where their consequences are shown.
 *
 * -----------------------------------------------------------------------------
 * AND IT SAYS "GUIDANCE" A LOT, ON PURPOSE.
 *
 * Almost nothing in a detached house is governed by an acoustic code. Every
 * other panel in this app cites a book that can fail an inspection; this one
 * mostly cannot, and printing a section number anyway would be the fastest way
 * to make somebody stop believing the ones that are real.
 */

import { useEffect, useState } from 'react';

import { Panel } from '../components/Panel';
import { Slider } from '../components/Slider';
import { useDesign, useDesignEdit } from '@/bridge/useDesign';
import { useEditor } from '@/bridge/useEditor';
import { useAcoustics } from '@/bridge/useAnalysis';
import { editorStore, DEFAULT_SOUND } from '@/state/selection';
import { OUTDOOR_NOISE, TRANSMISSION, reverbTarget } from '@/code/acoustics';
import type { Engine } from '@/core/Engine';

interface SoundPanelProps {
  engine: Engine | null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function SoundPanel({ engine }: SoundPanelProps) {
  const doc = useDesign();
  const edit = useDesignEdit();
  const { walkthrough, sound } = useEditor();
  const report = useAcoustics();

  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  /* ---- Whether sound is actually coming out, which is not the same as on ---- */

  useEffect(() => {
    if (!engine) return;

    /*
     * Polled rather than pushed, twice a second.
     *
     * The browser can suspend an audio context at any moment — a backgrounded
     * tab, a device change — and it does so without telling anybody. Asking
     * periodically is the only reliable way to know, and twice a second is far
     * more often than the state changes.
     */
    const tick = () => setRunning(engine.soundRunning);
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [engine, walkthrough]);

  const patch = (change: Partial<typeof sound>) => {
    editorStore.patch({ sound: { ...sound, ...change } });
  };

  const rooms = report.rooms.filter((room) => room.volume >= 12);

  return (
    <Panel title="Sound" badge={rooms.length > 0 ? `${rooms.length} rooms` : undefined} defaultOpen={false}>
      {/* ------------------------------ Playback ---------------------------- */}

      <div className="elec__section">
        <div className="elec__section-title">
          Playback
          <span className="elec__meta">{running ? 'on' : engine ? 'not started' : 'no engine'}</span>
        </div>

        {!running && (
          <>
            <button
              type="button"
              className="btn btn--wide"
              onClick={() => {
                // A click is a user gesture, which is the only thing a browser
                // will start an audio context on.
                void engine?.startAudio().then(setRunning);
              }}
            >
              Turn the sound on
            </button>
            <p className="field__hint">
              Browsers will not let a page make a noise until you have clicked something,
              and they refuse silently rather than with an error — so this button exists
              rather than leaving you wondering why the house is quiet. Walking through
              also starts it.
            </p>
          </>
        )}

        <Slider
          label="Volume"
          displayValue={`${Math.round(sound.volume * 100)}%`}
          min={0}
          max={1}
          step={0.05}
          value={sound.volume}
          onChange={(value) => patch({ volume: value })}
        />

        <label className="check">
          <input
            type="checkbox"
            checked={sound.footsteps}
            onChange={(event) => patch({ footsteps: event.target.checked })}
          />
          <span>Footsteps</span>
        </label>
        <p className="field__hint">
          Voiced by the floor you are actually standing on. Walking from a carpeted
          bedroom onto a tiled hall and hearing it change is how you notice that the
          hall is the noisiest part of the house to move through.
        </p>

        <label className="check">
          <input
            type="checkbox"
            checked={sound.interactions}
            onChange={(event) => patch({ interactions: event.target.checked })}
          />
          <span>Doors, switches, drawers and taps</span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={sound.mechanical}
            onChange={(event) => patch({ mechanical: event.target.checked })}
          />
          <span>The heating and cooling running</span>
        </label>
        <p className="field__hint">
          Air at the registers, as loud as the airflow Manual D actually gave them.
          If you can hear the supply from the bed, the report below has a finding
          about it — and you have just heard the same thing twice.
        </p>

        <label className="check">
          <input
            type="checkbox"
            checked={sound.outside}
            onChange={(event) => patch({ outside: event.target.checked })}
          />
          <span>Outside, through the glazing</span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={sound.reverb}
            onChange={(event) => patch({ reverb: event.target.checked })}
          />
          <span>The room&rsquo;s own reverberation</span>
        </label>
        <p className="field__hint">
          Not a preset. The tail is built from this room&rsquo;s volume and this
          room&rsquo;s surfaces, so changing the floor finish changes what the room
          sounds like. Switching it off is the clearest way to hear what the room is
          doing to everything else.
        </p>

        <button
          type="button"
          className="btn btn--wide"
          onClick={() => editorStore.patch({ sound: { ...DEFAULT_SOUND } })}
        >
          Back to the defaults
        </button>
      </div>

      {/* ------------------------- The two design inputs --------------------- */}

      <div className="elec__section">
        <div className="elec__section-title">
          What the model cannot know
          <span className="elec__meta">design inputs</span>
        </div>

        <div className="field">
          <span className="field__label">Outside the plot</span>
          <select
            className="select"
            value={doc.acoustics.outdoorNoiseId}
            onChange={(event) =>
              edit((draft) => {
                draft.acoustics.outdoorNoiseId = event.target.value;
              })
            }
          >
            {OUTDOOR_NOISE.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label} — {entry.dba} dBA
              </option>
            ))}
          </select>
          <p className="field__hint">
            Nothing in a model of a house knows what is on the other side of the
            boundary. Which facade it arrives at IS derived: the site records which
            plot line is the front, so a bedroom at the back is quieter by the
            screening of the house itself.
          </p>
        </div>

        <div className="field">
          <span className="field__label">Interior partitions</span>
          <select
            className="select"
            value={doc.acoustics.partitionId}
            onChange={(event) =>
              edit((draft) => {
                draft.acoustics.partitionId = event.target.value;
              })
            }
          >
            {TRANSMISSION.filter((entry) => entry.id.startsWith('partition')).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label} — STC {entry.stc}
              </option>
            ))}
          </select>
          <p className="field__hint">
            The envelope spec records the exterior wall because the energy code asks
            about it. Nothing has ever had to ask what is inside a stud partition, and
            acoustically it is the difference between hearing the words next door and
            hearing a murmur. Batts in the cavity are the cheapest five points there is.
          </p>
        </div>
      </div>

      {/* ---------------------------- What each room does --------------------- */}

      {rooms.length > 0 && (
        <div className="elec__section">
          <div className="elec__section-title">
            Reverberation
            <span className="elec__meta">500 Hz&ndash;2 kHz</span>
          </div>

          <table className="elec__table">
            <tbody>
              {rooms.map((room) => {
                const target = reverbTarget(room.purpose);
                const long = room.midRt60 > target.max;
                const short = room.midRt60 < target.min;
                const open = expanded === room.roomKey;

                return (
                  <tr key={room.roomKey}>
                    <td>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setExpanded(open ? null : room.roomKey)}
                      >
                        {room.name}
                      </button>
                      {open && (
                        <div className="field__hint">
                          {Math.round(room.volume)} m³, {round1(room.height)} m to the ceiling.
                          {' '}Target {target.min}&ndash;{target.max} s. {target.why}
                          {room.dominant && (
                            <>
                              {' '}Most of the absorption in it is the{' '}
                              {room.dominant.label.toLowerCase()} ({round1(room.dominant.area)} m²).
                            </>
                          )}
                          {' '}{room.methodWhy}
                          {room.bassRatio > 1.4 && (
                            <>
                              {' '}The bass rings {round1(room.bassRatio)}× as long as the mid —{' '}
                              {round1(room.rt60[0] ?? 0)} s at 125 Hz. That is heard as
                              muddiness rather than as echo, and one averaged figure hides it.
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="elec__amount">
                      {round1(room.midRt60)} s
                      {(long || short) && (
                        <span className="elec__meta"> {long ? 'long' : 'short'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="field__hint">
            Sabine&rsquo;s equation, or Eyring&rsquo;s where the room is absorbent enough that
            Sabine&rsquo;s small-loss assumption fails — each room says which was used. Every
            surface of the room is counted, and so is the furniture standing in it: a
            three-seat sofa absorbs nearly as much at 1 kHz as the whole painted ceiling
            above it, which is why an empty room and a furnished one are two different rooms.
            Doors are assumed shut.
          </p>
        </div>
      )}

      {/* -------------------------------- Findings --------------------------- */}

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
                {/* Four kinds of authority here rather than the usual two, and
                    the distinctions are real: the IBC is law, ASHRAE is the
                    mechanical industry's own recommendation, the WHO is a
                    health body, and most of this is neither — it is this app's
                    guidance and it says so. */}
                <span className="stairs__section">
                  {finding.authority === 'none'
                    ? 'Guidance'
                    : `${finding.authority} ${finding.section}`.trim()}
                </span>
              </span>
              <span className="stairs__finding-detail">{finding.detail}</span>
              {finding.remedy && <span className="stairs__finding-remedy">{finding.remedy}</span>}
            </div>
          ))}
        </div>
      )}

      {rooms.length === 0 && (
        <p className="field__hint">
          Draw some rooms and name them. Reverberation is a property of an enclosed
          volume, so there is nothing to compute until there is one.
        </p>
      )}

      <p className="field__hint">
        Almost nothing about sound in a detached house is governed by any code. The IBC
        requires STC 50 between separate dwelling units and says nothing about the wall
        between your bedroom and your living room; there is no equivalent of the IRC or
        the NEC here. So this report is guidance, it is labelled as guidance, and the one
        real citation in it is there to tell you what does <em>not</em> apply.
      </p>
    </Panel>
  );
}

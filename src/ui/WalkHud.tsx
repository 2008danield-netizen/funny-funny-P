/**
 * The crosshair, and what it says you can do.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS NOT IN THE SIDE PANEL.
 *
 * While the pointer is locked the whole of somebody's attention is in the
 * middle of the screen — that is what pointer lock is for. A prompt in a panel
 * three hundred pixels to the right is a prompt nobody reads, and an
 * interaction nobody can find is an interaction that does not exist. So it sits
 * on the crosshair, where the thing being reached for already is.
 *
 * -----------------------------------------------------------------------------
 * POLLED, NOT PUSHED.
 *
 * The engine knows what is under the crosshair every frame, sixty or ninety
 * times a second. Pushing that into React would mean a render inside the frame
 * loop to change two words, which is exactly the kind of thing that eats a
 * frame budget for nothing. Six times a second is faster than anybody reads and
 * costs nothing measurable.
 *
 * None of this is drawn in a headset. There the highlight is the ring in world
 * space around the object itself — a DOM overlay does not exist inside an XR
 * session, and a crosshair fixed to the middle of a head-tracked view would be
 * an object stuck to somebody's face.
 */

import { useEffect, useState } from 'react';

import type { Engine } from '@/core/Engine';

interface WalkHudProps {
  engine: Engine | null;
  /** Whether the walkthrough is running at all. */
  walking: boolean;
}

export function WalkHud({ engine, walking }: WalkHudProps) {
  const [prompt, setPrompt] = useState<{ label: string; verb: string } | null>(null);
  const [presenting, setPresenting] = useState(false);

  useEffect(() => {
    if (!engine || !walking) {
      setPrompt(null);
      return;
    }

    const tick = () => {
      setPrompt(engine.walkPrompt);
      setPresenting(engine.presenting);
    };

    tick();
    const timer = window.setInterval(tick, 160);
    return () => window.clearInterval(timer);
  }, [engine, walking]);

  if (!walking || presenting) return null;

  return (
    <div className="walkhud" aria-live="polite">
      {/* The crosshair is always drawn while walking, whether or not there is
          anything to reach for: it is what tells you where "here" is, and a
          reticle that appears only sometimes reads as a glitch. */}
      <div className={`walkhud__cross ${prompt ? 'walkhud__cross--live' : ''}`} />

      {prompt && (
        <div className="walkhud__prompt">
          {prompt.verb && <span className="walkhud__verb">{prompt.verb}</span>}
          <span className="walkhud__label">{prompt.label}</span>
        </div>
      )}
    </div>
  );
}

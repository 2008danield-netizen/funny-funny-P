/**
 * The full-size view of a plan, for the two jobs that need real precision.
 *
 * SETTING THE SCALE means clicking the two ends of something whose length you
 * know. STRAIGHTENING means clicking the four corners of a photographed sheet.
 * Both are pixel-accurate work, and both would be miserable done by picking in
 * the 3D view: the plan is small there, foreshortened, and behind whatever has
 * already been drawn.
 *
 * So this covers the viewport with the image at the largest size that fits, and
 * takes clicks in image coordinates. Nothing here touches the design; it hands
 * back the points it collected and the panel decides what they mean.
 */

import { useEffect, useRef, useState } from 'react';

import type { Point2 } from '@/state/types';

export type SetupMode = 'calibrate' | 'corners';

interface PlanSetupProps {
  dataUrl: string;
  mode: SetupMode;
  /** Called with the collected points, in image pixels. */
  onDone: (points: Point2[]) => void;
  onCancel: () => void;
}

const WANTED: Record<SetupMode, number> = { calibrate: 2, corners: 4 };

const INSTRUCTIONS: Record<SetupMode, { title: string; body: string }> = {
  calibrate: {
    title: 'Click the two ends of something you know the length of',
    body:
      'The longest thing you are sure about is the best one — an outside wall, or an overall dimension already printed on the plan. Two clicks are each worth a pixel or two, and that error is divided by the distance between them, so a long measurement is a far better one.',
  },
  corners: {
    title: 'Click the four corners of the sheet',
    body:
      'In any order. The photograph will be redrawn as though the camera had been square on to the paper — which is what makes the measurements taken off it mean anything.',
  },
};

export function PlanSetup({ dataUrl, mode, onDone, onCancel }: PlanSetupProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [points, setPoints] = useState<Point2[]>([]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const wanted = WANTED[mode];

  // Escape always gets you out. A modal you cannot leave with the keyboard is
  // a modal somebody will reload the page to escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const record = (event: React.MouseEvent<HTMLImageElement>) => {
    const element = imageRef.current;
    if (!element || !size) return;

    const box = element.getBoundingClientRect();
    // Displayed size to natural size: the click lands where it looks like it
    // lands however the image has been scaled to fit.
    const x = ((event.clientX - box.left) / box.width) * size.width;
    const z = ((event.clientY - box.top) / box.height) * size.height;

    const next = [...points, { x, z }];
    setPoints(next);
    if (next.length >= wanted) onDone(next);
  };

  const marks = points.map((point, index) => {
    if (!size) return null;
    return (
      <div
        key={index}
        className="plansetup__mark"
        style={{ left: `${(point.x / size.width) * 100}%`, top: `${(point.z / size.height) * 100}%` }}
      >
        {index + 1}
      </div>
    );
  });

  return (
    <div className="plansetup" role="dialog" aria-modal="true" aria-label={INSTRUCTIONS[mode].title}>
      <div className="plansetup__bar">
        <div>
          <strong>{INSTRUCTIONS[mode].title}</strong>
          <p>{INSTRUCTIONS[mode].body}</p>
        </div>
        <div className="plansetup__actions">
          <span className="plansetup__count">
            {points.length} of {wanted}
          </span>
          <button type="button" className="btn" onClick={() => setPoints([])} disabled={!points.length}>
            Start again
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <div className="plansetup__stage">
        <div className="plansetup__frame">
          <img
            ref={imageRef}
            src={dataUrl}
            alt="The floor plan being traced"
            onClick={record}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
          {marks}
          {points.length === 2 && mode === 'calibrate' && size && (
            <svg className="plansetup__line" viewBox={`0 0 ${size.width} ${size.height}`}>
              <line
                x1={points[0]!.x}
                y1={points[0]!.z}
                x2={points[1]!.x}
                y2={points[1]!.z}
                stroke="#e0a83c"
                strokeWidth={Math.max(2, size.width / 400)}
              />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

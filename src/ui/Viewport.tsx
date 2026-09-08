/**
 * The 3D viewport.
 *
 * React's only job here is to own a DOM node and the engine's lifetime.
 * Everything inside the canvas is driven by the engine, which reads the design
 * store directly — so this component never re-renders in response to a design
 * change, and dragging a colour picker costs zero React work.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Engine, type EngineStats } from '@/core/Engine';
import { VIEWPOINTS, type ViewpointId } from '@/controls/CameraController';

interface ViewportProps {
  /** Called with the engine once it is running, and with null on teardown. */
  onEngineReady: (engine: Engine | null) => void;
  /** Editing toolbar, overlaid on the canvas. */
  toolbar?: ReactNode;
}

export function Viewport({ onEngineReady, toolbar }: ViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);

  const [stats, setStats] = useState<EngineStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let engine: Engine;
    try {
      engine = new Engine(host);
    } catch (cause) {
      // The overwhelmingly likely cause is no WebGL support (old browser,
      // disabled hardware acceleration, or a locked-down VM).
      console.error('[havavamama] Engine failed to start:', cause);
      setError(
        'This browser could not start WebGL. Try a recent version of Chrome, ' +
          'Edge, Firefox or Safari with hardware acceleration enabled.',
      );
      return;
    }

    engine.setStatsHandler(setStats);
    engineRef.current = engine;
    onEngineReady(engine);

    return () => {
      // Full teardown on unmount. In development this also runs on every hot
      // reload, so anything less than complete disposal leaks a WebGL context.
      onEngineReady(null);
      engineRef.current = null;
      engine.dispose();
    };
  }, [onEngineReady]);

  const goTo = useCallback((viewpoint: ViewpointId) => {
    engineRef.current?.goToViewpoint(viewpoint);
  }, []);

  return (
    <div className="viewport">
      <div className="viewport__canvas-host" ref={hostRef} />

      {error ? (
        <div className="viewport__error">{error}</div>
      ) : (
        <>
          {toolbar}
          <div className="viewport__overlay">
            <div className="viewport__viewpoints">
              {VIEWPOINTS.map((viewpoint, index) => (
                <button
                  key={viewpoint.id}
                  type="button"
                  className="btn btn--ghost"
                  title={`${viewpoint.hint} (press ${index + 1})`}
                  onClick={() => goTo(viewpoint.id)}
                >
                  {viewpoint.label}
                </button>
              ))}
            </div>
            <div className="viewport__hint">
              Drag to orbit &middot; right-drag or two fingers to pan &middot;
              scroll to zoom
            </div>
          </div>

          {stats && (
            <div className="viewport__stats">
              <span>{stats.fps} fps</span>
              <span>{stats.drawCalls} draws</span>
              <span>{stats.triangles.toLocaleString()} tris</span>
              {/* What the progressive renderer is doing. "Refining" means it is
                  still accumulating samples; the number is how many. */}
              <span title="Progressive render quality">
                {stats.converged ? `${stats.samples} spp` : `refining ${stats.samples}`}
              </span>
              <span title="Quality tier">{stats.tier}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

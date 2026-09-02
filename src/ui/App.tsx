/**
 * Application shell.
 *
 * Owns the layout, the engine reference, and the wiring between UI panels that
 * need to talk to the 3D engine (screenshots, wall auto-hide, viewpoints).
 * Design state itself does not flow through here — panels read and write the
 * store directly, which keeps this component from re-rendering on every edit.
 */

import { useCallback, useRef, useState } from 'react';

import { Viewport } from './Viewport';
import { RoomPanel } from './panels/RoomPanel';
import { WallsPanel } from './panels/WallsPanel';
import { FloorPanel } from './panels/FloorPanel';
import { SurfacesPanel } from './panels/SurfacesPanel';
import { ViewPanel } from './panels/ViewPanel';
import { ProjectPanel } from './panels/ProjectPanel';
import { useAutosave } from '@/bridge/useAutosave';
import { useDesignEdit, useDesignSlice, useHistoryState } from '@/bridge/useDesign';
import { useKeyboardShortcuts } from '@/bridge/useKeyboardShortcuts';
import { designStore } from '@/state/store';
import type { Engine } from '@/core/Engine';
import type { ViewpointId } from '@/controls/CameraController';

export function App() {
  const engineRef = useRef<Engine | null>(null);
  // Mirrors the ref in state purely so panels re-render when the engine becomes
  // available and can enable controls that depend on it.
  const [engineReady, setEngineReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const name = useDesignSlice((doc) => doc.name);
  const edit = useDesignEdit();
  const { canUndo, canRedo } = useHistoryState();

  useAutosave();

  const handleEngineReady = useCallback((engine: Engine | null) => {
    engineRef.current = engine;
    setEngineReady(engine !== null);
  }, []);

  const goToViewpoint = useCallback((viewpoint: ViewpointId) => {
    engineRef.current?.goToViewpoint(viewpoint);
  }, []);

  useKeyboardShortcuts(goToViewpoint);

  const handleScreenshot = useCallback(
    () => engineRef.current?.captureScreenshot() ?? '',
    [],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__logo">
            havava<span>mama</span>
          </span>
          <span className="topbar__tag">Room Studio</span>
        </div>

        <input
          className="topbar__name"
          value={name}
          aria-label="Design name"
          onChange={(event) =>
            edit((draft) => {
              draft.name = event.target.value;
            }, { history: 'coalesce', coalesceKey: 'doc.name' })
          }
        />

        <div className="topbar__spacer" />

        <div className="topbar__group">
          <button
            type="button"
            className="btn btn--icon"
            title="Undo (Ctrl/⌘ + Z)"
            aria-label="Undo"
            disabled={!canUndo}
            onClick={() => designStore.undo()}
          >
            ↶
          </button>
          <button
            type="button"
            className="btn btn--icon"
            title="Redo (Ctrl/⌘ + Shift + Z)"
            aria-label="Redo"
            disabled={!canRedo}
            onClick={() => designStore.redo()}
          >
            ↷
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-expanded={sidebarOpen}
          >
            {sidebarOpen ? 'Hide panel' : 'Show panel'}
          </button>
        </div>
      </header>

      <div className={`app__body ${sidebarOpen ? '' : 'app__body--collapsed'}`}>
        <Viewport onEngineReady={handleEngineReady} />

        {sidebarOpen && (
          <aside className="sidebar">
            <RoomPanel />
            <WallsPanel />
            <FloorPanel />
            <SurfacesPanel />
            <ViewPanel
              onAutoHideWallsChange={(enabled) => engineRef.current?.setAutoHideWalls(enabled)}
            />
            <ProjectPanel onScreenshot={engineReady ? handleScreenshot : null} />
          </aside>
        )}
      </div>
    </div>
  );
}

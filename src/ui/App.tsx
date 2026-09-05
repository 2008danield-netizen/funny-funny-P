/**
 * Application shell.
 *
 * Owns the layout, the engine reference, and the wiring between UI panels that
 * need to talk to the 3D engine (screenshots, wall auto-hide, viewpoints, wall
 * splitting). Design state does not flow through here — panels read and write
 * the store directly, which keeps this component from re-rendering on every edit.
 */

import { useCallback, useRef, useState } from 'react';

import { Viewport } from './Viewport';
import { Toolbar } from './Toolbar';
import { PlanPanel } from './panels/PlanPanel';
import { StoreyPanel } from './panels/StoreyPanel';
import { RoofPanel } from './panels/RoofPanel';
import { TracePanel } from './panels/TracePanel';
import { SitePanel } from './panels/SitePanel';
import { ElectricalPanel } from './panels/ElectricalPanel';
import { FittingsPanel } from './panels/FittingsPanel';
import { PlumbingPanel } from './panels/PlumbingPanel';
import { DrawingsPanel } from './panels/DrawingsPanel';
import { CataloguePanel } from './panels/CataloguePanel';
import { AdvisorPanel } from './panels/AdvisorPanel';
import { IssuesPanel } from './panels/IssuesPanel';
import { ShoppingListPanel } from './panels/ShoppingListPanel';
import { InspectorPanel } from './panels/InspectorPanel';
import { LightingPanel } from './panels/LightingPanel';
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

  const handleSplitWall = useCallback(() => {
    engineRef.current?.splitSelectedWall();
  }, []);

  const handleRotate = useCallback((direction: number) => {
    engineRef.current?.rotateSelection(direction);
  }, []);

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
            title="Undo (Ctrl/Cmd + Z)"
            aria-label="Undo"
            disabled={!canUndo}
            onClick={() => designStore.undo()}
          >
            &#8630;
          </button>
          <button
            type="button"
            className="btn btn--icon"
            title="Redo (Ctrl/Cmd + Shift + Z)"
            aria-label="Redo"
            disabled={!canRedo}
            onClick={() => designStore.redo()}
          >
            &#8631;
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
        <Viewport onEngineReady={handleEngineReady} toolbar={<Toolbar />} />

        {sidebarOpen && (
          <aside className="sidebar">
            {/* The inspector sits at the top: in a direct-manipulation editor
                the selection is what the user is thinking about, so its
                properties should never require scrolling to reach. */}
            <InspectorPanel onSplitWall={handleSplitWall} onRotate={handleRotate} />
            {/* The advisor sits above the catalogue: it is the panel that tells
                you what to do next, and the catalogue is where you go to do it. */}
            <AdvisorPanel />
            <CataloguePanel />
            <IssuesPanel />
            <ShoppingListPanel />
            <StoreyPanel />
            <TracePanel />
            <RoofPanel />
            <SitePanel />
            <FittingsPanel />
            <ElectricalPanel />
            <PlumbingPanel />
            <DrawingsPanel />
            <PlanPanel />
            <LightingPanel />
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

/**
 * Application entry point.
 *
 * Restores any autosaved design before the first render so the user never sees
 * the default room flash past on their way to their own.
 */

import { createRoot } from 'react-dom/client';

import { App } from './ui/App';
import { loadAutosave } from './state/persistence';
import { designStore } from './state/store';
import './ui/theme.css';

const restored = loadAutosave();
if (restored) {
  // `hydrate` installs the document without creating a history entry: the
  // restored design is where this session starts, so there is nothing sensible
  // to undo back to.
  designStore.hydrate(restored);
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element — check index.html.');

/*
 * Deliberately NOT wrapped in <React.StrictMode>.
 *
 * StrictMode double-invokes effects in development, which would create, tear
 * down and recreate the WebGL engine — regenerating every procedural texture
 * twice on each hot reload. The engine's disposal is complete enough to survive
 * it, but the wasted work makes development noticeably slower for no benefit
 * that applies to a single imperative canvas host.
 */
createRoot(container).render(<App />);

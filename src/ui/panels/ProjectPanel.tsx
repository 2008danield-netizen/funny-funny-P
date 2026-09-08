/**
 * Project actions: export, import, reset and screenshot.
 *
 * The design autosaves continuously to this browser, so there is no "save"
 * button by design — the explicit actions here are the ones that move a design
 * in or out of the browser.
 */

import { useRef, useState } from 'react';

import { Panel } from '../components/Panel';
import { useDesign } from '@/bridge/useDesign';
import { clearAutosave, exportDocument, importDocument } from '@/state/persistence';
import { createDefaultDocument } from '@/state/defaults';
import { designStore } from '@/state/store';

interface ProjectPanelProps {
  /** Captures the current frame; supplied by the engine once it has mounted. */
  onScreenshot: (() => string) | null;
}

export function ProjectPanel({ onScreenshot }: ProjectPanelProps) {
  const doc = useDesign();
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  /** Shows a transient status line under the buttons. */
  const flash = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 3000);
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      designStore.replace(await importDocument(file));
      flash(`Loaded "${file.name}".`);
    } catch {
      // Covers unreadable files and invalid JSON alike; anything that parses
      // is repaired by the sanitiser rather than rejected.
      flash('That file could not be read as a havavamama design.');
    }
  };

  const handleScreenshot = () => {
    if (!onScreenshot) return;
    const link = document.createElement('a');
    link.href = onScreenshot();
    link.download = `${doc.name.replace(/\s+/g, '-').toLowerCase() || 'room'}.png`;
    link.click();
    flash('Screenshot saved.');
  };

  const handleReset = () => {
    // A confirm dialog is warranted: this is the one destructive action here,
    // and undo would not bring back a design the user had autosaved for weeks.
    if (!window.confirm('Discard this design and start from the default room?')) return;
    clearAutosave();
    designStore.replace(createDefaultDocument());
    flash('Reset to the default room.');
  };

  return (
    <Panel title="Project" defaultOpen={false}>
      <div className="button-row">
        <button
          type="button"
          className="btn"
          onClick={() => {
            // Exporting now reads the traced plan images out of the browser's
            // image store, which is asynchronous. Any failure is reported
            // rather than swallowed: a save the user thinks happened and did
            // not is the worst kind.
            void exportDocument(doc).catch((error: unknown) => {
              console.error('[havavamama] Export failed:', error);
              flash('That export did not finish. Nothing was saved.');
            });
          }}
        >
          Export
        </button>
        <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
          Import
        </button>
      </div>

      <div className="button-row">
        <button
          type="button"
          className="btn"
          onClick={handleScreenshot}
          disabled={!onScreenshot}
        >
          Save screenshot
        </button>
        <button type="button" className="btn btn--danger" onClick={handleReset}>
          Reset
        </button>
      </div>

      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          void handleImport(event.target.files?.[0]);
          // Clear the input so selecting the same file twice fires again.
          event.target.value = '';
        }}
      />

      {message && <p className="field__hint">{message}</p>}

      <p className="field__hint">
        Your design saves automatically to this browser. Export writes a
        <code> .havavamama.json </code> file you can back up or send to someone
        else — it is plain text and safe to keep in version control.
      </p>
    </Panel>
  );
}

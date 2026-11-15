import { useEffect, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';

const desktop = window.controlDeck;

export default function Titlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop?.onMaximizedChange) return undefined;
    return desktop.onMaximizedChange(setMaximized);
  }, []);

  return (
    <header className="titlebar" aria-label="Application title bar">
      <div className="titlebar__identity">
        <span className="titlebar__signal" aria-hidden="true" />
        <span className="titlebar__product">Control Deck</span>
        <span className="titlebar__slash" aria-hidden="true">
          /
        </span>
        <span className="titlebar__context">WARP Console</span>
      </div>

      <div className="titlebar__right">
        <span className="titlebar__mode">
          <span className="titlebar__mode-dot" aria-hidden="true" />
          Simulated backend
        </span>

        <div className="window-controls" role="group" aria-label="Window controls">
          <button
            className="window-control"
            type="button"
            aria-label="Minimize window"
            title="Minimize"
            disabled={!desktop}
            onClick={() => desktop?.minimize()}
          >
            <Minus size={13} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            className="window-control"
            type="button"
            aria-label={maximized ? 'Restore window' : 'Maximize window'}
            title={maximized ? 'Restore' : 'Maximize'}
            disabled={!desktop}
            onClick={() => desktop?.toggleMaximize()}
          >
            <Square size={10.5} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            className="window-control window-control--close"
            type="button"
            aria-label="Close window"
            title="Close"
            disabled={!desktop}
            onClick={() => desktop?.close()}
          >
            <X size={14} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}

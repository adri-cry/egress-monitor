import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, ScrollText } from 'lucide-react';
import { TAB_META } from '../data/seed';

export default function LogViewer({ logs, activeTab, onTabChange, onCopy }) {
  const [copied, setCopied] = useState(false);
  const terminalRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const baseId = useId();
  const activeEntries = logs[activeTab] ?? [];
  const activeMeta = TAB_META.find((tab) => tab.id === activeTab) ?? TAB_META[0];

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return undefined;

    const frame = window.requestAnimationFrame(() => {
      terminal.scrollTop = terminal.scrollHeight;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, activeEntries.length]);

  useEffect(() => {
    setCopied(false);
  }, [activeTab]);

  useEffect(
    () => () => {
      window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    if (activeEntries.length === 0) return;

    const success = await onCopy();
    if (!success) return;

    setCopied(true);
    window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
  };

  const handleTabKeyDown = (event, index) => {
    const lastIndex = TAB_META.length - 1;
    let nextIndex = null;

    if (event.key === 'ArrowRight') nextIndex = index === lastIndex ? 0 : index + 1;
    if (event.key === 'ArrowLeft') nextIndex = index === 0 ? lastIndex : index - 1;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = lastIndex;

    if (nextIndex === null) return;
    event.preventDefault();

    const tablist = event.currentTarget.closest('[role="tablist"]');
    const buttons = tablist?.querySelectorAll('[role="tab"]');
    onTabChange(TAB_META[nextIndex].id);
    window.requestAnimationFrame(() => buttons?.[nextIndex]?.focus());
  };

  return (
    <section className="panel log-panel" aria-labelledby="log-viewer-title">
      <header className="panel-heading log-panel__heading">
        <div className="panel-heading__main">
          <span className="panel-heading__icon" aria-hidden="true">
            <ScrollText size={14} strokeWidth={1.9} />
          </span>
          <h2 className="panel-heading__title" id="log-viewer-title">
            LOG VIEWER
          </h2>
        </div>
        <span className="live-tail">
          <span className="signal-dot is-live" aria-hidden="true" />
          LIVE TAIL
        </span>
      </header>

      <div className="log-toolbar">
        <div className="log-tabs" role="tablist" aria-label="Log sources">
          {TAB_META.map((tab, index) => {
            const selected = tab.id === activeTab;
            const count = logs[tab.id]?.length ?? 0;

            return (
              <button
                className="log-tab"
                type="button"
                role="tab"
                key={tab.id}
                id={`${baseId}-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span>{tab.label}</span>
                <span className="log-tab__count" aria-hidden="true">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <button
          className={`copy-button ${copied ? 'is-copied' : ''}`}
          type="button"
          onClick={handleCopy}
          disabled={activeEntries.length === 0}
          title="Copy the active log to clipboard"
        >
          {copied ? (
            <Check size={12.5} strokeWidth={2.2} aria-hidden="true" />
          ) : (
            <Copy size={12.5} strokeWidth={1.9} aria-hidden="true" />
          )}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      <div
        className="log-terminal"
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        tabIndex={0}
      >
        <div
          className="log-terminal__entries"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={`${activeMeta.label} entries`}
        >
          {activeEntries.length === 0 ? (
            <p className="log-empty">No entries recorded for this source yet.</p>
          ) : (
            activeEntries.map((entry) => (
              <div className={`log-line log-line--${entry.level}`} key={entry.id}>
                <span className="log-line__time">{entry.time}</span>
                <span className="log-line__text">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <footer className="log-footer">
        <span className="log-footer__mode">TAIL -F</span>
        <span className="log-footer__path" title={activeMeta.path}>
          {activeMeta.path}
        </span>
        <span className="log-footer__count">
          {activeEntries.length} {activeEntries.length === 1 ? 'ENTRY' : 'ENTRIES'}
        </span>
      </footer>
    </section>
  );
}

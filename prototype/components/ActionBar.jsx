import {
  ArrowUpRight,
  MonitorUp,
  Power,
  RefreshCw,
  SquareTerminal,
} from 'lucide-react';

export default function ActionBar({
  connected,
  onLaunchDesktop,
  onLaunchCli,
  onRotate,
  onToggleConnection,
}) {
  return (
    <nav className="action-bar" aria-label="Primary control actions">
      <button
        className="action-button action-button--outline"
        type="button"
        onClick={onLaunchDesktop}
      >
        <span className="action-button__icon" aria-hidden="true">
          <MonitorUp size={16} strokeWidth={1.8} />
        </span>
        <span className="action-button__label">Launch Client Desktop</span>
        <ArrowUpRight
          className="action-button__end"
          size={14}
          strokeWidth={1.7}
          aria-hidden="true"
        />
      </button>

      <button className="action-button action-button--outline" type="button" onClick={onLaunchCli}>
        <span className="action-button__icon" aria-hidden="true">
          <SquareTerminal size={16} strokeWidth={1.8} />
        </span>
        <span className="action-button__label">Launch Client CLI</span>
        <ArrowUpRight
          className="action-button__end"
          size={14}
          strokeWidth={1.7}
          aria-hidden="true"
        />
      </button>

      <button
        className="action-button action-button--primary"
        type="button"
        onClick={onRotate}
        disabled={!connected}
        aria-label="Rotate IPv6 /64 now (Hop)"
        title={connected ? 'Rotate to a fresh /64' : 'Reconnect WARP before hopping'}
      >
        <span className="action-button__icon action-button__icon--primary" aria-hidden="true">
          <RefreshCw size={16} strokeWidth={2.1} />
        </span>
        <span className="action-button__label">Rotate /64 Now</span>
        <span className="keycap" aria-hidden="true">
          HOP
        </span>
      </button>

      <button
        className={`action-button ${connected ? 'action-button--ghost' : 'action-button--reconnect'}`}
        type="button"
        onClick={onToggleConnection}
      >
        <span className="action-button__icon" aria-hidden="true">
          <Power size={16} strokeWidth={1.8} />
        </span>
        <span className="action-button__label">
          {connected ? 'Disconnect WARP' : 'Reconnect WARP'}
        </span>
      </button>
    </nav>
  );
}

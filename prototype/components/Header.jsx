import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';

export default function Header({ connected, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const spinTimerRef = useRef(null);

  useEffect(
    () => () => {
      window.clearTimeout(spinTimerRef.current);
    },
    [],
  );

  const handleRefresh = () => {
    if (refreshing) return;

    setRefreshing(true);
    onRefresh();
    spinTimerRef.current = window.setTimeout(() => setRefreshing(false), 700);
  };

  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <span>A</span>
          <i className="brand-mark__sheen" />
        </div>

        <div className="brand-copy">
          <div className="brand-title-row">
            <h1 className="brand-title">CONTROL DECK</h1>
            <span className="maker-badge">
              <span className="maker-badge__dash" aria-hidden="true" />
              MADE BY AVATAR
            </span>
          </div>
          <p
            className="brand-subtitle"
            aria-label="WARP IPv6 /64 Rotator • Cloudflare Edge Pinner • Fail-Closed Windows Lane"
          >
            <span>WARP IPv6 /64 Rotator</span>
            <span className="brand-subtitle__dot" aria-hidden="true">
              •
            </span>
            <span>Cloudflare Edge Pinner</span>
            <span className="brand-subtitle__dot" aria-hidden="true">
              •
            </span>
            <span>Fail-Closed Windows Lane</span>
          </p>
        </div>
      </div>

      <div className="header-actions">
        <div
          className={`protection-pill ${connected ? 'is-protected' : 'is-offline'}`}
          role="status"
          aria-live="polite"
        >
          <span className="protection-pill__halo" aria-hidden="true" />
          <span className="protection-pill__icon" aria-hidden="true">
            <ShieldCheck size={14} strokeWidth={2} />
          </span>
          <span className="protection-pill__strong">{connected ? 'PROTECTED' : 'OFFLINE'}</span>
          <span className="protection-pill__dot" aria-hidden="true">
            •
          </span>
          <span className="protection-pill__detail">
            {connected ? 'WARP IPv6' : 'NO TUNNEL'}
          </span>
        </div>

        <button
          className={`refresh-button ${refreshing ? 'is-refreshing' : ''}`}
          type="button"
          onClick={handleRefresh}
          aria-label="Refresh control-plane state"
        >
          <RefreshCw size={13.5} strokeWidth={1.9} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>
    </header>
  );
}

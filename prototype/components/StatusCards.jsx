import { useId } from 'react';
import { Check, ChevronDown, Globe2, Lock, RefreshCw, WifiOff } from 'lucide-react';
import { EDGE_OPTIONS } from '../data/seed';

function Tag({ tone = 'neutral', children, icon = null }) {
  return (
    <span className={`card-tag card-tag--${tone}`}>
      {icon}
      {children}
    </span>
  );
}

export default function StatusCards({
  snapshot,
  connected,
  onEdgeSelect,
  onReRollEdge,
}) {
  const edgeSelectId = useId();

  return (
    <section className="status-grid" aria-label="WARP status overview">
      <article className={`status-card status-card--public ${connected ? '' : 'is-offline'}`}>
        <div className="status-card__head">
          <h2 className="status-card__label">PUBLIC WARP /64</h2>
          <Tag tone={connected ? 'green' : 'neutral'} icon={<Check size={9} strokeWidth={2.4} />}>
            {connected ? 'CF VERIFIED' : 'LAST KNOWN'}
          </Tag>
        </div>
        <p className="status-card__address" title={snapshot.publicBlock}>
          {snapshot.publicBlock}
        </p>
        <p className="status-card__subaddress" title={snapshot.publicHost}>
          {snapshot.publicHost}
        </p>
        <div className={`card-fact ${connected ? '' : 'is-muted'}`}>
          <span className={`signal-dot ${connected ? 'is-live' : 'is-down'}`} aria-hidden="true" />
          {connected ? 'Cloudflare anycast · AS13335' : 'Tunnel offline · last known block'}
        </div>
      </article>

      <article className="status-card status-card--adapter">
        <div className="status-card__head">
          <h2 className="status-card__label">WARP ADAPTER IP</h2>
          <Tag tone="blue">WARP</Tag>
        </div>
        <p className="status-card__address" title={snapshot.adapterIp}>
          {snapshot.adapterIp}
        </p>
        <div className="adapter-meta">
          <span className="adapter-meta__key">TUN</span>
          <span className="adapter-meta__line" aria-hidden="true" />
          <span className="adapter-meta__value">warp0</span>
        </div>
        <div className={`card-fact ${connected ? 'is-positive' : 'is-muted'}`}>
          {connected ? (
            <Lock size={11} strokeWidth={2} aria-hidden="true" />
          ) : (
            <WifiOff size={11} strokeWidth={2} aria-hidden="true" />
          )}
          {connected ? 'Socket-bound fail-closed' : 'Tunnel detached · fail-closed'}
        </div>
      </article>

      <article className="status-card status-card--edge">
        <div className="status-card__head">
          <h2 className="status-card__label">PINNED EDGE (AAAA)</h2>
          <button
            className="card-tag card-tag--neutral card-tag-button"
            type="button"
            onClick={onReRollEdge}
            aria-label="Re-roll pinned Cloudflare edge"
            title="Re-roll pinned edge"
          >
            Re-roll
            <RefreshCw size={9} strokeWidth={2.1} aria-hidden="true" />
          </button>
        </div>
        <p className="status-card__address" title={snapshot.edge}>
          {snapshot.edge}
        </p>
        <p className="status-card__subaddress status-card__subaddress--faint">
          Anycast ingress · AAAA verified
        </p>
        <div className="edge-select">
          <Globe2 size={12} strokeWidth={1.8} aria-hidden="true" />
          <label className="sr-only" htmlFor={edgeSelectId}>
            Pinned edge policy
          </label>
          <select
            id={edgeSelectId}
            value={snapshot.edgePolicy === 'auto' ? 'auto' : snapshot.edge}
            onChange={(event) => onEdgeSelect(event.target.value)}
          >
            {EDGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown
            className="edge-select__chevron"
            size={12}
            strokeWidth={2}
            aria-hidden="true"
          />
        </div>
      </article>

      <article className="status-card status-card--stats">
        <div className="status-card__head">
          <h2 className="status-card__label">STATS &amp; SAVED WORK</h2>
          <Tag tone="green">{snapshot.hops} HOPS</Tag>
        </div>
        <p className="stats-inline">
          <span>
            <strong>{snapshot.projects}</strong> projects
          </span>
          <span className="stats-inline__dot" aria-hidden="true">
            •
          </span>
          <span>
            <strong>{snapshot.chats}</strong> chats
          </span>
        </p>
        <p className="stats-subline">
          <span>
            <strong>{snapshot.blacklisted}</strong> blacklisted /64s
          </span>
          <span className="stats-subline__dot" aria-hidden="true">
            •
          </span>
          <span>
            Last hop: <strong>{snapshot.lastHop}</strong>
          </span>
        </p>
        <div className="stats-track" aria-hidden="true">
          <span className="stats-track__fill" style={{ width: `${Math.min(snapshot.hops, 25) * 4}%` }} />
        </div>
        <div className="card-fact">
          <span className="signal-dot is-live" aria-hidden="true" />
          Work state saved locally · session stable
        </div>
      </article>
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  Copy,
  Gauge,
  Globe,
  Loader2,
  Minus,
  Monitor,
  Orbit,
  Power,
  Radio,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useDeck } from './useDeck';

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

const TAB_META = [
  { id: 'guard', label: 'Guard Log' },
  { id: 'keeper', label: 'Keeper Log' },
  { id: 'app', label: 'App Log' },
];

const STATUS_META = {
  protected: { label: 'PROTECTED · WARP EGRESS', tone: 'mint', Icon: ShieldCheck },
  leaked: { label: 'LEAK DETECTED · EGRESS EXPOSED', tone: 'fault', Icon: ShieldAlert },
  rotating: { label: 'ROTATING · NEXT /64', tone: 'blue', Icon: RotateCw, spin: true },
  degraded: { label: 'DEGRADED · EGRESS UNVERIFIED', tone: 'amber', Icon: ShieldAlert },
  disconnected: { label: 'OFFLINE · TUNNEL DOWN', tone: 'fault', Icon: ShieldOff },
  idle: { label: 'STANDBY · NOT CONNECTED', tone: 'muted', Icon: ShieldOff },
  'engine-missing': { label: 'ENGINE MISSING', tone: 'amber', Icon: AlertTriangle },
  'pool-empty': { label: 'CONFIG POOL EMPTY', tone: 'amber', Icon: AlertTriangle },
  fault: { label: 'FAULT · CHECK LOG', tone: 'fault', Icon: AlertTriangle },
  boot: { label: 'BOOTING · LOCAL ENGINE', tone: 'blue', Icon: Loader2, spin: true },
};

const PILL_TONES = {
  mint: 'border-mint/45 bg-mint/10 text-mint-bright glow-pill',
  blue: 'border-blue/45 bg-blue/10 text-blue-bright',
  amber: 'border-amber/45 bg-amber/10 text-amber',
  fault: 'border-fault/45 bg-fault/10 text-fault',
  muted: 'border-line bg-white/[.02] text-ink-3',
};

const CHIP_TONES = {
  mint: 'border-mint/40 bg-mint/10 text-mint',
  blue: 'border-blue/40 bg-blue/10 text-blue-bright',
  amber: 'border-amber/40 bg-amber/10 text-amber',
  fault: 'border-fault/40 bg-fault/10 text-fault',
  muted: 'border-line bg-white/[.02] text-ink-4',
};

const LEVEL_TONES = {
  success: 'text-mint-bright',
  warn: 'text-amber',
  error: 'text-fault',
  info: 'text-ink-2',
};

const pad = (value) => String(value).padStart(2, '0');

function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function timeAgo(iso, now) {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function uptime(startedAt, now) {
  if (!startedAt) return '—';
  const seconds = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs) return `${hrs}h ${pad(mins)}m`;
  if (mins) return `${mins}m ${pad(secs)}s`;
  return `${secs}s`;
}

function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/* -------------------------------------------------------------------------- */
/* primitives                                                                 */
/* -------------------------------------------------------------------------- */

function Chip({ children, tone = 'muted' }) {
  return (
    <span
      className={`rounded-[3px] border px-1.5 py-[3px] font-mono text-[8.5px] uppercase tracking-[0.12em] ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

function Dot({ tone = 'mint', pulse = false }) {
  const colors = {
    mint: 'bg-mint',
    blue: 'bg-blue',
    amber: 'bg-amber',
    fault: 'bg-fault',
    muted: 'bg-ink-4',
  };
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${colors[tone] || colors.mint} ${
        pulse ? 'live-dot' : ''
      }`}
    />
  );
}

function WindowButton({ label, onClick, children, danger = false }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-7 w-9 place-items-center rounded-[4px] text-ink-4 transition-colors hover:bg-white/[.06] ${
        danger ? 'hover:text-fault' : 'hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function Titlebar({ desktop }) {
  const bridge = typeof window !== 'undefined' ? window.deck : null;

  return (
    <div className="drag flex h-9 shrink-0 items-center justify-between border-b border-line/70 bg-deep/80 pl-4 pr-1 backdrop-blur">
      <div className="flex items-center gap-2 font-mono text-[8.5px] uppercase tracking-[0.2em] text-ink-4">
        <Dot pulse />
        <span className="text-ink-2">EGRESS MONITOR</span>
        <span className="text-ink-4/50">/</span>
        <span>WARP CONSOLE</span>
      </div>
      <div className="no-drag flex items-center gap-1">
        <span className="mr-2 font-mono text-[8px] uppercase tracking-[0.16em] text-ink-4">
          {desktop ? 'LOCAL ENGINE' : 'BROWSER PREVIEW'}
        </span>
        <WindowButton label="Minimize" onClick={() => bridge?.window?.minimize()}>
          <Minus className="h-3.5 w-3.5" strokeWidth={2} />
        </WindowButton>
        <WindowButton label="Maximize" onClick={() => bridge?.window?.toggleMaximize()}>
          <Square className="h-3 w-3" strokeWidth={2} />
        </WindowButton>
        <WindowButton label="Close" danger onClick={() => bridge?.window?.close()}>
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </WindowButton>
      </div>
    </div>
  );
}

function StatusPill({ status, connected, family }) {
  const meta = STATUS_META[status] || STATUS_META.idle;
  // The protocol comes from the measured egress, never from a hardcoded label:
  // WARP hands out IPv4 as often as IPv6, and the pill must not claim otherwise.
  const protocol = family === 'ipv6' ? 'IPv6' : family === 'ipv4' ? 'IPv4' : 'EGRESS';
  const label =
    connected && status === 'protected'
      ? `PROTECTED · WARP ${protocol}`
      : meta.label;
  const Icon = meta.Icon;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex h-10 items-center gap-2.5 rounded-full border px-3.5 font-mono text-[9.5px] uppercase tracking-[0.14em] ${PILL_TONES[meta.tone]}`}
    >
      <Icon className={`h-3.5 w-3.5 ${meta.spin ? 'spin-slow' : ''}`} strokeWidth={2} />
      <span className="whitespace-nowrap">{label}</span>
      <Dot tone={meta.tone} pulse={meta.tone === 'mint'} />
    </div>
  );
}

function MetricCard({ label, chip, tone = 'muted', children, footer }) {
  return (
    <section className="panel flex min-h-[158px] flex-col px-3.5 pb-2.5 pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-ink-4">
          {label}
        </span>
        {chip ? <Chip tone={tone}>{chip}</Chip> : null}
      </div>
      <div className="mt-3 flex-1">{children}</div>
      {footer ? (
        <div className="mt-2 flex items-center gap-1.5 border-t border-white/[0.055] pt-2 text-[9.5px] leading-tight text-ink-3">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

function ActionButton({ icon: Icon, label, sub, onClick, busy, disabled, accent = 'blue' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`panel group flex h-12 items-center gap-2.5 px-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        accent === 'fault' ? 'hover:border-fault/45' : 'hover:border-blue/45 hover:bg-raised/80'
      }`}
    >
      <span
        className={`grid h-7 w-7 place-items-center rounded-[5px] border ${
          accent === 'fault'
            ? 'border-fault/30 bg-fault/10 text-fault'
            : 'border-blue/25 bg-blue/10 text-blue-bright'
        }`}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 spin-slow" strokeWidth={2} />
        ) : (
          <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-semibold text-ink">{label}</span>
        {sub ? (
          <span className="mt-[1px] block truncate font-mono text-[8.5px] uppercase tracking-[0.09em] text-ink-4">
            {sub}
          </span>
        ) : null}
      </span>
      <ArrowUpRight
        className={`h-3.5 w-3.5 shrink-0 transition-colors ${
          accent === 'fault' ? 'text-ink-4 group-hover:text-fault/80' : 'text-ink-4 group-hover:text-blue-bright'
        }`}
        strokeWidth={1.8}
      />
    </button>
  );
}

function ToggleRow({ icon: Icon, title, description, tag, enabled, onToggle, disabled }) {
  return (
    <div
      role="presentation"
      onClick={() => !disabled && onToggle(!enabled)}
      className="flex min-h-[76px] flex-1 cursor-pointer items-center gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.018]"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] border border-line/90 bg-white/[0.02] text-blue">
        <Icon className="h-4 w-4" strokeWidth={1.8} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-semibold text-ink">{title}</span>
          {tag ? <Chip tone={enabled ? 'mint' : 'muted'}>{tag}</Chip> : null}
        </div>
        <p className="mt-0.5 text-[10px] leading-snug text-ink-3">{description}</p>
      </div>

      <span
        className={`w-6 text-right font-mono text-[8.5px] uppercase tracking-[0.1em] ${
          enabled ? 'text-mint' : 'text-ink-4'
        }`}
      >
        {enabled ? 'ON' : 'OFF'}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={title}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(!enabled);
        }}
        className="switch disabled:opacity-40"
        data-on={enabled ? 'true' : 'false'}
      />
    </div>
  );
}

function LogViewer({ logs, paths, activeTab, onTabChange, onCopy, onClear, clearing, onOpenLogs }) {
  const listRef = useRef(null);
  const [stick, setStick] = useState(true);
  const entries = logs[activeTab] || [];

  useEffect(() => {
    if (!stick) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, activeTab, stick]);

  const handleScroll = (event) => {
    const node = event.currentTarget;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    setStick(atBottom);
  };

  const pathForTab = {
    guard: paths.guardLog,
    keeper: paths.keeperLog,
    app: paths.appLog,
  }[activeTab];

  return (
    <section className="panel flex min-h-[430px] flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-3">
          <Terminal className="h-3.5 w-3.5 text-blue" strokeWidth={1.8} />
          LOG VIEWER
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-mint/30 bg-mint/[0.07] px-2 py-[3px] font-mono text-[8px] uppercase tracking-[0.14em] text-mint">
            <Dot pulse tone="mint" />
            LIVE TAIL
          </span>
          <button
            type="button"
            onClick={onCopy}
            className="flex h-7 items-center gap-1.5 rounded-[5px] border border-line bg-white/[0.02] px-2 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-2 transition-colors hover:border-blue/40 hover:text-ink"
          >
            <Copy className="h-3 w-3" strokeWidth={1.9} />
            Copy
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={clearing || !entries.length}
            className="flex h-7 items-center gap-1.5 rounded-[5px] border border-line bg-white/[0.02] px-2 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-2 transition-colors hover:border-fault/40 hover:text-fault disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" strokeWidth={1.9} />
            {clearing ? 'Clearing…' : 'Clear'}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-white/[0.05] px-2" role="tablist">
        {TAB_META.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`relative px-3 py-2.5 font-mono text-[9.5px] tracking-[0.04em] transition-colors ${
                active ? 'text-ink-strong' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {tab.label}
              <span className={`ml-1.5 text-[8.5px] ${active ? 'text-mint' : 'text-ink-4'}`}>
                {(logs[tab.id] || []).length}
              </span>
              {active ? (
                <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-mint" />
              ) : null}
            </button>
          );
        })}
        <span className="ml-auto pr-2 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-4">
          {stick ? 'TAILING' : 'SCROLL PAUSED'}
        </span>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="log-scroll min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono text-[10.5px]"
      >
        {entries.length ? (
          entries.map((entry) => (
              <div key={entry.id} className="grid grid-cols-[84px_1fr] gap-2.5 py-[2px] leading-[1.55]">
              <span className="whitespace-nowrap text-ink-4/80 tabular">{entry.t}</span>
              <span className={`${LEVEL_TONES[entry.level] || LEVEL_TONES.info} break-words`}>
                {entry.text}
              </span>
            </div>
          ))
        ) : (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-1.5 text-center">
            <Terminal className="h-5 w-5 text-ink-4/50" strokeWidth={1.5} />
            <p className="text-[10px] text-ink-4">Waiting for engine and guard events…</p>
            <p className="text-[9px] text-ink-4/70">
              Lines appear here the moment the proxy or guard writes them.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-2">
        <span className="truncate font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-4">
          TAIL · {pathForTab || '—'}
        </span>
        <button
          type="button"
          onClick={onOpenLogs}
          className="shrink-0 font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-4 transition-colors hover:text-blue-bright"
        >
          OPEN FOLDER
        </button>
        <span className="shrink-0 font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-4">
          {entries.length} ENTRIES
        </span>
      </div>
    </section>
  );
}

function Toast({ toast, onDismiss }) {
  const tone = toast.tone || 'success';
  const meta = {
    success: { className: 'border-mint/40 text-mint', Icon: Check },
    info: { className: 'border-blue/40 text-blue-bright', Icon: Gauge },
    warn: { className: 'border-amber/40 text-amber', Icon: AlertTriangle },
    error: { className: 'border-fault/40 text-fault', Icon: AlertTriangle },
  }[tone] || { className: 'border-line text-ink-2', Icon: Gauge };

  const Icon = meta.Icon;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`panel fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-2.5 border px-3.5 py-3 text-[11px] shadow-2xl ${meta.className}`}
    >
      <Icon className="mt-[1px] h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <span className="flex-1 leading-snug text-ink">{toast.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="text-ink-4 transition-colors hover:text-ink"
      >
        <X className="h-3 w-3" strokeWidth={2} />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* app                                                                        */
/* -------------------------------------------------------------------------- */

export default function App() {
  const deck = useDeck();
  const {
    state,
    logs,
    phase,
    busy,
    toast,
    dismissToast,
    rotate,
    selectConfig,
    clearLogs,
    connect,
    disconnect,
    refresh,
    launch,
    setToggle,
    choosePoolDir,
    copyText,
    activeLogText,
    notify,
  } = deck;

  const [tab, setTab] = useState('guard');
  const now = useNow();
  const desktop = typeof window !== 'undefined' && Boolean(window.deck);
  const { egress, engine, proxy, pool, edge, adapter, stats, toggles, guard } = state;
  const edgeFamily =
    edge.family || (edge.pinned?.includes(':') ? 'ipv6' : edge.pinned ? 'ipv4' : null);
  const edgeLabel = edgeFamily === 'ipv6' ? 'AAAA' : edgeFamily === 'ipv4' ? 'A' : 'DNS';
  const egressOk = Boolean(egress.verified && egress.fresh !== false);

  useEffect(() => {
    const handler = (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'r') {
        event.preventDefault();
        setTab('guard');
        rotate();
      } else if (key === '1') {
        setTab('guard');
      } else if (key === '2') {
        setTab('keeper');
      } else if (key === '3') {
        setTab('app');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [rotate]);

  const lastTrigger = state.guard.lastTriggerAt;
  useEffect(() => {
    if (lastTrigger) setTab('guard');
  }, [lastTrigger]);

  const handleRotate = useCallback(() => {
    setTab('guard');
    rotate();
  }, [rotate]);

  const handleConnection = useCallback(() => {
    if (state.connected) disconnect();
    else connect();
  }, [state.connected, connect, disconnect]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(activeLogText(tab));
    const label = TAB_META.find((item) => item.id === tab)?.label || 'Log';
    notify(ok ? `${label} copied` : 'Clipboard access was blocked', ok ? 'success' : 'warn');
  }, [activeLogText, copyText, notify, tab]);

  const handleClear = useCallback(async () => {
    const label = TAB_META.find((item) => item.id === tab)?.label || 'Log';
    if (!window.confirm(`Clear ${label}? This removes the file contents.`)) return;
    const result = await clearLogs(tab);
    notify(
      result?.ok === false ? result.message || 'Clear failed' : `${label} cleared`,
      result?.ok === false ? 'error' : 'success',
    );
  }, [clearLogs, notify, tab]);

  const activeToggles = useMemo(
    () => Object.values(toggles || {}).filter(Boolean).length,
    [toggles],
  );

  const connectionLabel = state.connected
    ? 'Disconnect'
    : state.status === 'disconnected'
      ? 'Reconnect WARP'
      : 'Connect WARP';

  const connected = state.connected;
  const publicValue = egress.block64 || egress.ip || '—';
  const publicHint = egress.block64
    ? egress.ip
    : egress.ip
      ? 'IPv4 egress · no IPv6 /64 observed'
      : 'awaiting egress probe';

  return (
    <div className="deck-bg flex h-screen flex-col overflow-hidden">
      <Titlebar desktop={desktop} />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-3.5 px-5 py-4">
          {phase === 'bridge-missing' ? (
            <div className="flex items-center gap-2 rounded-md border border-amber/35 bg-amber/[0.06] px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-amber">
              <AlertTriangle className="h-3.5 w-3.5" />
              Browser preview — IPC bridge unavailable. Start the desktop shell with npm run dev.
            </div>
          ) : null}

          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-full border border-blue/40 bg-blue/15 shadow-[0_0_26px_-6px_rgba(75,151,255,0.8)]">
                <Orbit className="h-5 w-5 text-blue-bright" strokeWidth={1.7} />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-[21px] font-bold leading-none tracking-[0.16em] text-ink-strong">
                    EGRESS MONITOR
                  </h1>
                  <span className="rounded-[3px] border border-line bg-white/[0.02] px-1.5 py-[3px] font-mono text-[8px] uppercase tracking-[0.16em] text-ink-4">
                    WARP /64 ROTATOR
                  </span>
                </div>
                <p className="mt-1.5 text-[10.5px] text-ink-3">
                  WireGuard pool · sing-box proxy 127.0.0.1:41987 · log-triggered rotation
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <span className="hidden font-mono text-[9px] uppercase tracking-[0.14em] text-ink-4 sm:inline">
                {clock(new Date(now))}
              </span>
              <StatusPill status={state.status} connected={connected} family={egress.family} />
              <button
                type="button"
                onClick={refresh}
                disabled={busy === 'refresh'}
                className="panel flex h-10 items-center gap-2 px-3.5 text-[11px] font-medium text-ink-2 transition-colors hover:border-blue/45 hover:text-ink disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${busy === 'refresh' ? 'spin-slow' : ''}`}
                  strokeWidth={1.9}
                />
                Refresh
              </button>
            </div>
          </header>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <ActionButton
              icon={Monitor}
              label="Launch App"
              sub="Desktop client · proxy env"
              busy={busy === 'launch:desktop'}
              onClick={() => launch('desktop')}
            />
            <ActionButton
              icon={Terminal}
              label="Launch CLI"
              sub="Shell with HTTP(S)_PROXY"
              busy={busy === 'launch:cli'}
              onClick={() => launch('cli')}
            />
            <button
              type="button"
              onClick={handleRotate}
              disabled={!pool.total || state.rotating || Boolean(busy)}
              className="glow-mint flex h-12 items-center gap-2.5 rounded-[8px] bg-mint px-3.5 text-left text-[#04150d] transition-transform active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
            >
              <span className="grid h-7 w-7 place-items-center rounded-[5px] border border-[#04150d]/20 bg-[#04150d]/10">
                {state.rotating || busy === 'rotate' ? (
                  <Loader2 className="h-3.5 w-3.5 spin-slow" strokeWidth={2.2} />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" strokeWidth={2.2} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-bold tracking-[0.01em]">
                  Rotate /64 Now
                </span>
                <span className="mt-[1px] block truncate font-mono text-[8.5px] uppercase tracking-[0.09em] text-[#04150d]/70">
                  {pool.currentFile ? `next after ${pool.currentFile}` : 'no active config'}
                </span>
              </span>
              <kbd className="rounded-[3px] border border-[#04150d]/25 px-1.5 py-[2px] font-mono text-[8px] font-semibold tracking-[0.12em]">
                HOP
              </kbd>
            </button>
            <ActionButton
              icon={Power}
              label={connectionLabel}
              sub={connected ? 'Stop engine · fail closed' : 'Start sing-box engine'}
              accent={connected ? 'fault' : 'blue'}
              busy={busy === 'connect' || busy === 'disconnect'}
              onClick={handleConnection}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="PUBLIC EGRESS /64"
              chip={
                egressOk ? (egress.leaked ? 'LEAK CHECK FAILED' : 'CF VERIFIED') : 'UNVERIFIED'
              }
              tone={egress.leaked ? 'fault' : egressOk ? 'mint' : 'muted'}
              footer={
                <>
                  <Dot
                    tone={egress.leaked ? 'fault' : egressOk ? 'mint' : 'amber'}
                    pulse={egressOk && !egress.leaked}
                  />
                  <span className="truncate">
                    {egress.error
                      ? egress.error
                      : egress.verified && !egressOk
                        ? `Verification stale · ${timeAgo(egress.checkedAt, now)}`
                        : egressOk
                          ? `Probe via SOCKS5 · ${timeAgo(egress.checkedAt, now)}`
                          : 'Waiting for first probe'}
                  </span>
                </>
              }
            >
              <div
                className={`break-all font-mono text-[16.5px] font-medium leading-tight tracking-[-0.03em] ${
                  egressOk ? 'text-ink-strong' : 'text-ink-3'
                }`}
              >
                {publicValue}
              </div>
              <div className="mt-1.5 truncate font-mono text-[10px] text-ink-3">{publicHint}</div>
              <div className="mt-2 flex items-center gap-1.5">
                <Chip tone="muted">AS13335</Chip>
                <span className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-4">
                  {egress.directIp ? `direct ${egress.directIp}` : 'egress isolated'}
                </span>
              </div>
            </MetricCard>

            <MetricCard
              label="PROXY ADAPTER STATUS"
              chip={engine.state === 'running' ? 'ENGINE UP' : 'ENGINE DOWN'}
              tone={engine.state === 'running' ? 'mint' : 'amber'}
              footer={
                <>
                  <Dot tone={proxy.listening ? 'mint' : 'fault'} pulse={proxy.listening} />
                  <span className="truncate">
                    {adapter.ipv6 || adapter.ipv4 || 'no adapter bound'}
                    {engine.pid ? ` · pid ${engine.pid}` : ''}
                  </span>
                </>
              }
            >
              <div className="font-mono text-[16.5px] leading-tight tracking-[-0.03em] text-ink-strong">
                {proxy.host}:{proxy.port}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 truncate font-mono text-[10px] text-ink-3">
                <span className="uppercase tracking-[0.08em]">MIXED</span>
                <span className="text-ink-4/60">·</span>
                <span>{engine.format || 'no format'}</span>
                <span className="text-ink-4/60">·</span>
                <span>{engine.version ? `v${engine.version}` : 'sing-box'}</span>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <Chip tone={proxy.listening ? 'mint' : 'muted'}>
                  {proxy.listening ? 'SOCKS5 OK' : 'NO LISTENER'}
                </Chip>
                <span className="truncate font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-4">
                  {pool.currentFile || 'no config'}
                </span>
              </div>
            </MetricCard>

            <MetricCard
              label={`PINNED EDGE (${edgeLabel})`}
              chip={edgeLabel}
              tone={edge.pinned ? 'blue' : 'amber'}
              footer={
                <>
                  <Globe className="h-3 w-3 shrink-0 text-ink-4" strokeWidth={1.8} />
                  <span className="truncate">
                    {edge.host} ·{' '}
                    {edge.resolvedAt ? `resolved ${timeAgo(edge.resolvedAt, now)}` : 'unresolved'}
                  </span>
                </>
              }
            >
              <div className="break-all font-mono text-[14.5px] leading-snug tracking-[-0.03em] text-ink-strong">
                {edge.pinned || '—'}
              </div>
              <div className="mt-1.5 truncate font-mono text-[10px] text-ink-3">
                AAAA {edge.aaaa || '—'} · A {edge.a || '—'}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <Chip tone={edge.pinned ? 'mint' : 'amber'}>
                  {edge.pinned ? 'PINNED' : 'NOT PINNED'}
                </Chip>
                <span className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-4">
                  prefer {edge.prefer || 'ipv4'}
                </span>
              </div>
            </MetricCard>

            <MetricCard
              label="STATS & SAVED WORK"
              chip={`${stats.hops} HOPS`}
              tone="mint"
              footer={
                <>
                  <Dot tone={guard.watching ? 'mint' : 'muted'} pulse={guard.watching} />
                  <span className="truncate">
                    {guard.watching ? 'guard armed' : 'guard disarmed'} · {stats.blacklisted} retired /64
                  </span>
                </>
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[26px] leading-none tracking-[-0.04em] text-mint">
                      {stats.hops}
                    </span>
                    <span className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-ink-4">
                      hops
                    </span>
                  </div>
                  <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-4">
                    {engine.startedAt ? `up ${uptime(engine.startedAt, now)}` : 'engine idle'}
                  </div>
                </div>
                <div className="space-y-1 text-right">
                  <div className="flex items-baseline justify-end gap-1.5">
                    <span className="font-mono text-[12px] text-ink-2">
                      {stats.projects ?? '—'}
                    </span>
                    <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4">
                      projects
                    </span>
                  </div>
                  <div className="flex items-baseline justify-end gap-1.5">
                    <span className="font-mono text-[12px] text-ink-2">{stats.chats ?? '—'}</span>
                    <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4">
                      chats
                    </span>
                  </div>
                  <div className="flex items-baseline justify-end gap-1.5">
                    <span className="font-mono text-[12px] text-ink-2">{stats.triggers}</span>
                    <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-4">
                      triggers
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-white/[0.05]">
                <div
                  className="h-full rounded-full bg-mint/70 transition-all"
                  style={{
                    width: `${
                      pool.total ? ((Math.max(pool.index, 0) + 1) / pool.total) * 100 : 0
                    }%`,
                  }}
                />
              </div>
            </MetricCard>
          </div>

          <div className="grid flex-1 gap-3.5 xl:grid-cols-[1.16fr_1fr]">
            <section className="panel flex flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-3">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-blue" strokeWidth={1.8} />
                  PROTECTION &amp; SERVICE CONTROLS
                </div>
                <span className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-mint">
                  {activeToggles} OF 4 ACTIVE
                </span>
              </div>

              <div className="flex flex-1 flex-col divide-y divide-white/[0.05]">
                <ToggleRow
                  icon={Activity}
                  title="Proxy Keeper"
                  description="Supervises sing-box and restarts the engine whenever :41987 stops listening."
                  tag={state.keeper.running ? 'SUPERVISING' : 'PAUSED'}
                  enabled={Boolean(toggles.keeper)}
                  onToggle={(next) => setToggle('keeper', next)}
                />
                <ToggleRow
                  icon={Radio}
                  title="Log Guard"
                  description="Watches client.log with chokidar; a QuotaExceeded line hops to the next /64."
                  tag={guard.watching ? 'WATCHING' : 'DISARMED'}
                  enabled={Boolean(toggles.logGuard)}
                  onToggle={(next) => setToggle('logGuard', next)}
                />
                <ToggleRow
                  icon={Monitor}
                  title="Desktop App Proxy"
                  description="Injects HTTP_PROXY, HTTPS_PROXY and ALL_PROXY into clients launched here."
                  enabled={Boolean(toggles.desktopProxy)}
                  onToggle={(next) => setToggle('desktopProxy', next)}
                />
                <ToggleRow
                  icon={Power}
                  title="Auto-Start"
                  description="Registers the console as a Windows sign-in item for the operator account."
                  tag={toggles.autoStart ? 'ENABLED' : ''}
                  enabled={Boolean(toggles.autoStart)}
                  onToggle={(next) => setToggle('autoStart', next)}
                />
              </div>

              <div className="border-t border-white/[0.06] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-ink-4">
                    CONFIG POOL · {pool.total}
                  </span>
                  <button
                    type="button"
                    onClick={choosePoolDir}
                    className="font-mono text-[8px] uppercase tracking-[0.08em] text-ink-4 transition-colors hover:text-blue-bright"
                  >
                    CHANGE FOLDER
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  {pool.entries.length ? (
                    pool.entries.slice(0, 8).map((entry) => {
                      const active = entry.name === pool.currentFile;
                      const pending = busy === `select:${entry.name}`;
                      return (
                        <button
                          key={entry.name}
                          type="button"
                          onClick={() => selectConfig(entry.name)}
                          disabled={active || Boolean(busy) || state.rotating}
                          title={
                            active
                              ? `${entry.name} is active`
                              : `Switch engine to ${entry.name}`
                          }
                          className={`flex items-center gap-1.5 rounded-[4px] border px-2 py-1.5 text-left font-mono text-[9px] transition-colors disabled:cursor-not-allowed ${
                            active
                              ? 'border-mint/35 bg-mint/[0.06] text-mint'
                              : 'border-line/70 bg-white/[0.015] text-ink-3 enabled:hover:border-blue/40 enabled:hover:text-ink-2'
                          }`}
                        >
                          <Dot tone={active ? 'mint' : 'muted'} />
                          <span className="truncate">{entry.name}</span>
                          {active ? (
                            <Check className="ml-auto h-3 w-3 shrink-0 text-mint" strokeWidth={2.2} />
                          ) : pending ? (
                            <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin" strokeWidth={2.2} />
                          ) : null}
                        </button>
                      );
                    })
                  ) : (
                    <p className="col-span-2 font-mono text-[9px] text-amber">
                      No .conf files — drop WARP configs into the pool folder.
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/[0.06] px-4 py-2.5 font-mono text-[8px] uppercase tracking-[0.08em]">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-ink-4">guard cooldown</span>
                  <span className="text-ink-2">
                    {Math.round((guard.cooldownMs || 0) / 1000)}s
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="text-ink-4">keeper poll</span>
                  <span className="text-ink-2">
                    {Math.round((state.keeper.intervalMs || 0) / 1000)}s
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="text-ink-4">pool position</span>
                  <span className="text-ink-2">
                    {pool.index >= 0 ? pool.index + 1 : '—'}/{pool.total || '—'}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="text-ink-4">inbound</span>
                  <span className="text-ink-2">SOCKS5 · {proxy.port}</span>
                </span>
              </div>

              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-2.5 font-mono text-[8.5px] uppercase tracking-[0.08em] text-ink-4">
                <span className="flex items-center gap-1.5">
                  <Dot tone={connected ? 'mint' : 'fault'} />
                  {connected ? 'fail-closed lane online' : 'fail-closed lane offline'}
                </span>
                <span>pool {pool.total} configs</span>
                <span>
                  {state.keeper.lastBeatAt
                    ? `beat ${timeAgo(state.keeper.lastBeatAt, now)}`
                    : 'no keeper beat'}
                </span>
              </div>
            </section>

            <LogViewer
              logs={logs}
              paths={state.paths}
              activeTab={tab}
              onTabChange={setTab}
              onCopy={handleCopy}
              onClear={handleClear}
              clearing={busy === `clear:${tab}`}
              onOpenLogs={() => window.deck?.openLogs()}
            />
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1 pt-0.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-ink-4">
            <div className="flex items-center gap-2">
              <span className="text-ink-3">OCU</span>
              <span>FAIL-CLOSED LOCAL LANE</span>
              <span className="text-ink-4/50">/</span>
              <span className={connected ? 'text-mint' : 'text-fault'}>
                {connected ? 'TUNNEL ACTIVE' : 'TUNNEL OFFLINE'}
              </span>
              <span className="text-ink-4/50">/</span>
              <span>{engine.state}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="max-w-[360px] truncate normal-case tracking-normal"
                title={state.paths.pool}
              >
                {state.paths.pool || 'pool path pending'}
              </span>
              <span className="text-ink-4/50">·</span>
              <span
                className="max-w-[300px] truncate normal-case tracking-normal"
                title={state.paths.clientLog}
              >
                {state.paths.clientLog || 'client.log pending'}
              </span>
            </div>
          </footer>
        </main>
      </div>

      {toast ? <Toast key={toast.id} toast={toast} onDismiss={dismissToast} /> : null}

      {state.lastError ? (
        <div className="flex items-center justify-center gap-2 border-t border-fault/30 bg-fault/[0.07] px-4 py-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-fault">
          <AlertTriangle className="h-3 w-3" />
          {state.lastError}
        </div>
      ) : null}
    </div>
  );
}

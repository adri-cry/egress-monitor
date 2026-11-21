import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_STATE = {
  status: 'boot',
  connected: false,
  rotating: false,
  engine: {
    state: 'stopped',
    pid: null,
    format: null,
    startedAt: null,
    version: null,
    error: null,
  },
  proxy: { host: '127.0.0.1', port: 41987, listening: false },
  pool: { dir: '', entries: [], errors: [], total: 0, currentFile: null, index: -1 },
  egress: {
    ip: null,
    family: null,
    block64: null,
    subnet64: null,
    verified: false,
    fresh: false,
    leaked: false,
    directIp: null,
    checkedAt: null,
    error: null,
  },
  adapter: { name: null, ipv4: null, ipv6: null, mtu: null, dns: [], fingerprint: null },
  edge: {
    host: 'engage.cloudflareclient.com',
    aaaa: null,
    a: null,
    pinned: null,
    family: null,
    prefer: 'ipv4',
    resolvedAt: null,
    error: null,
  },
  stats: {
    hops: 0,
    triggers: 0,
    blacklisted: 0,
    projects: null,
    chats: null,
    configs: 0,
  },
  toggles: { keeper: true, logGuard: true, desktopProxy: true, autoStart: false },
  guard: { watching: false, path: '', lastTriggerAt: null, cooldownUntil: null, triggers: 0 },
  usage: {
    enabled: true,
    reachable: false,
    checkedAt: null,
    error: null,
    requests: 0,
    today: 0,
    cap: 200,
    ratio: 0,
    warnRatio: 0.8,
    hopRatio: 0.9,
    resetAt: null,
    preemptiveHop: true,
    anyBusy: false,
    sessions: 0,
    busySessions: 0,
    idleStreak: 0,
    lastHopAt: null,
    history: [],
  },
  keeper: { running: false, lastBeatAt: null, failures: 0, intervalMs: 10000 },
  paths: { home: '', pool: '', logs: '', clientLog: '', guardLog: '', keeperLog: '', appLog: '' },
  lastError: null,
};

const EMPTY_LOGS = { guard: [], keeper: [], app: [] };
const LOG_LIMIT = 400;

export function useDeck() {
  const bridge = typeof window !== 'undefined' ? window.deck : null;

  const [state, setState] = useState(EMPTY_STATE);
  const [logs, setLogs] = useState(EMPTY_LOGS);
  const [phase, setPhase] = useState(bridge ? 'loading' : 'bridge-missing');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const mounted = useRef(true);

  const notify = useCallback((message, tone = 'success') => {
    window.clearTimeout(toastTimer.current);
    setToast({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      message,
      tone,
    });
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const dismissToast = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(toastTimer.current);
    };
  }, []);

  const mergeEntries = useCallback((tab, entries) => {
    if (!entries?.length) return;
    setLogs((current) => {
      const existing = new Set((current[tab] || []).map((entry) => entry.id));
      const fresh = entries.filter((entry) => entry && !existing.has(entry.id));
      if (!fresh.length) return current;
      return {
        ...current,
        [tab]: [...(current[tab] || []), ...fresh].slice(-LOG_LIMIT),
      };
    });
  }, []);

  useEffect(() => {
    if (!bridge) return undefined;

    let cancelled = false;

    bridge
      .getState()
      .then((payload) => {
        if (cancelled || !payload) return;
        setState((current) => ({ ...current, ...payload.state }));
        if (payload.logs) setLogs({ ...EMPTY_LOGS, ...payload.logs });
        setPhase('ready');
      })
      .catch((error) => {
        if (cancelled) return;
        setPhase('error');
        notify(`State load failed: ${error.message}`, 'error');
      });

    const offState = bridge.onState?.((next) => {
      if (cancelled || !next) return;
      setState((current) => ({ ...current, ...next }));
      setPhase('ready');
    });

    const offLog = bridge.onLog?.((payload) => {
      if (cancelled || !payload?.tab) return;
      mergeEntries(payload.tab, [payload.entry]);
    });

    return () => {
      cancelled = true;
      offState?.();
      offLog?.();
    };
  }, [bridge, mergeEntries, notify]);

  const run = useCallback(
    async (key, action) => {
      if (!bridge) {
        notify('Desktop bridge unavailable — launch with npm run dev.', 'warn');
        return { ok: false, message: 'bridge unavailable' };
      }

      setBusy(key);
      try {
        const result = await action();
        if (result?.message) {
          notify(result.message, result.ok === false ? 'error' : 'success');
        }
        return result ?? { ok: true };
      } catch (error) {
        notify(error.message || 'Action failed', 'error');
        return { ok: false, message: error.message };
      } finally {
        if (mounted.current) setBusy('');
      }
    },
    [bridge, notify],
  );

  const rotate = useCallback(() => run('rotate', () => bridge.rotate()), [bridge, run]);
  const selectConfig = useCallback(
    (name) => run(`select:${name}`, () => bridge.selectConfig(name)),
    [bridge, run],
  );
  const connect = useCallback(() => run('connect', () => bridge.connect()), [bridge, run]);
  const disconnect = useCallback(() => run('disconnect', () => bridge.disconnect()), [bridge, run]);
  const refresh = useCallback(() => run('refresh', () => bridge.refresh()), [bridge, run]);
  const launch = useCallback(
    (kind) => run(`launch:${kind}`, () => bridge.launch(kind)),
    [bridge, run],
  );
  const choosePoolDir = useCallback(
    () => run('pool', () => bridge.choosePoolDir()),
    [bridge, run],
  );
  const chooseClientLog = useCallback(
    () => run('clientLog', () => bridge.chooseClientLog()),
    [bridge, run],
  );

  const setToggle = useCallback(
    (id, enabled) => {
      setState((current) => ({
        ...current,
        toggles: { ...current.toggles, [id]: enabled },
      }));
      return run(`toggle:${id}`, () => bridge.setToggle(id, enabled));
    },
    [bridge, run],
  );

  const setUsageOptions = useCallback(
    (patch) => run('usage:options', () => bridge.setUsageOptions(patch)),
    [bridge, run],
  );

  const copyText = useCallback(
    async (text) => {
      if (bridge?.copyText) {
        try {
          await bridge.copyText(text);
          return true;
        } catch {
          /* fall through to the browser clipboard */
        }
      }
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          /* clipboard denied */
        }
      }
      return false;
    },
    [bridge],
  );

  const activeLogText = useCallback(
    (tab) =>
      (logs[tab] || []).map((entry) => `${entry.t} ${entry.text}`).join('\n'),
    [logs],
  );

  const clearLogs = useCallback(
    async (tab) => {
      const result = await run(`clear:${tab}`, () => bridge.clearLogs(tab));
      if (result?.ok !== false) {
        setLogs((current) => ({ ...current, [tab]: [] }));
      }
      return result;
    },
    [bridge, run],
  );

  return {
    state,
    logs,
    phase,
    busy,
    toast,
    notify,
    dismissToast,
    rotate,
    selectConfig,
    clearLogs,
    connect,
    disconnect,
    refresh,
    launch,
    setToggle,
    setUsageOptions,
    choosePoolDir,
    chooseClientLog,
    copyText,
    activeLogText,
  };
}

export { EMPTY_STATE };

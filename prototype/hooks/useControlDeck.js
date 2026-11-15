import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TAB_META,
  buildNextRotation,
  clockNow,
  nextEdgeAfter,
  seedLogs,
  seedSnapshot,
  seedToggles,
  stampNow,
} from '../data/seed';

let logSequence = 0;
const createLogId = () => `log-${Date.now()}-${(logSequence += 1)}`;

export function useControlDeck() {
  const [snapshot, setSnapshot] = useState(seedSnapshot);
  const [toggles, setToggles] = useState(seedToggles);
  const [logs, setLogs] = useState(seedLogs);
  const [activeTab, setActiveTab] = useState('guard');
  const [toast, setToast] = useState(null);

  const snapshotRef = useRef(seedSnapshot);
  const togglesRef = useRef(seedToggles);
  const rotationIndexRef = useRef(0);
  const toastTimerRef = useRef(null);

  const notify = useCallback((message, tone = 'success') => {
    window.clearTimeout(toastTimerRef.current);
    setToast({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      message,
      tone,
    });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  const dismissToast = useCallback(() => {
    window.clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const appendEntries = useCallback((entries) => {
    setLogs((current) => {
      const next = { ...current };

      for (const entry of entries) {
        next[entry.tab] = [
          ...next[entry.tab],
          {
            id: createLogId(),
            time: entry.time,
            level: entry.level,
            text: entry.text,
          },
        ].slice(-200);
      }

      return next;
    });
  }, []);

  const applySnapshot = useCallback((next) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const rotateNow = useCallback(() => {
    const previous = snapshotRef.current;

    if (!previous.connected) {
      notify('WARP is offline. Reconnect before hopping.', 'warn');
      return false;
    }

    const index = rotationIndexRef.current;
    rotationIndexRef.current += 1;

    const rotation = buildNextRotation(index, previous.edgePolicy, previous.edge);
    const at = stampNow();
    const next = {
      ...previous,
      publicBlock: rotation.publicBlock,
      publicHost: rotation.host,
      adapterIp: rotation.adapter,
      edge: rotation.edge,
      hops: previous.hops + 1,
      blacklisted: previous.blacklisted + 1,
      lastHop: clockNow(),
    };

    applySnapshot(next);
    setActiveTab('guard');
    appendEntries([
      {
        tab: 'guard',
        time: at,
        level: 'success',
        text: `rotated #${next.hops}: ${previous.publicHost} -> ${next.publicHost} /64`,
      },
      {
        tab: 'blacklist',
        time: at,
        level: 'warn',
        text: `${previous.publicBlock} · blocked · quota 429 ×3`,
      },
    ]);
    notify(`Hop ${next.hops} complete · fresh /64 active`, 'success');
    return true;
  }, [appendEntries, applySnapshot, notify]);

  const toggleControl = useCallback(
    (id) => {
      const control = togglesRef.current.find((item) => item.id === id);
      if (!control) return;

      const enabled = !control.enabled;
      const nextToggles = togglesRef.current.map((item) =>
        item.id === id ? { ...item, enabled } : item,
      );
      const at = stampNow();

      togglesRef.current = nextToggles;
      setToggles(nextToggles);
      setActiveTab(control.tab);

      let message = `${control.title} ${enabled ? 'enabled' : 'disabled'}`;

      if (id === 'zenGuard') {
        message = enabled
          ? 'Zen Guard enabled · watching client.log (poll 10s, cooldown 75s)'
          : 'Zen Guard disabled';
      } else if (id === 'warpKeeper') {
        message = enabled
          ? 'WARP Keeper enabled · TUN mode enforced'
          : 'WARP Keeper disabled · TUN enforcement released';
      } else if (id === 'desktopProxy') {
        message = enabled
          ? 'Desktop App Proxy wired · service.json → 127.0.0.1:41987'
          : 'Desktop App Proxy unwired · service.json restored';
      } else if (id === 'firewall') {
        message = enabled
          ? 'Firewall Kill-Switch armed · direct non-WARP CU egress blocked (UAC)'
          : 'Firewall Kill-Switch disarmed';
      } else if (id === 'strictHosts') {
        message = enabled
          ? 'Strict All-Hosts WARP enabled · non-allowlisted domains fail-closed'
          : 'Strict All-Hosts WARP disabled';
      } else if (id === 'logonAutoStart') {
        message = enabled
          ? 'Logon Auto-Start enabled · Keeper + Guard scheduled tasks registered'
          : 'Logon Auto-Start disabled';
      }

      appendEntries([
        {
          tab: control.tab,
          time: at,
          level: enabled ? 'success' : 'warn',
          text: message,
        },
      ]);
      notify(`${control.title} ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'success' : 'info');
    },
    [appendEntries, notify],
  );

  const setEdgePolicy = useCallback(
    (selection) => {
      const previous = snapshotRef.current;
      const at = stampNow();

      if (selection === 'auto') {
        const edge = nextEdgeAfter(previous.edge);
        applySnapshot({ ...previous, edge, edgePolicy: 'auto' });
        setActiveTab('keeper');
        appendEntries([
          {
            tab: 'keeper',
            time: at,
            level: 'info',
            text: `edge policy auto-random · pinned ${edge} · AAAA verified`,
          },
        ]);
        notify('Edge policy set to auto-random', 'info');
        return;
      }

      applySnapshot({ ...previous, edge: selection, edgePolicy: selection });
      setActiveTab('keeper');
      appendEntries([
        {
          tab: 'keeper',
          time: at,
          level: 'success',
          text: `edge pinned: ${selection} · AAAA handshake ok`,
        },
      ]);
      notify(`Pinned edge ${selection}`, 'success');
    },
    [appendEntries, applySnapshot, notify],
  );

  const reRollEdge = useCallback(() => {
    const previous = snapshotRef.current;
    const edge = nextEdgeAfter(previous.edge);
    const edgePolicy = previous.edgePolicy === 'auto' ? 'auto' : edge;

    applySnapshot({ ...previous, edge, edgePolicy });
    setActiveTab('keeper');
    appendEntries([
      {
        tab: 'keeper',
        time: stampNow(),
        level: 'success',
        text: `edge re-rolled · ${previous.edge} -> ${edge} · socket bind verified`,
      },
    ]);
    notify(
      previous.edgePolicy === 'auto'
        ? 'Edge re-rolled · socket bound'
        : 'Pinned edge re-rolled · socket bound',
      'success',
    );
  }, [appendEntries, applySnapshot, notify]);

  const launchClient = useCallback(
    (target) => {
      const isDesktop = target === 'desktop';
      appendEntries([
        {
          tab: 'client',
          time: stampNow(),
          level: 'success',
          text: isDesktop
            ? 'launch request · Client.exe → 127.0.0.1:41987 (simulated)'
            : 'launch request · client CLI → 127.0.0.1:41987 (simulated)',
        },
      ]);
      setActiveTab('client');
      notify(
        `${isDesktop ? 'Client Desktop' : 'Client CLI'} launch simulated · proxy :41987`,
        'info',
      );
    },
    [appendEntries, notify],
  );

  const toggleConnection = useCallback(() => {
    const previous = snapshotRef.current;
    const at = stampNow();

    if (previous.connected) {
      applySnapshot({ ...previous, connected: false });
      setActiveTab('keeper');
      appendEntries([
        {
          tab: 'keeper',
          time: at,
          level: 'warn',
          text: 'WARP disconnected by operator · TUN adapter removed (simulated)',
        },
        {
          tab: 'guard',
          time: at,
          level: 'warn',
          text: 'egress lane offline · rotator paused, fail-closed',
        },
      ]);
      notify('WARP disconnected · simulated TUN teardown', 'warn');
      return;
    }

    applySnapshot({ ...previous, connected: true });
    setActiveTab('keeper');
    appendEntries([
      {
        tab: 'keeper',
        time: at,
        level: 'success',
        text: 'WARP reconnected · TUN adapter restored, socket pool rebound (simulated)',
      },
      {
        tab: 'guard',
        time: at,
        level: 'success',
        text: 'guard resumed · fail-closed lane online',
      },
    ]);
    notify('WARP reconnected · protected lane restored', 'success');
  }, [appendEntries, applySnapshot, notify]);

  const refresh = useCallback(() => {
    appendEntries([
      {
        tab: activeTab,
        time: stampNow(),
        level: 'info',
        text: 'control surface refreshed · keeper heartbeat ok · rtt 21ms',
      },
    ]);
    notify('Control surface refreshed', 'info');
  }, [activeTab, appendEntries, notify]);

  const copyActiveLog = useCallback(async () => {
    const entries = logs[activeTab] ?? [];
    const meta = TAB_META.find((tab) => tab.id === activeTab);
    const content = entries.map((entry) => `${entry.time} ${entry.text}`).join('\n');

    const copyWithBrowserApi = async () => {
      if (window.controlDeck?.copyText) {
        try {
          await window.controlDeck.copyText(content);
          return true;
        } catch {
          // Fall through to the next available clipboard path.
        }
      }

      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(content);
          return true;
        } catch {
          // Fall through to the legacy path when the Clipboard API is denied.
        }
      }

      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();

      try {
        return document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    };

    try {
      const copied = await copyWithBrowserApi();
      if (!copied) throw new Error('Clipboard write rejected');

      notify(`${meta?.label ?? 'Log'} copied · ${entries.length} entries`, 'success');
      return true;
    } catch {
      notify('Clipboard access was blocked by the host.', 'warn');
      return false;
    }
  }, [activeTab, logs, notify]);

  return {
    snapshot,
    toggles,
    logs,
    activeTab,
    activeEntries: logs[activeTab] ?? [],
    toast,
    setActiveTab,
    rotateNow,
    toggleControl,
    setEdgePolicy,
    reRollEdge,
    launchClient,
    toggleConnection,
    refresh,
    copyActiveLog,
    dismissToast,
  };
}

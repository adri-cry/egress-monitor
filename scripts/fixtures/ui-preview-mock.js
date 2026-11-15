/* UI preview bridge — injects a static demo state for headless screenshots. */
(() => {
  const stamp = (date) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(
      date.getMinutes(),
    )}:${p(date.getSeconds())}`;
  };
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const listeners = new Set();
  let seq = 0;
  const entry = (msAgo, level, text) => ({
    id: `demo-${(seq += 1)}`,
    t: stamp(new Date(Date.now() - msAgo)),
    iso: ago(msAgo),
    level,
    text,
  });

  const logs = {
    guard: [
      entry(590000, 'info', 'rotated #13: 2a09:bac5:3a1c:3c43::/64 -> 2a09:bac5:3a1c:1e0b::/64'),
      entry(588000, 'success', 'edge pinned: 2606:4700:d0::a29f:c001 · AAAA handshake ok'),
      entry(250000, 'info', 'log-guard armed · watching client.log'),
      entry(240000, 'warn', 'QuotaExceeded detected in client.log · upstream denied request (429)'),
      entry(238000, 'success', 'log-guard detected trigger -> rotating to config_04.conf -> success.'),
      entry(237000, 'info', 'hop #14 · 2a09:bac5:3a1c:1e0b::/64 -> 2a09:bac5:3a1c:25c3::/64 · 1180ms'),
      entry(236000, 'warn', '2a09:bac5:3a1c:1e0b::/64 retired · added to rotation blacklist'),
      entry(9000, 'info', 'log-guard cooldown clear · next quota line will hop'),
    ],
    keeper: [
      entry(280000, 'info', 'keeper restart -> config_04.conf'),
      entry(279000, 'success', 'engine ready · config_04.conf · endpoints format · pid 21984'),
      entry(278000, 'success', 'tunnel up · config_04.conf · 842ms · proxy 127.0.0.1:41987'),
      entry(60000, 'info', 'heartbeat ok · engine running · proxy reachable · pid 21984'),
      entry(4000, 'info', 'heartbeat ok · engine running · proxy reachable · pid 21984'),
    ],
    app: [
      entry(300000, 'info', 'console home C:\\ProgramData\\egress-monitor'),
      entry(299000, 'info', 'proxy target 127.0.0.1:41987'),
      entry(296000, 'success', 'pool scanned · 4 config(s) in C:\\ProgramData\\egress-monitor\\warp-configs'),
      entry(295000, 'success', 'edge pinned · engage.cloudflareclient.com · AAAA 2606:4700:d0::a29f:c001'),
      entry(12000, 'info', 'console refreshed · pool 4 · engine running'),
    ],
  };

  const state = {
    status: 'protected',
    connected: true,
    rotating: false,
    engine: {
      state: 'running',
      command: 'C:\\ProgramData\\egress-monitor\\engine\\sing-box.exe',
      pid: 21984,
      format: 'endpoints',
      startedAt: ago(278000),
      version: '1.12.4',
      error: null,
    },
    proxy: { host: '127.0.0.1', port: 41987, listening: true },
    pool: {
      dir: 'C:\\ProgramData\\egress-monitor\\warp-configs',
      total: 4,
      currentFile: 'config_04.conf',
      index: 3,
      entries: [
        { name: 'config_01.conf', ipv4: '172.16.0.2', ipv6: '2606:4700:110:8d3e:8f2a:4b1c:9d3e:1001' },
        { name: 'config_02.conf', ipv4: '172.16.0.3', ipv6: '2606:4700:110:8d3e:8f2a:4b1c:9d3e:1002' },
        { name: 'config_03.conf', ipv4: '172.16.0.4', ipv6: '2606:4700:110:8d3e:8f2a:4b1c:9d3e:1003' },
        { name: 'config_04.conf', ipv4: '172.16.0.5', ipv6: '2606:4700:110:8d3e:8f2a:4b1c:9d3e:1004' },
      ],
      errors: [],
    },
    egress: {
      ip: '2a09:bac5:3a1c:25c3:7f2a:91be:33c1:4d20',
      family: 'ipv6',
      block64: '2a09:bac5:3a1c:25c3::/64',
      subnet64: '2a09:bac5:3a1c:25c3',
      verified: true,
      leaked: false,
      directIp: '103.28.14.77',
      checkedAt: ago(12000),
      error: null,
    },
    adapter: {
      name: 'config_04.conf',
      ipv4: '172.16.0.5',
      ipv6: '2606:4700:110:8d3e:8f2a:4b1c:9d3e:1004',
      mtu: 1280,
      dns: ['1.1.1.1', '1.0.0.1'],
      fingerprint: '9f2ac1d3be77',
    },
    edge: {
      host: 'engage.cloudflareclient.com',
      aaaa: '2606:4700:d0::a29f:c001',
      a: '162.159.192.1',
      resolvedAt: ago(295000),
      error: null,
    },
    stats: { hops: 14, triggers: 3, blacklisted: 14, projects: 12, chats: 76, configs: 4 },
    toggles: { keeper: true, logGuard: true, desktopProxy: true, autoStart: false },
    guard: {
      watching: true,
      path: 'C:\\ProgramData\\egress-monitor\\logs\\client.log',
      lastTriggerAt: ago(238000),
      cooldownUntil: null,
      cooldownMs: 75000,
      triggers: 3,
    },
    keeper: { running: true, lastBeatAt: ago(4000), failures: 0, intervalMs: 10000 },
    paths: {
      home: 'C:\\ProgramData\\egress-monitor',
      pool: 'C:\\ProgramData\\egress-monitor\\warp-configs',
      logs: 'C:\\ProgramData\\egress-monitor\\logs',
      clientLog: 'C:\\ProgramData\\egress-monitor\\logs\\client.log',
      guardLog: 'C:\\ProgramData\\egress-monitor\\logs\\guard.log',
      keeperLog: 'C:\\ProgramData\\egress-monitor\\logs\\keeper.log',
      appLog: 'C:\\ProgramData\\egress-monitor\\logs\\app.log',
    },
    lastError: null,
  };

  const emit = () => listeners.forEach((listener) => listener({ ...state }));
  const notify = (message, tone) => ({ ok: true, message, tone });

  window.deck = {
    isDesktop: true,
    getState: async () => ({ state: { ...state }, logs }),
    onState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLog: () => () => {},
    refresh: async () => notify('Console refreshed.'),
    rotate: async () => {
      state.rotating = true;
      state.status = 'rotating';
      emit();
      await new Promise((resolve) => setTimeout(resolve, 650));
      state.rotating = false;
      state.stats.hops += 1;
      state.pool.currentFile = 'config_01.conf';
      state.pool.index = 0;
      state.egress.block64 = '2a09:bac5:3a1c:9d10::/64';
      state.egress.ip = '2a09:bac5:3a1c:9d10:4c2e:aa19:7b3d:0011';
      state.egress.checkedAt = new Date().toISOString();
      state.engine.startedAt = new Date().toISOString();
      state.status = 'protected';
      const now = stamp(new Date());
      logs.guard.push(
        { id: `demo-${(seq += 1)}`, t: now, level: 'success', text: 'operator hop -> rotating to config_01.conf -> success.' },
        { id: `demo-${(seq += 1)}`, t: now, level: 'info', text: `hop #${state.stats.hops} · 2a09:bac5:3a1c:25c3::/64 -> ${state.egress.block64} · 1180ms` },
      );
      emit();
      return notify(`Hop #${state.stats.hops} complete · config_01.conf`);
    },
    connect: async () => notify('Tunnel up.'),
    disconnect: async () => {
      state.connected = false;
      state.status = 'disconnected';
      state.proxy.listening = false;
      emit();
      return notify('Tunnel disconnected.');
    },
    setToggle: async (id, enabled) => {
      state.toggles[id] = enabled;
      if (id === 'keeper') state.keeper.running = enabled;
      if (id === 'logGuard') state.guard.watching = enabled;
      emit();
      return notify(`${id} ${enabled ? 'enabled' : 'disabled'}`);
    },
    launch: async (kind) => notify(`${kind === 'desktop' ? 'Client Desktop' : 'Client CLI'} launched via :41987.`),
    choosePoolDir: async () => notify('Pool selection is disabled in preview.', 'warn'),
    chooseClientLog: async () => notify('Log selection is disabled in preview.', 'warn'),
    openPool: async () => notify('Preview only.', 'warn'),
    openLogs: async () => notify('Preview only.', 'warn'),
    copyText: async () => true,
    window: {
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
      onMaximizedChange: () => () => {},
    },
  };
})();

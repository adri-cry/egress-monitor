/**
 * Backend smoke tests — run with `npm run test:backend`.
 *
 * Covers config parsing, sing-box rendering, the chokidar quota guard and the
 * child_process engine lifecycle. No Electron window, no WARP account.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pool = require('../electron/lib/pool.cjs');
const {
  Deck,
  EngineManager,
  LogBus,
  LogGuard,
  canConnect,
  desktopProxyArgs,
  normalizeSettings,
  setLinuxAutostart,
  stamp,
  stripAnsi,
  whichSync,
} = require('../electron/main.cjs');

const scratch = process.env.TMPDIR || path.join(os.tmpdir());
const root = await fs.mkdtemp(path.join(scratch, 'egress-test-'));

const results = [];
function pass(name) {
  results.push({ name, ok: true });
  console.log(`  ok  ${name}`);
}
function fail(name, error) {
  results.push({ name, ok: false, error });
  console.error(`FAIL  ${name}\n      ${error.message}`);
}

async function test(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

const sample = (index = 1, overrides = {}) => `[Interface]
PrivateKey = ${'A'.repeat(42)}${index}=
Address = 172.16.0.${index}/32, 2606:4700:110:8d3e:abcd:0000:0000:000${index}/128
DNS = 1.1.1.1, 2606:4700:4700::1111
MTU = 1280

[Peer]
PublicKey = ${'B'.repeat(42)}=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 162.159.192.${index}:2408
${overrides.extra || ''}`;

async function makeDeckHome(name, count = 3) {
  const home = path.join(root, name);
  await fs.mkdir(path.join(home, 'warp-configs'), { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    await fs.writeFile(path.join(home, 'warp-configs', `config_0${index}.conf`), sample(index));
  }
  return home;
}

const fastSettings = {
  edge: { host: '', prefer: 'ipv4' },
  probe: { urls: ['http://stub.invalid/ip'], timeoutMs: 500, compareDirect: false },
  client: { desktop: { command: '' }, cli: { command: '' } },
  autoConnect: false,
};

async function writeDeckSettings(home) {
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify(fastSettings));
}

function waitFor(predicate, timeoutMs = 6000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        if (await predicate()) return resolve(true);
      } catch {
        /* keep polling */
      }
      if (Date.now() > deadline) return reject(new Error(`${label} timed out`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

console.log(`\nEgress Monitor backend tests\nroot: ${root}\n`);

await test('stamp() emits MM-DD HH:mm:ss', () => {
  assert.match(stamp(new Date(2026, 10, 14, 8, 11, 52)), /^11-14 08:11:52$/);
});

await test('parseWarpConfig extracts interface + peer', () => {
  const conf = pool.parseWarpConfig(sample(4), 'config_04.conf');
  assert.equal(conf.name, 'config_04.conf');
  assert.equal(conf.ipv4, '172.16.0.4');
  assert.match(conf.ipv6, /^2606:4700:110:8d3e/);
  assert.equal(conf.mtu, 1280);
  assert.equal(conf.peer.endpointHost, '162.159.192.4');
  assert.equal(conf.peer.endpointPort, 2408);
  assert.deepEqual(conf.addresses, [
    '172.16.0.4/32',
    '2606:4700:110:8d3e:abcd:0000:0000:0004/128',
  ]);
  assert.equal(conf.dns.length, 2);
  assert.equal(conf.fingerprint.length, 12);
});

await test('parseWarpConfig rejects a config without a peer', () => {
  assert.throws(
    () => pool.parseWarpConfig('[Interface]\nPrivateKey = x\nAddress = 172.16.0.2/32\n', 'bad.conf'),
    /missing \[Peer\]/,
  );
});

await test('ipv6Block64 handles compressed and expanded addresses', () => {
  assert.equal(
    pool.ipv6Block64('2a09:bac5:3a1c:25c3:1e2d:3f4a:5b6c:7d8e'),
    '2a09:bac5:3a1c:25c3::/64',
  );
  assert.equal(pool.ipv6Block64('2a09:bac5:3a1c:25c3::1'), '2a09:bac5:3a1c:25c3::/64');
  assert.equal(pool.ipv6Block64('2a09:bac5:3a1c:25c3::1/128'), '2a09:bac5:3a1c:25c3::/64');
  assert.equal(pool.ipv6Block64('203.0.113.9'), null);
});

await test('parseEndpoint keeps bare IPv6 intact and honours brackets', () => {
  assert.deepEqual(pool.parseEndpoint('2606:4700:d0::a29f:c001'), {
    host: '2606:4700:d0::a29f:c001',
    port: 2408,
  });
  assert.deepEqual(pool.parseEndpoint('[2606:4700:d0::1]:2409'), {
    host: '2606:4700:d0::1',
    port: 2409,
  });
  assert.deepEqual(pool.parseEndpoint('engage.cloudflareclient.com:2408'), {
    host: 'engage.cloudflareclient.com',
    port: 2408,
  });
});

await test('renderSingBoxConfig produces endpoints + outbound formats', () => {
  const conf = pool.parseWarpConfig(sample(2), 'config_02.conf');
  const endpoints = pool.renderSingBoxConfig(conf, {
    listenPort: 41987,
    format: 'endpoints',
    serverAddress: '162.159.192.2',
  });
  assert.equal(endpoints.inbounds[0].listen_port, 41987);
  assert.equal(endpoints.endpoints[0].type, 'wireguard');
  assert.equal(endpoints.endpoints[0].peers[0].address, '162.159.192.2');
  assert.equal(endpoints.endpoints[0].peers[0].allowed_ips.length, 2);
  assert.equal(endpoints.route.final, 'warp');
  assert.ok(endpoints.endpoints[0].private_key);

  const legacy = pool.renderSingBoxConfig(conf, {
    listenPort: 41987,
    format: 'outbound',
  });
  assert.equal(legacy.outbounds[0].type, 'direct');
  assert.equal(legacy.outbounds[1].type, 'wireguard');
  assert.equal(legacy.outbounds[1].server_port, 2408);
  assert.equal(legacy.endpoints, undefined);
  const legacyTags = new Set(legacy.outbounds.map((outbound) => outbound.tag));
  for (const rule of legacy.route.rules) {
    assert.ok(legacyTags.has(rule.outbound), `route references missing outbound ${rule.outbound}`);
  }
});

await test('scanPool sorts naturally and reports rejected files', async () => {
  const dir = path.join(root, 'pool');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config_10.conf'), sample(3));
  await fs.writeFile(path.join(dir, 'config_2.conf'), sample(2));
  await fs.writeFile(path.join(dir, 'config_1.conf'), sample(1));
  await fs.writeFile(path.join(dir, 'broken.conf'), 'not a wireguard config');
  await fs.writeFile(path.join(dir, 'ignore.txt'), 'ignore me');

  const result = await pool.scanPool(dir);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['config_1.conf', 'config_2.conf', 'config_10.conf'],
  );
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /missing \[Interface\]/);
});

await test('nextEntry round-robins and wraps', () => {
  const entries = [{ name: 'a.conf' }, { name: 'b.conf' }, { name: 'c.conf' }];
  assert.equal(pool.nextEntry(entries, 'a.conf').name, 'b.conf');
  assert.equal(pool.nextEntry(entries, 'c.conf').name, 'a.conf');
  assert.equal(pool.nextEntry(entries, 'missing.conf').name, 'a.conf');
  assert.equal(pool.nextEntry([{ name: 'only.conf' }], 'only.conf').name, 'only.conf');
});

await test('LogGuard fires on any quota-family line, not just QuotaExceeded', async () => {
  const logPath = path.join(root, 'client-family.log');
  await fs.writeFile(logPath, 'boot\n');
  const triggers = [];
  const guard = new LogGuard({
    filePath: logPath,
    cooldownMs: 0,
    onTrigger: (info) => triggers.push(info),
    onLog: () => {},
  });

  await guard.start();
  assert.equal(guard.watching, true);

  try {
    await fs.appendFile(logPath, '2026-11-14 08:11:52 upstream denied: QuotaExceeded (429)\n');
    await waitFor(() => triggers.length === 1, 6000, 'QuotaExceeded');
    assert.match(triggers[0].line, /QuotaExceeded/);

    await fs.appendFile(logPath, 'AI_APICallError: FreeUsageLimitError: free usage limit reached\n');
    await waitFor(() => triggers.length === 2, 6000, 'FreeUsageLimitError');

    await fs.appendFile(logPath, 'error: quota exceeded\n');
    await waitFor(() => triggers.length === 3, 6000, 'lowercase quota exceeded');

    await fs.appendFile(logPath, '{"error":{"type":"insufficient_quota"}}\n');
    await waitFor(() => triggers.length === 4, 6000, 'insufficient_quota');

    await fs.appendFile(logPath, 'HTTP 429 Too Many Requests\n');
    await waitFor(() => triggers.length === 5, 6000, '429 Too Many Requests');

    await fs.appendFile(logPath, 'rate limit exceeded, retrying in 30s\n');
    await waitFor(() => triggers.length === 6, 6000, 'rate limit exceeded');

    await fs.appendFile(logPath, 'harmless info line about capacity planning\n');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(triggers.length, 6, 'ordinary lines must not trigger');
  } finally {
    await guard.stop();
  }
});

await test('LogGuard defers a quota line inside cooldown instead of dropping it', async () => {
  const logPath = path.join(root, 'client-defer.log');
  await fs.writeFile(logPath, 'boot\n');
  const triggers = [];
  const guard = new LogGuard({
    filePath: logPath,
    cooldownMs: 800,
    onTrigger: (info) => triggers.push(info),
    onLog: () => {},
  });

  await guard.start();
  try {
    await fs.appendFile(logPath, 'QuotaExceeded first\n');
    await waitFor(() => triggers.length === 1, 6000, 'first trigger');

    // Written inside the cooldown window: the hop must be delayed, not lost.
    await fs.appendFile(logPath, 'QuotaExceeded second inside cooldown\n');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(triggers.length, 1, 'second trigger waits for the cooldown');

    await waitFor(() => triggers.length === 2, 6000, 'deferred trigger fires');
    assert.equal(triggers[1].deferred, true, 'deferred hop is flagged');
    assert.match(triggers[1].line, /second inside cooldown/);

    // Further quota lines fold into the single pending hop (they must not each
    // fire). Wall-clock dependent: if the cooldown already lapsed the first of
    // these fires at once, so settle on the outcome instead of a fixed sleep.
    await fs.appendFile(logPath, 'QuotaExceeded third\n');
    await fs.appendFile(logPath, 'QuotaExceeded fourth\n');
    await waitFor(() => triggers.length >= 3, 6000, 'folded hop fires');
    await new Promise((resolve) => setTimeout(resolve, 900)); // past another cooldown
    assert.equal(triggers.length, 3, 'two extra lines fold into one hop, not two');
    assert.match(
      triggers[2].line,
      /third|fourth/,
      'the folded hop must carry one of the folded lines',
    );
  } finally {
    await guard.stop();
  }
});

await test('LogGuard reads every new byte in a burst larger than one chunk', async () => {
  const logPath = path.join(root, 'client-burst.log');
  await fs.writeFile(logPath, 'boot\n');
  const triggers = [];
  const guard = new LogGuard({
    filePath: logPath,
    cooldownMs: 0,
    maxChunk: 256,
    onTrigger: (info) => triggers.push(info),
    onLog: () => {},
  });

  await guard.start();
  try {
    // Quota line lands at the start of a 4KB burst: a tail-only read misses it.
    const filler = `${'noise '.repeat(60)}\n`.repeat(12);
    await fs.appendFile(logPath, `QuotaExceeded early in burst\n${filler}`);
    await waitFor(() => triggers.length === 1, 6000, 'quota inside a large burst');
    assert.match(triggers[0].line, /early in burst/);
  } finally {
    await guard.stop();
  }
});

await test('LogGuard watches extra log files and re-reads a fresh quota on arm', async () => {
  const primary = path.join(root, 'client-primary.log');
  const extra = path.join(root, 'client-extra.log');
  await fs.writeFile(primary, 'boot\n');
  await fs.writeFile(extra, 'QuotaExceeded written before the guard started\n');

  const triggers = [];
  const guard = new LogGuard({
    filePaths: [primary, extra],
    cooldownMs: 0,
    lookbackMs: 60000,
    onTrigger: (info) => triggers.push(info),
    onLog: () => {},
  });

  await guard.start();
  try {
    assert.equal(guard.filePaths.length, 2);
    await waitFor(() => triggers.length === 1, 6000, 'lookback trigger');
    assert.equal(path.basename(triggers[0].file), 'client-extra.log');

    await fs.appendFile(extra, 'QuotaExceeded fresh in the secondary file\n');
    await waitFor(() => triggers.length === 2, 6000, 'secondary file trigger');
    assert.match(triggers[1].line, /fresh in the secondary file/);
  } finally {
    await guard.stop();
  }
});

await test('LogGuard does not re-hop on old history when armed without lookback', async () => {
  const logPath = path.join(root, 'client-history.log');
  await fs.writeFile(logPath, 'QuotaExceeded from a previous session\n');
  const triggers = [];
  const guard = new LogGuard({
    filePath: logPath,
    cooldownMs: 0,
    lookbackMs: 0,
    onTrigger: (info) => triggers.push(info),
    onLog: () => {},
  });

  await guard.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(triggers.length, 0, 'arming at EOF must ignore existing history');
  } finally {
    await guard.stop();
  }
});

await test('LogGuard does not replay a consumed trigger after cooldown', async () => {
  const logPath = path.join(root, 'client-replay.log');
  await fs.writeFile(logPath, 'boot\n');
  const triggers = [];
  const guard = new LogGuard({
    filePath: logPath,
    cooldownMs: 500,
    onTrigger: (info) => triggers.push(info),
    onLog: () => {},
  });

  await guard.start();
  try {
    await fs.appendFile(logPath, 'QuotaExceeded first\n');
    await waitFor(() => triggers.length === 1, 6000, 'first trigger');

    await new Promise((resolve) => setTimeout(resolve, 900));
    await fs.appendFile(logPath, 'harmless line after cooldown\n');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(triggers.length, 1, 'stale QuotaExceeded must not trigger again');

    await fs.appendFile(logPath, 'QuotaExceeded fresh\n');
    await waitFor(() => triggers.length === 2, 6000, 'fresh trigger');
  } finally {
    await guard.stop();
  }
});

await test('computeStatus reports a leak instead of protected', () => {
  const deck = {
    state: {
      rotating: false,
      connected: true,
      lastError: null,
      lastErrorCode: null,
      egress: { verified: true, leaked: true, checkedAt: new Date().toISOString() },
    },
    settings: { probe: { staleAfterMs: 180000 } },
    egressFresh: Deck.prototype.egressFresh,
    pool: { entries: [{ name: 'config_1.conf' }] },
    persisted: { manualOffline: false },
  };

  Deck.prototype.computeStatus.call(deck);
  assert.equal(deck.state.status, 'leaked');

  deck.state.egress = { verified: true, leaked: false, checkedAt: new Date().toISOString() };
  Deck.prototype.computeStatus.call(deck);
  assert.equal(deck.state.status, 'protected');

  deck.state.egress.checkedAt = new Date(Date.now() - 600000).toISOString();
  Deck.prototype.computeStatus.call(deck);
  assert.equal(deck.state.status, 'degraded');

  deck.state.egress = { verified: false, leaked: false };
  Deck.prototype.computeStatus.call(deck);
  assert.equal(deck.state.status, 'degraded');
});

await test('LogBus keeps a ring buffer and writes tab files', async () => {
  const dir = path.join(root, 'bus');
  const bus = new LogBus({ dir, limit: 3 });
  await bus.init();
  for (let i = 0; i < 5; i += 1) bus.append('guard', 'info', `line ${i}`);
  const snapshot = bus.snapshot();
  assert.equal(snapshot.guard.length, 3);
  assert.match(snapshot.guard[2].text, /line 4/);
  await bus.flush();
  const raw = await fs.readFile(path.join(dir, 'guard.log'), 'utf8');
  assert.match(raw, /line 4/);
  assert.match(raw, /\tinfo\t/);
});

await test('LogBus strips ANSI escapes and rotates oversized tab files', async () => {
  assert.equal(stripAnsi('\u001b[1;31mred\u001b[0m text'), 'red text');

  const dir = path.join(root, 'bus-ansi');
  const bus = new LogBus({ dir, limit: 10, maxBytes: 160 });
  await bus.init();
  bus.append('app', 'warn', '\u001b[31mERROR\u001b[0m boom');
  assert.doesNotMatch(bus.snapshot().app[0].text, /\u001b/);
  await bus.flush();

  let raw = await fs.readFile(path.join(dir, 'app.log'), 'utf8');
  assert.match(raw, /ERROR boom/);
  assert.doesNotMatch(raw, /\u001b/);

  for (let i = 0; i < 8; i += 1) {
    bus.append('app', 'info', `padding line ${i} ${'x'.repeat(40)}`);
  }
  await bus.flush();
  assert.equal(fssync.existsSync(path.join(dir, 'app.log.1')), true);
  raw = await fs.readFile(path.join(dir, 'app.log'), 'utf8');
  assert.ok(raw.length < 500, 'active log must shrink after rotation');
});

await test('normalizeSettings survives null and mistyped settings.json', async () => {
  const isWin = process.platform === 'win32';
  const defaults = normalizeSettings(null);
  assert.equal(defaults.proxy.port, 41987);
  assert.equal(defaults.engine.command, isWin ? 'engine/sing-box.exe' : 'engine/sing-box');
  assert.equal(defaults.probe.urls.length, 3);
  assert.match(defaults.probe.urls[0], /api6\./, 'IPv6 probe must run first or /64 rotation stays invisible');
  assert.equal(defaults.logs.maxBytes, 2 * 1024 * 1024);

  const coerced = normalizeSettings({
    proxy: null,
    probe: { urls: null },
    client: null,
    logs: null,
  });
  assert.equal(coerced.proxy.host, '127.0.0.1');
  assert.equal(coerced.client.cli.command, isWin ? 'powershell.exe' : '');
  assert.equal(coerced.logs.maxBytes, 2 * 1024 * 1024);

  const guarded = normalizeSettings({
    proxy: { port: 'nope' },
    probe: { timeoutMs: 1 },
    keeper: { intervalMs: 1 },
    edge: { prefer: 'bogus' },
  });
  assert.equal(guarded.proxy.port, 41987);
  assert.equal(guarded.probe.timeoutMs, 500);
  assert.equal(guarded.keeper.intervalMs, 1000);
  assert.equal(guarded.edge.prefer, 'ipv4');

  const home = path.join(root, 'null-settings');
  await fs.mkdir(path.join(home, 'warp-configs'), { recursive: true });
  await fs.writeFile(path.join(home, 'settings.json'), 'null');
  const deck = new Deck({ home, win: null });
  await deck.loadSettings();
  assert.equal(deck.settings.proxy.port, 41987);
  assert.equal(deck.settings.poolDir, path.join(home, 'warp-configs'));
});

await test('desktopProxyArgs strips Chromium proxy switches when unwired', () => {
  assert.deepEqual(
    desktopProxyArgs(['--proxy-server=127.0.0.1:41987', '--disable-gpu'], false),
    ['--disable-gpu'],
  );
  assert.deepEqual(
    desktopProxyArgs(['--proxy-server', 'http://127.0.0.1:41987', '--flag'], false),
    ['--flag'],
  );
  assert.deepEqual(
    desktopProxyArgs(['--proxy-server=127.0.0.1:41987', '--flag'], true),
    ['--proxy-server=127.0.0.1:41987', '--flag'],
  );
});

await test('Deck restores the persisted config on startup', async () => {
  const home = await makeDeckHome('deck-persisted');
  await writeDeckSettings(home);
  await fs.mkdir(path.join(home, 'runtime'), { recursive: true });
  await fs.writeFile(
    path.join(home, 'runtime', 'deck-state.json'),
    JSON.stringify({ currentConfig: 'config_03.conf' }),
  );

  const deck = new Deck({ home, win: null });
  try {
    await deck.init();
    assert.equal(deck.currentEntry?.name, 'config_03.conf');
  } finally {
    await deck.dispose();
  }
});

await test('Deck falls back to the next config when connect cannot start it', async () => {
  const home = await makeDeckHome('deck-fallback');
  await writeDeckSettings(home);
  const deck = new Deck({ home, win: null });

  try {
    await deck.init();
    const attempted = [];
    deck.startEntry = async (entry) => {
      attempted.push(entry.name);
      if (entry.name === 'config_01.conf') throw new Error('handshake failed');
      deck.currentEntry = entry;
    };
    deck.probe = async () => deck.state.egress;
    deck.scanWorkspace = async () => deck.workspaceCache;

    const result = await deck.connect('manual');
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(attempted.slice(0, 2), ['config_01.conf', 'config_02.conf']);
    assert.equal(deck.currentEntry.name, 'config_02.conf');
    assert.match(result.message, /config_02\.conf/);

    deck.state.connected = false;
    const hopped = await deck.rotate('manual');
    assert.equal(hopped.ok, true, hopped.message);
    assert.equal(deck.currentEntry.name, 'config_03.conf');
  } finally {
    await deck.dispose();
  }
});

await test('resolveServerAddress uses the pinned edge address', async () => {
  const deck = new Deck({ home: path.join(root, 'edge-address'), win: null });
  deck.settings.edge = { host: 'edge.test', prefer: 'ipv6' };
  deck.state.edge = {
    host: 'edge.test',
    aaaa: '2606:4700::1',
    a: '104.16.0.1',
    pinned: '2606:4700::1',
  };

  assert.equal(await deck.resolveServerAddress({ endpointHost: 'edge.test' }), '2606:4700::1');
  deck.settings.edge.prefer = 'ipv4';
  deck.state.edge.pinned = '104.16.0.1';
  assert.equal(await deck.resolveServerAddress({ endpointHost: 'edge.test' }), '104.16.0.1');
  assert.equal(await deck.resolveServerAddress({ endpointHost: '8.8.8.8' }), '8.8.8.8');
});

await test('EngineManager starts the proxy port and stops the child', async () => {
  const home = path.join(root, 'engine-home');
  await fs.mkdir(path.join(home, 'runtime'), { recursive: true });
  process.env.FAKE_IP_PORT = '42801';

  const logs = [];
  const engine = new EngineManager({
    command: process.execPath,
    args: [path.join(here, 'fixtures', 'fake-engine.mjs')],
    home,
    port: 43197,
    configPath: path.join(home, 'runtime', 'sing-box.json'),
    timeoutMs: 8000,
    log: (tab, level, text) => logs.push({ tab, level, text }),
  });

  const config = {
    log: { level: 'warn' },
    inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: 43197 }],
    endpoints: [{ type: 'wireguard', tag: 'warp', peers: [] }],
    route: { final: 'warp' },
  };

  try {
    await engine.start({ config, entryName: 'config_1.conf', format: 'endpoints' });
    assert.equal(engine.running, true);
    assert.equal(await canConnect('127.0.0.1', 43197, 800), true);
    assert.ok(fssync.existsSync(engine.configPath));
    const written = JSON.parse(await fs.readFile(engine.configPath, 'utf8'));
    assert.equal(written.inbounds[0].listen_port, 43197);
  } finally {
    await engine.stop();
  }

  await waitFor(async () => !(await portOpen(43197)), 5000, 'proxy port close');
  assert.equal(engine.running, false);
  assert.ok(logs.some((entry) => /engine ready/.test(entry.text)));
});

await test('EngineManager reports ENGINE_MISSING for a missing binary', async () => {
  const home = path.join(root, 'missing-home');
  const engine = new EngineManager({
    command: path.join(home, process.platform === 'win32' ? 'does-not-exist.exe' : 'does-not-exist'),
    home,
    port: 43198,
    configPath: path.join(home, 'runtime', 'sing-box.json'),
    timeoutMs: 2000,
  });

  await assert.rejects(
    () =>
      engine.start({
        config: { inbounds: [{ listen_port: 43198 }] },
        entryName: 'x',
        format: 'endpoints',
      }),
    (error) => error.code === 'ENGINE_MISSING',
  );
});

await test('Deck rotates on a guard trigger and persists hops', async () => {
  const home = path.join(root, 'deck-home');
  await fs.mkdir(path.join(home, 'warp-configs'), { recursive: true });
  await fs.mkdir(path.join(home, 'workspace'), { recursive: true });
  for (let i = 1; i <= 3; i += 1) {
    await fs.writeFile(path.join(home, 'warp-configs', `config_0${i}.conf`), sample(i));
  }

  await fs.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({
      proxy: { host: '127.0.0.1', port: 43297 },
      engine: {
        command: process.execPath,
        args: [path.join(here, 'fixtures', 'fake-engine.mjs')],
        timeoutMs: 8000,
      },
      poolDir: 'warp-configs',
      clientLogPath: 'logs/client.log',
      edge: { host: '', prefer: 'ipv4' },
      probe: { urls: ['http://stub.invalid/ip'], timeoutMs: 1000, compareDirect: false },
      guard: { cooldownMs: 500 },
      keeper: { intervalMs: 10000, failuresBeforeRestart: 2, heartbeatLogMs: 90000 },
      client: { desktop: { command: '' }, cli: { command: '' } },
      workspaceDir: 'workspace',
      autoConnect: false,
    }),
  );

  process.env.FAKE_IP_PORT = '42802';
  const deck = new Deck({ home, win: null });

  try {
    await deck.init();
    let probeCount = 0;
    deck.fetchIp = async () => {
      probeCount += 1;
      return `2a09:bac5:3a1c:${(0x2600 + probeCount).toString(16)}::1`;
    };

    const first = await deck.connect('manual');
    assert.equal(first.ok, true, first.message);
    assert.equal(deck.state.connected, true);
    assert.equal(deck.state.stats.hops, 0);
    const firstConfig = deck.currentEntry.name;
    assert.match(deck.state.egress.block64, /^2a09:bac5:3a1c:2601::\/64$/);

    const rotated = await deck.rotate('manual');
    assert.equal(rotated.ok, true, rotated.message);
    assert.notEqual(deck.currentEntry.name, firstConfig);
    assert.equal(deck.state.stats.hops, 1);

    await deck.handleGuardTrigger({
      at: Date.now(),
      count: 1,
      line: 'upstream denied request: QuotaExceeded (429)',
      file: path.join(home, 'logs', 'client.log'),
    });
    assert.equal(deck.state.stats.hops, 2);
    assert.equal(deck.state.stats.triggers, 1, 'acted trigger counted');
    assert.equal(deck.state.stats.blacklisted, 1, 'quota hop retires a /64');

    // Routine hops must not inflate the retired-/64 counter.
    const manual = await deck.rotate('manual');
    assert.equal(manual.ok, true, manual.message);
    assert.equal(deck.state.stats.blacklisted, 1, 'manual hop is not a retirement');

    // A trigger the deck refuses to act on must not be counted either.
    await deck.toggle('logGuard', false);
    await deck.handleGuardTrigger({
      at: Date.now(),
      count: 1,
      line: 'upstream denied request: QuotaExceeded (429)',
      file: path.join(home, 'logs', 'client.log'),
    });
    assert.equal(deck.state.stats.triggers, 1, 'ignored trigger must not be counted');
    assert.equal(deck.state.stats.hops, 3, 'ignored trigger must not hop');

    await deck.logs.flush();
    const guardLog = await fs.readFile(path.join(home, 'logs', 'guard.log'), 'utf8');
    assert.match(
      guardLog,
      /log-guard detected trigger -> rotating to config_0\d\.conf -> success\./,
    );
    assert.doesNotMatch(JSON.stringify(deck.publicState()), /PrivateKey|privateKey/);
  } finally {
    await deck.dispose();
  }
});

await test('linux launcher helpers: XDG autostart file and PATH lookup', async () => {
  const entry = path.join(root, 'autostart', 'egress-monitor.desktop');
  assert.equal(await setLinuxAutostart(true, entry), true);
  const text = await fs.readFile(entry, 'utf8');
  assert.match(text, /^\[Desktop Entry\]/);
  assert.match(text, /^Type=Application$/m);
  assert.match(text, /^Exec=.+/m, 'Exec must name the Electron binary');
  assert.equal(await setLinuxAutostart(false, entry), false);
  assert.equal(fssync.existsSync(entry), false);

  assert.ok(whichSync(process.platform === 'win32' ? 'node.exe' : 'node'), 'node must resolve from PATH');
  assert.equal(whichSync('definitely-not-a-real-binary-xyz'), null);
});

await fs.rm(root, { recursive: true, force: true }).catch(() => {});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  for (const item of failed) console.error(`- ${item.name}: ${item.error.message}`);
  process.exit(1);
}

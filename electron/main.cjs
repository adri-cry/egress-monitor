'use strict';

/**
 * Egress Rotator & Monitor — Electron main process.
 *
 * Responsibilities:
 *  - manage a pool of WireGuard (Cloudflare WARP) configurations
 *  - drive a local sing-box proxy on 127.0.0.1:41987 via child_process
 *  - watch client.log with chokidar and hop /64 when "QuotaExceeded" appears
 *  - supervise the engine (keeper), probe egress, expose state over IPC
 *
 * Run inside Electron:  electron .
 * Run under plain Node:  require() this file to access the exported classes
 *                        (used by scripts/test-backend.mjs).
 */

const { app, BrowserWindow, clipboard, dialog, ipcMain, net, session, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const netTcp = require('node:net');
const dns = require('node:dns/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const chokidar = require('chokidar');

const {
  ipFamily,
  ipv6Block64,
  ipv6Subnet64,
  loadWarpConfig,
  nextEntry,
  renderSingBoxConfig,
  scanPool,
} = require('./lib/pool.cjs');

const execFileAsync = promisify(execFile);

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const SCREENSHOT_PATH = process.env.OCU_SCREENSHOT;
const isScreenshotRun = Boolean(SCREENSHOT_PATH);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

const TOGGLE_IDS = ['keeper', 'logGuard', 'desktopProxy', 'autoStart'];
const LOG_TABS = ['guard', 'keeper', 'app'];

let mainWindow = null;
let deck = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pad(value) {
  return String(value).padStart(2, '0');
}

/** `11-14 08:11:52` — the timestamp format used across the console. */
function stamp(date = new Date()) {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** Resolve paths against the console home, leaving bare command names alone. */
function resolveSettingPath(home, value) {
  const expanded = expandHome(String(value || ''));
  if (!expanded) return expanded;
  if (path.isAbsolute(expanded)) return expanded;
  if (expanded.includes('/') || expanded.includes('\\')) return path.resolve(home, expanded);
  return expanded; // bare executable name, resolved through PATH
}

function relativize(home, value) {
  if (!value) return value;
  if (!path.isAbsolute(value)) return value;
  return path.relative(home, value) || '.';
}

/** Data paths are always relative to the console home, never PATH lookups. */
function resolveDataPath(home, value) {
  const expanded = expandHome(String(value || ''));
  if (!expanded) return expanded;
  return path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded);
}

function canConnect(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = netTcp.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function tail(text, max = 600) {
  const clean = String(text || '').trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

const ANSI_PATTERN =
  /\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-_]/g;

/** Remove terminal colour codes so the UI and log files stay readable. */
function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(/[\u001B\u009B]/g, '');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readRange(file, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fssync.createReadStream(file, { start, end });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function defaultSettings() {
  return {
    proxy: { host: '127.0.0.1', port: 41987 },
    engine: {
      command: 'engine/sing-box.exe',
      args: [],
      timeoutMs: 15000,
    },
    poolDir: 'warp-configs',
    clientLogPath: 'logs/client.log',
    edge: { host: 'engage.cloudflareclient.com', prefer: 'ipv4' },
    probe: {
      // IPv6 first: a dual-stack endpoint answers over whichever family the
      // client dialled, so /64 rotation would never show up. api6 is AAAA-only.
      urls: [
        'https://api6.ipify.org?format=json',
        'https://api64.ipify.org?format=json',
        'https://api.ipify.org?format=json',
      ],
      timeoutMs: 9000,
      compareDirect: true,
      refreshMs: 60000,
      staleAfterMs: 180000,
    },
    guard: { cooldownMs: 75000 },
    keeper: { intervalMs: 10000, failuresBeforeRestart: 2, heartbeatLogMs: 90000 },
    logs: { maxBytes: 2 * 1024 * 1024 },
    client: {
      desktop: { command: '', args: [], cwd: '' },
      cli: {
        command: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoExit',
          '-Command',
          "$env:HTTPS_PROXY='http://127.0.0.1:41987'; $env:HTTP_PROXY=$env:HTTPS_PROXY; $env:ALL_PROXY=$env:HTTPS_PROXY; Write-Host ('Egress proxy wired: ' + $env:HTTPS_PROXY)",
        ],
        cwd: '',
      },
    },
    workspaceDir: 'workspace',
    autoConnect: true,
  };
}

/**
 * Coerce settings.json into the default schema. Missing or mistyped values
 * (null, strings, arrays where objects belong) fall back to defaults instead
 * of crashing `init()` with "Cannot read properties of null".
 */
function normalizeSettings(raw) {
  const defaults = defaultSettings();

  const walk = (base, value) => {
    if (Array.isArray(base)) {
      if (!Array.isArray(value)) return [...base];
      const template = base[0];
      const kept = value.filter((item) =>
        template === undefined ? true : typeof item === typeof template,
      );
      return kept.length || !base.length ? kept : [...base];
    }
    if (isPlainObject(base)) {
      const source = isPlainObject(value) ? value : {};
      const out = {};
      for (const key of Object.keys(base)) out[key] = walk(base[key], source[key]);
      for (const key of Object.keys(source)) {
        if (!(key in out)) out[key] = source[key];
      }
      return out;
    }
    if (typeof base === 'number') {
      return typeof value === 'number' && Number.isFinite(value) ? value : base;
    }
    if (typeof base === 'boolean') return typeof value === 'boolean' ? value : base;
    if (typeof base === 'string') return typeof value === 'string' ? value : base;
    return value === undefined ? base : value;
  };

  const settings = walk(defaults, raw);

  // Range guards for values that reach sockets, timers and child processes.
  settings.proxy.port = clampInt(settings.proxy.port, defaults.proxy.port, 1, 65535);
  settings.probe.timeoutMs = clampInt(
    settings.probe.timeoutMs,
    defaults.probe.timeoutMs,
    500,
    60000,
  );
  settings.probe.refreshMs = clampInt(
    settings.probe.refreshMs,
    defaults.probe.refreshMs,
    5000,
    900000,
  );
  settings.probe.staleAfterMs = clampInt(
    settings.probe.staleAfterMs,
    defaults.probe.staleAfterMs,
    5000,
    3600000,
  );
  settings.probe.urls = settings.probe.urls.filter((url) => /^https?:\/\//i.test(url));
  if (!settings.probe.urls.length) settings.probe.urls = [...defaults.probe.urls];
  settings.edge.prefer = settings.edge.prefer === 'ipv6' ? 'ipv6' : 'ipv4';
  settings.engine.timeoutMs = clampInt(
    settings.engine.timeoutMs,
    defaults.engine.timeoutMs,
    1000,
    120000,
  );
  settings.keeper.intervalMs = clampInt(
    settings.keeper.intervalMs,
    defaults.keeper.intervalMs,
    1000,
    300000,
  );
  settings.keeper.failuresBeforeRestart = clampInt(
    settings.keeper.failuresBeforeRestart,
    defaults.keeper.failuresBeforeRestart,
    1,
    10,
  );
  settings.keeper.heartbeatLogMs = clampInt(
    settings.keeper.heartbeatLogMs,
    defaults.keeper.heartbeatLogMs,
    10000,
    3600000,
  );
  settings.guard.cooldownMs = clampInt(
    settings.guard.cooldownMs,
    defaults.guard.cooldownMs,
    5000,
    3600000,
  );
  settings.logs.maxBytes = clampInt(
    settings.logs.maxBytes,
    defaults.logs.maxBytes,
    16 * 1024,
    100 * 1024 * 1024,
  );
  settings.autoConnect = Boolean(settings.autoConnect);
  settings.probe.compareDirect = Boolean(settings.probe.compareDirect);

  return settings;
}

const PROXY_FLAGS = /^--(?:proxy-server|proxy-bypass-list|proxy-pac-url)(?:=|$)/i;

/** Drop Chromium proxy switches when the desktop proxy toggle is off. */
function desktopProxyArgs(args, enabled) {
  const list = Array.isArray(args) ? [...args] : [];
  if (enabled) return list;
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index]);
    if (PROXY_FLAGS.test(arg)) {
      if (
        !arg.includes('=') &&
        index + 1 < list.length &&
        !String(list[index + 1]).startsWith('--')
      ) {
        index += 1; // also drop the separate value form: --proxy-server http://…
      }
      continue;
    }
    out.push(list[index]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

class LogBus {
  constructor({ dir, limit = 400, onEntry = null, maxBytes = 0 }) {
    this.dir = dir;
    this.limit = limit;
    this.onEntry = onEntry;
    this.maxBytes = maxBytes;
    this.seq = 0;
    this.buffers = { guard: [], keeper: [], app: [] };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    for (const tab of LOG_TABS) {
      const raw = await fsp.readFile(path.join(this.dir, `${tab}.log`), 'utf8').catch(() => '');
      const lines = raw.trim() ? raw.trim().split(/\r?\n/).slice(-this.limit) : [];
      for (const line of lines) {
        const [iso, level, ...rest] = line.split('\t');
        if (!iso || !rest.length) continue;
        const date = new Date(iso);
        this.buffers[tab].push({
          id: `restored-${tab}-${this.seq++}`,
          t: Number.isNaN(date.getTime()) ? iso : stamp(date),
          iso,
          level: level || 'info',
          text: stripAnsi(rest.join('\t')),
        });
      }
    }
  }

  append(tab, level, text) {
    const target = this.buffers[tab] ? tab : 'app';
    const date = new Date();
    const entry = {
      id: `${date.getTime()}-${this.seq++}`,
      t: stamp(date),
      iso: date.toISOString(),
      level,
      text: stripAnsi(text).replace(/[\r\n\t]/g, ' '),
    };

    const buffer = this.buffers[target];
    buffer.push(entry);
    if (buffer.length > this.limit) buffer.splice(0, buffer.length - this.limit);

    // Serialize file writes so restored logs keep their original order.
    this.writeChain = this.writeChain
      .then(async () => {
        const file = path.join(this.dir, `${target}.log`);
        if (this.maxBytes > 0) {
          const stat = await fsp.stat(file).catch(() => null);
          if (stat && stat.size >= this.maxBytes) {
            const archived = `${file}.1`;
            await fsp.rm(archived, { force: true }).catch(() => {});
            await fsp.rename(file, archived).catch(() => {});
          }
        }
        await fsp.appendFile(file, `${entry.iso}\t${entry.level}\t${entry.text}\n`);
      })
      .catch(() => {});

    try {
      this.onEntry?.(target, entry);
    } catch {
      /* never let a logging subscriber break the rotator */
    }

    return entry;
  }

  async flush() {
    await this.writeChain;
  }

  async clear(tab) {
    if (!this.buffers[tab]) return false;
    this.buffers[tab] = [];
    const file = path.join(this.dir, `${tab}.log`);
    this.writeChain = this.writeChain
      .then(async () => {
        await fsp.writeFile(file, '');
        await fsp.rm(`${file}.1`, { force: true }).catch(() => {});
      })
      .catch(() => {});
    await this.writeChain;
    return true;
  }

  snapshot() {
    return {
      guard: [...this.buffers.guard],
      keeper: [...this.buffers.keeper],
      app: [...this.buffers.app],
    };
  }
}

// ---------------------------------------------------------------------------
// chokidar log guard
// ---------------------------------------------------------------------------

class LogGuard {
  constructor({ filePath, onTrigger, onLog = null, cooldownMs = 75000, maxChunk = 512 * 1024 }) {
    this.filePath = filePath;
    this.onTrigger = onTrigger;
    this.onLog = onLog;
    this.cooldownMs = cooldownMs;
    this.maxChunk = maxChunk;

    this.offset = 0;
    this.pending = '';
    this.lastTriggerAt = 0;
    this.suppressedLoggedAt = 0;
    this.watcher = null;
    this.scanning = false;
    this.queued = false;
    this.triggerCount = 0;
  }

  get watching() {
    return Boolean(this.watcher);
  }

  async start() {
    if (this.watcher) return;

    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    if (!fssync.existsSync(this.filePath)) {
      await fsp.writeFile(this.filePath, '');
    }

    const stat = await fsp.stat(this.filePath);
    // Start at EOF: only lines that arrive after the guard is armed can hop.
    this.offset = stat.size;
    this.pending = '';

    this.watcher = chokidar.watch(this.filePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      alwaysStat: true,
    });

    this.watcher.on('change', () => this.scan());
    this.watcher.on('add', () => {
      this.offset = 0;
      this.pending = '';
      this.scan();
    });
    this.watcher.on('unlink', () => {
      this.offset = 0;
      this.pending = '';
    });
    this.watcher.on('error', (error) => {
      this.onLog?.('error', `log-guard watcher error: ${error.message}`);
    });

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      this.watcher.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async scan() {
    if (this.scanning) {
      this.queued = true;
      return;
    }
    this.scanning = true;

    try {
      const stat = await fsp.stat(this.filePath).catch(() => null);
      if (!stat) return;

      if (stat.size < this.offset) {
        this.offset = 0;
        this.pending = '';
      }
      if (stat.size === this.offset) return;

      const start = Math.max(this.offset, stat.size - this.maxChunk);
      const chunk = await readRange(this.filePath, start, stat.size - 1);
      this.offset = stat.size;

      const combined = this.pending + chunk;
      this.pending = combined.slice(-64);

      if (!combined.includes('QuotaExceeded')) return;

      const now = Date.now();
      if (now - this.lastTriggerAt < this.cooldownMs) {
        // Consume the match so the same bytes cannot fire again once the
        // cooldown expires. A new quota error must be written to the log.
        this.pending = '';
        if (now - this.suppressedLoggedAt > this.cooldownMs) {
          this.suppressedLoggedAt = now;
          const remaining = Math.ceil((this.cooldownMs - (now - this.lastTriggerAt)) / 1000);
          this.onLog?.(
            'warn',
            `log-guard cooldown active · trigger suppressed for ${remaining}s`,
          );
        }
        return;
      }

      this.lastTriggerAt = now;
      this.triggerCount += 1;
      const matchLine =
        combined
          .split(/\r?\n/)
          .find((line) => line.includes('QuotaExceeded')) || 'QuotaExceeded';

      // The trigger has been handled; drop it from the carry buffer so a later
      // unrelated line cannot replay this match after the cooldown.
      this.pending = '';
      this.onTrigger?.({
        at: now,
        count: this.triggerCount,
        line: matchLine.trim().slice(0, 400),
        file: this.filePath,
      });
    } catch (error) {
      this.onLog?.('error', `log-guard scan failed: ${error.message}`);
    } finally {
      this.scanning = false;
      if (this.queued) {
        this.queued = false;
        setImmediate(() => this.scan());
      }
    }
  }

  async stop() {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// sing-box engine
// ---------------------------------------------------------------------------

class EngineManager {
  constructor({
    command,
    args = [],
    home,
    host = '127.0.0.1',
    port = 41987,
    configPath,
    timeoutMs = 15000,
    log = null,
    onUnexpectedExit = null,
  }) {
    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.home = home;
    this.host = host;
    this.port = port;
    this.configPath = configPath;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.onUnexpectedExit = onUnexpectedExit;

    this.child = null;
    this.stopping = false;
    this.stderr = '';
    this.startedAt = null;
    this.format = null;
    this.supportsEndpoints = true;
    this.version = null;
    this.detected = false;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  async resolveCommand() {
    if (!this.command) return null;
    const expanded = expandHome(this.command);

    if (path.isAbsolute(expanded)) {
      return fssync.existsSync(expanded) ? expanded : null;
    }

    if (expanded.includes('/') || expanded.includes('\\')) {
      const absolute = path.resolve(this.home, expanded);
      return fssync.existsSync(absolute) ? absolute : null;
    }

    return expanded; // resolved through PATH by spawn()
  }

  async detect() {
    if (this.detected) return;
    if (!/sing-?box/i.test(this.command || '')) {
      this.detected = true;
      return;
    }

    const resolved = await this.resolveCommand();
    if (!resolved) return; // allow a later start to pick up a newly added binary

    try {
      const { stdout, stderr } = await execFileAsync(resolved, ['version'], {
        windowsHide: true,
        timeout: 4000,
      });
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${stdout || ''} ${stderr || ''}`);
      if (match) {
        const [, major, minor, patch] = match;
        this.version = `${major}.${minor}.${patch}`;
        this.supportsEndpoints =
          Number(major) > 1 || (Number(major) === 1 && Number(minor) >= 11);
      }
      this.detected = true;
    } catch {
      this.detected = true; // fall back to the optimistic default
    }
  }

  async start({ config, entryName = '', format = 'endpoints' }) {
    await this.stop();
    await this.detect();

    const command = await this.resolveCommand();
    if (!command) {
      throw new EngineError(
        'ENGINE_MISSING',
        `sing-box not found at "${this.command}". Drop sing-box.exe into engine/ or run "npm run engine:fetch".`,
      );
    }

    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    await fsp.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');

    this.stderr = '';
    this.format = format;
    let spawnError = null;

    const child = spawn(command, [...this.args, 'run', '-c', this.configPath], {
      cwd: this.home,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;
    this.startedAt = Date.now();

    child.stdout?.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString()).trim();
      if (text) this.log?.('app', 'info', `engine: ${tail(text, 300)}`);
    });
    child.stderr?.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      this.stderr = tail(`${this.stderr}\n${text}`, 2000);
      if (text.trim()) this.log?.('app', 'warn', `engine: ${tail(text, 300)}`);
    });
    child.once('error', (error) => {
      spawnError = error;
      this.log?.('app', 'error', `engine spawn failed: ${error.message}`);
    });

    child.once('exit', (code, signal) => {
      const wasCurrent = this.child === child;
      if (wasCurrent) this.child = null;
      const pid = child.pid;
      const uptime = this.startedAt ? Date.now() - this.startedAt : 0;

      if (this.stopping || !wasCurrent) return;
      this.log?.(
        'app',
        code === 0 ? 'info' : 'error',
        `engine exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''}) after ${Math.round(
          uptime / 1000,
        )}s · pid ${pid}`,
      );
      this.onUnexpectedExit?.({ code, signal, stderr: this.stderr });
    });

    try {
      await this.waitUntilReady(child, () => spawnError);
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.log?.(
      'app',
      'success',
      `engine ready · ${entryName || 'config'} · ${format} format · pid ${child.pid}`,
    );
  }

  async waitUntilReady(child, getSpawnError) {
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const spawnError = getSpawnError?.();
      if (spawnError) {
        throw new EngineError(
          'ENGINE_MISSING',
          `engine command could not start: ${spawnError.message}`,
        );
      }
      if (child.exitCode !== null) {
        throw new EngineError(
          'ENGINE_EXIT',
          `engine exited with code ${child.exitCode}. ${tail(this.stderr, 700)}`,
        );
      }
      if (await canConnect(this.host, this.port, 500)) return;
      await delay(120);
    }

    throw new EngineError(
      'ENGINE_TIMEOUT',
      `proxy did not listen on ${this.host}:${this.port} within ${this.timeoutMs}ms. ${tail(
        this.stderr,
        700,
      )}`,
    );
  }

  async stop() {
    const child = this.child;
    if (!child) return;

    this.stopping = true;
    this.child = null;

    const exited = new Promise((resolve) => child.once('exit', resolve));

    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* process already gone */
    }

    await Promise.race([exited, delay(3000)]);
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }

    this.stopping = false;
    this.startedAt = null;
  }
}

// ---------------------------------------------------------------------------
// control plane
// ---------------------------------------------------------------------------

class Deck {
  constructor({ home, win }) {
    this.home = home;
    this.win = win;

    this.paths = {
      home,
      pool: path.join(home, 'warp-configs'),
      logs: path.join(home, 'logs'),
      runtime: path.join(home, 'runtime'),
      engineConfig: path.join(home, 'runtime', 'sing-box.json'),
      settings: path.join(home, 'settings.json'),
      state: path.join(home, 'runtime', 'deck-state.json'),
      clientLog: path.join(home, 'logs', 'client.log'),
      workspace: path.join(home, 'workspace'),
    };

    this.settings = defaultSettings();
    this.persisted = {
      hops: 0,
      triggers: 0,
      blacklisted: 0,
      currentConfig: null,
      manualOffline: false,
      toggles: { keeper: true, logGuard: true, desktopProxy: true, autoStart: false },
    };

    this.logs = new LogBus({
      dir: this.paths.logs,
      onEntry: (tab, entry) => this.send('deck:log', { tab, entry }),
    });

    this.pool = { dir: this.paths.pool, entries: [], errors: [] };
    this.currentEntry = null;
    this.engine = null;
    this.guard = null;
    this.rotating = false;
    this.keeperTimer = null;
    this.keeperBusy = false;
    this.keeperFailures = 0;
    this.lastHeartbeatLog = 0;
    this.workspaceCache = { at: 0, projects: null, chats: null };
    this.proxySession = null;
    this.directSession = null;

    this.state = {
      status: 'idle',
      connected: false,
      rotating: false,
      engine: {
        state: 'stopped',
        command: this.settings.engine.command,
        pid: null,
        format: null,
        startedAt: null,
        version: null,
        error: null,
      },
      proxy: { host: this.settings.proxy.host, port: this.settings.proxy.port, listening: false },
      pool: { dir: this.paths.pool, total: 0, entries: [], errors: [], currentFile: null, index: -1 },
      egress: {
        ip: null,
        family: null,
        block64: null,
        subnet64: null,
        verified: false,
        leaked: false,
        directIp: null,
        checkedAt: null,
        error: null,
      },
      adapter: { name: null, ipv4: null, ipv6: null, mtu: null, dns: [], fingerprint: null },
      edge: {
        host: this.settings.edge.host,
        aaaa: null,
        a: null,
        pinned: null,
        family: null,
        prefer: this.settings.edge.prefer,
        resolvedAt: null,
        error: null,
      },
      stats: { hops: 0, triggers: 0, blacklisted: 0, projects: null, chats: null },
      toggles: { ...this.persisted.toggles },
      guard: {
        watching: false,
        path: this.paths.clientLog,
        lastTriggerAt: null,
        cooldownUntil: null,
        cooldownMs: 75000,
        triggers: 0,
      },
      keeper: {
        running: false,
        lastBeatAt: null,
        failures: 0,
        intervalMs: this.settings.keeper.intervalMs,
      },
      paths: {
        home,
        pool: this.paths.pool,
        logs: this.paths.logs,
        clientLog: this.paths.clientLog,
        guardLog: path.join(this.paths.logs, 'guard.log'),
        keeperLog: path.join(this.paths.logs, 'keeper.log'),
        appLog: path.join(this.paths.logs, 'app.log'),
        settings: this.paths.settings,
        engineConfig: this.paths.engineConfig,
      },
      platform: process.platform,
      lastError: null,
      lastErrorCode: null,
    };
  }

  // -- lifecycle -----------------------------------------------------------

  async init() {
    await fsp.mkdir(this.paths.pool, { recursive: true });
    await fsp.mkdir(this.paths.logs, { recursive: true });
    await fsp.mkdir(this.paths.runtime, { recursive: true });
    await fsp.mkdir(this.paths.workspace, { recursive: true });

    await this.loadSettings();
    await this.loadPersisted();
    this.logs.maxBytes = this.settings.logs.maxBytes;
    await this.logs.init();

    this.log('app', 'info', `console home ${this.home}`);
    this.log('app', 'info', `proxy target ${this.settings.proxy.host}:${this.settings.proxy.port}`);

    await this.rescanPool({ quiet: true, preferred: this.persisted.currentConfig });
    await this.resolveEdge({ quiet: true });

    this.state.toggles = { ...this.persisted.toggles };
    this.state.stats.hops = this.persisted.hops;
    this.state.stats.triggers = this.persisted.triggers;
    this.state.stats.blacklisted = this.persisted.blacklisted;
    this.state.guard.triggers = this.persisted.triggers;

    if (app) {
      try {
        this.state.toggles.autoStart = app.getLoginItemSettings().openAtLogin;
      } catch {
        /* not supported on this platform */
      }
    }

    this.engine = new EngineManager({
      command: this.settings.engine.command,
      args: this.settings.engine.args,
      home: this.home,
      host: this.settings.proxy.host,
      port: this.settings.proxy.port,
      configPath: this.paths.engineConfig,
      timeoutMs: this.settings.engine.timeoutMs,
      log: (tab, level, text) => this.log(tab, level, text),
      onUnexpectedExit: (info) => this.handleEngineExit(info),
    });

    this.guard = new LogGuard({
      filePath: this.paths.clientLog,
      cooldownMs: this.settings.guard.cooldownMs,
      onLog: (level, text) => this.log('guard', level, text),
      onTrigger: (info) => {
        this.handleGuardTrigger(info).catch((error) =>
          this.log('guard', 'error', `guard handler failed: ${error.message}`),
        );
      },
    });

    if (!app) return;

    this.proxySession = session.fromPartition('deck-egress');
    this.directSession = session.fromPartition('deck-direct');

    this.startKeeper();

    if (this.state.toggles.logGuard) {
      await this.startGuard().catch((error) =>
        this.log('guard', 'error', `log-guard failed to arm: ${error.message}`),
      );
    }

    this.computeStatus();
    this.broadcast();

    if (
      this.settings.autoConnect &&
      this.state.toggles.keeper &&
      !this.persisted.manualOffline &&
      this.pool.entries.length
    ) {
      setTimeout(() => {
        this.connect('startup').catch((error) =>
          this.log('app', 'error', `startup connect failed: ${error.message}`),
        );
      }, 500);
    }
  }

  async dispose() {
    this.stopKeeper();
    await this.guard?.stop();
    await this.engine?.stop();
    await this.savePersisted();
    await this.logs.flush().catch(() => {});
  }

  // -- persistence ---------------------------------------------------------

  async loadSettings() {
    const raw = await fsp.readFile(this.paths.settings, 'utf8').catch(() => null);
    let loaded;

    if (!raw) {
      loaded = defaultSettings();
      await fsp.writeFile(this.paths.settings, `${JSON.stringify(loaded, null, 2)}\n`, 'utf8');
      this.settings = this.materializeSettings(loaded);
    } else {
      try {
        loaded = normalizeSettings(JSON.parse(raw));
      } catch (error) {
        this.log('app', 'error', `settings.json is invalid (${error.message}) — using defaults`);
        loaded = defaultSettings();
      }
      this.settings = this.materializeSettings(loaded);
    }

    this.paths.pool = this.settings.poolDir;
    this.paths.clientLog = this.settings.clientLogPath;
    this.paths.workspace = this.settings.workspaceDir;

    this.state.proxy = {
      host: this.settings.proxy.host,
      port: this.settings.proxy.port,
      listening: false,
    };
    this.state.pool.dir = this.paths.pool;
    this.state.guard.path = this.paths.clientLog;
    this.state.guard.cooldownMs = this.settings.guard.cooldownMs;
    this.state.paths = {
      ...this.state.paths,
      pool: this.paths.pool,
      clientLog: this.paths.clientLog,
      workspace: this.paths.workspace,
    };
    this.state.engine.command = this.settings.engine.command;
    this.state.keeper.intervalMs = this.settings.keeper.intervalMs;
  }

  /** Make every path in settings absolute so the UI can display it. */
  materializeSettings(settings) {
    return {
      ...settings,
      poolDir: resolveDataPath(this.home, settings.poolDir),
      clientLogPath: resolveDataPath(this.home, settings.clientLogPath),
      workspaceDir: resolveDataPath(this.home, settings.workspaceDir),
      engine: {
        ...settings.engine,
        command: resolveSettingPath(this.home, settings.engine.command),
      },
    };
  }

  async loadPersisted() {
    const raw = await fsp.readFile(this.paths.state, 'utf8').catch(() => null);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.persisted = {
        ...this.persisted,
        ...parsed,
        toggles: { ...this.persisted.toggles, ...(parsed.toggles || {}) },
      };
    } catch {
      /* corrupted state is not fatal */
    }
  }

  async savePersisted() {
    this.persisted.hops = this.state.stats.hops;
    this.persisted.triggers = this.state.guard.triggers;
    this.persisted.blacklisted = this.state.stats.blacklisted;
    this.persisted.currentConfig = this.currentEntry?.name ?? this.state.pool.currentFile;
    this.persisted.toggles = { ...this.state.toggles };

    const payload = JSON.stringify(this.persisted, null, 2);
    await fsp.writeFile(this.paths.state, `${payload}\n`, 'utf8').catch(() => {});
  }

  // -- logging -------------------------------------------------------------

  log(tab, level, text) {
    return this.logs.append(tab, level, text);
  }

  send(channel, payload) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  broadcast() {
    this.computeStatus();
    this.send('deck:state', this.publicState());
  }

  publicState() {
    return {
      ...this.state,
      egress: { ...this.state.egress, fresh: this.egressFresh() },
      stats: {
        ...this.state.stats,
        configs: this.pool.entries.length,
      },
      pool: {
        ...this.state.pool,
        total: this.pool.entries.length,
        entries: this.pool.entries,
        errors: this.pool.errors,
        dir: this.paths.pool,
        currentFile: this.currentEntry?.name ?? null,
        index: this.currentEntry
          ? this.pool.entries.findIndex((entry) => entry.name === this.currentEntry.name)
          : -1,
      },
      guard: { ...this.state.guard, watching: Boolean(this.guard?.watching) },
      keeper: { ...this.state.keeper, running: this.state.toggles.keeper },
      paths: { ...this.state.paths },
    };
  }

  /** A verification is only trustworthy for `probe.staleAfterMs`. */
  egressFresh() {
    const { verified, checkedAt } = this.state.egress || {};
    if (!verified || !checkedAt) return false;
    const ttl = Number(this.settings?.probe?.staleAfterMs) || 180000;
    const checked = Date.parse(checkedAt);
    if (!Number.isFinite(checked)) return false;
    return Date.now() - checked <= ttl;
  }

  computeStatus() {
    if (this.state.rotating) {
      this.state.status = 'rotating';
      return;
    }
    if (!this.pool.entries.length && !this.state.connected) {
      this.state.status = 'pool-empty';
      return;
    }
    if (this.state.connected) {
      if (this.state.egress.leaked) {
        this.state.status = 'leaked';
      } else {
        this.state.status = this.egressFresh() ? 'protected' : 'degraded';
      }
      return;
    }
    if (this.state.lastErrorCode === 'ENGINE_MISSING') {
      this.state.status = 'engine-missing';
      return;
    }
    if (this.state.lastError) {
      this.state.status = 'fault';
      return;
    }
    this.state.status = this.persisted.manualOffline ? 'disconnected' : 'idle';
  }

  // -- pool ----------------------------------------------------------------

  async rescanPool({ quiet = false, preferred = null } = {}) {
    const previous = this.currentEntry?.name ?? preferred ?? null;
    this.pool = await scanPool(this.paths.pool);
    this.state.pool = {
      dir: this.paths.pool,
      total: this.pool.entries.length,
      entries: this.pool.entries,
      errors: this.pool.errors,
      currentFile: previous,
      index: -1,
    };
    this.state.stats.configs = this.pool.entries.length;

    for (const error of this.pool.errors) {
      this.log('app', 'warn', `pool: ${error.name} rejected — ${error.message}`);
    }

    if (previous) {
      const match = this.pool.entries.find((entry) => entry.name === previous);
      this.currentEntry = match || (this.pool.entries[0] ?? null);
    } else {
      this.currentEntry = this.pool.entries[0] ?? null;
    }

    if (!quiet) {
      this.log(
        'app',
        this.pool.entries.length ? 'success' : 'warn',
        `pool scanned · ${this.pool.entries.length} config(s) in ${this.paths.pool}${
          this.pool.errors.length ? ` · ${this.pool.errors.length} rejected` : ''
        }`,
      );
    }
    return this.pool;
  }

  // -- edge / stats --------------------------------------------------------

  async resolveEdge({ quiet = false } = {}) {
    const host = this.settings.edge.host;
    if (!host) return;

    const [aaaa, a] = await Promise.allSettled([
      withTimeout(dns.resolve6(host), 4500, 'AAAA lookup'),
      withTimeout(dns.resolve4(host), 4500, 'A lookup'),
    ]);

    const aaaaValue = aaaa.status === 'fulfilled' ? aaaa.value[0] : null;
    const aValue = a.status === 'fulfilled' ? a.value[0] : null;
    const error =
      !aaaaValue && !aValue
        ? (aaaa.status === 'rejected' ? aaaa.reason.message : null) || 'no records'
        : null;

    const preferV6 = this.settings.edge.prefer === 'ipv6';
    const pinned = preferV6 ? aaaaValue || aValue : aValue || aaaaValue;

    this.state.edge = {
      host,
      aaaa: aaaaValue,
      a: aValue,
      pinned,
      family: pinned ? ipFamily(pinned) : null,
      prefer: this.settings.edge.prefer,
      resolvedAt: new Date().toISOString(),
      error,
    };
    this.broadcast();

    if (!quiet) {
      this.log(
        'keeper',
        error ? 'warn' : 'success',
        error
          ? `edge resolve failed · ${host} · ${error}`
          : `edge pinned · ${host} · AAAA ${aaaaValue || 'n/a'} · A ${aValue || 'n/a'} · using ${
              pinned || 'dns default'
            }`,
      );
    }
  }

  async scanWorkspace() {
    if (Date.now() - this.workspaceCache.at < 30000) return this.workspaceCache;

    const countDirs = async (dir) => {
      try {
        const items = await fsp.readdir(dir, { withFileTypes: true });
        return items.filter((item) => item.isDirectory()).length;
      } catch {
        return null;
      }
    };
    const countFiles = async (dir) => {
      try {
        const items = await fsp.readdir(dir, { withFileTypes: true });
        return items.filter((item) => item.isFile() && item.name.endsWith('.json')).length;
      } catch {
        return null;
      }
    };

    const [projects, chats] = await Promise.all([
      countDirs(path.join(this.paths.workspace, 'projects')),
      countFiles(path.join(this.paths.workspace, 'chats')),
    ]);

    this.workspaceCache = { at: Date.now(), projects, chats };
    this.state.stats.projects = projects;
    this.state.stats.chats = chats;
    return this.workspaceCache;
  }

  // -- engine / egress -----------------------------------------------------

  async resolveServerAddress(entry) {
    const host = entry.endpointHost;
    if (!host) return null;
    if (ipFamily(host)) return host;

    const prefer = this.settings.edge.prefer === 'ipv6' ? 6 : 4;
    const fallback = prefer === 6 ? 4 : 6;

    // Pin the address already resolved for the UI so the engine talks to the
    // IP shown on the dashboard instead of a second, possibly different lookup.
    if (host === this.settings.edge.host) {
      const pinned =
        this.state.edge.pinned || (prefer === 6 ? this.state.edge.aaaa : this.state.edge.a);
      if (pinned && ipFamily(pinned)) return pinned;
    }

    for (const family of [prefer, fallback]) {
      try {
        const result = await withTimeout(dns.lookup(host, { family }), 4000, `DNS ${host}`);
        if (ipFamily(result.address)) return result.address;
      } catch {
        /* try the other family */
      }
    }
    return null; // sing-box will resolve the hostname itself
  }

  applyAdapter(conf, format) {
    this.state.adapter = {
      name: conf.name,
      ipv4: conf.ipv4,
      ipv6: conf.ipv6,
      mtu: conf.mtu,
      dns: conf.dns,
      fingerprint: conf.fingerprint,
    };
    this.state.engine = {
      ...this.state.engine,
      state: 'running',
      pid: this.engine?.child?.pid ?? null,
      format,
      startedAt: this.engine?.startedAt ? new Date(this.engine.startedAt).toISOString() : null,
      version: this.engine?.version ?? null,
      error: null,
    };
    this.state.proxy.listening = true;
  }

  async startEntry(entry) {
    const { conf } = await loadWarpConfig(entry.path);
    const serverAddress = await this.resolveServerAddress(entry);
    await this.engine.detect();

    const preferred = this.engine.supportsEndpoints ? 'endpoints' : 'outbound';
    const formats = preferred === 'endpoints' ? ['endpoints', 'outbound'] : ['outbound'];
    let lastError = null;

    for (const format of formats) {
      try {
        const config = renderSingBoxConfig(conf, {
          listenHost: this.settings.proxy.host,
          listenPort: this.settings.proxy.port,
          format,
          serverAddress,
        });
        await this.engine.start({ config, entryName: entry.name, format });
        this.currentEntry = entry;
        this.applyAdapter(conf, format);
        this.state.pool.currentFile = entry.name;
        return;
      } catch (error) {
        lastError = error;
        this.log('app', 'warn', `engine start failed (${format}): ${error.message}`);
        if (error.code === 'ENGINE_MISSING') break;
      }
    }

    throw lastError || new Error('engine failed to start');
  }

  async fetchIp(url, viaProxy) {
    const targetSession = viaProxy ? this.proxySession : this.directSession;
    if (!targetSession) throw new Error('probe session unavailable');

    if (viaProxy) {
      await targetSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: `socks5://${this.settings.proxy.host}:${this.settings.proxy.port}`,
        proxyBypassRules: '',
      });
    } else {
      await targetSession.setProxy({ mode: 'direct' });
    }

    // net.fetch ignores a session-level proxy (a dead proxy still returns the
    // direct egress), so the probe uses net.request, which honours it.
    const text = await new Promise((resolve, reject) => {
      const timeoutMs = this.settings.probe.timeoutMs;
      const request = net.request({ url, session: targetSession, useSessionCookies: false });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        try {
          request.abort();
        } catch {
          /* already closed */
        }
        finish(reject, new Error(`probe timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let body = '';
      request.on('response', (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          try {
            request.abort();
          } catch {
            /* already closed */
          }
          finish(reject, new Error(`HTTP ${response.statusCode} from probe endpoint`));
          return;
        }
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => finish(resolve, body.trim()));
        response.on('error', (error) => finish(reject, error));
      });
      request.on('error', (error) => finish(reject, error));
      request.setHeader('cache-control', 'no-store');
      request.end();
    });
    let ip = null;
    try {
      const json = JSON.parse(text);
      ip = json.ip || json.address || json.query || null;
    } catch {
      const match = /([0-9a-f]{0,4}:[0-9a-f:]+|\d{1,3}(?:\.\d{1,3}){3})/i.exec(text);
      ip = match ? match[1] : text;
    }

    if (!ip || !ipFamily(ip)) throw new Error('probe response did not contain a valid IP');
    return ip;
  }

  async probe({ viaProxy = true, compareDirect = false } = {}) {
    const urls = this.settings.probe.urls || [];
    let lastError = null;

    for (const url of urls) {
      try {
        const ip = await this.fetchIp(url, viaProxy);
        const family = ipFamily(ip);
        const block64 = family === 'ipv6' ? ipv6Block64(ip) : null;
        let directIp = null;
        let leaked = false;

        if (compareDirect) {
          try {
            directIp = await this.fetchIp(url, false);
            leaked = Boolean(directIp && directIp === ip);
          } catch {
            directIp = null;
          }
        }

        this.state.egress = {
          ip,
          family,
          block64,
          subnet64: family === 'ipv6' ? ipv6Subnet64(ip) : null,
          verified: true,
          leaked,
          directIp,
          checkedAt: new Date().toISOString(),
          error: null,
        };

        if (leaked) {
          this.log('keeper', 'warn', `egress leak check · proxied and direct IP match (${ip})`);
        }
        return this.state.egress;
      } catch (error) {
        lastError = error;
        this.log('app', 'warn', `probe ${url} failed: ${error.message}`);
      }
    }

    this.state.egress = {
      ...this.state.egress,
      verified: false,
      checkedAt: new Date().toISOString(),
      error: lastError?.message || 'no probe endpoint reachable',
    };
    return this.state.egress;
  }

  // -- connection lifecycle ------------------------------------------------

  /**
   * Start the preferred config, falling back to the next pool entries when a
   * config cannot start. A single expired/blackholed config must not trap the
   * keeper in a connect-fail loop.
   */
  async startAnyEntry(preferredName = null, { attempts = 3, onAttempt = null } = {}) {
    const total = Math.min(attempts, this.pool.entries.length);
    let entry =
      this.pool.entries.find((item) => item.name === preferredName) ??
      this.pool.entries[0] ??
      null;
    const tried = new Set();
    let lastError = null;

    for (let attempt = 0; attempt < total; attempt += 1) {
      if (!entry) break;
      if (tried.has(entry.name)) {
        entry = nextEntry(this.pool.entries, entry.name);
        if (!entry || tried.has(entry.name)) break;
        continue;
      }
      tried.add(entry.name);
      try {
        await this.startEntry(entry);
        return entry;
      } catch (error) {
        lastError = error;
        try {
          onAttempt?.(entry, error);
        } catch {
          /* never let a logging callback abort the fallback loop */
        }
        if (error.code === 'ENGINE_MISSING') break;
        entry = nextEntry(this.pool.entries, entry.name);
      }
    }

    throw lastError || new Error('no config could be started');
  }

  async connect(reason = 'manual') {
    if (this.rotating) return { ok: false, message: 'Rotation already in progress.' };
    if (!this.pool.entries.length) await this.rescanPool({ quiet: true });
    if (!this.pool.entries.length) {
      this.state.lastError = `No .conf files in ${this.paths.pool}.`;
      this.state.lastErrorCode = 'POOL_EMPTY';
      this.computeStatus();
      this.broadcast();
      return { ok: false, message: `No .conf files in ${this.paths.pool}.` };
    }

    const preferredName = this.currentEntry?.name ?? this.persisted.currentConfig ?? null;

    this.rotating = true;
    this.state.rotating = true;
    this.state.lastError = null;
    this.state.lastErrorCode = null;
    this.log(
      'keeper',
      'info',
      `${reason === 'startup' ? 'auto-connect' : reason === 'keeper' ? 'keeper restart' : 'operator connect'} -> ${preferredName || 'first available config'}`,
    );
    this.broadcast();

    const startedAt = Date.now();
    try {
      const started = await this.startAnyEntry(preferredName, {
        attempts: 3,
        onAttempt: (entry, error) =>
          this.log(
            'keeper',
            'warn',
            `${entry.name} failed to start · ${error.message} · trying next config`,
          ),
      });
      this.state.connected = true;
      this.persisted.manualOffline = false;
      await this.probe({ compareDirect: this.settings.probe.compareDirect });
      await this.scanWorkspace();
      // A live port is not proof of a working tunnel: sing-box can bind the
      // inbound and still log "no route to internet". Only claim "tunnel up"
      // when the egress probe actually came back verified.
      const verified = this.state.egress.verified === true;
      this.log(
        'keeper',
        verified ? 'success' : 'warn',
        verified
          ? `tunnel up · ${started.name} · ${Date.now() - startedAt}ms · proxy ${this.settings.proxy.host}:${this.settings.proxy.port}`
          : `tunnel listening but egress unverified · ${started.name} · ${Date.now() - startedAt}ms · ${this.state.egress.error || 'probe failed'}`,
      );
      this.state.pool.currentFile = started.name;
      await this.savePersisted();
      return { ok: true, message: `Tunnel up via ${started.name}.` };
    } catch (error) {
      this.state.connected = false;
      this.state.lastError = error.message;
      this.state.lastErrorCode = error.code || 'CONNECT_FAILED';
      this.state.engine = {
        ...this.state.engine,
        state: 'stopped',
        pid: null,
        error: error.message,
      };
      this.log('keeper', 'error', `tunnel up failed · ${error.message}`);
      return { ok: false, message: error.message };
    } finally {
      this.rotating = false;
      this.state.rotating = false;
      this.computeStatus();
      this.broadcast();
    }
  }

  async disconnect({ manual = true } = {}) {
    this.persisted.manualOffline = manual;
    await this.engine?.stop().catch(() => {});
    this.state.connected = false;
    this.state.engine = {
      ...this.state.engine,
      state: 'stopped',
      pid: null,
      startedAt: null,
      error: null,
    };
    this.state.proxy.listening = false;
    this.state.egress = { ...this.state.egress, verified: false };
    this.state.lastError = null;
    this.state.lastErrorCode = null;
    this.log('keeper', 'warn', 'tunnel disconnected by operator · engine stopped');
    this.computeStatus();
    await this.savePersisted();
    this.broadcast();
    return { ok: true, message: 'Tunnel disconnected.' };
  }

  async rotate(reason = 'manual') {
    if (this.rotating) return { ok: false, message: 'Rotation already in progress.' };
    if (!this.pool.entries.length) {
      return { ok: false, message: 'Config pool is empty.' };
    }
    if (!this.state.connected) {
      this.log('guard', 'warn', 'rotation requested while tunnel is offline · starting the next config');
    }

    const label =
      reason === 'log-guard'
        ? 'log-guard detected trigger'
        : reason === 'keeper'
          ? 'keeper watchdog'
          : 'operator hop';

    this.rotating = true;
    this.state.rotating = true;
    this.state.lastError = null;
    this.state.lastErrorCode = null;
    this.broadcast();

    const startedAt = Date.now();
    const previousName = this.currentEntry?.name ?? null;
    const previousBlock = this.state.egress.block64;

    const firstCandidate = nextEntry(this.pool.entries, previousName);
    let started = null;

    try {
      started = await this.startAnyEntry(firstCandidate?.name ?? null, {
        attempts: 3,
        onAttempt: (entry, error) =>
          this.log(
            'guard',
            'error',
            `${label} -> rotating to ${entry.name} -> failed: ${error.message}`,
          ),
      });

      this.state.connected = true;
      await this.probe({ compareDirect: this.settings.probe.compareDirect });
      await this.scanWorkspace();

      this.state.stats.hops += 1;
      // A /64 is only "retired" when its quota was exhausted; keeper and manual
      // hops are routine swaps. previousBlock is null on IPv4 egress, so key the
      // counter off the trigger reason instead of the egress family.
      const retired = reason === 'log-guard';
      this.state.stats.blacklisted += retired ? 1 : 0;
      this.state.pool.currentFile = started.name;

      const elapsed = Date.now() - startedAt;
      this.log('guard', 'success', `${label} -> rotating to ${started.name} -> success.`);
      this.log(
        'guard',
        'info',
        `hop #${this.state.stats.hops} · ${previousBlock || this.state.egress.block64 || 'no previous /64'} -> ${
          this.state.egress.block64 || this.state.egress.ip || 'probe pending'
        } · ${elapsed}ms`,
      );

      if (retired) {
        this.log(
          'guard',
          'warn',
          `${previousName || 'previous config'} retired · ${previousBlock || 'unknown egress'} burned by quota`,
        );
      }

      await this.savePersisted();
      return { ok: true, message: `Hop #${this.state.stats.hops} complete · ${started.name}` };
    } catch (error) {
      this.state.lastError = error.message;
      this.state.lastErrorCode = error.code || 'ROTATE_FAILED';
      this.state.connected = false;
      this.state.engine = { ...this.state.engine, state: 'stopped', pid: null, error: error.message };
      this.state.proxy.listening = false;
      this.log('guard', 'error', `rotation failed · ${error.message}`);
      return { ok: false, message: error.message };
    } finally {
      this.rotating = false;
      this.state.rotating = false;
      this.computeStatus();
      this.broadcast();
    }
  }

  async selectConfig(name) {
    if (this.rotating) return { ok: false, message: 'Rotation already in progress.' };
    if (!this.pool.entries.length) await this.rescanPool({ quiet: true });

    const entry = this.pool.entries.find((item) => item.name === name);
    if (!entry) return { ok: false, message: `Config not found: ${name}` };
    if (this.state.connected && this.currentEntry?.name === entry.name) {
      return { ok: true, message: `${entry.name} is already active.` };
    }

    this.rotating = true;
    this.state.rotating = true;
    this.state.lastError = null;
    this.state.lastErrorCode = null;
    this.broadcast();

    const startedAt = Date.now();
    try {
      const started = await this.startAnyEntry(entry.name, { attempts: 1 });
      this.state.connected = true;
      await this.probe({ compareDirect: this.settings.probe.compareDirect });
      await this.scanWorkspace();
      this.state.pool.currentFile = started.name;
      this.log(
        'keeper',
        'success',
        `operator select -> ${started.name} -> success · ${Date.now() - startedAt}ms`,
      );
      await this.savePersisted();
      return { ok: true, message: `Switched to ${started.name}.` };
    } catch (error) {
      this.state.lastError = error.message;
      this.state.lastErrorCode = error.code || 'SELECT_FAILED';
      this.state.connected = false;
      this.state.engine = { ...this.state.engine, state: 'stopped', pid: null, error: error.message };
      this.state.proxy.listening = false;
      this.log('keeper', 'error', `select ${entry.name} failed · ${error.message}`);
      return { ok: false, message: error.message };
    } finally {
      this.rotating = false;
      this.state.rotating = false;
      this.computeStatus();
      this.broadcast();
    }
  }

  async clearLogs(tab) {
    if (!LOG_TABS.includes(tab)) return { ok: false, message: `Unknown log tab: ${tab}` };
    await this.logs.clear(tab);
    return { ok: true, message: `${tab}.log cleared.` };
  }

  async handleGuardTrigger(info) {
    this.state.guard.lastTriggerAt = new Date(info.at).toISOString();
    this.state.guard.cooldownUntil = new Date(info.at + this.settings.guard.cooldownMs).toISOString();

    this.log('guard', 'warn', `QuotaExceeded detected in client.log · ${info.line}`);

    if (!this.state.toggles.logGuard) {
      this.log('guard', 'warn', 'log-guard is disabled · trigger ignored');
      await this.savePersisted();
      this.broadcast();
      return;
    }
    if (this.rotating) {
      this.log('guard', 'warn', 'log-guard trigger ignored · rotation already in flight');
      await this.savePersisted();
      this.broadcast();
      return;
    }
    if (!this.state.connected) {
      this.log('guard', 'warn', 'log-guard detected trigger -> tunnel offline · hop skipped.');
      await this.savePersisted();
      this.broadcast();
      return;
    }

    // Only triggers that actually caused a hop are counted, so the counter
    // reads as "quota events acted on", not "quota lines seen".
    this.state.guard.triggers += 1;
    this.state.stats.triggers = this.state.guard.triggers;
    await this.savePersisted();
    this.broadcast();

    const result = await this.rotate('log-guard');
    if (!result.ok) {
      this.log('guard', 'error', `log-guard rotation aborted · ${result.message}`);
    }
  }

  handleEngineExit(info) {
    if (this.rotating) return;
    this.state.connected = false;
    this.state.engine = {
      ...this.state.engine,
      state: 'stopped',
      pid: null,
      error: `engine exited (code ${info.code ?? 'null'})`,
    };
    this.state.proxy.listening = false;
    this.state.lastError = this.state.engine.error;
    this.state.lastErrorCode = 'ENGINE_EXIT';
    this.log('keeper', 'error', 'engine died unexpectedly · keeper will recover');

    if (this.state.toggles.keeper && !this.persisted.manualOffline) {
      setTimeout(() => {
        this.connect('keeper').catch((error) =>
          this.log('keeper', 'error', `keeper recovery failed · ${error.message}`),
        );
      }, 1200);
    }

    this.computeStatus();
    this.broadcast();
  }

  // -- keeper --------------------------------------------------------------

  startKeeper() {
    this.stopKeeper();
    this.keeperTimer = setInterval(() => {
      this.keeperTick().catch((error) =>
        this.log('keeper', 'error', `keeper tick failed · ${error.message}`),
      );
    }, this.settings.keeper.intervalMs);
  }

  stopKeeper() {
    if (this.keeperTimer) clearInterval(this.keeperTimer);
    this.keeperTimer = null;
    this.state.keeper.running = false;
  }

  async keeperTick() {
    if (this.keeperBusy || this.rotating) return;
    this.keeperBusy = true;

    try {
      const enabled = this.state.toggles.keeper;
      this.state.keeper.running = enabled;
      if (!enabled || this.persisted.manualOffline) return;

      const portUp = await canConnect(
        this.settings.proxy.host,
        this.settings.proxy.port,
        800,
      );
      this.state.proxy.listening = portUp;

      if (!portUp) {
        this.keeperFailures += 1;
        this.state.keeper.failures = this.keeperFailures;
        this.log(
          'keeper',
          'warn',
          `proxy ${this.settings.proxy.host}:${this.settings.proxy.port} not listening (${this.keeperFailures}/${this.settings.keeper.failuresBeforeRestart})`,
        );

        if (this.keeperFailures >= this.settings.keeper.failuresBeforeRestart) {
          this.keeperFailures = 0;
          this.state.keeper.failures = 0;
          if (this.state.connected) await this.rotate('keeper');
          else await this.connect('keeper');
        }
      } else {
        this.keeperFailures = 0;
        this.state.keeper.failures = 0;
        this.state.keeper.lastBeatAt = new Date().toISOString();

        // Port reachability is not proof of a clean egress: re-verify on a TTL
        // so a stale "verified" badge can never outlive the actual tunnel.
        if (this.state.connected) {
          const checked = Date.parse(this.state.egress.checkedAt || '');
          const age = Number.isFinite(checked) ? Date.now() - checked : Infinity;
          if (age >= this.settings.probe.refreshMs) {
            const egress = await this.probe({
              compareDirect: this.settings.probe.compareDirect,
            });
            if (egress.leaked) {
              this.log(
                'keeper',
                'warn',
                `egress recheck · proxy and direct IP still match (${egress.ip})`,
              );
            } else if (egress.verified) {
              this.log(
                'keeper',
                'info',
                `egress recheck · ${egress.ip} · ${egress.family || 'unknown'}`,
              );
            } else {
              this.log('keeper', 'warn', `egress recheck failed · ${egress.error}`);
            }
          }
        }

        if (Date.now() - this.lastHeartbeatLog > this.settings.keeper.heartbeatLogMs) {
          this.lastHeartbeatLog = Date.now();
          this.log(
            'keeper',
            'info',
            `heartbeat ok · engine ${this.state.engine.state} · proxy reachable · pid ${this.state.engine.pid ?? '—'}`,
          );
        }
      }

      this.computeStatus();
      this.broadcast();
    } finally {
      this.keeperBusy = false;
    }
  }

  // -- guard ---------------------------------------------------------------

  async startGuard() {
    if (!this.guard) return;
    if (this.guard.watching) return;
    await this.guard.start();
    this.state.guard.watching = true;
    this.log('guard', 'info', `log-guard armed · watching ${this.paths.clientLog}`);
    this.broadcast();
  }

  async stopGuard() {
    if (!this.guard) return;
    await this.guard.stop();
    this.state.guard.watching = false;
    this.log('guard', 'warn', 'log-guard disarmed · client.log no longer watched');
    this.broadcast();
  }

  // -- actions -------------------------------------------------------------

  async toggle(id, enabled) {
    if (!TOGGLE_IDS.includes(id)) throw new Error(`Unknown toggle: ${id}`);
    const next = Boolean(enabled);
    this.state.toggles[id] = next;

    if (id === 'keeper') {
      this.state.keeper.running = next;
      this.log('keeper', next ? 'success' : 'warn', `proxy keeper ${next ? 'enabled' : 'disabled'}`);
      if (next && !this.state.connected && !this.persisted.manualOffline && this.pool.entries.length) {
        await this.connect('keeper');
      }
    } else if (id === 'logGuard') {
      if (next) await this.startGuard();
      else await this.stopGuard();
    } else if (id === 'desktopProxy') {
      this.log(
        'app',
        next ? 'success' : 'warn',
        next
          ? `desktop app proxy wired · launched clients get HTTP(S)_PROXY=http://${this.settings.proxy.host}:${this.settings.proxy.port}`
          : 'desktop app proxy unwired · launched clients use direct egress',
      );
    } else if (id === 'autoStart') {
      if (app) {
        const args = app.isPackaged ? [] : [PROJECT_ROOT];
        app.setLoginItemSettings({ openAtLogin: next, path: process.execPath, args });
        const actual = app.getLoginItemSettings().openAtLogin;
        this.state.toggles.autoStart = actual;
        this.log(
          'app',
          actual === next ? 'success' : 'warn',
          `auto-start ${actual ? 'enabled' : 'disabled'} · ${actual ? 'launches at Windows sign-in' : 'login item removed'}`,
        );
      }
    }

    await this.savePersisted();
    this.broadcast();
    return { ok: true, message: `${id} ${next ? 'enabled' : 'disabled'}` };
  }

  async launch(kind) {
    if (kind !== 'desktop' && kind !== 'cli') throw new Error(`Unknown launch target: ${kind}`);
    const client = this.settings.client[kind];
    const label = kind === 'desktop' ? 'Client Desktop' : 'Client CLI';

    if (!client?.command) {
      const message = `${label} is not configured. Set client.${kind}.command in settings.json.`;
      this.log('app', 'error', `launch failed · ${message}`);
      return { ok: false, message };
    }

    const env = { ...process.env };
    const proxyEnabled = Boolean(this.state.toggles.desktopProxy);
    if (proxyEnabled) {
      const proxyUrl = `http://${this.settings.proxy.host}:${this.settings.proxy.port}`;
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.ALL_PROXY = proxyUrl;
      env.NO_PROXY = 'localhost,127.0.0.1,::1';
    }

    const cwd = client.cwd ? resolveSettingPath(this.home, client.cwd) : this.home;
    const args =
      kind === 'desktop' ? desktopProxyArgs(client.args, proxyEnabled) : [...(client.args || [])];
    if (kind === 'desktop' && !proxyEnabled && args.length !== (client.args || []).length) {
      this.log(
        'app',
        'warn',
        `desktop app proxy unwired · stripped proxy switches from ${label} args`,
      );
    }

    try {
      const child = spawn(client.command, args, {
        cwd,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });

      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();

      this.log(
        'app',
        'success',
        `${label} launched · pid ${child.pid} · proxy ${proxyEnabled ? 'wired' : 'direct'}`,
      );
      return {
        ok: true,
        message: `${label} launched${proxyEnabled ? ' via :41987' : ''}.`,
      };
    } catch (error) {
      const message = `${label} launch failed: ${error.message}`;
      this.log('app', 'error', message);
      return { ok: false, message };
    }
  }

  async refresh() {
    if (this.rotating) return { ok: false, message: 'Rotation in progress.' };
    await this.rescanPool({ quiet: true });
    await this.resolveEdge({ quiet: true });
    if (this.state.connected) {
      await this.probe({ compareDirect: this.settings.probe.compareDirect });
    }
    await this.scanWorkspace();
    this.state.proxy.listening = await canConnect(
      this.settings.proxy.host,
      this.settings.proxy.port,
      700,
    );
    this.log(
      'app',
      'info',
      `console refreshed · pool ${this.pool.entries.length} · engine ${this.state.engine.state} · ${
        this.state.egress.ip || 'no egress probe'
      }`,
    );
    this.computeStatus();
    this.broadcast();
    return { ok: true, message: 'Console refreshed.' };
  }

  async choosePoolDir() {
    if (!app) return { ok: false, message: 'Not running in Electron.' };
    const result = await dialog.showOpenDialog(this.win, {
      title: 'Select WireGuard config pool',
      defaultPath: this.paths.pool,
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, message: 'Cancelled.' };

    this.paths.pool = result.filePaths[0];
    this.settings.poolDir = this.paths.pool;
    this.state.paths.pool = this.paths.pool;
    this.state.pool.dir = this.paths.pool;
    await this.writeSettings();
    await this.rescanPool();
    this.broadcast();
    return { ok: true, message: `Pool set to ${this.paths.pool}` };
  }

  async chooseClientLog() {
    if (!app) return { ok: false, message: 'Not running in Electron.' };
    const result = await dialog.showOpenDialog(this.win, {
      title: 'Select client log file',
      defaultPath: this.paths.clientLog,
      properties: ['openFile'],
      filters: [{ name: 'Log files', extensions: ['log', 'txt'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, message: 'Cancelled.' };

    await this.stopGuard();
    this.paths.clientLog = result.filePaths[0];
    this.settings.clientLogPath = this.paths.clientLog;
    this.state.paths.clientLog = this.paths.clientLog;
    this.state.guard.path = this.paths.clientLog;
    if (this.guard) this.guard.filePath = this.paths.clientLog;
    await this.writeSettings();
    if (this.state.toggles.logGuard) await this.startGuard();
    this.log('guard', 'info', `client log target updated · ${this.paths.clientLog}`);
    this.broadcast();
    return { ok: true, message: `Guard watching ${this.paths.clientLog}` };
  }

  async writeSettings() {
    const payload = {
      ...this.settings,
      poolDir: relativize(this.home, this.paths.pool),
      clientLogPath: relativize(this.home, this.paths.clientLog),
      workspaceDir: relativize(this.home, this.paths.workspace),
      engine: {
        ...this.settings.engine,
        command: relativize(this.home, this.settings.engine.command),
      },
    };
    await fsp.writeFile(this.paths.settings, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  async openPath(target) {
    const result = await shell.openPath(target);
    return result ? { ok: false, message: result } : { ok: true, message: 'Opened.' };
  }

  getState() {
    return { state: this.publicState(), logs: this.logs.snapshot() };
  }
}

// ---------------------------------------------------------------------------
// Electron shell
// ---------------------------------------------------------------------------

function resolveHome() {
  if (process.env.DECK_HOME) return path.resolve(process.env.DECK_HOME);
  if (app?.isPackaged) return app.getPath('userData');
  return PROJECT_ROOT;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 1040,
    minWidth: 1120,
    minHeight: 780,
    show: false,
    frame: false,
    title: 'Egress Monitor',
    backgroundColor: '#050a0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    if (!isScreenshotRun) mainWindow.show();
  });
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-state', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-state', false);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    // In production only the bundled renderer may be navigated to; a bare
    // `file:` prefix would accept any local file, including attacker-dropped HTML.
    const allowed = DEV_URL
      ? targetUrl.startsWith(DEV_URL)
      : targetUrl.startsWith(`file://${path.join(DIST_DIR, 'index.html')}`);
    if (!allowed) event.preventDefault();
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  return mainWindow;
}

function registerIpc() {
  const safe = (handler) => async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      deck?.log('app', 'error', error.message);
      return { ok: false, message: error.message };
    }
  };

  ipcMain.handle('deck:state', safe(() => deck.getState()));
  ipcMain.handle('deck:refresh', safe(() => deck.refresh()));
  ipcMain.handle('deck:rotate', safe(() => deck.rotate('manual')));
  ipcMain.handle('deck:select-config', safe((_event, name) => deck.selectConfig(String(name))));
  ipcMain.handle('deck:logs:clear', safe((_event, tab) => deck.clearLogs(String(tab))));
  ipcMain.handle('deck:connect', safe(() => deck.connect('manual')));
  ipcMain.handle('deck:disconnect', safe(() => deck.disconnect({ manual: true })));
  ipcMain.handle('deck:toggle', safe((_event, id, enabled) => deck.toggle(id, enabled)));
  ipcMain.handle('deck:launch', safe((_event, kind) => deck.launch(kind)));
  ipcMain.handle('deck:pool:choose', safe(() => deck.choosePoolDir()));
  ipcMain.handle('deck:log:choose', safe(() => deck.chooseClientLog()));
  ipcMain.handle('deck:pool:open', safe(() => deck.openPath(deck.paths.pool)));
  ipcMain.handle('deck:logs:open', safe(() => deck.openPath(deck.paths.logs)));
  ipcMain.handle(
    'deck:copy',
    safe((_event, text) => {
      if (typeof text !== 'string') throw new TypeError('Clipboard payload must be a string.');
      clipboard.writeText(text);
      return { ok: true };
    }),
  );

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

async function bootstrap() {
  const home = resolveHome();
  const win = createWindow();
  deck = new Deck({ home, win });
  registerIpc();

  win.webContents.on('did-finish-load', () => {
    deck.broadcast();
  });

  if (isScreenshotRun) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          await fsp.mkdir(path.dirname(SCREENSHOT_PATH), { recursive: true });
          await fsp.writeFile(SCREENSHOT_PATH, image.toPNG());
          console.log(`Screenshot saved: ${SCREENSHOT_PATH}`);
        } catch (error) {
          console.error('Screenshot capture failed:', error);
          process.exitCode = 1;
        } finally {
          app.quit();
        }
      }, 7000);
    });
  }

  await deck.init();
}

const hasLock = app ? app.requestSingleInstanceLock() : true;

if (app && !hasLock) {
  app.quit();
} else if (app) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    bootstrap().catch((error) => {
      console.error('[egress-monitor] bootstrap failed:', error);
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        deck?.broadcast();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    Promise.resolve(deck?.dispose())
      .catch(() => {})
      .finally(() => app.quit());
  });
}

process.on('uncaughtException', (error) => {
  console.error('[egress-monitor] uncaught exception:', error);
  deck?.log('app', 'error', `uncaught exception · ${error.message}`);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('[egress-monitor] unhandled rejection:', reason);
  deck?.log('app', 'error', `unhandled rejection · ${message}`);
});

module.exports = {
  Deck,
  EngineError,
  EngineManager,
  LogBus,
  LogGuard,
  canConnect,
  defaultSettings,
  desktopProxyArgs,
  normalizeSettings,
  stamp,
  stripAnsi,
};

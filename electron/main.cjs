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
// EGRESS_HIDDEN=1 -> jalankan sebagai background service: window dibuat tapi
// tidak ditampilkan. Ikon tray diurus oleh tray.sh (yad), bukan Electron Tray.
const isHidden = ['1', 'true', 'yes'].includes(
  String(process.env.EGRESS_HIDDEN || '').toLowerCase(),
);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

const TOGGLE_IDS = ['keeper', 'logGuard', 'desktopProxy', 'autoStart'];
const LOG_TABS = ['guard', 'keeper', 'app'];

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const ENGINE_BIN = IS_WIN ? 'sing-box.exe' : 'sing-box';
const DEFAULT_ENGINE_COMMAND = `engine/${ENGINE_BIN}`;

/**
 * Terminals that accept "run this command" args, in the order Mint editions
 * ship them (Cinnamon, MATE, XFCE, then generic). Each entry appends the full
 * argv, so `-e`/`-x` receive `bash -lc <script>` as separate arguments.
 */
const LINUX_TERMINALS = [
  { command: 'gnome-terminal', prefix: ['--'] },
  { command: 'mate-terminal', prefix: ['-x'] },
  { command: 'xfce4-terminal', prefix: ['-x'] },
  { command: 'konsole', prefix: ['-e'] },
  { command: 'xterm', prefix: ['-e'] },
];

/** XDG autostart entry — Electron's setLoginItemSettings is Windows/macOS only. */
function linuxAutostartPath() {
  return path.join(os.homedir(), '.config', 'autostart', 'egress-monitor.desktop');
}

/** Write or remove the XDG autostart entry. Returns the state that actually landed. */
async function setLinuxAutostart(enabled, file = linuxAutostartPath()) {
  if (!enabled) {
    await fsp.rm(file, { force: true }).catch(() => {});
    return false;
  }

  const exec = [process.execPath, ...(app?.isPackaged ? [] : [PROJECT_ROOT])]
    .map((part) => (/[\s"'\\]/.test(part) ? `"${part.replace(/(["\\])/g, '\\$1')}"` : part))
    .join(' ');
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Egress Monitor',
    'Comment=WARP egress rotator and monitor',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');

  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, entry, 'utf8');
  return fssync.existsSync(file);
}

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

/** Synchronous PATH lookup so the launch click can decide before spawning. */
function whichSync(name) {
  if (!name) return null;
  if (path.isAbsolute(name)) return fssync.existsSync(name) ? name : null;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fssync.accessSync(candidate, fssync.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
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

/** CLI client default: a PowerShell window on Windows, a detected terminal on Linux. */
function defaultCliClient() {
  if (!IS_WIN) return { command: '', args: [], cwd: '' };
  return {
    command: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoExit',
      '-Command',
      "$env:HTTPS_PROXY='http://127.0.0.1:41987'; $env:HTTP_PROXY=$env:HTTPS_PROXY; $env:ALL_PROXY=$env:HTTPS_PROXY; Write-Host ('Egress proxy wired: ' + $env:HTTPS_PROXY)",
    ],
    cwd: '',
  };
}

function defaultSettings() {
  return {
    proxy: { host: '127.0.0.1', port: 41987 },
    engine: {
      command: DEFAULT_ENGINE_COMMAND,
      args: [],
      timeoutMs: 15000,
    },
    poolDir: 'warp-configs',
    clientLogPath: 'logs/client.log',
    // Extra logs to watch in addition to clientLogPath (e.g. one per client).
    clientLogPaths: [],
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
      cli: defaultCliClient(),
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
  settings.clientLogPaths = (Array.isArray(settings.clientLogPaths) ? settings.clientLogPaths : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
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

/**
 * Quota / rate-limit lines worth a hop. Clients name the same condition
 * differently (`QuotaExceeded`, `FreeUsageLimitError`, `insufficient_quota`,
 * `429 Too Many Requests`), so match the family, not one literal string.
 */
const QUOTA_PATTERN =
  /quota[\s_-]*exceeded|freeusage|free usage limit|insufficient[\s_-]?quota|rate limit|too many requests/i;

class LogGuard {
  constructor({
    filePath = null,
    filePaths = null,
    onTrigger,
    onLog = null,
    cooldownMs = 75000,
    maxChunk = 512 * 1024,
    lookbackMs = 0,
    maxScanBytes = 4 * 1024 * 1024,
  }) {
    const initial =
      Array.isArray(filePaths) && filePaths.length ? filePaths : filePath ? [filePath] : [];
    this.filePaths = [...new Set(initial.map((item) => path.resolve(String(item))))];
    this.onTrigger = onTrigger;
    this.onLog = onLog;
    this.cooldownMs = cooldownMs;
    this.maxChunk = maxChunk;
    this.lookbackMs = lookbackMs;
    this.maxScanBytes = Math.max(maxChunk, maxScanBytes);

    this.files = new Map(); // abs path -> { offset, pending }
    this.lastTriggerAt = 0;
    this.suppressedLoggedAt = 0;
    this.deferred = null;
    this.watcher = null;
    this.scanning = false;
    this.queued = false;
    this.triggerCount = 0;
  }

  get watching() {
    return Boolean(this.watcher);
  }

  /** Primary file — kept for the IPC/UI path display. */
  get filePath() {
    return this.filePaths[0] ?? null;
  }

  async setPaths(list) {
    this.filePaths = [...new Set((list || []).map((item) => path.resolve(String(item))))];
    if (this.watcher) {
      await this.stop();
      await this.start();
    }
  }

  stateFor(file) {
    const key = path.resolve(String(file));
    if (!this.files.has(key)) this.files.set(key, { offset: 0, pending: '' });
    return this.files.get(key);
  }

  async start() {
    if (this.watcher) return;
    this.files = new Map();

    for (const file of this.filePaths) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (!fssync.existsSync(file)) await fsp.writeFile(file, '');

      const stat = await fsp.stat(file).catch(() => null);
      // Default to EOF: only lines that arrive after arming should hop, so a
      // restart cannot re-hop on history. A quota written just before arming
      // (mtime inside the lookback window) is still live though, so re-read
      // one window for it.
      const fresh =
        Boolean(stat) && this.lookbackMs > 0 && Date.now() - stat.mtimeMs <= this.lookbackMs;
      const offset = !stat
        ? 0
        : fresh
          ? Math.max(0, stat.size - Math.min(stat.size, this.maxChunk))
          : stat.size;
      this.files.set(path.resolve(file), { offset, pending: '' });
    }

    this.watcher = chokidar.watch(this.filePaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      alwaysStat: true,
    });

    this.watcher.on('change', (file) => this.scan(file));
    this.watcher.on('add', (file) => {
      const state = this.stateFor(file);
      state.offset = 0;
      state.pending = '';
      this.scan(file);
    });
    this.watcher.on('unlink', (file) => {
      const state = this.stateFor(file);
      state.offset = 0;
      state.pending = '';
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

    // Pick up the lookback window, if any.
    await this.scan();
  }

  async scan(file = null) {
    if (this.scanning) {
      this.queued = true;
      return;
    }
    this.scanning = true;

    try {
      const targets = file ? [path.resolve(String(file))] : [...this.files.keys()];
      for (const target of targets) await this.scanFile(target);
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

  async scanFile(file) {
    const state = this.stateFor(file);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) return;

    if (stat.size < state.offset) {
      state.offset = 0;
      state.pending = '';
    }
    if (stat.size === state.offset) return;

    // Read every new byte (chunked) instead of the last maxChunk only: a burst
    // larger than one chunk used to hide the quota line in the middle.
    const growth = stat.size - state.offset;
    let cursor = state.offset;
    if (growth > this.maxScanBytes) {
      cursor = stat.size - this.maxScanBytes;
      this.onLog?.(
        'warn',
        `log-guard burst in ${path.basename(file)} · skipped ${growth - this.maxScanBytes} of ${growth} new bytes`,
      );
    }

    let text = '';
    while (cursor < stat.size) {
      const stop = Math.min(stat.size, cursor + this.maxChunk) - 1;
      text += await readRange(file, cursor, stop);
      cursor = stop + 1;
    }
    state.offset = stat.size;

    const combined = state.pending + text;
    state.pending = combined.slice(-64);

    if (!QUOTA_PATTERN.test(combined)) return;

    const matchLine = combined.split(/\r?\n/).find((line) => QUOTA_PATTERN.test(line)) || 'quota';
    // The match is consumed here: once handled (now or deferred) it can never
    // replay from the carry buffer on a later, unrelated write.
    state.pending = '';

    // opencode logs `timestamp=2026-...Z level=ERROR ...`. The time the error
    // actually happened must win over the time we happened to notice it —
    // otherwise an old line re-read after a refresh looks like a fresh hop.
    const loggedAtOf = (line) => {
      const found = line.match(
        /timestamp\s*=\s*"?([^\s"]+)"?|\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s"]*)/i,
      );
      return found ? Date.parse(found[1] || found[2]) : NaN;
    };
    const now = Date.now();
    let freshLine = null;
    let freshAt = NaN;
    let staleLine = null;
    for (const line of combined.split(/\r?\n/).filter((item) => QUOTA_PATTERN.test(item))) {
      const at = loggedAtOf(line);
      if (Number.isFinite(at) && now - at > this.lookbackMs) {
        staleLine ??= line;
        continue;
      }
      freshLine = line;
      freshAt = at;
      break;
    }

    if (!freshLine) {
      const at = loggedAtOf(staleLine || matchLine);
      this.onLog?.(
        'warn',
        `log-guard ignored stale quota line · logged ${
          Number.isFinite(at) ? new Date(at).toISOString() : 'unknown'
        } (${Number.isFinite(at) ? Math.round((now - at) / 60000) : '?'}m old)`,
      );
      return;
    }

    this.armTrigger({
      line: freshLine.trim().slice(0, 400),
      file,
      at: Number.isFinite(freshAt) ? freshAt : now,
    });
  }

  /**
   * Cooldown delays a hop, it does not drop it: one deferred trigger runs as
   * soon as the cooldown expires so back-to-back quota errors still burn the
   * next /64 instead of vanishing.
   */
  armTrigger({ line, file, at = Date.now() }) {
    const now = Date.now();
    const wait = this.lastTriggerAt + this.cooldownMs - now;

    if (wait > 0) {
      if (!this.deferred) {
        this.deferred = setTimeout(() => {
          this.deferred = null;
          this.fireTrigger({ line, file, deferred: true, at });
        }, wait);
        this.deferred.unref?.();
        this.onLog?.(
          'warn',
          `log-guard cooldown active · hop deferred ${Math.ceil(wait / 1000)}s`,
        );
      } else if (now - this.suppressedLoggedAt > this.cooldownMs) {
        this.suppressedLoggedAt = now;
        this.onLog?.('warn', 'log-guard cooldown active · extra trigger folded into pending hop');
      }
      return;
    }

    this.fireTrigger({ line, file, deferred: false, at });
  }

  fireTrigger({ line, file, deferred, at }) {
    const detectedAt = Date.now();
    this.lastTriggerAt = detectedAt;
    this.triggerCount += 1;
    this.onTrigger?.({
      at: at ?? detectedAt,
      detectedAt,
      count: this.triggerCount,
      line,
      file,
      deferred,
    });
  }

  async stop() {
    if (this.deferred) {
      clearTimeout(this.deferred);
      this.deferred = null;
    }
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
    await this.killStaleEngines();
    await this.detect();

    const command = await this.resolveCommand();
    if (!command) {
      throw new EngineError(
        'ENGINE_MISSING',
        `sing-box not found at "${this.command}". Drop ${ENGINE_BIN} into engine/ or run "npm run engine:fetch".`,
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
      if (await canConnect(this.host, this.port, 500)) {
        // The port can answer a beat before a bind failure surfaces (e.g. a
        // stale engine held it and this child is about to exit). Give the
        // child a moment and require it to still be alive before "ready".
        await delay(250);
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new EngineError(
            'ENGINE_EXIT',
            `engine exited with code ${child.exitCode}. ${tail(this.stderr, 700)}`,
          );
        }
        return;
      }
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

  /**
   * A previous run can leave a sing-box child orphaned (crash, forced quit,
   * a failed rotation that stopped tracking it). It still holds the proxy
   * port, so the next engine dies with "address already in use" while the
   * readiness check mistakes the orphan's port for success. Reap any process
   * running THIS deck's config before spawning — matched on the exact
   * `run -c <configPath>` argv so nothing else can be hit.
   */
  async killStaleEngines() {
    if (process.platform === 'win32') return;
    const marker = `run -c ${this.configPath}`;
    const stale = [];
    let entries;
    try {
      entries = await fsp.readdir('/proc');
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid || (this.child && pid === this.child.pid)) continue;
      let cmdline;
      try {
        cmdline = (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
      } catch {
        continue; // process exited or not readable
      }
      if (cmdline.includes(marker)) stale.push(pid);
    }
    if (!stale.length) return;
    for (const pid of stale) {
      try {
        process.kill(pid, 'SIGTERM');
        this.log?.('app', 'warn', `stale engine pid ${pid} reaped before start (held ${this.host}:${this.port})`);
      } catch {
        /* already gone */
      }
    }
    await delay(1200);
    for (const pid of stale) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* exited after SIGTERM */
      }
    }
    await delay(300);
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
      burntBlocks: [],
      failedHops: 0,
      lastOkHop: 0,
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
    this.egressFailures = 0;
    this.backoffUntil = 0;
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
      if (IS_LINUX) {
        this.state.toggles.autoStart = fssync.existsSync(linuxAutostartPath());
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
      filePaths: this.guardPaths(),
      cooldownMs: this.settings.guard.cooldownMs,
      // Re-read one window on arm so a quota written seconds before the guard
      // came up is still acted on, without re-hopping old history on restart.
      lookbackMs: this.settings.guard.cooldownMs,
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
      clientLogPaths: (settings.clientLogPaths || []).map((item) =>
        resolveDataPath(this.home, item),
      ),
      workspaceDir: resolveDataPath(this.home, settings.workspaceDir),
      engine: {
        ...settings.engine,
        command: resolveSettingPath(this.home, settings.engine.command),
      },
    };
  }

  /** Primary client log first, then any extra logs configured beside it. */
  guardPaths() {
    return [
      ...new Set([this.paths.clientLog, ...(this.settings.clientLogPaths || [])].filter(Boolean)),
    ];
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
    this.persisted.burntBlocks = Array.isArray(this.persisted.burntBlocks)
      ? this.persisted.burntBlocks.slice(-200)
      : [];
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
  async startAnyEntry(preferredName = null, { attempts = 3, onAttempt = null, verify = null } = {}) {
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
        // A bound port is not proof of a usable tunnel: some WARP /64s route
        // nothing at all. Probe before committing to the config.
        if (verify) {
          const ok = await verify(entry);
          if (!ok) {
            // The config was started and probed but not accepted: the live
            // tunnel is already this config's. Drop the stale egress so a later
            // rotation compares against this config rather than the one that
            // was live before the hop.
            this.state.egress = { ...this.state.egress, verified: false };
            throw Object.assign(new Error('egress probe failed · config has no working tunnel'), {
              code: 'EGRESS_UNVERIFIED',
            });
          }
        }
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
        verify: async () => (await this.probe({ compareDirect: this.settings.probe.compareDirect })).verified,
        onAttempt: (entry, error) =>
          this.log(
            'keeper',
            'warn',
            `${entry.name} failed to start · ${error.message} · trying next config`,
          ),
      });
      this.state.connected = true;
      this.persisted.manualOffline = false;
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
      this.state.lastError = error.message;
      this.state.lastErrorCode = error.code || 'CONNECT_FAILED';
      this.reconcileEngineState(error.message);
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

  /**
   * Hop retries a bounded number of times. A single hop can legitimately fail
   * (a reused/burnt /64, a blackholed config), so the pool is walked once more
   * before giving up; a fresh console start still starts from `currentConfig`.
   */
  static HOP_ATTEMPTS = 2;

  async rotateOnce(reason, previousName, previous, burnt) {
    const firstCandidate = nextEntry(this.pool.entries, previousName);
    return this.startAnyEntry(firstCandidate?.name ?? null, {
      attempts: Math.min(3, this.pool.entries.length),
      verify: async (entry) => {
        const egress = await this.probe({
          compareDirect: this.settings.probe.compareDirect,
        });
        if (!egress.verified) return false;
        // A bound port with a reused /64 is not a fresh hop: the upstream
        // quota follows the /64, so keep trying other configs. Compare the
        // probed block against the egress captured before this hop, not the
        // live state (probe() has already overwritten it by now).
        const block = egress.block64 ? ipv6Block64(egress.block64) : null;
        if (!block) return true; // IPv4 egress: no /64 to compare
        const old = previous.block64 ? ipv6Block64(previous.block64) : null;
        if (old && block === old) {
          this.log('guard', 'warn', `${reason} -> ${entry.name} reused /64 ${block} · trying next config`);
          return false;
        }
        if (burnt.has(block)) {
          this.log('guard', 'warn', `${reason} -> ${entry.name} hit burnt /64 ${block} · trying next config`);
          return false;
        }
        this.persisted.burntBlocks = [...new Set([...burnt, block])];
        return true;
      },
      onAttempt: (entry, error) =>
        this.log('guard', 'error', `${reason} -> rotating to ${entry.name} -> failed: ${error.message}`),
    });
  }

  /**
   * A failed hop/connect does not always mean the engine is down: the last
   * candidate may have started and bound the port, and only the egress verify
   * rejected it (burnt/reused /64, probe timeout). Declaring the engine stopped
   * while it is actually running strands the console offline — the keeper only
   * reconnects when the port is unreachable, so nothing ever recovers. Reflect
   * the live engine instead; the failure stays visible via lastError and the
   * keeper's periodic egress recheck heals the status once the probe passes.
   */
  reconcileEngineState(errorMessage) {
    const child = this.engine?.child;
    const alive = Boolean(child && child.exitCode === null && child.signalCode === null);
    if (alive) {
      this.state.connected = true;
      this.state.engine = {
        ...this.state.engine,
        state: 'running',
        pid: child.pid ?? null,
        error: errorMessage,
      };
      this.state.proxy.listening = true;
    } else {
      this.state.connected = false;
      this.state.engine = {
        ...this.state.engine,
        state: 'stopped',
        pid: null,
        error: errorMessage,
      };
      this.state.proxy.listening = false;
    }
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
    // Capture the egress before startAnyEntry(): it stops and restarts the
    // engine, which drops the live tunnel, so any later probe reports the new
    // config's /64 and the previous one would be lost.
    const previous = this.state.egress
      ? {
          ip: this.state.egress.ip ?? null,
          family: this.state.egress.family ?? null,
          block64: this.state.egress.block64 ?? null,
          subnet64: this.state.egress.subnet64 ?? null,
        }
      : { ip: null, family: null, block64: null, subnet64: null };
    const previousBlock = previous.block64;
    const burnt = new Set(
      (Array.isArray(this.persisted.burntBlocks) ? this.persisted.burntBlocks : [])
        .map((item) => ipv6Block64(item))
        .filter(Boolean),
    );
    if (reason === 'log-guard' && previousBlock) {
      const key = ipv6Block64(previousBlock);
      if (key && !burnt.has(key)) {
        burnt.add(key);
        this.persisted.burntBlocks = [...burnt];
      }
    }

    let started = null;

    try {
      let lastError = null;
      for (let attempt = 0; attempt < Deck.HOP_ATTEMPTS; attempt += 1) {
        try {
          started = await this.rotateOnce(label, previousName, previous, burnt);
          break;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < Deck.HOP_ATTEMPTS) {
            this.log(
              'guard',
              'warn',
              `${label} -> pool pass ${attempt + 1} found no fresh /64 · retrying once`,
            );
          }
        }
      }
      if (!started) {
        // Do not lose the retirement: the /64 that just hit the quota wall must
        // stay blacklisted even when no fresh config could be started.
        if (reason === 'log-guard' && previousBlock) {
          const key = ipv6Block64(previousBlock);
          if (key) this.persisted.burntBlocks = [...new Set([...burnt, key])];
        }
        throw lastError || new Error('no config could be started');
      }

      this.state.connected = true;
      await this.scanWorkspace();

      this.state.stats.hops += 1;
      this.persisted.lastOkHop = Date.now();
      this.persisted.failedHops = 0;
      this.backoffUntil = 0;
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
      this.reconcileEngineState(error.message);
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
    const detectedAt = info.detectedAt ?? info.at;
    this.state.guard.lastTriggerAt = new Date(info.at).toISOString();
    this.state.guard.cooldownUntil = new Date(
      detectedAt + this.settings.guard.cooldownMs,
    ).toISOString();

    const where = info.file ? path.basename(info.file) : 'client.log';
    this.log(
      'guard',
      'warn',
      `${info.deferred ? 'deferred quota trigger fired' : 'quota trigger detected'} in ${where} · logged ${stamp(new Date(info.at))} · seen ${stamp(new Date(detectedAt))} · ${info.line}`,
    );

    if (!this.state.toggles.logGuard) {
      this.log('guard', 'warn', 'log-guard is disabled · trigger ignored');
      await this.savePersisted();
      this.broadcast();
      return;
    }
    if (this.rotating) {
      // The hop already in flight lands on a config with fresh quota, so a
      // quota line written mid-hop is satisfied by it. Counting it would
      // double-count one exhaustion event.
      this.log('guard', 'warn', 'log-guard trigger absorbed · rotation already in flight');
      await this.savePersisted();
      this.broadcast();
      return;
    }

    // Loop protection: if a fresh /64 hits the wall again almost immediately,
    // the address did not help. Pause auto-rotation briefly instead of burning
    // through the whole config pool in a minute.
    const now = Date.now();
    const REWALL_MS = 3 * 60 * 1000;
    const BACKOFF_MS = 2 * 60 * 1000;
    const FAILED_HOPS_MAX = 2;
    if (now < this.backoffUntil) {
      this.log(
        'guard',
        'warn',
        `quota wall repeating on fresh /64 · auto-rotation paused ~${Math.ceil((this.backoffUntil - now) / 60000)}m`,
      );
      await this.savePersisted();
      this.broadcast();
      return;
    }
    const lastOkHop = Number(this.persisted.lastOkHop || 0);
    if (lastOkHop && now - lastOkHop <= REWALL_MS) {
      this.persisted.failedHops = Number(this.persisted.failedHops || 0) + 1;
      this.log(
        'guard',
        'warn',
        `wall returned ${Math.round((now - lastOkHop) / 1000)}s after a fresh /64 (${this.persisted.failedHops}/${FAILED_HOPS_MAX})`,
      );
      if (this.persisted.failedHops >= FAILED_HOPS_MAX) {
        this.backoffUntil = now + BACKOFF_MS;
        this.persisted.failedHops = 0;
        this.log('guard', 'warn', `pausing auto-rotation for ${BACKOFF_MS / 60000} min — new /64s keep hitting the wall`);
      }
      await this.savePersisted();
      this.broadcast();
      if (this.backoffUntil) return;
    } else if (lastOkHop) {
      this.persisted.failedHops = 0;
    }

    // No `connected` short-circuit: rotate() already handles an offline
    // tunnel by starting the next config, so dropping the trigger here would
    // silently lose a real quota event.
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
              this.egressFailures = 0;
              this.log(
                'keeper',
                'info',
                `egress recheck · ${egress.ip} · ${egress.family || 'unknown'}`,
              );
            } else {
              this.egressFailures += 1;
              this.log(
                'keeper',
                'warn',
                `egress recheck failed · ${egress.error} (${this.egressFailures}/${this.settings.keeper.failuresBeforeRestart})`,
              );
              if (this.egressFailures >= this.settings.keeper.failuresBeforeRestart) {
                this.egressFailures = 0;
                this.log('keeper', 'warn', 'egress still unverified · rotating to another /64');
                await this.rotate('keeper');
              }
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
    const files = this.guard.filePaths;
    this.log(
      'guard',
      'info',
      `log-guard armed · watching ${files.join(', ')}${files.length > 1 ? ` (${files.length} files)` : ''}`,
    );
    this.broadcast();
  }

  async stopGuard() {
    if (!this.guard) return;
    await this.guard.stop();
    this.state.guard.watching = false;
    this.log('guard', 'warn', 'log-guard disarmed · client log no longer watched');
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
        if (IS_LINUX) {
          this.state.toggles.autoStart = await setLinuxAutostart(next);
          this.log(
            'app',
            this.state.toggles.autoStart === next ? 'success' : 'warn',
            `auto-start ${next ? 'enabled' : 'disabled'} · ${
              next ? linuxAutostartPath() : 'XDG autostart entry removed'
            }`,
          );
        } else {
          const args = app.isPackaged ? [] : [PROJECT_ROOT];
          app.setLoginItemSettings({ openAtLogin: next, path: process.execPath, args });
          const actual = app.getLoginItemSettings().openAtLogin;
          this.state.toggles.autoStart = actual;
          this.log(
            'app',
            actual === next ? 'success' : 'warn',
            `auto-start ${actual ? 'enabled' : 'disabled'} · ${
              actual ? `launches at ${IS_WIN ? 'Windows sign-in' : 'login'}` : 'login item removed'
            }`,
          );
        }
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

    let command = client?.command;
    let baseArgs = [...(client?.args || [])];

    // Linux has no single CLI host: pick the first terminal that exists and
    // hand it `bash -lc <proxy export + $SHELL>`. An explicit command wins.
    if (kind === 'cli' && !command && IS_LINUX) {
      const terminal = LINUX_TERMINALS.map((item) => ({
        ...item,
        path: whichSync(item.command),
      })).find((item) => item.path);
      if (!terminal) {
        const message = 'Client CLI is not configured and no terminal was found. Set client.cli.command in settings.json.';
        this.log('app', 'error', `launch failed · ${message}`);
        return { ok: false, message };
      }
      const proxyUrl = `http://${this.settings.proxy.host}:${this.settings.proxy.port}`;
      command = terminal.path;
      baseArgs = [
        ...terminal.prefix,
        'bash',
        '-lc',
        `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} ALL_PROXY=${proxyUrl} ` +
          `NO_PROXY=localhost,127.0.0.1,::1; echo "Egress proxy wired: ${proxyUrl}"; exec "$SHELL"`,
      ];
    }

    if (!command) {
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

    const cwd = client?.cwd ? resolveSettingPath(this.home, client.cwd) : this.home;
    const args =
      kind === 'desktop' ? desktopProxyArgs(baseArgs, proxyEnabled) : [...baseArgs];
    if (kind === 'desktop' && !proxyEnabled && args.length !== baseArgs.length) {
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
    if (this.guard) await this.guard.setPaths(this.guardPaths());
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
      clientLogPaths: (this.settings.clientLogPaths || []).map((item) =>
        relativize(this.home, item),
      ),
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
    if (!isScreenshotRun && !isHidden) mainWindow.show();
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
    // Kalau window sudah ditutup (mainWindow=null), buat lagi dari deck yang
    // tetap hidup di background.
    if (!mainWindow || mainWindow.isDestroyed()) {
      const win = createWindow();
      win.webContents.on('did-finish-load', () => deck?.broadcast());
      win.show();
      win.focus();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    // Kalau instance pertama jalan hidden (background service), tunjukkan
    // window-nya supaya bisa dipakai seperti biasa.
    if (isHidden || !mainWindow.isVisible()) mainWindow.show();
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
    // Dalam mode background (hidden), menutup window TIDAK boleh mematikan
    // aplikasi — proxy harus tetap jalan. UI dibuka kembali lewat tray.
    if (isHidden) return;
    if (process.platform !== 'darwin') app.quit();
  });

  let quitting = false;
  const shutdown = () => {
    if (quitting) return;
    quitting = true;
    Promise.resolve(deck?.dispose())
      .catch(() => {})
      .finally(() => app.quit());
  };
  app.on('before-quit', (event) => {
    if (quitting) return;
    // Di mode hidden, abaikan quit yang dipicu sistem (mis. session cleanup/
    // window-all-closed). Yang sah: SIGTERM dari systemctl stop, atau tray Keluar.
    if (isHidden) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    shutdown();
  });
  // systemd mengirim SIGTERM saat `systemctl stop` — ini harus tetap mematikan.
  process.on('SIGTERM', shutdown);
  // Quit dari UI/tray: jalurkan shutdown yang sama (dispose engine dulu, lalu quit).
  ipcMain.on('window:quit', shutdown);
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
  setLinuxAutostart,
  stamp,
  stripAnsi,
  whichSync,
};

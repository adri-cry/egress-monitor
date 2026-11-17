'use strict';

/**
 * WireGuard config pool: discovery, parsing, rotation order and sing-box
 * rendering. Deliberately free of Electron imports so it can be unit tested
 * with plain Node.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PEER_PORT = 2408;
const DEFAULT_MTU = 1280;
const DEFAULT_ALLOWED_IPS = ['0.0.0.0/0', '::/0'];

class ConfigError extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
    this.file = file;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function naturalCompare(a, b) {
  return collator.compare(a, b);
}

/** Split a WireGuard-style INI file into sections (interface / peer / ...). */
function parseIni(text) {
  const sections = {};
  let section = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const header = /^\[(.+)]$/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      if (!sections[section]) sections[section] = {};
      continue;
    }

    if (!section) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!key || key in sections[section]) continue; // first occurrence wins
    sections[section][key] = value;
  }

  return sections;
}

function splitList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function ipFamily(value) {
  const ip = String(value)
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .split('/')[0];
  if (ip.includes(':')) return 'ipv6';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return 'ipv4';
  return null;
}

function normalizeCidr(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.includes('/')) return trimmed;
  const family = ipFamily(trimmed);
  if (!family) return null;
  return `${trimmed}/${family === 'ipv6' ? 128 : 32}`;
}

function stripCidr(value) {
  return String(value).trim().replace(/\/\d+$/, '');
}

/** Parse `host:port`, `[v6]:port` and bare IPv6 endpoints without a port. */
function parseEndpoint(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return { host: '', port: DEFAULT_PEER_PORT };

  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close !== -1) {
      const host = trimmed.slice(1, close);
      const rest = trimmed.slice(close + 1).replace(/^:/, '');
      const port = Number.parseInt(rest, 10);
      return { host, port: Number.isFinite(port) ? port : DEFAULT_PEER_PORT };
    }
  }

  const colons = (trimmed.match(/:/g) || []).length;
  if (colons > 1) {
    // Unbracketed IPv6 must be treated as a bare address; RFC 3986 requires
    // brackets when a port is present.
    return { host: trimmed, port: DEFAULT_PEER_PORT };
  }

  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) return { host: trimmed, port: DEFAULT_PEER_PORT };
  const port = Number.parseInt(trimmed.slice(idx + 1), 10);
  return {
    host: trimmed.slice(0, idx),
    port: Number.isFinite(port) ? port : DEFAULT_PEER_PORT,
  };
}

function fingerprintOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

/**
 * Expand an IPv6 address into eight 16-bit groups. Returns null for anything
 * that is not IPv6. Embedded IPv4 (`::ffff:1.2.3.4`) is supported.
 */
function expandIpv6(value) {
  let ip = String(value)
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .split('/')[0];
  if (!ip.includes(':')) return null;

  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    const v4 = ip.slice(lastColon + 1);
    const octets = v4.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    ip = `${ip.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${(
      (octets[2] << 8) |
      octets[3]
    ).toString(16)}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  const parsed = groups.map((group) => Number.parseInt(group || '0', 16));
  if (parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return parsed;
}

/** The public /64 implied by an IPv6 address, e.g. `2a09:bac5:3a1c:25c3::/64`. */
function ipv6Block64(value) {
  const groups = expandIpv6(value);
  if (!groups) return null;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

function ipv6Subnet64(value) {
  const groups = expandIpv6(value);
  if (!groups) return null;
  return groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':');
}

function parseWarpConfig(text, fileName = 'config.conf') {
  const sections = parseIni(text);
  const iface = sections.interface;
  const peer = sections.peer;

  if (!iface) throw new ConfigError(fileName, 'missing [Interface] section');
  if (!peer) throw new ConfigError(fileName, 'missing [Peer] section');

  const privateKey = iface.privatekey || '';
  if (!privateKey) throw new ConfigError(fileName, 'missing Interface.PrivateKey');

  const addresses = splitList(iface.address).map(normalizeCidr).filter(Boolean);
  if (!addresses.length) throw new ConfigError(fileName, 'missing Interface.Address');

  const publicKey = peer.publickey || '';
  if (!publicKey) throw new ConfigError(fileName, 'missing Peer.PublicKey');

  const endpoint = parseEndpoint(peer.endpoint);
  if (!endpoint.host) throw new ConfigError(fileName, 'missing Peer.Endpoint');

  const allowedIps = splitList(peer.allowedips).map(normalizeCidr).filter(Boolean);
  const mtuRaw = Number.parseInt(iface.mtu || '', 10);
  const reserved = splitList(iface.reserved || peer.reserved)
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);

  const ipv4 = addresses.find((cidr) => ipFamily(cidr) === 'ipv4') || null;
  const ipv6 = addresses.find((cidr) => ipFamily(cidr) === 'ipv6') || null;

  return {
    name: fileName,
    privateKey,
    addresses,
    ipv4: ipv4 ? stripCidr(ipv4) : null,
    ipv6: ipv6 ? stripCidr(ipv6) : null,
    dns: splitList(iface.dns),
    mtu: Number.isFinite(mtuRaw) && mtuRaw >= 576 ? mtuRaw : DEFAULT_MTU,
    fingerprint: fingerprintOf(text),
    peer: {
      publicKey,
      presharedKey: peer.presharedkey || null,
      endpointHost: endpoint.host,
      endpointPort: endpoint.port,
      allowedIps: allowedIps.length ? allowedIps : DEFAULT_ALLOWED_IPS,
      keepalive: 25,
      reserved: reserved.length === 3 ? reserved : null,
    },
  };
}

async function loadWarpConfig(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  const conf = parseWarpConfig(text, path.basename(filePath));
  return { conf, text, filePath };
}

/** Public, secret-free projection safe to ship to the renderer. */
function publicEntry(conf, filePath) {
  return {
    name: conf.name,
    path: filePath,
    ipv4: conf.ipv4,
    ipv6: conf.ipv6,
    mtu: conf.mtu,
    dns: conf.dns,
    endpointHost: conf.peer.endpointHost,
    endpointPort: conf.peer.endpointPort,
    fingerprint: conf.fingerprint,
  };
}

async function scanPool(dir) {
  const entries = [];
  const errors = [];
  let names = [];

  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { dir, entries, errors };
    throw error;
  }

  names = names.filter((name) => name.toLowerCase().endsWith('.conf')).sort(naturalCompare);

  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const { conf } = await loadWarpConfig(filePath);
      entries.push({ ...publicEntry(conf, filePath), order: entries.length });
    } catch (error) {
      errors.push({ name, message: error.message });
    }
  }

  return { dir, entries, errors };
}

/** Round-robin: the next config after `currentName`, wrapping at the end. */
function nextEntry(entries, currentName) {
  if (!entries.length) return null;
  const index = entries.findIndex((entry) => entry.name === currentName);
  if (index === -1) return entries[0];
  if (entries.length === 1) return entries[0];
  return entries[(index + 1) % entries.length];
}

/**
 * Loopback, link-local and RFC1918 destinations must never enter the tunnel:
 * a proxied client (e.g. one started with --proxy-server) asks the proxy for
 * its own local API port, and tunnelling that dial hangs until timeout.
 */
const DIRECT_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '::ffff:127.0.0.0/104',
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fe80::/10',
  'fc00::/7',
];

function directRules() {
  return [
    { ip_cidr: DIRECT_CIDRS, outbound: 'direct' },
    { ip_is_private: true, outbound: 'direct' },
    { domain_suffix: ['localhost', '.localhost'], outbound: 'direct' },
  ];
}

/**
 * Render a sing-box configuration.
 * `format: 'endpoints'` targets sing-box >= 1.11 (wireguard endpoint),
 * `format: 'outbound'` targets sing-box <= 1.10 (wireguard outbound).
 */
function renderSingBoxConfig(conf, options = {}) {
  const {
    listenHost = '127.0.0.1',
    listenPort = 41987,
    format = 'endpoints',
    serverAddress = null,
  } = options;

  const server = serverAddress || conf.peer.endpointHost;
  const inbound = {
    type: 'mixed',
    tag: 'proxy-in',
    listen: listenHost,
    listen_port: listenPort,
  };

  // Resolve probe/domain names inside the tunnel. Without this sing-box falls
  // back to the host resolver (systemd-resolved / Tailscale MagicDNS), which
  // hands back Cloudflare anycast IPs that are unreachable from the WARP exit
  // -> "connect tcp ... operation timed out" and endless probe failures.
  const dns = {
    servers: [
      { tag: 'warp-dns', type: 'https', server: '1.1.1.1', detour: 'warp' },
      { tag: 'local-dns', type: 'local' },
    ],
    rules: [
      {
        domain_suffix: ['.local', '.ts.net', 'localhost'],
        action: 'route',
        server: 'local-dns',
      },
      {
        // WARP's IPv4 egress is a shared anycast address that does not change
        // between configs; only the IPv6 /64 rotates. Resolve the inference
        // host over IPv6 so the client's traffic leaves through the rotated
        // /64 instead of the constant IPv4 address.
        domain_suffix: ['opencode.ai'],
        action: 'route',
        server: 'warp-dns',
        strategy: 'prefer_ipv6',
      },
      { action: 'route', server: 'warp-dns' },
    ],
  };

  if (format === 'outbound') {
    return {
      log: { level: 'warn', timestamp: true },
      inbounds: [inbound],
      dns,
      outbounds: [
        { type: 'direct', tag: 'direct' },
        {
          type: 'wireguard',
          tag: 'warp',
          server,
          server_port: conf.peer.endpointPort,
          local_address: conf.addresses,
          private_key: conf.privateKey,
          peer_public_key: conf.peer.publicKey,
          ...(conf.peer.presharedKey ? { pre_shared_key: conf.peer.presharedKey } : {}),
          ...(conf.peer.reserved ? { reserved: conf.peer.reserved } : {}),
          mtu: conf.mtu,
        },
      ],
      route: {
        auto_detect_interface: true,
        default_domain_resolver: 'warp-dns',
        rules: directRules(),
        final: 'warp',
      },
    };
  }

  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [inbound],
    dns,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    endpoints: [
      {
        type: 'wireguard',
        tag: 'warp',
        system: false,
        mtu: conf.mtu,
        address: conf.addresses,
        private_key: conf.privateKey,
        peers: [
          {
            address: server,
            port: conf.peer.endpointPort,
            public_key: conf.peer.publicKey,
            ...(conf.peer.presharedKey ? { pre_shared_key: conf.peer.presharedKey } : {}),
            ...(conf.peer.reserved ? { reserved: conf.peer.reserved } : {}),
            allowed_ips: conf.peer.allowedIps,
            persistent_keepalive_interval: conf.peer.keepalive,
          },
        ],
      },
    ],
    route: {
      auto_detect_interface: true,
      default_domain_resolver: 'warp-dns',
      rules: directRules(),
      final: 'warp',
    },
  };
}

function poolExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  ConfigError,
  DEFAULT_PEER_PORT,
  expandIpv6,
  ipFamily,
  ipv6Block64,
  ipv6Subnet64,
  loadWarpConfig,
  naturalCompare,
  nextEntry,
  parseEndpoint,
  parseIni,
  parseWarpConfig,
  poolExists,
  renderSingBoxConfig,
  scanPool,
};

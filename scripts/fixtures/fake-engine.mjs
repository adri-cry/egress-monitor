/**
 * Test fixture: a stand-in for sing-box.
 *
 * Speaks the same CLI shape (`fake-engine run -c <config>`), opens a SOCKS5
 * proxy on the inbound port from the config, and serves a fake egress IP on
 * FAKE_IP_PORT. Every start bumps a hop counter so each rotation exposes a new
 * /64. This exists only so scripts/test-backend.mjs and the UI screenshot run
 * can exercise the real rotation loop without a WARP account.
 */

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'run') process.exit(0);

const configIndex = args.indexOf('-c');
const configPath = configIndex >= 0 ? args[configIndex + 1] : null;
if (!configPath) process.exit(2);

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const port = config?.inbounds?.[0]?.listen_port ?? 41987;
const ipPort = Number(process.env.FAKE_IP_PORT || 42800);

const counterPath = path.join(path.dirname(configPath), 'fake-hop.txt');
let hop = 0;
try {
  hop = Number(fs.readFileSync(counterPath, 'utf8')) || 0;
} catch {
  /* first start */
}
hop += 1;
fs.writeFileSync(counterPath, String(hop));

const ip = `2a09:bac5:3a1c:${(0x2500 + hop).toString(16)}::1`;

const ipServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ip, hop }));
});

ipServer.listen(ipPort, '127.0.0.1');

function parseTarget(buffer) {
  const atyp = buffer[3];
  if (atyp === 0x01) {
    return { host: [...buffer.subarray(4, 8)].join('.'), port: buffer.readUInt16BE(8), size: 10 };
  }
  if (atyp === 0x03) {
    const length = buffer[4];
    return {
      host: buffer.subarray(5, 5 + length).toString('utf8'),
      port: buffer.readUInt16BE(5 + length),
      size: 5 + length + 2,
    };
  }
  if (atyp === 0x04) {
    const groups = [];
    for (let i = 0; i < 8; i += 1) groups.push(buffer.readUInt16BE(4 + i * 2).toString(16));
    return { host: groups.join(':'), port: buffer.readUInt16BE(20), size: 22 };
  }
  return null;
}

const proxy = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let stage = 'greeting';

  socket.on('error', () => socket.destroy());

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (stage === 'greeting') {
      if (buffer.length < 2) return;
      const methods = buffer[1];
      if (buffer.length < 2 + methods) return;
      buffer = buffer.subarray(2 + methods);
      socket.write(Buffer.from([0x05, 0x00]));
      stage = 'request';
    }

    if (stage === 'request') {
      if (buffer.length < 4) return;
      if (buffer[0] !== 0x05 || buffer[1] !== 0x01) {
        socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
        return;
      }
      const target = parseTarget(buffer);
      if (!target) {
        socket.destroy();
        return;
      }
      buffer = buffer.subarray(target.size);
      stage = 'tunnel';

      const upstream = net.connect(target.port, target.host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (buffer.length) upstream.write(buffer);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
    }
  });
});

proxy.listen(port, '127.0.0.1');

function shutdown() {
  proxy.close();
  ipServer.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

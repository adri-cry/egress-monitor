import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const host = '127.0.0.1';
const port = 5173;
const appUrl = `http://${host}:${port}`;

let viteProcess = null;
let electronProcess = null;
let shuttingDown = false;

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill();
  }
  if (viteProcess && !viteProcess.killed) {
    viteProcess.kill();
  }

  setTimeout(() => process.exit(exitCode), 100);
}

async function waitForVite(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(appUrl);
      if (response.ok) return;
    } catch {
      // Vite is still warming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Vite did not become ready at ${appUrl} within ${timeoutMs}ms.`);
}

async function start() {
  console.log('\n[egress-monitor] starting Vite…');

  viteProcess = spawn(process.execPath, [viteBin, '--host', host, '--port', String(port)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  viteProcess.on('exit', (code) => {
    if (!shuttingDown && !electronProcess) {
      console.error(`[egress-monitor] Vite exited with code ${code ?? 1}.`);
      stop(code ?? 1);
    }
  });

  await waitForVite();
  console.log(`[egress-monitor] Vite ready at ${appUrl}`);
  console.log('[egress-monitor] launching Electron…\n');

  electronProcess = spawn(electronPath, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: appUrl,
    },
  });

  electronProcess.on('exit', (code) => {
    stop(code ?? 0);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('uncaughtException', (error) => {
  console.error(error);
  stop(1);
});

start().catch((error) => {
  console.error(`[egress-monitor] ${error.message}`);
  stop(1);
});

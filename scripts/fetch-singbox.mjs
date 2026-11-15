/**
 * Download a sing-box release for this machine into engine/.
 *
 *   npm run engine:fetch
 *   npm run engine:fetch -- --force
 *   SINGBOX_VERSION=1.12.4 npm run engine:fetch
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'engine');
const target = path.join(engineDir, 'sing-box.exe');

const force = process.argv.includes('--force');
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const version = process.env.SINGBOX_VERSION || null;

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'egress-monitor-installer',
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This installer targets Windows. Install sing-box with your package manager instead.');
  }

  if (!force) {
    try {
      await fs.access(target);
      console.log(`engine/sing-box.exe already exists — use --force to replace it.`);
      return;
    } catch {
      /* not installed yet */
    }
  }

  const release = version
    ? await githubJson(`https://api.github.com/repos/SagerNet/sing-box/releases/tags/v${version}`)
    : await githubJson('https://api.github.com/repos/SagerNet/sing-box/releases/latest');

  const asset = (release.assets || []).find(
    (item) => item.name.endsWith(`windows-${arch}.zip`) && item.name.startsWith('sing-box-'),
  );
  if (!asset) throw new Error(`No windows-${arch} zip in release ${release.tag_name}`);

  console.log(`Downloading ${asset.name} (${release.tag_name})…`);
  const download = await fetch(asset.browser_download_url, {
    headers: { 'user-agent': 'egress-monitor-installer' },
  });
  if (!download.ok) throw new Error(`Download failed: HTTP ${download.status}`);

  const buffer = Buffer.from(await download.arrayBuffer());
  const zipPath = path.join(os.tmpdir(), asset.name);
  await fs.writeFile(zipPath, buffer);

  const unpackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sing-box-'));
  console.log('Extracting…');
  try {
    await execFileAsync('tar', ['-xf', zipPath, '-C', unpackDir], { windowsHide: true });
  } catch {
    // Some Windows shells block tar.exe; fall back to PowerShell.
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(unpackDir)} -Force`,
      ],
      { windowsHide: true },
    );
  }

  const stack = [unpackDir];
  let exe = null;
  while (stack.length && !exe) {
    const dir = stack.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === 'sing-box.exe') exe = full;
    }
  }
  if (!exe) throw new Error('sing-box.exe was not found in the release archive');

  await fs.mkdir(engineDir, { recursive: true });
  await fs.copyFile(exe, target);

  await fs.rm(zipPath, { force: true }).catch(() => {});
  await fs.rm(unpackDir, { recursive: true, force: true }).catch(() => {});

  const { stdout } = await execFileAsync(target, ['version'], { windowsHide: true });
  console.log(stdout.trim());
  console.log(`\nInstalled: ${target}`);
  console.log('Restart Egress Monitor (or press Refresh) to use it.');
}

main().catch((error) => {
  console.error(`\nengine:fetch failed — ${error.message}`);
  process.exitCode = 1;
});

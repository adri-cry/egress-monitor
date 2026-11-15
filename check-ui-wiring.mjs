// self-check: LogBus.clear truncates file + rotated file, drops buffer
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LogBus } from './electron/main.cjs';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'logbus-'));
const bus = new LogBus({ dir });
await bus.init();

await bus.append('app', 'info', 'first line');
await bus.append('app', 'warn', 'second line');
await bus.flush();
const file = path.join(dir, 'app.log');
await fsp.writeFile(`${file}.1`, 'old rotated\n');

assert.ok((await fsp.readFile(file, 'utf8')).includes('first line'), 'log written');
assert.equal(bus.buffers.app.length, 2, 'buffer has 2 entries');

assert.equal(await bus.clear('app'), true, 'clear returns true');
assert.equal((await fsp.readFile(file, 'utf8')), '', 'file truncated to empty');
await assert.rejects(fsp.access(`${file}.1`), 'rotated file removed');
assert.deepEqual(bus.buffers.app, [], 'buffer emptied');

assert.equal(await bus.clear('nope'), false, 'unknown tab rejected');

await fsp.rm(dir, { recursive: true, force: true });
console.log('PASS logbus clear');

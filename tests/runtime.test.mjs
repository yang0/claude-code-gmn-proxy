import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopDetachedProxyOnly } from '../src/runtime.mjs';

test('stopDetachedProxyOnly terminates the pid referenced in the state directory', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await fs.writeFile(path.join(stateDir, 'proxy.pid'), `${child.pid}\n`);

  await stopDetachedProxyOnly({ stateDir });

  for (let i = 0; i < 50; i += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(child.signalCode === 'SIGTERM' || child.exitCode !== null);
});

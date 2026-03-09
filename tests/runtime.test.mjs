import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findClaudeBinary, stopDetachedProxyOnly } from '../src/runtime.mjs';

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

test('findClaudeBinary resolves a Windows PATH shim', {
  skip: process.platform !== 'win32',
}, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-bin-'));
  const fakeClaude = path.join(tempDir, 'claude.cmd');
  await fs.writeFile(fakeClaude, '@echo off\r\nexit /b 0\r\n');

  const originalPath = process.env.PATH;
  const originalOverride = process.env.CLAUDE_CODE_CLI;
  process.env.PATH = `${tempDir};${originalPath || ''}`;
  delete process.env.CLAUDE_CODE_CLI;

  try {
    assert.equal(findClaudeBinary().toLowerCase(), fakeClaude.toLowerCase());
  } finally {
    process.env.PATH = originalPath;
    if (originalOverride === undefined) {
      delete process.env.CLAUDE_CODE_CLI;
    } else {
      process.env.CLAUDE_CODE_CLI = originalOverride;
    }
  }
});

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

test('ensureProxyAvailable does not emit a FileHandle GC warning', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-home-'));
  const port = await getFreePort();
  const runtimeModule = new URL('../src/runtime.mjs', import.meta.url).href;
  const stderr = [];
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-'], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
    },
  });

  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdin.end(`
    import { ensureProxyAvailable, stopProxy } from ${JSON.stringify(runtimeModule)};
    const config = {
      host: '127.0.0.1',
      port: ${port},
      upstreamBaseUrl: 'https://example.invalid',
      upstreamApiKey: 'test-key',
      defaultModel: 'gpt-5.4',
      reasoningEffort: 'high',
      localAuthToken: 'local-token',
    };
    await ensureProxyAvailable(config);
    for (let i = 0; i < 3; i += 1) {
      global.gc();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await stopProxy(config);
  `);

  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr.join(''));
  assert.equal(stderr.join(''), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClaudeArgs,
  buildClaudeSettingsOverride,
  detachedProxyPidLooksOwnedByCurrentPackage,
  findClaudeBinary,
  stopDetachedProxyOnly,
} from '../src/runtime.mjs';

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

test('buildClaudeSettingsOverride routes Claude through the local proxy', () => {
  const settings = buildClaudeSettingsOverride({
    host: '127.0.0.1',
    port: 4040,
    localAuthToken: 'local-token',
  });

  assert.deepEqual(settings, {
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4040',
      ANTHROPIC_AUTH_TOKEN: 'local-token',
    },
  });
});

test('buildClaudeArgs injects a Claude settings override before user args', () => {
  const args = buildClaudeArgs(['-p', 'Reply with PONG only.'], {
    defaultModel: 'gpt-5.4',
  }, 'C:/temp/claude-settings.json');

  assert.deepEqual(args, [
    '--settings',
    'C:/temp/claude-settings.json',
    '--model',
    'gpt-5.4',
    '-p',
    'Reply with PONG only.',
  ]);
});

test('buildClaudeArgs removes caller-provided Claude settings flags', () => {
  const args = buildClaudeArgs([
    '--settings',
    'C:/temp/user-settings.json',
    '--setting-sources',
    'user,project,local',
    '-p',
    'Reply with PONG only.',
  ], {
    defaultModel: 'gpt-5.4',
  }, 'C:/temp/claude-settings.json');

  assert.deepEqual(args, [
    '--settings',
    'C:/temp/claude-settings.json',
    '--model',
    'gpt-5.4',
    '-p',
    'Reply with PONG only.',
  ]);
});

test('detachedProxyPidLooksOwnedByCurrentPackage only trusts this repo server process', async (context) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-owned-'));
  const port = await getFreePort();
  const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      CLAUDE_CODE_GMN_PROXY_HOST: '127.0.0.1',
      CLAUDE_CODE_GMN_PROXY_PORT: String(port),
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_BASE_URL: 'https://example.invalid',
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_API_KEY: 'test-key',
      CLAUDE_CODE_GMN_PROXY_AUTH_TOKEN: 'local-token',
    },
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        break;
      }
    } catch {
      // child may still be starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await fs.writeFile(path.join(stateDir, 'proxy.pid'), `${child.pid}\n`);
  assert.equal(await detachedProxyPidLooksOwnedByCurrentPackage({ stateDir }), true);

  await fs.writeFile(path.join(stateDir, 'proxy.pid'), `${process.pid}\n`);
  assert.equal(await detachedProxyPidLooksOwnedByCurrentPackage({ stateDir }), false);
});

test('execClaudeWithProxy injects Claude settings and removes the temp settings file', {
  skip: process.platform !== 'win32',
}, async (context) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-home-'));
  const tempBin = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-bin-'));
  const fakeClaudeScript = path.join(tempBin, 'fake-claude.mjs');
  const fakeClaudeCmd = path.join(tempBin, 'claude.cmd');
  const reportPath = path.join(tempHome, 'fake-claude-report.json');
  const runtimeModule = new URL('../src/runtime.mjs', import.meta.url).href;
  const port = await getFreePort();
  const config = {
    host: '127.0.0.1',
    port,
    upstreamBaseUrl: 'https://example.invalid',
    upstreamApiKey: 'test-key',
    defaultModel: 'gpt-5.4',
    reasoningEffort: 'high',
    localAuthToken: 'local-token',
  };
  const healthPayload = {
    ok: true,
    default_model: config.defaultModel,
    upstream_base_url: config.upstreamBaseUrl,
    config_fingerprint: configFingerprint(config),
  };

  await fs.writeFile(fakeClaudeScript, `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    const settingsIndex = args.indexOf('--settings');
    const settingsPath = settingsIndex >= 0 ? args[settingsIndex + 1] : null;
    const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : null;
    fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify({
      args,
      settings,
      settingsPath,
      env: {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      },
    }, null, 2));
  `);
  await fs.writeFile(fakeClaudeCmd, `@echo off\r\nnode \"${fakeClaudeScript}\" %*\r\n`);

  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify(healthPayload);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => proxy.listen(port, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
  });

  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      PATH: `${tempBin};${process.env.PATH || ''}`,
      CLAUDE_CODE_CLI: 'claude.cmd',
      REPORT_PATH: reportPath,
      CLAUDE_CODE_GMN_PROXY_HOST: config.host,
      CLAUDE_CODE_GMN_PROXY_PORT: String(config.port),
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_BASE_URL: config.upstreamBaseUrl,
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_API_KEY: config.upstreamApiKey,
      CLAUDE_CODE_GMN_PROXY_MODEL: config.defaultModel,
      CLAUDE_CODE_GMN_PROXY_REASONING: config.reasoningEffort,
      CLAUDE_CODE_GMN_PROXY_AUTH_TOKEN: config.localAuthToken,
    },
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdin.end(`
    import { execClaudeWithProxy } from ${JSON.stringify(runtimeModule)};
    await execClaudeWithProxy(['-p', 'Reply with PONG only.', '--output-format', 'json']);
  `);

  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr.join(''));

  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.deepEqual(report.args.slice(0, 4), [
    '--settings',
    report.settingsPath,
    '--model',
    'gpt-5.4',
  ]);
  assert.deepEqual(report.settings, {
    env: {
      ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
      ANTHROPIC_AUTH_TOKEN: config.localAuthToken,
    },
  });
  assert.deepEqual(report.env, {
    ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
    ANTHROPIC_AUTH_TOKEN: config.localAuthToken,
    ANTHROPIC_API_KEY: null,
  });

  const stateDir = path.join(tempHome, '.claude-code-gmn-proxy');
  const stateFiles = await fs.readdir(stateDir);
  assert.deepEqual(stateFiles.filter((name) => name.startsWith('claude-settings-')), []);
});

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function configFingerprint(config) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      upstreamBaseUrl: config.upstreamBaseUrl,
      upstreamApiKey: config.upstreamApiKey,
      defaultModel: config.defaultModel,
      reasoningEffort: config.reasoningEffort,
      localAuthToken: config.localAuthToken,
    }))
    .digest('hex');
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // proxy may still be starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`proxy on port ${port} did not become healthy`);
}

function startStaleProxy({ port, health, shutdownDelayMs = 0 }) {
  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HEALTH_JSON: JSON.stringify(health),
      SHUTDOWN_DELAY_MS: String(shutdownDelayMs),
    },
  });
  child.stdin.end(`
    import http from 'node:http';
    const health = JSON.parse(process.env.HEALTH_JSON);
    const shutdownDelayMs = Number(process.env.SHUTDOWN_DELAY_MS || '0');
    const server = http.createServer((req, res) => {
      const body = JSON.stringify(health);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    });
    process.on('SIGTERM', () => {
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, shutdownDelayMs);
    });
    await new Promise((resolve) => server.listen(Number(process.env.PORT), '127.0.0.1', resolve));
    setInterval(() => {}, 1000);
  `);
  return child;
}

function startOwnedDetachedProxy({ config, shutdownDelayMs = 0 }) {
  const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--input-type=module', '-', entry], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ENTRY: entry,
      SHUTDOWN_DELAY_MS: String(shutdownDelayMs),
      CLAUDE_CODE_GMN_PROXY_HOST: config.host,
      CLAUDE_CODE_GMN_PROXY_PORT: String(config.port),
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_BASE_URL: config.upstreamBaseUrl,
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_API_KEY: config.upstreamApiKey,
      CLAUDE_CODE_GMN_PROXY_MODEL: config.defaultModel,
      CLAUDE_CODE_GMN_PROXY_REASONING: config.reasoningEffort,
      CLAUDE_CODE_GMN_PROXY_AUTH_TOKEN: config.localAuthToken,
    },
  });
  child.stdin.end(`
    import { spawn } from 'node:child_process';
    const server = spawn(process.execPath, [process.env.ENTRY], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: process.env,
    });
    process.on('SIGTERM', () => {
      setTimeout(() => {
        if (server.exitCode === null && server.signalCode === null) {
          server.kill('SIGTERM');
        }
        process.exit(0);
      }, Number(process.env.SHUTDOWN_DELAY_MS || '0'));
    });
    setInterval(() => {}, 1000);
  `);
  return child;
}

async function runEnsureProxyAvailable({ tempHome, runtimeModule, config }) {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
    },
  });
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdin.end(`
    import { ensureProxyAvailable, proxyHealth, stopProxy } from ${JSON.stringify(runtimeModule)};
    const config = ${JSON.stringify(config)};
    await ensureProxyAvailable(config);
    console.log(JSON.stringify(await proxyHealth(config)));
    await stopProxy(config);
  `);
  const [code] = await once(child, 'exit');
  return {
    code,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
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

test('ensureProxyAvailable does not reuse a detached proxy with stale config', async (context) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-home-'));
  const port = await getFreePort();
  const runtimeModule = new URL('../src/runtime.mjs', import.meta.url).href;
  const stateDir = path.join(tempHome, '.claude-code-gmn-proxy');
  await fs.mkdir(stateDir, { recursive: true });

  const staleProxy = startOwnedDetachedProxy({
    config: {
      host: '127.0.0.1',
      port,
      upstreamBaseUrl: 'https://old.example',
      upstreamApiKey: 'stale-key',
      defaultModel: 'old-model',
      reasoningEffort: 'high',
      localAuthToken: 'local-token',
    },
  });
  const staleStderr = [];
  staleProxy.stderr.on('data', (chunk) => staleStderr.push(chunk.toString()));
  context.after(() => {
    if (staleProxy.exitCode === null && staleProxy.signalCode === null) {
      staleProxy.kill('SIGTERM');
    }
  });

  await waitForHealth(port);

  await fs.writeFile(path.join(stateDir, 'proxy.pid'), `${staleProxy.pid}\n`);

  const result = await runEnsureProxyAvailable({
    tempHome,
    runtimeModule,
    config: {
      host: '127.0.0.1',
      port,
      upstreamBaseUrl: 'https://example.invalid',
      upstreamApiKey: 'test-key',
      defaultModel: 'gpt-5.4',
      reasoningEffort: 'high',
      localAuthToken: 'local-token',
    },
  });

  assert.equal(result.code, 0, `${result.stderr}${staleStderr.join('')}`);
  assert.match(result.stdout, /"default_model":"gpt-5\.4"/);
  assert.match(result.stdout, /"upstream_base_url":"https:\/\/example\.invalid"/);
});

test('ensureProxyAvailable waits for a stale detached proxy to release the port', async (context) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-home-'));
  const port = await getFreePort();
  const runtimeModule = new URL('../src/runtime.mjs', import.meta.url).href;
  const stateDir = path.join(tempHome, '.claude-code-gmn-proxy');
  await fs.mkdir(stateDir, { recursive: true });

  const staleProxy = startOwnedDetachedProxy({
    config: {
      host: '127.0.0.1',
      port,
      upstreamBaseUrl: 'https://old.example',
      upstreamApiKey: 'stale-key',
      defaultModel: 'old-model',
      reasoningEffort: 'high',
      localAuthToken: 'local-token',
    },
    shutdownDelayMs: 400,
  });
  const staleStderr = [];
  staleProxy.stderr.on('data', (chunk) => staleStderr.push(chunk.toString()));
  context.after(() => {
    if (staleProxy.exitCode === null && staleProxy.signalCode === null) {
      staleProxy.kill('SIGTERM');
    }
  });

  await waitForHealth(port);
  await fs.writeFile(path.join(stateDir, 'proxy.pid'), `${staleProxy.pid}\n`);

  const result = await runEnsureProxyAvailable({
    tempHome,
    runtimeModule,
    config: {
      host: '127.0.0.1',
      port,
      upstreamBaseUrl: 'https://example.invalid',
      upstreamApiKey: 'test-key',
      defaultModel: 'gpt-5.4',
      reasoningEffort: 'high',
      localAuthToken: 'local-token',
    },
  });

  assert.equal(result.code, 0, `${result.stderr}${staleStderr.join('')}`);
  assert.match(result.stdout, /"default_model":"gpt-5\.4"/);
});

test('ensureProxyAvailable does not reuse a proxy when the config fingerprint changes', async (context) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-home-'));
  const port = await getFreePort();
  const runtimeModule = new URL('../src/runtime.mjs', import.meta.url).href;
  const stateDir = path.join(tempHome, '.claude-code-gmn-proxy');
  const config = {
    host: '127.0.0.1',
    port,
    upstreamBaseUrl: 'https://example.invalid',
    upstreamApiKey: 'new-key',
    defaultModel: 'gpt-5.4',
    reasoningEffort: 'high',
    localAuthToken: 'local-token',
  };
  await fs.mkdir(stateDir, { recursive: true });

  const staleProxy = startOwnedDetachedProxy({
    config: {
      ...config,
      upstreamApiKey: 'old-key',
    },
  });
  const staleStderr = [];
  staleProxy.stderr.on('data', (chunk) => staleStderr.push(chunk.toString()));
  context.after(() => {
    if (staleProxy.exitCode === null && staleProxy.signalCode === null) {
      staleProxy.kill('SIGTERM');
    }
  });

  await waitForHealth(port);
  await fs.writeFile(path.join(stateDir, 'proxy.pid'), `${staleProxy.pid}\n`);

  const result = await runEnsureProxyAvailable({ tempHome, runtimeModule, config });

  assert.equal(result.code, 0, `${result.stderr}${staleStderr.join('')}`);
  assert.match(result.stdout, new RegExp(`"config_fingerprint":"${configFingerprint(config)}"`));
});

test('ensureProxyAvailable refuses to kill an unrelated pid during stale-config recovery', async (context) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-home-'));
  const port = await getFreePort();
  const runtimeModule = new URL('../src/runtime.mjs', import.meta.url).href;

  const staleProxy = startStaleProxy({
    port,
    health: { ok: true, default_model: 'old-model', upstream_base_url: 'https://old.example' },
  });
  context.after(() => {
    if (staleProxy.exitCode === null && staleProxy.signalCode === null) {
      staleProxy.kill('SIGTERM');
    }
  });

  await waitForHealth(port);

  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
    },
  });
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdin.end(`
    import { promises as fs } from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { ensureProxyAvailable } from ${JSON.stringify(runtimeModule)};
    const config = {
      host: '127.0.0.1',
      port: ${port},
      upstreamBaseUrl: 'https://example.invalid',
      upstreamApiKey: 'test-key',
      defaultModel: 'gpt-5.4',
      reasoningEffort: 'high',
      localAuthToken: 'local-token',
    };
    const stateDir = path.join(os.homedir(), '.claude-code-gmn-proxy');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'proxy.pid'), \`\${process.pid}\\n\`);
    try {
      await ensureProxyAvailable(config);
      console.log('unexpected-success');
      process.exit(0);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
  `);

  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null, `unexpected signal ${signal}; stdout=${stdout.join('')} stderr=${stderr.join('')}`);
  assert.equal(code, 1, `stdout=${stdout.join('')} stderr=${stderr.join('')}`);
  assert.match(stderr.join(''), /not owned by this package/i);
});

test('execClaudeWithProxy removes temp settings files when the wrapper receives SIGINT', {
  skip: process.platform !== 'win32',
}, async (context) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-home-'));
  const tempBin = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-gmn-proxy-bin-'));
  const fakeClaudeScript = path.join(tempBin, 'fake-claude-sleep.mjs');
  const fakeClaudeCmd = path.join(tempBin, 'claude.cmd');
  const reportPath = path.join(tempHome, 'fake-claude-sleep-report.json');
  const runtimeModule = new URL('../src/runtime.mjs', import.meta.url).href;
  const port = await getFreePort();
  const config = {
    host: '127.0.0.1',
    port,
    upstreamBaseUrl: 'https://example.invalid',
    upstreamApiKey: 'test-key',
    defaultModel: 'gpt-5.4',
    reasoningEffort: 'high',
    localAuthToken: 'local-token',
  };
  const healthPayload = {
    ok: true,
    default_model: config.defaultModel,
    upstream_base_url: config.upstreamBaseUrl,
    config_fingerprint: configFingerprint(config),
  };

  await fs.writeFile(fakeClaudeScript, `
    import fs from 'node:fs';
    fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  await fs.writeFile(fakeClaudeCmd, `@echo off\r\nnode \"${fakeClaudeScript}\" %*\r\n`);

  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify(healthPayload);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => proxy.listen(port, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
  });

  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      PATH: `${tempBin};${process.env.PATH || ''}`,
      CLAUDE_CODE_CLI: 'claude.cmd',
      REPORT_PATH: reportPath,
      CLAUDE_CODE_GMN_PROXY_HOST: config.host,
      CLAUDE_CODE_GMN_PROXY_PORT: String(config.port),
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_BASE_URL: config.upstreamBaseUrl,
      CLAUDE_CODE_GMN_PROXY_UPSTREAM_API_KEY: config.upstreamApiKey,
      CLAUDE_CODE_GMN_PROXY_MODEL: config.defaultModel,
      CLAUDE_CODE_GMN_PROXY_REASONING: config.reasoningEffort,
      CLAUDE_CODE_GMN_PROXY_AUTH_TOKEN: config.localAuthToken,
    },
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdin.end(`
    import { execClaudeWithProxy } from ${JSON.stringify(runtimeModule)};
    setTimeout(() => {
      process.emit('SIGINT', 'SIGINT');
    }, 250);
    setTimeout(() => {
      process.exit(99);
    }, 2000);
    await execClaudeWithProxy(['-p', 'Reply with PONG only.', '--output-format', 'json']);
  `);

  const stateDir = path.join(tempHome, '.claude-code-gmn-proxy');
  await waitForCondition(async () => {
    try {
      const stateFiles = await fs.readdir(stateDir);
      return stateFiles.some((name) => name.startsWith('claude-settings-'));
    } catch {
      return false;
    }
  }, 'wrapper temp settings file');
  await waitForCondition(async () => {
    try {
      await fs.access(reportPath);
      return true;
    } catch {
      return false;
    }
  }, 'fake Claude startup report');

  await once(child, 'exit');

  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  try {
    process.kill(report.pid, 'SIGTERM');
  } catch {
    // child process may already have exited
  }

  await waitForCondition(async () => {
    try {
      const stateFiles = await fs.readdir(stateDir);
      return stateFiles.filter((name) => name.startsWith('claude-settings-')).length === 0;
    } catch {
      return false;
    }
  }, 'wrapper temp settings cleanup');

  const stateFiles = await fs.readdir(stateDir);
  assert.deepEqual(stateFiles.filter((name) => name.startsWith('claude-settings-')), [], stderr.join(''));
});

async function waitForCondition(fn, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
